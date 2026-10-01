'use strict';
/**
 * security.js — Security Filter（§12 / §55）。
 *
 * Activity 进入 WorkItem 前必须经过本过滤器（§12），禁止绕过它直接进入长期日志。
 *
 * 两条硬约束：
 *   1. **禁止记录**：密码、API Key、Token、Cookie、私钥、银行卡信息、完整环境变量、
 *      完整文件内容、浏览器隐私内容、剪贴板内容、密码管理器内容。
 *   2. **禁止访问**：全磁盘扫描、任意浏览器读取、任意剪贴板读取、密码管理器读取、
 *      任意 Shell 执行。Skill 只能访问用户明确配置的日志目录及宿主提供的必要事件信息。
 *
 * 因此安全项为 **fail-closed**：配置里的 allow_* 即使写成 true 也会被忽略并回落为 false，
 * 受限访问面不存在"打开"路径。
 *
 * 长度处理（超长内容的处理策略）：
 *   ① 先脱敏（纯本地规则）
 *   ② 超长时**优先调用 AI 压缩**为摘要（`lib/llm.js`），而不是静默截断
 *   ③ AI 不可用/失败 → 降级为截断，并**显式标记** `truncated` 与 `original_length`
 *   ④ 结构化 detail 走独立上限，不调用 AI，超限时记录 `detail_compression`
 *
 * 之所以不保留「静默截断」：自动采集路径（Hook）下 CLI 的 stdout 会被丢弃，
 * 截断若只写在 stdout 里，用户完全无感，尾部内容永久丢失。
 */

const MAX_ACTIVITY_LENGTH = 200;
/**
 * 结构化 detail 的安全上限。
 *
 * `content` 的 200 字是**展示日志上限**；detail 用于保留工作事项的结构化说明，
 * 但仍禁止保存完整 Prompt / Response / 文件内容，因此继续设置保守硬上限。
 */
const MAX_DETAIL_LENGTH = 4000;

/**
 * 是否启用 AI 压缩（超长内容）。默认开启，可被 config.security.ai_summarize 关闭。
 * 关闭或失败时降级为截断。
 */
const DEFAULT_AI_SUMMARIZE = true;

/**
 * AI 压缩的超时预算（秒）。
 *
 * 必须小于 Hook 留给子进程的时间（`hook-bridge.js` 的 SPAWN_TIMEOUT_MS = 7s），
 * 否则超长内容会把整个 Hook 拖到宿主 10s 上限之外。超时即降级为截断。
 */
const DEFAULT_AI_SUMMARIZE_TIMEOUT_SEC = 6;

/** 内容脱敏规则。顺序即优先级。 */
const RULES = [
  {
    name: 'private_key',
    label: '私钥',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    name: 'api_key',
    label: 'API Key',
    re: /\b(?:sk-ant-[A-Za-z0-9\-_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35})\b/g,
  },
  {
    name: 'token',
    label: 'Token',
    re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
  },
  {
    name: 'bearer',
    label: 'Bearer 凭据',
    re: /\bBearer\s+[A-Za-z0-9\-._~+/]{16,}=*/g,
  },
  {
    name: 'credential_pair',
    label: '口令字段',
    re: /\b(?:password|passwd|pwd|secret|client_secret|access_key|secret_key|api_key|apikey|auth_token)\b\s*[:=]\s*(?:"[^"]{1,80}"|'[^']{1,80}'|[^\s,;]{4,80})/gi,
  },
  {
    // 2026-09-21 补：中文标签 + 值同样是指令级泄漏，此前只覆盖英文关键词，
    // 导致用户在中文里贴出的凭据（「令牌：xxx」「密码：xxx」）原样入库。
    // 允许标签与值之间夹一层中文/空格（如「我的令牌是 xxx」）。
    //
    // ⚠️ 只捕获**值本身**，绝不吃掉两侧的引号/逗号 ——
    //    历史版本在末尾加了可选的 `["'`]?`，结果把 JSON 里字符串的收尾引号一起替换掉，
    //    把 `"content": "令牌：xxx",` 变成 `"content": "[已脱敏:…],`，
    //    直接写坏了 current.json（2026-09-21 真实事故）。脱敏只替换值，不碰分隔符。
    name: 'credential_pair_cn',
    label: '口令字段（中文）',
    re: /(?:令牌|密钥|口令|密码|访问令牌|私钥|凭据|凭证)(?:是|为|：|:|＝|=|\s){1,6}([A-Za-z0-9\-._~+/]{12,}={0,2})/g,
  },
  {
    name: 'cookie',
    label: 'Cookie',
    re: /\b(?:set-)?cookie\s*:\s*[^\n]{4,200}/gi,
  },
  {
    name: 'env_dump',
    label: '环境变量转储',
    // §12：完整环境变量禁止记录。连续 3 个以上 KEY=VALUE 视为转储
    re: /(?:^|\n)\s*[A-Z][A-Z0-9_]{2,}\s*=\s*[^\n]{1,200}(?:\n\s*[A-Z][A-Z0-9_]{2,}\s*=\s*[^\n]{1,200}){2,}/g,
  },
  {
    name: 'id_card',
    label: '身份证件信息',
    re: /\b\d{17}[\dXx]\b/g,
  },
  {
    name: 'bank_card',
    label: '银行卡信息',
    re: /\b\d{4}(?:[ -]?\d{4}){3,4}\b/g,
  },
  {
    name: 'email',
    label: '邮箱地址',
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  },
];

/** §12/§55：禁止访问的边界。配置无法打开。 */
const ACCESS_BOUNDARIES = [
  {
    key: 'log_directory_only',
    label: '日志目录',
    fixed: 'restricted',
    rule: '仅允许访问用户明确配置的日志目录',
  },
  { key: 'allow_full_disk_scan', label: '全盘扫描', rule: '禁止全磁盘扫描' },
  { key: 'allow_browser_access', label: '浏览器访问', rule: '禁止任意浏览器读取' },
  { key: 'allow_clipboard_access', label: '剪贴板访问', rule: '禁止任意剪贴板读取' },
  { key: 'allow_password_manager_access', label: '密码管理器访问', rule: '禁止密码管理器读取' },
  { key: 'allow_arbitrary_shell', label: '任意 Shell 执行', rule: '禁止任意 Shell 执行' },
];

/** §12：禁止记录的内容类型 */
const RECORD_PROHIBITIONS = [
  { key: 'store_full_prompt', label: '完整 Prompt' },
  { key: 'store_full_ai_response', label: '完整 AI Response' },
  { key: 'store_file_content', label: '完整文件内容' },
  { key: 'store_command_output', label: '完整命令输出' },
  { key: 'store_env_dump', label: '完整环境变量' },
  { key: 'store_clipboard', label: '剪贴板内容' },
  { key: 'store_browser_private', label: '浏览器隐私内容' },
  { key: 'store_password_manager', label: '密码管理器内容' },
];

/** 合并清单（validate-log 使用） */
const BOUNDARIES = ACCESS_BOUNDARIES.concat(RECORD_PROHIBITIONS).map((b) =>
  Object.assign({ allowed: b.key === 'log_directory_only' }, b)
);

/**
 * 归一化安全配置（§44 形状 + fail-closed）。
 * allow_* 一律强制为 false；strict_mode 恒为 true。
 */
function normalizeSecurityConfig(raw) {
  const src = raw || {};
  const out = {
    strict_mode: true,
    allow_browser_access: false,
    allow_clipboard_access: false,
    allow_password_manager_access: false,
    allow_full_disk_scan: false,
    allow_arbitrary_shell: false,
    redact_sensitive: true,
    max_activity_length: MAX_ACTIVITY_LENGTH,
    max_detail_length: MAX_DETAIL_LENGTH,
    // 超长内容优先交给 AI 压缩，而不是静默截断
    ai_summarize: DEFAULT_AI_SUMMARIZE,
  };
  // 只有脱敏开关、长度上限与 AI 压缩开关允许调整，且不会放开任何受限访问面
  if (typeof src.redact_sensitive === 'boolean') out.redact_sensitive = src.redact_sensitive;
  if (typeof src.ai_summarize === 'boolean') out.ai_summarize = src.ai_summarize;
  const max = Number(src.max_activity_length);
  if (Number.isFinite(max) && max > 0) out.max_activity_length = Math.min(max, 2000);
  const maxDetail = Number(src.max_detail_length);
  if (Number.isFinite(maxDetail) && maxDetail > 0) {
    out.max_detail_length = Math.min(maxDetail, 20000);
  }
  // AI 压缩的超时预算。默认 6s：Hook 给子进程 7s，超时降级为截断而不是拖垮 Hook
  const aiTimeout = Number(src.ai_summarize_timeout_sec);
  out.ai_summarize_timeout_sec =
    Number.isFinite(aiTimeout) && aiTimeout > 0 ? Math.min(aiTimeout, 60) : DEFAULT_AI_SUMMARIZE_TIMEOUT_SEC;
  return out;
}

/** 默认安全配置 */
const defaultSecurityConfig = () => normalizeSecurityConfig({});

/** 脱敏：命中片段替换为 [已脱敏:标签]，返回命中清单 */
function redact(text, options) {
  const opts = options || {};
  if (opts.enabled === false) return { text: String(text || ''), hits: [] };
  let out = String(text || '');
  const hits = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(out)) {
      hits.push(rule.name);
      rule.re.lastIndex = 0;
      out = out.replace(rule.re, `[已脱敏:${rule.label}]`);
    }
    rule.re.lastIndex = 0;
  }
  return { text: out, hits: [...new Set(hits)] };
}

/**
 * 折叠为单行（不做长度裁剪）。
 * §12 禁止记录完整 Prompt / Response / 文件内容，因此折叠换行与连续空白。
 */
function foldSingleLine(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * 压缩为单行摘要（纯本地，不含 AI）。
 * 超长时截断。保留此函数作为 AI 不可用时的降级路径与单元测试入口。
 */
function summarize(text, maxLength) {
  const max = maxLength || MAX_ACTIVITY_LENGTH;
  const out = foldSingleLine(text);
  if (out.length > max) return { text: out.slice(0, max), truncated: true };
  return { text: out, truncated: false };
}

/**
 * §12 完整过滤链：脱敏 → （超长则 AI 压缩，失败降级截断）→ 单行摘要。
 *
 * @param {string} raw 原始内容
 * @param {object} [options] { security, aiSummarize, llm, llmOptions }
 *   - `aiSummarize===false` 强制走本地截断（测试/离线）
 *   - `llm` 可注入替代实现（测试用），默认 `lib/llm.js`
 * @returns {object} 含 `content` 与截断/压缩的完整元信息
 */
function filterContent(raw, options) {
  const o = options || {};
  const cfg = normalizeSecurityConfig(o.security);
  const redacted = redact(raw, { enabled: cfg.redact_sensitive });
  const folded = foldSingleLine(redacted.text);
  const originalLength = String(raw || '').length;
  const base = {
    hits: redacted.hits,
    redacted: redacted.hits.length > 0,
    original_length: originalLength,
  };

  // 未超限：直接放行，不做任何压缩
  if (folded.length <= cfg.max_activity_length) {
    return Object.assign(base, {
      content: folded,
      truncated: false,
      summarized: false,
      ai_used: false,
    });
  }

  // 超限：优先 AI 压缩（脱敏后的文本才交给模型，避免敏感信息出网）
  const wantAi = o.aiSummarize !== false && cfg.ai_summarize !== false;
  if (wantAi) {
    let llm = o.llm;
    if (!llm) {
      try {
        llm = require('./llm');
      } catch (e) {
        llm = null;
      }
    }
    if (llm && typeof llm.summarizeToLimit === 'function') {
      let r = null;
      try {
        // 超时必须受限：Hook 路径下整个子进程只有 7s，压缩不能把预算吃光
        const llmOptions = Object.assign(
          { timeoutSec: cfg.ai_summarize_timeout_sec, maxAttempts: 1 },
          o.llmOptions
        );
        r = llm.summarizeToLimit(folded, cfg.max_activity_length, llmOptions);
      } catch (e) {
        r = { ok: false, error: String((e && e.message) || e) };
      }
      if (r && r.ok && r.summarized && r.text) {
        return Object.assign(base, {
          content: r.text,
          truncated: false,
          summarized: true,
          ai_used: true,
          compressed_from: folded.length,
          llm_attempts: r.attempts || 1,
          llm_error: null,
        });
      }
      // AI 失败 → 降级截断，但把失败原因带出去（调用方可提示用户）
      const fallback = summarize(folded, cfg.max_activity_length);
      return Object.assign(base, {
        content: fallback.text,
        truncated: true,
        summarized: false,
        ai_used: false,
        compressed_from: folded.length,
        llm_error: (r && r.error) || 'AI 压缩未返回结果',
      });
    }
  }

  // AI 关闭或不可用 → 截断并显式标记
  const fallback = summarize(folded, cfg.max_activity_length);
  return Object.assign(base, {
    content: fallback.text,
    truncated: true,
    summarized: false,
    ai_used: false,
    compressed_from: folded.length,
    llm_error: wantAi ? 'AI 压缩模块不可用' : 'AI 压缩已关闭',
  });
}

/**
 * 结构化 detail 的过滤链：脱敏 → 折叠单行 → 安全上限截断。
 *
 * 与 `filterContent` 的区别：这里**不调用 AI 压缩**，也不把结果限制在 200 字。
 * `detail` 不是展示日志，而是结构化记录的补充说明，因此保留更多信息；
 * 但仍必须脱敏，并用独立安全上限防止把聊天原文或文件全文写入日志。
 */
function filterDetail(raw, options) {
  const o = options || {};
  const cfg = normalizeSecurityConfig(o.security);
  const redacted = redact(raw, { enabled: cfg.redact_sensitive });
  const folded = foldSingleLine(redacted.text);
  const max = cfg.max_detail_length;
  const truncated = folded.length > max;
  return {
    detail: truncated ? folded.slice(0, max) : folded,
    hits: redacted.hits,
    redacted: redacted.hits.length > 0,
    original_length: String(raw || '').length,
    final_length: truncated ? max : folded.length,
    truncated,
  };
}

/** 只检测不修改 */
function containsSensitive(text) {
  const hits = [];
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    if (rule.re.test(text)) hits.push(rule.name);
    rule.re.lastIndex = 0;
  }
  return hits;
}

/**
 * 压缩留痕（供日志落库，使超长内容的处理**可见**）。
 *
 * 只在该条内容确实超长（被压缩或截断）时返回对象，否则返回 null ——
 * 避免给每条正常记录都挂一个无意义的空对象。
 */
function compressionMeta(filtered) {
  if (!filtered) return null;
  const from = Number(filtered.compressed_from);
  const didSomething = Boolean(filtered.summarized) || Boolean(filtered.truncated);
  if (!didSomething) return null;
  return {
    summarized: Boolean(filtered.summarized),
    truncated: Boolean(filtered.truncated),
    original_length: Number.isFinite(from) ? from : Number(filtered.original_length) || null,
    final_length: filtered.content ? filtered.content.length : null,
    // 截断是**信息损失**，必须把原因带出来供用户判断
    reason: filtered.truncated
      ? `AI 压缩失败，已截断至 ${(filtered.content || '').length} 字：${filtered.llm_error || '未知原因'}`
      : `已由 AI 压缩至 ${(filtered.content || '').length} 字`,
  };
}

/** detail 截断留痕；未截断时返回 null。 */
function detailMeta(filtered) {
  if (!filtered || !filtered.truncated) return null;
  return {
    truncated: true,
    original_length: Number(filtered.original_length) || null,
    final_length: Number(filtered.final_length) || null,
    reason: `detail 超过安全上限，已截断至 ${Number(filtered.final_length) || 0} 字`,
  };
}

/** 生成 /security 报告数据（§12/§55） */function report(raw) {
  const cfg = normalizeSecurityConfig(raw);
  const rows = ACCESS_BOUNDARIES.map((b) => ({
    key: b.key,
    label: b.label,
    state: 'forced_closed',
    display: b.fixed === 'restricted' ? '已限制' : '关闭',
    rule: b.rule,
  }));
  RECORD_PROHIBITIONS.forEach((p) => {
    rows.push({ key: p.key, label: `记录${p.label}`, state: 'forced_closed', display: '关闭' });
  });
  return {
    strict_mode: true,
    rows,
    access_boundaries: ACCESS_BOUNDARIES,
    record_prohibitions: RECORD_PROHIBITIONS,
    redact_sensitive: cfg.redact_sensitive,
    max_activity_length: cfg.max_activity_length,
    max_detail_length: cfg.max_detail_length,
    ai_summarize: cfg.ai_summarize,
    ai_summarize_timeout_sec: cfg.ai_summarize_timeout_sec,
    rules: RULES.map((r) => ({ name: r.name, label: r.label })),
  };
}

module.exports = {
  MAX_ACTIVITY_LENGTH,
  MAX_DETAIL_LENGTH,
  DEFAULT_AI_SUMMARIZE,
  DEFAULT_AI_SUMMARIZE_TIMEOUT_SEC,
  RULES,
  BOUNDARIES,
  ACCESS_BOUNDARIES,
  RECORD_PROHIBITIONS,
  defaultSecurityConfig,
  normalizeSecurityConfig,
  redact,
  foldSingleLine,
  summarize,
  filterContent,
  filterDetail,
  compressionMeta,
  detailMeta,
  containsSensitive,
  report,
};
