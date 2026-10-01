'use strict';
/**
 * llm.js — 超长文本的 AI 压缩（§12 内容的长度合规）。
 *
 * 背景：`security.filterContent()` 原本对超长内容**静默截断**到 200 字 ——
 * 自动采集路径（Hook）下用户完全无感，尾部内容永久丢失。本模块把「截断」
 * 换成「先让 AI 压缩成摘要」，只在 AI 不可用时才降级为截断（且必须显式标记）。
 *
 * 设计约束：
 *   - **同步**：本技能全程同步执行模型，走 `curl.exe` 子进程而非 fetch。
 *   - **凭据从宿主配置读取**：`~/.workbuddy/models.json`（含 url 与 apiKey）。
 *     该文件由宿主维护，本模块只读，不复制、不外泄、不写入日志。
 *   - **必须绕代理**：与 `space-projects.js` 同因 —— 本机 HTTPS_PROXY 指向本地
 *     代理会把外部请求打成 404。
 *   - **失败不阻断**：任何异常都返回 `{ ok:false }`，由调用方降级。
 *   - **绝不把 token 放进错误信息**。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** Windows 10+ 自带 curl.exe；避免依赖 Git Bash 的 shim（本机 shim 已损坏） */
const DEFAULT_CURL = 'C:/Windows/System32/curl.exe';
/** 宿主模型配置文件 */
const MODELS_FILE = path.join('.workbuddy', 'models.json');
/** 压缩任务的默认超时（秒）。压缩是短任务，不需要 space-projects 那样的长超时 */
const DEFAULT_TIMEOUT_SEC = 30;
/** 单次压缩允许的最大失败重试（压缩失败可降级，无需像项目名那样重试 3 次） */
const MAX_ATTEMPTS = 2;

/**
 * 读取宿主模型配置。
 *
 * @param {object} [opts] { home }
 * @returns {{ok:boolean, url?:string, apiKey?:string, model?:string, error?:string}}
 */
function readModelConfig(opts) {
  const h = (opts && opts.home) || os.homedir();
  const file = path.join(h, MODELS_FILE);
  if (!fs.existsSync(file)) return { ok: false, error: `未找到模型配置：${file}` };
  let list;
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ok: false, error: '模型配置不是合法 JSON' };
  }
  const arr = Array.isArray(list) ? list : [list];
  const m = arr.find((x) => x && x.url && x.apiKey);
  if (!m) return { ok: false, error: '模型配置中没有可用的 url/apiKey' };
  return { ok: true, url: String(m.url), apiKey: String(m.apiKey), model: String(m.id || m.name || '') };
}

/** 从模型列表中挑一个可用的（供测试注入） */
function pickModel(list) {
  const arr = Array.isArray(list) ? list : [list];
  return arr.find((x) => x && x.url && x.apiKey) || null;
}

/**
 * 压缩提示词。
 *
 * 目标不是「写摘要」而是「在不丢关键信息的前提下压到 N 字内」——
 * 工作日志要保留**做了什么 + 产出/结论**，去掉寒暄、复述、修饰。
 */
function buildMessages(text, maxLength) {
  return [
    {
      role: 'system',
      content:
        '你是工作日志压缩助手。把用户给出的文本压缩为**一句**工作事项摘要。\n' +
        '要求：\n' +
        `1. 严格不超过 ${maxLength} 个字（中文按字符计）。\n` +
        '2. 保留「做了什么 + 对象/模块 + 结果或结论」这些关键信息，不要丢失。\n' +
        '3. 删除寒暄、客套、复述、解释性语句、口语填充词。\n' +
        '4. 不要分点、不要换行、不要引号、不要任何前缀或说明。\n' +
        '5. 只输出摘要本身。',
    },
    { role: 'user', content: text },
  ];
}

/**
 * 从模型响应中取出正文。
 *
 * 注意 reasoning 模型（如 DeepSeek-V4）会把额度先花在 `reasoning_content` 上，
 * 若 `max_tokens` 太小则 `content` 为空 —— 所以调用方要给足预算，
 * 这里同时兼容两种字段名。
 */
function extractContent(parsed) {
  const msg = (parsed && parsed.choices && parsed.choices[0] && parsed.choices[0].message) || {};
  const raw = msg.content != null ? msg.content : msg.reasoning_content;
  return String(raw == null ? '' : raw).trim();
}

/** 去掉模型可能加上的引号/前后缀，并压成单行 */
function normalizeSummary(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .replace(/^摘要[:：]\s*/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 调一次 chat/completions（同步，走 curl.exe）。
 *
 * @returns {{ok:boolean, text?:string, error?:string}}
 */
function requestSummary(cfg, messages, opts) {
  const o = opts || {};
  const curl = o.curl || DEFAULT_CURL;
  if (!fs.existsSync(curl)) return { ok: false, error: `未找到 curl.exe（${curl}）` };
  const timeoutSec = Number(o.timeoutSec) > 0 ? Number(o.timeoutSec) : DEFAULT_TIMEOUT_SEC;
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    // reasoning 模型会把额度先用于思考，预算必须给足，否则 content 为空
    max_tokens: Number(o.maxTokens) > 0 ? Number(o.maxTokens) : 2000,
    temperature: 0.2,
    stream: false,
  });
  const args = [
    '-sS',
    // 与 space-projects.js 同因：必须绕开本机代理，否则请求被本地代理打成 404
    '--noproxy',
    '*',
    '-m',
    String(timeoutSec),
    '-H',
    'Content-Type: application/json',
    '-H',
    'Authorization: Bearer ' + cfg.apiKey,
    '-d',
    body,
    cfg.url,
  ];
  let out = '';
  try {
    out = execFileSync(curl, args, {
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutSec * 1000 + 2000,
      windowsHide: true,
    });
  } catch (e) {
    // 错误信息里绝不能带 token —— curl 的 stderr 不含 Authorization 头，安全
    const so = String((e && e.stdout) || '').slice(0, 120);
    return { ok: false, error: '请求失败：' + String((e && e.message) || e).slice(0, 120) + (so ? ' / ' + so : '') };
  }
  let parsed;
  try {
    parsed = JSON.parse(out);
  } catch (e) {
    return { ok: false, error: '响应不是 JSON：' + out.slice(0, 120).replace(/\s+/g, ' ') };
  }
  if (parsed.error) {
    return { ok: false, error: '接口返回错误：' + String(parsed.error.message || parsed.error).slice(0, 120) };
  }
  const text = normalizeSummary(extractContent(parsed));
  if (!text) return { ok: false, error: '模型返回空内容' };
  return { ok: true, text, usage: parsed.usage || null };
}

/**
 * 把超长文本压缩到 maxLength 以内。
 *
 * @param {string} text 待压缩文本（调用方需保证已脱敏）
 * @param {number} maxLength 目标上限（字数）
 * @param {object} [opts] { home, curl, timeoutSec, maxTokens, maxAttempts, model }
 * @returns {{ok:boolean, text:string, summarized:boolean, attempts:number, usage?:object, error?:string}}
 */
function summarizeToLimit(text, maxLength, opts) {
  const o = opts || {};
  const target = Number(maxLength) > 0 ? Number(maxLength) : 200;
  const src = String(text == null ? '' : text);
  if (src.length <= target) {
    return { ok: true, text: src, summarized: false, attempts: 0 };
  }
  const cfg = o.model || readModelConfig(o);
  if (!cfg.ok) return { ok: false, text: src, summarized: false, attempts: 0, error: cfg.error };

  const messages = buildMessages(src, target);
  const attempts = Number(o.maxAttempts) > 0 ? Number(o.maxAttempts) : MAX_ATTEMPTS;
  let lastError = '未知原因';
  for (let i = 1; i <= attempts; i += 1) {
    const r = requestSummary(cfg, messages, o);
    if (r.ok) {
      // 模型偶尔会超出目标；超出则用本地兜底裁到上限，
      // 但此时给出真实长度，让调用方能据此判断是否需要人工介入。
      const outText = r.text.length > target ? r.text.slice(0, target) : r.text;
      return {
        ok: true,
        text: outText,
        summarized: true,
        attempts: i,
        usage: r.usage || null,
        model_text_length: r.text.length,
        clipped_by_model: r.text.length > target,
      };
    }
    lastError = r.error;
  }
  return { ok: false, text: src, summarized: false, attempts, error: lastError };
}

module.exports = {
  DEFAULT_CURL,
  MODELS_FILE,
  DEFAULT_TIMEOUT_SEC,
  MAX_ATTEMPTS,
  readModelConfig,
  pickModel,
  buildMessages,
  extractContent,
  normalizeSummary,
  requestSummary,
  summarizeToLimit,
};
