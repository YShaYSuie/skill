#!/usr/bin/env node
'use strict';
/**
 * test-egress-guard.js — 出网与外部命令的静态守卫（V3.0）。
 *
 * ## 为什么需要它
 *
 * 用户 2026-09-21 明确：**本技能不做自动推送**；随后又要求把「GitHub 日志持久化」
 * 整合进本技能（不拆成独立 Skill）。两者调和的方式是：
 *
 * ```text
 * ✓ 能力存在，但默认关闭（github.enabled = false）
 * ✓ git 调用收敛到**唯一一个文件** scripts/sync-github.js
 * ✓ 必须显式 --apply 才真正提交推送；默认 dry-run
 * ✓ 推送前做敏感信息扫描；Raw 默认不同步
 * ✓ 仓库强制 private
 * ```
 *
 * 这个决定不能只写在文档里 —— 文档会被后来的改动绕过，守卫不会。
 *
 * 本脚本对本技能全部 `.js` 做**静态审计**，把「越权外发」变成会失败的测试：
 *
 * ```text
 * ① git 命令与子命令只允许出现在白名单文件（scripts/sync-github.js）
 * ② 代码托管平台地址同样只允许出现在该文件
 * ③ 网络出口白名单：lib/space-projects.js（GET 只读）与 lib/llm.js（模型压缩）
 * ④ 子进程只许拉起本地 Node（或白名单内的 curl / git）
 * ⑤ security.ai_summarize=false 可完全离线
 * ⑥ GitHub 同步的安全默认值（默认关闭 / private / 不传 Raw / 无内嵌凭据 / 默认 dry-run）
 * ```
 *
 * 只读、零 Token、不联网。
 *
 * 运行：`node scripts/test-egress-guard.js`；退出码非 0 = 存在越权外发。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['scripts', 'scripts/lib', 'adapters'];

/**
 * 本守卫自身必须排除。
 *
 * 原因：它在源码里**字面包含** `execFileSync(` / `execSync(` / `spawnSync(` 这些
 * 检索模式（写在正则里），若不排除，它会把自己当成「可疑调用点」而永远失败。
 */
const SELF = 'scripts/test-egress-guard.js';

/**
 * 允许使用 curl 的模块白名单（其余模块一律不得发起网络请求）。
 * 键是相对技能根目录的 POSIX 路径；每个条目声明**允许的方法**与**存在的理由**。
 */
const CURL_ALLOWLIST = {
  'scripts/lib/space-projects.js': {
    method: 'GET',
    why: '只读线上空间项目 id→name（GET /console/as/projects）',
  },
  'scripts/lib/llm.js': {
    method: 'POST',
    why: '超长内容压缩（本技能唯一的对外写请求，可用 security.ai_summarize=false 关闭）',
  },
};

/**
 * 允许执行 git 的模块白名单（V3.1）。
 *
 * 用户要求「GitHub 日志持久化」整合进本技能，但**默认关闭**（`github.enabled=false`）。
 * 为了既满足该能力、又不失控，把 git 收敛到**唯一一个文件**：
 * 任何其它脚本里出现 git 调用，本守卫立即失败。
 */
const GIT_ALLOWLIST = {
  'scripts/sync-github.js': {
    why:
      'Structured Logs → GitHub 私有仓库归档（默认 enabled=false，需 --apply 才真正推送）。' +
      '可执行 git，以及可选地用 gh CLI 创建私有仓库。',
  },
  // 测试脚手架用本地裸仓库（git init --bare）验证同步链路，**不接触网络**
  'scripts/test-github-sync.js': {
    why: '离线行为测试：把本地裸仓库当作远端，验证上传/幂等/覆盖方向/敏感拦截',
  },
};

/**
 * 允许 Codex Hook 维护脚本启动本机 Codex app-server。
 * 它只读取 hooks/list / 校准本机信任状态，不访问网络。
 */
const CODEX_APP_SERVER_ALLOWLIST = {
  'scripts/ensure-codex-hooks.js': {
    why: '启动本机 Codex app-server，调用 hooks/list 校验 trustStatus 并读取 currentHash',
  },
};

/** 代码托管平台（本技能绝不允许出现） */
const HOSTING_RE = /\bgithub\.com|\bapi\.github|\bgitlab|\bgitee\.com|\bbitbucket|\bgist\.github/i;

let failed = 0;
let passed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: String((e && e.message) || e) });
    process.stdout.write(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n')[0]}\n`);
  }
}

/** 收集待审计文件（相对 ROOT 的 POSIX 风格路径 → 源码） */
function collectSources() {
  const out = new Map();
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    let entries = [];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue;
        walk(childRel);
      } else if (e.name.endsWith('.js')) {
        out.set(childRel, fs.readFileSync(path.join(ROOT, childRel), 'utf8'));
      }
    }
  };
  for (const d of SCAN_DIRS) walk(d);
  return out;
}

/**
 * 抽出所有外部命令调用的参数窗口。
 *
 * 只需覆盖本技能实际用到的三种：`execFileSync(...)` / `execSync(...)` / `spawnSync(...)`。
 * 取调用点之后的一段文本作为「参数窗口」，在其中查敏感字样。
 */
function commandWindows(src) {
  const out = [];
  const re = /(spawnSync|execFileSync|execSync|spawn)\s*\(/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ fn: m[1], at: m.index, text: src.slice(m.index, m.index + 1400) });
  }
  return out;
}

/** 判断该文件是否为本技能的**运行时**代码（测试脚本对自身做同类审计，另作放宽） */
const isTestFile = (rel) => /(^|\/)test-[^/]*\.js$/.test(rel);

const SOURCES = collectSources();

process.stdout.write('test-egress-guard.js — 出网与外部命令的静态守卫\n');
process.stdout.write(`审计范围：${[...SOURCES.keys()].length} 个文件（${SCAN_DIRS.join(', ')}）\n`);

/* ---------------- 1. git 只允许出现在白名单文件 ---------------- */
process.stdout.write('\n1. git 只在白名单文件里\n');

check('git 命令调用只出现在白名单模块（sync-github.js）', () => {
  const offenders = [];
  for (const [rel, src] of SOURCES) {
    if (rel === SELF) continue; // 见 SELF 注释：本文件字面包含这些函数名
    if (Object.prototype.hasOwnProperty.call(GIT_ALLOWLIST, rel)) continue;
    for (const w of commandWindows(src)) {
      // 参数窗口里出现独立的 git 分词才算违规（避免误伤 "digit" / ".git" 这类子串）
      if (/(['"`]|\s|,)git(\.exe)?(['"`]|\s|,|\))/i.test(w.text)) {
        offenders.push(`${rel} 的 ${w.fn}()`);
      }
    }
  }
  if (offenders.length) {
    throw new Error(
      `发现白名单外的 git 调用：${offenders.join('、')}。` +
        `git 只允许出现在 ${Object.keys(GIT_ALLOWLIST).join('、')}。`
    );
  }
});

check('git 子命令字样（push / clone / commit -m / remote add）只出现在白名单', () => {
  const offenders = [];
  for (const [rel, src] of SOURCES) {
    if (isTestFile(rel)) continue; // 测试脚本会以字符串断言这些词，属正常
    if (Object.prototype.hasOwnProperty.call(GIT_ALLOWLIST, rel)) continue;
    for (const w of commandWindows(src)) {
      if (
        /\b(push|clone|fetch|checkout|pull)\b(?!\s*\()|\b(remote\s+add|commit\s+-m)\b/.test(
          w.text
        )
      ) {
        offenders.push(rel);
      }
    }
  }
  if (offenders.length) throw new Error(`命令字符串含 git 子命令：${[...new Set(offenders)].join('、')}`);
});

/* ---------------- 2. 代码托管平台地址只出现在白名单 ---------------- */
process.stdout.write('\n2. 托管平台地址只在白名单文件里\n');

check('github / gitlab / gitee 地址只出现在 sync-github.js', () => {
  const offenders = [];
  for (const [rel, src] of SOURCES) {
    if (isTestFile(rel)) continue; // test-role-profile 里有「GitHub Release」用例文本
    if (Object.prototype.hasOwnProperty.call(GIT_ALLOWLIST, rel)) continue;
    // 逐行判断，跳过注释行（注释里说明「不做 git 同步」是允许且需要的）
    src.split('\n').forEach((line, i) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return;
      if (HOSTING_RE.test(line)) offenders.push(`${rel}:${i + 1}`);
    });
  }
  if (offenders.length) throw new Error(`出现托管平台地址：${offenders.join('、')}`);
});

/* ---------------- 3. 网络出口白名单 ---------------- */
process.stdout.write('\n3. 网络出口白名单\n');

check('只有白名单模块使用 curl', () => {
  const offenders = [];
  for (const [rel, src] of SOURCES) {
    if (isTestFile(rel)) continue;
    if (!/execFileSync\s*\(\s*curl/.test(src) && !/execFileSync\s*\(\s*DEFAULT_CURL/.test(src)) continue;
    if (!Object.prototype.hasOwnProperty.call(CURL_ALLOWLIST, rel)) offenders.push(rel);
  }
  if (offenders.length) throw new Error(`白名单外的模块发起了 curl：${offenders.join('、')}`);
});

check('space-projects.js 是只读 GET（不得带 -d / --data / -X POST）', () => {
  const src = SOURCES.get('scripts/lib/space-projects.js');
  if (!src) throw new Error('未找到 scripts/lib/space-projects.js（路径变更需同步更新本守卫）');
  if (/['"]-d['"]|--data\b|--request\b|['"]-X['"]/.test(src)) {
    throw new Error('space-projects.js 出现了写入型 curl 参数（应保持只读 GET）');
  }
});

check('llm.js 只向配置的模型端点发请求（无硬编码第三方地址）', () => {
  const src = SOURCES.get('scripts/lib/llm.js');
  if (!src) throw new Error('未找到 scripts/lib/llm.js');
  const codeOnly = src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith('*') && !t.startsWith('/*') && !t.startsWith('//');
    })
    .join('\n');
  if (/https?:\/\//.test(codeOnly)) {
    throw new Error('llm.js 出现硬编码 URL（端点应来自 ~/.workbuddy/models.json）');
  }
});

check('不存在其他网络 API 调用（fetch / http.request / https.request / net.connect）', () => {
  const offenders = [];
  for (const [rel, src] of SOURCES) {
    if (isTestFile(rel)) continue;
    if (/\bfetch\s*\(|require\(['"](?:https?|net|dns|tls)['"]\)/.test(src)) offenders.push(rel);
  }
  if (offenders.length) throw new Error(`发现未审计的网络调用：${offenders.join('、')}`);
});

/* ---------------- 4. 子进程只许拉起本地 Node ---------------- */
process.stdout.write('\n4. 子进程只允许拉起本地 Node\n');

check('非测试代码只 spawn 本地 Node、白名单 curl、白名单 git 或本机 Codex app-server', () => {
  const offenders = [];
  for (const [rel, src] of SOURCES) {
    if (isTestFile(rel)) continue;
    // 白名单内的 git 模块：其子进程调用已由第 1/2 节单独把关
    if (Object.prototype.hasOwnProperty.call(GIT_ALLOWLIST, rel)) continue;
    if (Object.prototype.hasOwnProperty.call(CODEX_APP_SERVER_ALLOWLIST, rel)) {
      for (const w of commandWindows(src)) {
        if (
          !/codexBin/.test(w.text) ||
          !/app-server/.test(w.text) ||
          !/--stdio/.test(w.text)
        ) {
          offenders.push(`${rel} 的 Codex 子进程未被约束`);
        }
      }
      continue;
    }
    for (const w of commandWindows(src)) {
      if (/process\.execPath/.test(w.text)) continue;
      if (/spawnSync\(\s*NODE\b/.test(w.text) && /const NODE = process\.execPath/.test(src)) {
        continue;
      }
      // curl 已由第 3 节按白名单单独把关
      if (/execFileSync\s*\(\s*(curl|DEFAULT_CURL)/.test(w.text)) continue;
      offenders.push(`${rel} 的 ${w.fn}()`);
    }
  }
  if (offenders.length) throw new Error(`未经审计的子进程调用：${offenders.join('、')}`);
});

check('测试代码里使用 git 的仅限离线同步测试', () => {
  const offenders = [];
  for (const [rel, src] of SOURCES) {
    if (!isTestFile(rel)) continue;
    if (rel === SELF) continue; // 本文件字面包含 git 检测模式，见 SELF 注释
    if (Object.prototype.hasOwnProperty.call(GIT_ALLOWLIST, rel)) continue;
    for (const w of commandWindows(src)) {
      if (/(['"`]|\s|,)git(\.exe)?(['"`]|\s|,|\))/i.test(w.text)) offenders.push(rel);
    }
  }
  if (offenders.length) {
    throw new Error(`测试文件中出现未经允许的 git 调用：${[...new Set(offenders)].join('、')}`);
  }
});

/* ---------------- 5. 安全开关可完全离线 ---------------- */
process.stdout.write('\n5. 可完全离线运行\n');

check('security.ai_summarize=false 可关闭唯一对外写路径', () => {
  const src = SOURCES.get('scripts/lib/security.js') || '';
  if (!/ai_summarize/.test(src)) {
    throw new Error('scripts/lib/security.js 未见 ai_summarize 开关（离线开关丢失？）');
  }
});

/* ---------------- 6. GitHub 同步的安全默认值 ---------------- */
process.stdout.write('\n6. GitHub 同步的安全默认值\n');

const SYNC = SOURCES.get('scripts/sync-github.js') || '';

check('sync-github.js 存在（GitHub 能力已整合进本技能）', () => {
  if (!SYNC) throw new Error('未找到 scripts/sync-github.js');
});

check('config 模板：github 默认关闭', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/config.json'), 'utf8'));
  if (!tpl.github) throw new Error('templates/config.json 缺少 github 段');
  if (tpl.github.enabled !== false) {
    throw new Error(`github.enabled 必须默认为 false（实际 ${JSON.stringify(tpl.github.enabled)}）`);
  }
});

check('config 模板：visibility 必须 private、sync_raw_logs 必须 false', () => {
  const tpl = JSON.parse(fs.readFileSync(path.join(ROOT, 'templates/config.json'), 'utf8'));
  if (tpl.github.visibility !== 'private') {
    throw new Error(`github.visibility 必须为 private（实际 ${tpl.github.visibility}）`);
  }
  if (tpl.github.sync_raw_logs !== false) {
    throw new Error('github.sync_raw_logs 必须默认为 false（Raw 含完整对话痕迹）');
  }
});

check('sync-github.js 不得内嵌任何令牌/凭据', () => {
  for (const pat of [/ghp_[A-Za-z0-9]{20,}/, /github_pat_[A-Za-z0-9_]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY/, /Bearer\s+[A-Za-z0-9._-]{20,}/]) {
    if (pat.test(SYNC)) throw new Error(`sync-github.js 疑似内嵌凭据：${pat}`);
  }
  // 也不许把令牌拼进命令行参数
  if (/['"]--?(password|token)['"]\s*,/.test(SYNC)) {
    throw new Error('sync-github.js 似乎把凭据作为命令行参数传递（认证应交给环境）');
  }
});

check('sync-github.js 默认 dry-run（必须显式 --apply 才提交推送）', () => {
  if (!/flagBool\(flags,\s*'apply'\)/.test(SYNC)) {
    throw new Error('未找到 --apply 开关判定，可能默认就会推送');
  }
  // 未 apply 时必须提前返回，不能落到 commit
  if (!/if\s*\(!apply\)/.test(SYNC)) {
    throw new Error('缺少 `if (!apply) return` 的提前返回，默认可能真的推送');
  }
});

check('sync-github.js 推送前必须做敏感信息扫描', () => {
  if (!/containsSensitive/.test(SYNC)) {
    throw new Error('sync-github.js 未调用 containsSensitive，推送前缺少凭据扫描');
  }
});

check('sync-github.js 不得写入日志目录（Local 是 Source of Truth）', () => {
  // 只允许写工作副本；出现「往日志目录写」的迹象即报错
  const writeCalls = [...SYNC.matchAll(/writeFileSync\s*\(([^,]{0,120}),/g)].map((m) => m[1]);
  for (const arg of writeCalls) {
    if (/CS\.(dayDir|logsDir|structuredDir)|C\.(currentPath|configPath|statePath)/.test(arg)) {
      throw new Error(`sync-github.js 试图写入日志目录：writeFileSync(${arg.trim()})`);
    }
  }
  if (/rmSync\s*\(\s*path\.join\(\s*dir/.test(SYNC)) {
    throw new Error('sync-github.js 试图删除日志目录下的内容（只应操作工作副本）');
  }
});

process.stdout.write(`\n结果：${passed} 通过，${failed} 失败（共 ${passed + failed} 项）\n`);
if (failed) {
  process.stdout.write('\n失败明细：\n');
  failures.forEach((f) => process.stdout.write(`  ✗ ${f.name}\n      ${f.error}\n`));
  process.exitCode = 1;
}
