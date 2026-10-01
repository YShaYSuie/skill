#!/usr/bin/env node
'use strict';
/**
 * test-github-sync.js — GitHub 日志持久化的离线行为测试（V3.1）。
 *
 * ## 为什么用「本地裸仓库」当远端
 *
 * `git init --bare` 生成的仓库可以被 `git clone` / `git push` 当普通远端使用，
 * 因此**整条同步链路都能在无网络、无凭据、无 GitHub 账号的前提下真实跑通** ——
 * 不是 mock，是真的 `git clone` + `git commit` + `git push`。
 *
 * ## 覆盖的关键不变量
 *
 * ```text
 * ① Local 是 Source of Truth：同步前后本地日志**逐字节不变**
 * ② 远端不存在 → 上传；内容一致 → 不产生空提交；内容不同 → 本地覆盖远端
 * ③ 绝不反向覆盖本地
 * ④ sync_raw_logs=false 时 raw/ 不上传
 * ⑤ 命中敏感信息 → 拒绝同步，且本地不受影响
 * ⑥ 默认关闭（enabled=false 时不推送）；默认 dry-run（不加 --apply 不提交）
 * ⑦ --prune 才删除远端过期日期目录
 * ```
 *
 * 若环境中没有 git，会明确报「跳过」而不是假装通过。
 *
 * 运行：`node scripts/test-github-sync.js`；退出码非 0 = 存在偏差。
 */

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;

/**
 * 夹具日期 = **本地今天**。
 *
 * ⚠️ 不能写死某一天：`config.github.sync_days = 1` 的同步范围是「今天」，
 * 夹具若是昨天的日期，**第二天开始整个测试会成片失败**（真实踩到过：
 * 2026-09-21 写的测试，9-22 跑就 12 项失败）。凡涉及「范围」的夹具，
 * 日期一律由运行时刻推导。
 */
const DAY = (() => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
})();

/* ------------------------------------------------------------------ *
 * 脚手架
 * ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;
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
const section = (t) => process.stdout.write(`\n${t}\n`);

/** 定位 git（与 sync-github.js 相同的候选顺序） */
function resolveGit() {
  const cands = [
    process.env.GIT_EXECUTABLE,
    'git',
    '<USER_HOME>/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe',
    'C:/Program Files/Git/cmd/git.exe',
  ].filter(Boolean);
  for (const c of cands) {
    try {
      execFileSync(c, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      return c;
    } catch (e) {
      /* 下一个 */
    }
  }
  return null;
}

const GIT = resolveGit();

process.stdout.write('test-github-sync.js — GitHub 日志持久化离线行为测试\n');
if (!GIT) {
  process.stdout.write('⚠ 未找到 git 可执行文件，无法验证同步链路。\n');
  process.stdout.write('  这不是通过：请安装 Git 或设置 GIT_EXECUTABLE 后重跑。\n');
  process.exitCode = 1;
  return;
}
process.stdout.write(`git: ${GIT}\n`);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-gh-'));
const HOME = path.join(sandbox, 'home');
const LOGDIR = path.join(sandbox, 'log');
const WORKDIR = path.join(sandbox, 'work');
const BARE = path.join(sandbox, 'remote.git');
const BARE2 = path.join(sandbox, 'remote2.git');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });

const CHILD_ENV = Object.assign({}, process.env, {
  HOME,
  USERPROFILE: HOME,
  GIT_EXECUTABLE: GIT,
  // 禁止 git 读取用户级配置，保证测试可重复（也验证脚本自己提供了提交身份）
  GIT_CONFIG_GLOBAL: path.join(HOME, '.gitconfig-none'),
  GIT_CONFIG_SYSTEM: path.join(HOME, '.gitconfig-none'),
  GIT_TERMINAL_PROMPT: '0',
});

const git = (args, cwd) =>
  String(
    execFileSync(GIT, cwd ? ['-C', cwd].concat(args) : args, {
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      env: CHILD_ENV,
      // execFileSync 默认**继承 stderr**，会把 git 的 fatal 提示直接打到测试输出里。
      // 捕获而非继承，让探测性调用（如空仓库上的 rev-parse）安静失败。
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  ).trim();

/** 裸仓库里的文件清单 */
const bareTree = (bare) => {
  try {
    return git(['--git-dir', bare, 'ls-tree', '-r', '--name-only', 'HEAD'])
      .split('\n')
      .filter(Boolean)
      .sort();
  } catch (e) {
    return [];
  }
};
const bareShow = (bare, file) =>
  git(['--git-dir', bare, 'show', `HEAD:${file}`]);
const bareCommitCount = (bare) => {
  try {
    return Number(git(['--git-dir', bare, 'rev-list', '--count', 'HEAD']));
  } catch (e) {
    return 0;
  }
};

function runSync(args, opts) {
  const o = opts || {};
  const res = spawnSync(
    NODE,
    [path.join(ROOT, 'scripts', 'sync-github.js'), '--dir', o.dir || LOGDIR].concat(args),
    // 上限：本机每个 git 进程启动约 3.5s，单次同步最多约 10 个 git 调用，
    // 因此单次预算给到 150s；一旦卡住会被转成可见失败，而不是无限等待。
    { env: CHILD_ENV, encoding: 'utf8', timeout: 150000 }
  );
  let json = null;
  try {
    json = JSON.parse(String(res.stdout || '').trim());
  } catch (e) {
    json = null;
  }
  return {
    code: res.status,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
    signal: res.signal || null,
    error: res.error ? String(res.error.message) : null,
    json,
  };
}

/** 断言某次 runSync 拿到了结构化结果（否则给出可诊断的信息） */
function expectJson(res) {
  if (res.json) return res.json;
  throw new Error(
    `未拿到 JSON 结果（code=${res.code} signal=${res.signal}${res.error ? ` error=${res.error}` : ''}）。` +
      `stderr=${String(res.stderr).slice(-300)}`
  );
}

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const CONV = {
  conversation_id: 'CON-20260921-AAAAAAAA',
  agent: 'craft',
  model_name: 'test-model',
  models: ['Test-Model'],
  start_time: `${DAY}T09:00:00+08:00`,
  end_time: `${DAY}T09:30:00+08:00`,
  duration_seconds: 1800,
  total_token: 1234,
  input_token: 1000,
  output_token: 234,
  cached_token: 500,
  reasoning_token: 12,
  total_score: 0.35,
  score_source: 'workbuddy_credit',
  score_request_count: 1,
  status: 'completed',
  settlement_status: 'settled',
  settled_at: `${DAY}T09:31:00+08:00`,
  source: 'workbuddy',
  session_id: 'sess-aaa',
  project: null,
  workspace: null,
  title: '合成会话',
  request_count: 1,
  skill_count: 1,
  missing_fields: [],
  raw_ref: null,
  parser_version: '3.1.0',
  created_at: `${DAY}T09:31:00+08:00`,
  updated_at: `${DAY}T09:31:00+08:00`,
};
const SKILL = {
  usage_id: 'SU-20260921-BBBBBBBBBB',
  conversation_id: CONV.conversation_id,
  agent: 'craft',
  skill_id: 'work-time-tracking',
  skill_name: 'work-time-tracking',
  skill_version: '3.1',
  start_time: `${DAY}T09:05:00+08:00`,
  end_time: `${DAY}T09:05:01+08:00`,
  duration_seconds: 1,
  skill_token: 4017,
  token_source: 'injection',
  call_request_id: 'req-1',
  call_request_total_token: 5000,
  load_chars: 14347,
  args: null,
  status: 'completed',
  trigger_type: 'agent',
  source: 'workbuddy',
  skill_invocation_id: 'call_1',
  created_at: `${DAY}T09:31:00+08:00`,
  updated_at: `${DAY}T09:31:00+08:00`,
};
const ACT = {
  activity_id: 'ACT-20260921-CCCCCCCCCC',
  date: DAY,
  project_name: '异构算力平台',
  work_type: '需求分析',
  content: '完成GPU细粒度调度需求分析',
  display_content: '【异构算力平台】【需求分析】完成GPU细粒度调度需求分析',
  start_time: '09:00',
  end_time: '09:30',
  duration_minutes: 30,
  source: 'agent',
  conversation_id: CONV.conversation_id,
  status: 'completed',
  confidence: 'high',
  work_item_id: null,
  created_at: `${DAY}T09:31:00+08:00`,
  updated_at: `${DAY}T09:31:00+08:00`,
};

function writeFixtures() {
  const day = path.join(LOGDIR, 'logs', DAY);
  fs.mkdirSync(day, { recursive: true });
  const put = (name, rows) =>
    fs.writeFileSync(path.join(day, name), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  put('conversations.jsonl', [CONV]);
  put('skill-usage.jsonl', [SKILL]);
  put('work-activities.jsonl', [ACT]);

  // raw 快照：用于验证 sync_raw_logs=false 时不上传
  const rawDir = path.join(LOGDIR, 'raw', 'workbuddy', DAY);
  fs.mkdirSync(rawDir, { recursive: true });
  fs.writeFileSync(path.join(rawDir, 'sess-aaa.json'), JSON.stringify({ session_id: 'sess-aaa' }), 'utf8');

  fs.writeFileSync(
    path.join(LOGDIR, '.log-manifest.json'),
    JSON.stringify({ type: 'work-time-log', version: '1.0', created_at: `${DAY}T00:00:00+08:00`, log_id: 'test-log' }),
    'utf8'
  );
  fs.writeFileSync(
    path.join(LOGDIR, 'config.json'),
    JSON.stringify(
      {
        skill: 'work-time-tracking',
        log_directory: LOGDIR,
        settlement: { skill_token_method: 'injection', token_per_char: 0.28 },
        storage: { raw_log: { enabled: true, retention_days: 7 } },
        github: {
          enabled: true,
          repository: 'worktimeLog',
          visibility: 'private',
          sync_days: 1,
          sync_raw_logs: false,
        },
      },
      null,
      2
    ),
    'utf8'
  );
  fs.writeFileSync(
    path.join(LOGDIR, 'current.json'),
    JSON.stringify({ date: DAY, version: 1, records: [], pending_items: [], sync: { status: 'pending' } }),
    'utf8'
  );
}

/** 日志目录的逐文件指纹（排除工作副本，避免把同步产物算进来） */
function fingerprintLogDir() {
  const out = {};
  const skip = new Set(['.github-sync']);
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (rel === '' && skip.has(e.name)) continue;
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else out[r] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    }
  };
  walk(LOGDIR, '');
  return out;
}

writeFixtures();
git(['init', '--bare', '-b', 'main', BARE]);
git(['init', '--bare', '-b', 'main', BARE2]);

const LOCAL_BEFORE_ALL = fingerprintLogDir();

/* ------------------------------------------------------------------ *
 * 1. 默认关闭
 * ------------------------------------------------------------------ */
section('1. 默认关闭（github.enabled 语义）');

// 先临时把 config 改成 enabled:false，验证「默认不推送」
const cfgPath = path.join(LOGDIR, 'config.json');
const cfgRaw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
cfgRaw.github.enabled = false;
fs.writeFileSync(cfgPath, JSON.stringify(cfgRaw, null, 2), 'utf8');

check('enabled=false 时跳过，且不创建工作副本', () => {
  const r = runSync(['--remote-url', BARE]);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.json.action, 'skipped');
  assert.ok(!fs.existsSync(WORKDIR), '不应创建工作副本');
});
check('enabled=false 时 dry-run 报告同样跳过', () => {
  const r = runSync(['--dry-run', '--remote-url', BARE]);
  assert.strictEqual(r.json.action, 'skipped');
});
check('--force 可临时覆盖 enabled=false', () => {
  // 用独立的工作副本目录：否则这次预演会把文件 stage 进去，
  // 让后面「首次 stage」的用例看到 unchanged 而不是 created
  const throwaway = path.join(sandbox, 'work-force-probe');
  const r = runSync(['--force', '--dry-run', '--work-dir', throwaway, '--remote-url', BARE]);
  assert.notStrictEqual(r.json.action, 'skipped');
});

cfgRaw.github.enabled = true;
fs.writeFileSync(cfgPath, JSON.stringify(cfgRaw, null, 2), 'utf8');

/* ------------------------------------------------------------------ *
 * 2. doctor
 * ------------------------------------------------------------------ */
section('2. --doctor 环境体检');

check('doctor 报告 git / gh / 工作副本 / 本地日期', () => {
  const r = runSync(['--doctor']);
  assert.strictEqual(r.code, 0);
  assert.ok(r.json.environment, '缺少 environment');
  assert.strictEqual(r.json.environment.git, true);
  assert.deepStrictEqual(r.json.environment.local_dates, [DAY]);
  assert.ok(Array.isArray(r.json.environment.structured_files));
});

/* ------------------------------------------------------------------ *
 * 3. dry-run：只 stage，不提交
 * ------------------------------------------------------------------ */
section('3. 默认 dry-run');

let dryRun;
check('dry-run 只报差异，不写工作副本', () => {
  dryRun = runSync(['--dry-run', '--work-dir', WORKDIR, '--remote-url', BARE]);
  expectJson(dryRun);
  assert.strictEqual(dryRun.json.action, 'dry_run');
  assert.ok(
    !fs.existsSync(path.join(WORKDIR, DAY, 'conversations.jsonl')),
    'dry-run 不应把文件写进工作副本（否则会污染紧随其后的 apply 判定）'
  );
  assert.strictEqual(bareCommitCount(BARE), 0, '不应有提交');
});
check('dry-run 报告 created 计数', () => {
  assert.strictEqual(dryRun.json.staged.created, 3, `created=${dryRun.json.staged.created}`);
});
check('dry-run 不产生提交', () => {
  assert.strictEqual(bareTree(BARE).length, 0);
});

/* ------------------------------------------------------------------ *
 * 4. --apply：真正提交并推送
 * ------------------------------------------------------------------ */
section('4. --apply 提交并推送');

let applied;
check('apply 成功提交并推送', () => {
  applied = runSync(['--apply', '--work-dir', WORKDIR, '--remote-url', BARE]);
  assert.strictEqual(applied.code, 0);
  assert.strictEqual(applied.json.action, 'pushed', `实际 ${applied.json.action}：${(applied.json.notes || []).join(' / ')}`);
  assert.strictEqual(applied.json.committed, true);
  assert.strictEqual(applied.json.pushed, true);
});
check('远端出现按日期组织的文件', () => {
  const tree = bareTree(BARE);
  assert.deepStrictEqual(tree, [
    `${DAY}/conversations.jsonl`,
    `${DAY}/skill-usage.jsonl`,
    `${DAY}/work-activities.jsonl`,
  ]);
});
check('远端内容与本地一致（逐字节）', () => {
  const local = fs.readFileSync(path.join(LOGDIR, 'logs', DAY, 'conversations.jsonl'), 'utf8');
  assert.strictEqual(bareShow(BARE, `${DAY}/conversations.jsonl`), local.trimEnd());
});
check('sync_raw_logs=false：raw/ 没有被上传', () => {
  assert.ok(!bareTree(BARE).some((f) => f.startsWith(`${DAY}/raw/`)), 'raw 不应上传');
});

/* ------------------------------------------------------------------ *
 * 5. 幂等：内容一致 → 不产生空提交
 * ------------------------------------------------------------------ */
section('5. 内容一致不重复更新');

check('重复 apply：报告 up_to_date 且不新增提交', () => {
  const before = bareCommitCount(BARE);
  const r = runSync(['--apply', '--work-dir', WORKDIR, '--remote-url', BARE]);
  assert.strictEqual(r.json.action, 'up_to_date', `实际 ${r.json.action}`);
  assert.strictEqual(bareCommitCount(BARE), before, '不应产生新提交');
});
check('重复 apply：unchanged 计数正确', () => {
  const r = runSync(['--apply', '--work-dir', WORKDIR, '--remote-url', BARE]);
  assert.strictEqual(r.json.staged.unchanged, 3);
  assert.strictEqual(r.json.staged.created, 0);
  assert.strictEqual(r.json.staged.updated, 0);
});

/* ------------------------------------------------------------------ *
 * 6. 本地覆盖远端（Local is Source of Truth）
 * ------------------------------------------------------------------ */
section('6. 本地覆盖远端');

check('本地改动后 apply：远端被本地内容覆盖', () => {
  const day = path.join(LOGDIR, 'logs', DAY);
  const convPath = path.join(day, 'conversations.jsonl');
  const updated = Object.assign({}, CONV, { total_token: 9999, updated_at: `${DAY}T10:00:00+08:00` });
  fs.writeFileSync(convPath, `${JSON.stringify(updated)}\n`, 'utf8');

  const r = runSync(['--apply', '--work-dir', WORKDIR, '--remote-url', BARE]);
  assert.strictEqual(r.json.action, 'pushed', `实际 ${r.json.action}`);
  assert.strictEqual(r.json.staged.updated, 1);
  assert.strictEqual(bareShow(BARE, `${DAY}/conversations.jsonl`), JSON.stringify(updated));
});
check('远端被改动也不会反向覆盖本地', () => {
  // 直接往远端 HEAD 写一个「伪造」版本（模拟远端被人改过）
  const wt = path.join(sandbox, 'fake');
  git(['clone', BARE, wt]);
  fs.writeFileSync(path.join(wt, DAY, 'conversations.jsonl'), '{"tampered":true}\n', 'utf8');
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-am', 'tamper'], wt);
  git(['push', 'origin', 'main'], wt);

  const localBefore = fs.readFileSync(
    path.join(LOGDIR, 'logs', DAY, 'conversations.jsonl'),
    'utf8'
  );
  // 本地已与「被篡改的远端」不同 → 同步应把本地覆盖上去，而不是把远端内容拉回本地
  const r = runSync(['--apply', '--work-dir', WORKDIR, '--remote-url', BARE]);
  assert.strictEqual(r.json.action, 'pushed');

  const localAfter = fs.readFileSync(
    path.join(LOGDIR, 'logs', DAY, 'conversations.jsonl'),
    'utf8'
  );
  assert.strictEqual(localAfter, localBefore, '本地日志被反向覆盖了');
  assert.ok(!bareShow(BARE, `${DAY}/conversations.jsonl`).includes('tampered'), '远端未被本地覆盖');
});

/* ------------------------------------------------------------------ *
 * 7. 敏感信息拦截
 * ------------------------------------------------------------------ */
section('7. 敏感信息不得上传');

check('命中敏感信息时拒绝同步（blocked_sensitive）', () => {
  const day = path.join(LOGDIR, 'logs', DAY);
  const actPath = path.join(day, 'work-activities.jsonl');
  const dirty = Object.assign({}, ACT, {
    content: `误贴的密钥 ghp_${'a'.repeat(36)} 需要拦截`,
  });
  fs.writeFileSync(actPath, `${JSON.stringify(dirty)}\n`, 'utf8');

  const before = bareCommitCount(BARE);
  const r = runSync(['--apply', '--work-dir', WORKDIR, '--remote-url', BARE]);
  assert.strictEqual(r.json.action, 'blocked_sensitive', `实际 ${r.json.action}`);
  assert.ok(r.json.sensitive_blocked.length >= 1, '应记录被拦截的文件');
  assert.strictEqual(bareCommitCount(BARE), before, '不应产生提交');
  assert.ok(!bareShow(BARE, `${DAY}/work-activities.jsonl`).includes('ghp_'), '敏感内容被推上去了');
});
check('被拦截后本地日志未被修改', () => {
  const text = fs.readFileSync(path.join(LOGDIR, 'logs', DAY, 'work-activities.jsonl'), 'utf8');
  assert.ok(text.includes('ghp_'), '本地内容不应被同步流程改动');
  // 还原，供后续用例继续
  fs.writeFileSync(
    path.join(LOGDIR, 'logs', DAY, 'work-activities.jsonl'),
    `${JSON.stringify(ACT)}\n`,
    'utf8'
  );
});

/* ------------------------------------------------------------------ *
 * 8. --prune 与 work-dir 保护
 * ------------------------------------------------------------------ */
section('8. prune 与工作副本保护');

check('工作副本非空且非 git 仓库时中止（不误删）', () => {
  const bad = path.join(sandbox, 'bad-work');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'stray.txt'), 'x', 'utf8');
  const r = runSync(['--apply', '--work-dir', bad, '--remote-url', BARE]);
  assert.strictEqual(r.json.action, 'failed');
  assert.ok(fs.existsSync(path.join(bad, 'stray.txt')), '不应删除工作副本里的既有文件');
});
check('不加 --prune 时不删除远端多余日期目录', () => {
  const before = bareTree(BARE);
  runSync(['--apply', '--work-dir', WORKDIR, '--remote-url', BARE]);
  assert.deepStrictEqual(bareTree(BARE), before);
});
check('--include-raw 时才上传 raw', () => {
  const r = runSync(['--apply', '--include-raw', '--work-dir', WORKDIR, '--remote-url', BARE]);
  assert.strictEqual(r.json.action, 'pushed');
  assert.ok(
    bareTree(BARE).some((f) => f.startsWith(`${DAY}/raw/`)),
    '指定 --include-raw 后应上传 raw'
  );
});

/* ------------------------------------------------------------------ *
 * 9. 仓库可见性守卫
 * ------------------------------------------------------------------ */
section('9. 仓库必须 private');

check('visibility=public 被拒绝（即使 config 被改坏）', () => {
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  raw.github.visibility = 'public';
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8');
  // config 归一化会把 public 回落为 private，因此实际仍会正常工作；
  // 这里断言「归一化后不是 public」，即危险值不会穿透到执行层。
  const CS = require(path.join(ROOT, 'scripts', 'lib', 'conversation-store'));
  const C = require(path.join(ROOT, 'scripts', 'lib', 'log-core'));
  const cfg = C.readConfig(LOGDIR);
  assert.strictEqual(cfg.github.visibility, 'private', 'public 未被回落为 private');
  assert.ok(CS); // 保持引用，避免 lint 噪声
  raw.github.visibility = 'private';
  fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf8');
});

/* ------------------------------------------------------------------ *
 * 10. Local 是 Source of Truth
 * ------------------------------------------------------------------ */
section('10. 本地日志未被同步流程改动');

check('除 .github-sync 外，本地日志逐字节不变', () => {
  const after = fingerprintLogDir();
  const before = LOCAL_BEFORE_ALL;
  // 期间我们**故意**改过 conversations/work-activities，先把这些已知改动还原比对
  const expectedChanges = new Set([
    `logs/${DAY}/conversations.jsonl`,
    `logs/${DAY}/work-activities.jsonl`,
  ]);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const unexpected = [];
  for (const k of keys) {
    if (before[k] === after[k]) continue;
    if (expectedChanges.has(k)) continue;
    unexpected.push(k);
  }
  assert.deepStrictEqual(unexpected, [], `以下文件被意外改动：${unexpected.join(', ')}`);
});
check('同步流程没有在 logs/ 下留下额外文件', () => {
  const names = fs.readdirSync(path.join(LOGDIR, 'logs', DAY)).sort();
  assert.deepStrictEqual(names, ['conversations.jsonl', 'skill-usage.jsonl', 'work-activities.jsonl']);
});

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

fs.rmSync(sandbox, { recursive: true, force: true });

process.stdout.write(`\n结果：${passed} 通过，${failed} 失败（共 ${passed + failed} 项）\n`);
if (failed) {
  process.stdout.write('\n失败明细：\n');
  failures.forEach((f) => process.stdout.write(`  ✗ ${f.name}\n      ${f.error}\n`));
  process.exitCode = 1;
}
