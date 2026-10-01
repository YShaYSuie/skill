#!/usr/bin/env node
'use strict';
/**
 * test-conversation-settlement.js — 对话结算 / 结构化日志回归测试。
 *
 * 全部在 `os.tmpdir()` 下构造**假的 WorkBuddy 数据目录**（含合成 JSONL 与合成 SQLite）
 * 和**假的日志目录**，因此：
 *
 * - 不触碰真实 `~/.workbuddy`（真实会话数据）；
 * - 不触碰真实日志目录（`LOG_ROOT`）；
 * - 不联网；
 * - 结果可重复。
 *
 * 覆盖用户 §15（幂等）、§6（禁止摊派 Token）、§16（异常）、§11（manual 无 Conversation）、
 * §17-§19（复盘只读结构化日志）等硬约束。
 *
 * 运行：
 *   node scripts/test-conversation-settlement.js
 * 退出码非 0 = 存在偏差。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SETTLE = path.join(ROOT, 'scripts', 'settle-conversation.js');
const NODE = process.execPath;

/* ------------------------------------------------------------------ *
 * 测试脚手架
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

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

/**
 * 沙箱环境。
 *
 * ⚠️ 必须重定向 HOME / USERPROFILE —— 脚本会通过 `~/.workbuddy/work-time-tracking.json`
 * 这个**全局**定位器解析默认日志目录；若继承真实 HOME，测试可能把生产定位器改坏，
 * 表现为「日志突然不记录了」且极难定位（见 references/data-model.md §12）。
 */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-settle-'));
const HOME = path.join(SANDBOX, 'home');
const WBTMP = path.join(HOME, '.workbuddy');
const LOGDIR = path.join(SANDBOX, 'log');
fs.mkdirSync(WBTMP, { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });

const CHILD_ENV = Object.assign({}, process.env, {
  HOME,
  USERPROFILE: HOME, // Windows 上 Node 读的是 USERPROFILE
  WORKBUDDY_HOME: WBTMP,
});

/** 运行 settle-conversation.js（显式传 --dir，避免依赖定位器） */
function runSettle(args, opts) {
  const o = opts || {};
  const res = spawnSync(NODE, [SETTLE, '--dir', o.dir || LOGDIR].concat(args), {
    env: CHILD_ENV,
    encoding: 'utf8',
    timeout: 60000,
  });
  let json = null;
  try {
    json = JSON.parse(String(res.stdout || '').trim());
  } catch (e) {
    json = null;
  }
  return { code: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || ''), json };
}

/* ------------------------------------------------------------------ *
 * 合成数据
 * ------------------------------------------------------------------ */

const T0 = new Date('2026-09-21T09:00:00+08:00').getTime();
const min = (n) => T0 + n * 60000;

/**
 * 写一个合成会话 JSONL。
 *
 * 关键点（与真实数据同构）：
 * - 同一次 API 请求的 usage 会出现在**多条**记录上 → 必须按 conversationRequestId 去重；
 * - Skill 调用 = function_call[name=Skill] + 同 callId 的 function_call_result；
 * - 返回文本以 "Error" 开头 ⇒ 载入失败。
 */
function writeSessionJsonl(sessionId, opts) {
  const o = opts || {};
  const slug = o.slug || 'c-synthetic-2026-09-21';
  const dir = path.join(WBTMP, 'projects', slug);
  fs.mkdirSync(dir, { recursive: true });
  const rows = [];

  rows.push({
    type: 'ai-title',
    aiTitle: o.title || '合成会话',
    timestamp: min(0),
    providerData: {},
  });

  // 请求 1：2 次请求级 usage 记录共用同一个 requestId（必须去重成 1 条）
  for (const inTok of [1000, 1500]) {
    rows.push({
      type: 'function_call',
      name: 'Read',
      callId: `call_dup_${inTok}`,
      timestamp: min(1),
      providerData: {
        conversationRequestId: 'req_1',
        requestModelName: 'Test-Model-A',
        agent: 'cli',
        usage: {
          requests: 1,
          inputTokens: inTok,
          outputTokens: 100,
          totalTokens: inTok + 100,
          inputTokensDetails: [{ cached_tokens: 500 }],
          outputTokensDetails: [{ reasoning_tokens: 20 }],
        },
      },
    });
  }

  // Skill A：成功载入，返回 1000 字符
  rows.push({
    type: 'function_call',
    name: 'Skill',
    callId: 'call_skill_a',
    arguments: JSON.stringify({ skill: 'alpha-skill' }),
    timestamp: min(2),
    providerData: { conversationRequestId: 'req_1' },
  });
  rows.push({
    type: 'function_call_result',
    callId: 'call_skill_a',
    name: 'Skill',
    status: 'completed',
    timestamp: min(3),
    output: { type: 'text', text: 'A'.repeat(1000) },
    providerData: {},
  });

  // 请求 2
  rows.push({
    type: 'function_call',
    name: 'Read',
    callId: 'call_r2',
    timestamp: min(4),
    providerData: {
      conversationRequestId: 'req_2',
      requestModelName: 'Test-Model-A',
      usage: {
        requests: 1,
        inputTokens: 4000,
        outputTokens: 200,
        totalTokens: 4200,
        inputTokensDetails: [{ cached_tokens: 100 }],
        outputTokensDetails: [{ reasoning_tokens: 50 }],
      },
    },
  });

  // Skill B：同一 Skill 的**第二次**调用（should produce a second Skill Usage row）
  rows.push({
    type: 'function_call',
    name: 'Skill',
    callId: 'call_skill_b',
    arguments: JSON.stringify({ skill: 'alpha-skill' }),
    timestamp: min(5),
    providerData: { conversationRequestId: 'req_2' },
  });
  rows.push({
    type: 'function_call_result',
    callId: 'call_skill_b',
    name: 'Skill',
    status: 'completed',
    timestamp: min(6),
    output: { type: 'text', text: 'B'.repeat(500) },
    providerData: {},
  });

  // Skill C：载入失败
  rows.push({
    type: 'function_call',
    name: 'Skill',
    callId: 'call_skill_c',
    arguments: JSON.stringify({ skill: 'ghost-skill' }),
    timestamp: min(7),
    providerData: { conversationRequestId: 'req_2' },
  });
  rows.push({
    type: 'function_call_result',
    callId: 'call_skill_c',
    name: 'Skill',
    status: 'completed',
    timestamp: min(8),
    output: { type: 'text', text: 'Error: Can not find skill: "ghost-skill".' },
    providerData: {},
  });

  if (o.userPrompts !== false) {
    rows.push({
      type: 'message',
      role: 'user',
      timestamp: min(1),
      content: [
        { type: 'input_text', text: '<user_query>完善GPU细粒度调度需求</user_query>' },
        { type: 'input_text', text: '<system-reminder>注入的上下文</system-reminder>' },
      ],
      providerData: {},
    });
    // 噪声：应被分类器过滤
    rows.push({
      type: 'message',
      role: 'user',
      timestamp: min(2),
      content: [{ type: 'input_text', text: '总结今日工作' }],
      providerData: {},
    });
  }

  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}

/** 建一个最小可用的合成 workbuddy.db */
function writeSyntheticDb(rows) {
  const { DatabaseSync } = require('node:sqlite');
  const dbFile = path.join(WBTMP, 'workbuddy.db');
  if (fs.existsSync(dbFile)) fs.rmSync(dbFile);
  const db = new DatabaseSync(dbFile);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, cwd TEXT NOT NULL, user_id TEXT NOT NULL,
      title TEXT, custom_title TEXT, status TEXT NOT NULL DEFAULT 'Pending',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      last_activity_at INTEGER, deleted_at INTEGER,
      is_playground INTEGER NOT NULL DEFAULT 0, source_mode TEXT,
      is_background_automation INTEGER, mode TEXT, model TEXT,
      expert_id TEXT, expert_locale TEXT, expert_runtime_identity TEXT,
      expert_marketplace TEXT, permission_mode TEXT, use_sandbox_cli INTEGER,
      project_id TEXT
    );
    CREATE TABLE session_usage (
      session_id TEXT PRIMARY KEY, used INTEGER NOT NULL, size INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, credit_json TEXT
    );
  `);
  const insSession = db.prepare(
    'INSERT INTO sessions (id, cwd, user_id, title, status, created_at, updated_at, last_activity_at, mode, model) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insUsage = db.prepare(
    'INSERT INTO session_usage (session_id, used, size, updated_at, credit_json) VALUES (?, ?, ?, ?, ?)'
  );
  for (const r of rows) {
    if (r.session) {
      insSession.run(
        r.session.id,
        r.session.cwd || 'D:/synthetic/ws',
        'u1',
        r.session.title || '合成会话',
        'completed',
        r.session.created_at,
        r.session.updated_at,
        r.session.updated_at,
        r.session.mode || 'craft',
        r.session.model || 'test-model-a'
      );
    }
    if (r.usage) {
      insUsage.run(r.usage.session_id, r.usage.used, r.usage.size, r.usage.updated_at, r.usage.credit_json);
    }
  }
  db.close();
  return dbFile;
}

/* ------------------------------------------------------------------ *
 * 读取日志
 * ------------------------------------------------------------------ */

const CS = require(path.join(ROOT, 'scripts', 'lib', 'conversation-store'));
const ME = require(path.join(ROOT, 'scripts', 'lib', 'metrics-engine'));
const SEC = require(path.join(ROOT, 'scripts', 'lib', 'security'));

const readConv = (date) => CS.read(LOGDIR, 'conversation', date || '2026-09-21');
const readSkill = (date) => CS.read(LOGDIR, 'skill_usage', date || '2026-09-21');
const readAct = (date) => CS.read(LOGDIR, 'work_activity', date || '2026-09-21');
const readCS = (kind, date) => CS.read(LOGDIR, kind, date || '2026-09-21');

const SESSION_FULL = '11111111-1111-4111-8111-111111111111';
const SESSION_NO_DB = '22222222-2222-4222-8222-222222222222';

/* ------------------------------------------------------------------ *
 * 开始
 * ------------------------------------------------------------------ */

process.stdout.write('test-conversation-settlement.js — 对话结算回归测试\n');
process.stdout.write(`沙箱：${SANDBOX}\n`);

writeSessionJsonl(SESSION_FULL, { title: '合成会话（完整）' });
writeSessionJsonl(SESSION_NO_DB, { title: '合成会话（无数据库行）', slug: 'c-synthetic-2026-09-21-b' });
writeSyntheticDb([
  {
    session: { id: SESSION_FULL, created_at: min(0), updated_at: min(30), title: '合成会话（完整）' },
    // credit 只覆盖 req_1（req_2 没有）→ total_score 必须是下界
    usage: { session_id: SESSION_FULL, used: 9999, size: 1000000, updated_at: min(30), credit_json: JSON.stringify({ req_1: 3.5 }) },
  },
  // SESSION_NO_DB 故意不建 session 行与 usage 行 → 走 partial 分支
]);

/* ---------------- 1. 基本结算 ---------------- */
section('1. 对话结算（Conversation Log）');

let first = runSettle(['--session', SESSION_FULL]);
check('首次结算退出码为 0', () => assert.strictEqual(first.code, 0));
check('报告 action=settled', () => assert.strictEqual(first.json.reports[0].action, 'settled'));

check('写入 1 条 Conversation Log', () => {
  const rows = readConv();
  assert.strictEqual(rows.length, 1);
});
check('记录 Agent / Model', () => {
  const r = readConv()[0];
  assert.ok(r.agent && r.agent !== CS.UNAVAILABLE, `agent=${r.agent}`);
  assert.strictEqual(r.model_name, 'test-model-a');
});
check('记录 Total Token（按 requestId 去重求和）', () => {
  const r = readConv()[0];
  // req_1 有两条记录（1000/1500 input），去重后取**第一条**：1000+100=1100
  // req_2：4200  → 合计 5300
  assert.strictEqual(r.total_token, 1100 + 4200, `total=${r.total_token}`);
  assert.strictEqual(r.request_count, 2, `request_count=${r.request_count}`);
  assert.strictEqual(r.skill_count, 3);
  assert.strictEqual(r.skill_invocation_count, 3);
  assert.strictEqual(r.distinct_skill_count, 2);
});
check('记录 WorkBuddy Score，并标注为下界', () => {
  const r = readConv()[0];
  assert.strictEqual(r.total_score, 3.5);
  assert.strictEqual(r.score_request_count, 1);
  assert.ok(r.score_request_count < r.request_count, '应识别出积分为下界');
});
check('记录起止时间', () => {
  const r = readConv()[0];
  assert.ok(r.start_time && r.end_time, `${r.start_time} → ${r.end_time}`);
  assert.ok(r.duration_seconds === null || r.duration_seconds > 0);
});
check('conversation_id 由 session_id 确定性派生', () => {
  const r = readConv()[0];
  assert.strictEqual(r.conversation_id, CS.makeConversationId('2026-09-21', SESSION_FULL));
  assert.ok(/^CON-20260921-[0-9A-F]{8}$/.test(r.conversation_id), r.conversation_id);
});
check('status = settled（关键字段齐全）', () => assert.strictEqual(readConv()[0].settlement_status, 'settled'));

/* ---------------- 2. Skill Usage ---------------- */
section('2. Skill Usage Log');

check('一个对话产生 3 条 Skill Usage（含同 Skill 两次调用）', () => {
  const rows = readSkill();
  assert.strictEqual(rows.length, 3, `实际 ${rows.length} 条`);
});
check('每条都关联 conversation_id', () => {
  for (const s of readSkill()) {
    assert.strictEqual(s.conversation_id, readConv()[0].conversation_id);
  }
});
check('usage_id 唯一', () => {
  const ids = readSkill().map((s) => s.usage_id);
  assert.strictEqual(new Set(ids).size, ids.length, ids.join(','));
});
check('记录 skill_invocation_id（宿主提供时优先使用）', () => {
  const ids = readSkill().map((s) => s.skill_invocation_id).filter(Boolean).sort();
  assert.deepStrictEqual(ids, ['call_skill_a', 'call_skill_b', 'call_skill_c']);
});

/* ---------------- 3. Token 口径（§6 禁止摊派） ---------------- */
section('3. Token 口径：禁止摊派估算');

check('成功载入的 Skill 记 injection 口径的真实值', () => {
  const a = readSkill().find((s) => s.skill_invocation_id === 'call_skill_a');
  assert.strictEqual(a.token_source, 'injection');
  assert.strictEqual(a.skill_token, Math.round(1000 * 0.28));
  assert.strictEqual(a.load_chars, 1000);
});
check('载入失败的 Skill → skill_token = unavailable（不估算）', () => {
  const c = readSkill().find((s) => s.skill_invocation_id === 'call_skill_c');
  assert.strictEqual(c.status, 'failed');
  assert.strictEqual(c.skill_token, null);
  assert.strictEqual(c.token_source, 'unavailable');
});
check('skill_token 不等于「总额 ÷ Skill 数」', () => {
  const total = readConv()[0].total_token;
  const n = readSkill().length;
  const prorated = Math.round(total / n);
  for (const s of readSkill()) {
    assert.notStrictEqual(s.skill_token, prorated, `发现摊派值 ${prorated}`);
  }
});
check('未把 B 口径（所在请求用量）写进 skill_token', () => {
  for (const s of readSkill()) {
    if (typeof s.call_request_total_token === 'number' && typeof s.skill_token === 'number') {
      assert.notStrictEqual(s.skill_token, s.call_request_total_token);
    }
  }
});
check('B 口径字段独立存在，且标明非独占', () => {
  const a = readSkill().find((s) => s.skill_invocation_id === 'call_skill_a');
  assert.strictEqual(a.call_request_total_token, 1100); // req_1 去重后
});
check('skill_token_method=off 时全部 unavailable', () => {
  const cfgFile = path.join(LOGDIR, 'config.json');
  const prev = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : null;
  fs.writeFileSync(
    cfgFile,
    JSON.stringify({ skill_token_method_placeholder: 1, settlement: { skill_token_method: 'off' } }),
    'utf8'
  );
  const dir2 = path.join(SANDBOX, 'log-off');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(
    path.join(dir2, 'config.json'),
    JSON.stringify({ settlement: { skill_token_method: 'off' } }),
    'utf8'
  );
  const res = runSettle(['--session', SESSION_FULL], { dir: dir2 });
  assert.strictEqual(res.code, 0);
  const rows = CS.read(dir2, 'skill_usage', '2026-09-21');
  assert.ok(rows.length > 0);
  for (const s of rows) assert.strictEqual(s.skill_token, CS.UNAVAILABLE, s.skill_id);
  if (prev === null) fs.rmSync(cfgFile, { force: true });
  else fs.writeFileSync(cfgFile, prev, 'utf8');
});

/* ---------------- 4. 幂等（§15） ---------------- */
section('4. 幂等与防重复');

check('重复结算：created 全为 0（不新增记录）', () => {
  const second = runSettle(['--session', SESSION_FULL]);
  assert.strictEqual(second.code, 0);
  const r = second.json.reports[0];
  assert.strictEqual(r.action, 'already_settled', `action=${r.action}`);
  assert.strictEqual(r.written.conversation.created, 0);
  assert.strictEqual(r.written.skill_usage.created, 0);
});
check('重复结算：Token 与 Score 未被重复累加', () => {
  const before = readConv()[0];
  runSettle(['--session', SESSION_FULL]);
  const after = readConv()[0];
  assert.strictEqual(after.total_token, before.total_token);
  assert.strictEqual(after.total_score, before.total_score);
  assert.strictEqual(after.input_token, before.input_token);
});
check('重复结算：日志条数不变', () => {
  assert.strictEqual(readConv().length, 1);
  assert.strictEqual(readSkill().length, 3);
});
check('重复结算：unchanged 被正确识别（未被误报为 updated）', () => {
  const r = runSettle(['--session', SESSION_FULL]).json.reports[0];
  assert.strictEqual(r.written.conversation.unchanged, 1);
  assert.strictEqual(r.written.skill_usage.unchanged, 3);
  assert.strictEqual(r.written.conversation.updated, 0);
});
check('第三次结算仍然幂等', () => {
  const r = runSettle(['--session', SESSION_FULL]).json.reports[0];
  assert.strictEqual(r.action, 'already_settled');
});

/* ---------------- 5. 异常处理（§16） ---------------- */
section('5. 异常处理');

check('缺少会话行与积分 → 记 not_applicable + 积分 0，且记录保留', () => {
  // 用户 2026-09-21 口径：一次 credit 都没上报 = 该会话走**模型 API**，
  // 不经积分通道，**积分本就为 0** —— 不是「不可获取」，也不算数据缺失。
  const res = runSettle(['--session', SESSION_NO_DB]);
  assert.strictEqual(res.code, 0);
  const rows = readConv();
  const r = rows.find((x) => x.session_id === SESSION_NO_DB);
  assert.ok(r, '记录必须保留，不得整条丢弃');
  assert.strictEqual(r.score_source, 'not_applicable');
  assert.strictEqual(r.total_score, 0, '不消耗积分 → 记 0，而不是 null');
  assert.strictEqual(r.score_request_count, 0);
  assert.ok(
    !r.missing_fields.includes('total_score'),
    '「不适用」不是缺失，不应进 missing_fields：' + JSON.stringify(r.missing_fields)
  );
  // 注：该夹具还缺会话行（model_name 等），因此整体仍是 partial ——
  // 这里只断言「积分」这一项不再构成缺失。
});
check('not_applicable 记录的 Token 仍然可用', () => {
  const r = readConv().find((x) => x.session_id === SESSION_NO_DB);
  assert.strictEqual(typeof r.total_token, 'number');
  assert.strictEqual(r.total_score, 0);
});
check('未知会话：报告 not_found，且不写入任何记录', () => {
  const before = readConv().length;
  const res = runSettle(['--session', 'ffffffff-ffff-4fff-8fff-ffffffffffff']);
  assert.strictEqual(res.json.reports[0].action, 'not_found');
  assert.strictEqual(res.code, 7, `退出码应表示会话不存在，实际 ${res.code}`);
  assert.strictEqual(readConv().length, before);
});
check('--exit-zero 让 Hook 场景永远退出码 0', () => {
  const res = runSettle(['--session', 'ffffffff-ffff-4fff-8fff-ffffffffffff', '--quiet', '--exit-zero']);
  assert.strictEqual(res.code, 0);
});
check('单会话失败不影响后续会话', () => {
  const res = runSettle(['--latest', '--limit', '5', '--quiet', '--exit-zero']);
  assert.strictEqual(res.code, 0);
});
check('异常记录不覆盖已有的有效值（哨兵不盖有效值）', () => {
  const r = readConv().find((x) => x.session_id === SESSION_FULL);
  assert.strictEqual(r.total_score, 3.5, '有效积分被 null 覆盖了');
});

/* ---------------- 6. Work Activity（§9/§11） ---------------- */
section('6. Work Activity');

check('manual 来源允许 conversation_id = null', () => {
  const stats = CS.upsertWorkActivity(
    LOGDIR,
    {
      date: '2026-09-21',
      project_name: '异构算力平台',
      work_type: '需求分析',
      content: '人工补录：评审会议结论整理',
      start_time: '14:00',
      end_time: '15:00',
      source: 'manual',
      conversation_id: null,
      status: 'completed',
      confidence: 'high',
    },
    { date: '2026-09-21' }
  );
  assert.strictEqual(stats.created, 1);
  const row = readAct().find((a) => a.source === 'manual');
  assert.ok(row);
  assert.strictEqual(row.conversation_id, null);
  assert.strictEqual(row.display_content, '【异构算力平台】【需求分析】人工补录：评审会议结论整理');
});
check('manual 事项重复写入不新增', () => {
  const stats = CS.upsertWorkActivity(
    LOGDIR,
    {
      date: '2026-09-21',
      project_name: '异构算力平台',
      work_type: '需求分析',
      content: '人工补录：评审会议结论整理',
      start_time: '14:00',
      end_time: '15:00',
      source: 'manual',
      conversation_id: null,
      status: 'completed',
      confidence: 'high',
    },
    { date: '2026-09-21' }
  );
  assert.strictEqual(stats.created, 0);
  assert.strictEqual(stats.unchanged, 1);
});
check('--activities prompts：噪声被过滤，关联本次对话', () => {
  const res = runSettle(['--session', SESSION_FULL, '--activities', 'prompts', '--quiet=false']);
  assert.strictEqual(res.code, 0);
  const rows = readAct().filter((a) => a.conversation_id === readConv()[0].conversation_id);
  assert.strictEqual(rows.length, 1, `应只保留 1 条，实际 ${rows.length}`);
  assert.ok(rows[0].content.includes('GPU'), rows[0].content);
  assert.ok(!rows[0].content.includes('总结今日'), '噪声「总结今日」未被过滤');
  assert.strictEqual(rows[0].source, 'agent');
  assert.strictEqual(rows[0].confidence, 'low');
  assert.strictEqual(rows[0].status, 'needs_confirmation');
});
check('--activities prompts：不编造项目与工作类型', () => {
  const rows = readAct().filter((a) => a.conversation_id === readConv()[0].conversation_id);
  for (const a of rows) {
    assert.strictEqual(a.project_name, null);
    assert.strictEqual(a.work_type, null);
  }
});

/* ---------------- 6.1 Work Segment / AI Usage（V3.5） ---------------- */
section('6.1 Work Segment / AI Usage');

const SEGMENT_FILE = path.join(SANDBOX, 'segments.json');
const ACTIVITY_FILE = path.join(SANDBOX, 'activities-with-segment.json');
const USAGE_FILE = path.join(SANDBOX, 'ai-usage.json');
fs.writeFileSync(
  SEGMENT_FILE,
  JSON.stringify([
    {
      topic: 'GPU 细粒度调度设计',
      summary: '设计 MIG、显存隔离与节点资源调度规则。',
      start_time: '2026-09-21T09:05:00+08:00',
      end_time: '2026-09-21T09:20:00+08:00',
    },
  ])
);
fs.writeFileSync(
  ACTIVITY_FILE,
  JSON.stringify([
    {
      project_name: '异构算力平台',
      work_type: '方案设计',
      content: '完成GPU细粒度调度方案设计',
      detail: '明确 MIG、显存隔离、GPU 复用率和节点资源调度规则。',
      ai_role: 'AI协作',
      segment_index: 0,
      start_time: '09:05',
      end_time: '09:20',
    },
  ])
);
fs.writeFileSync(
  USAGE_FILE,
  JSON.stringify([
    {
      activity_index: 0,
      segment_index: 0,
      input_token: 600,
      output_token: 400,
      credit: 1.2,
      skill: ['alpha-skill'],
      model: 'gpt-test',
      attribution_status: 'exact',
    },
  ])
);

const segmentSettlement = runSettle([
  '--session',
  SESSION_FULL,
  '--segments-file',
  SEGMENT_FILE,
  '--activities-file',
  ACTIVITY_FILE,
  '--ai-usage-file',
  USAGE_FILE,
]);
check('结算同时写入 Segment / Activity / AI Usage', () => {
  assert.strictEqual(segmentSettlement.code, 0);
  const r = segmentSettlement.json.reports[0];
  assert.strictEqual(r.action, 'settled');
  assert.strictEqual(r.written.work_segment.created, 1);
  assert.strictEqual(r.written.work_activity.created, 1);
  assert.strictEqual(r.written.ai_usage.created, 1);
});
check('Work Activity 关联 Segment 与 AI Role', () => {
  const row = readCS('work_activity').find((a) => a.content.includes('GPU细粒度调度方案'));
  assert.ok(row, '未找到新 Activity');
  assert.ok(row.segment_id, 'segment_id 应写入');
  assert.strictEqual(row.ai_role, 'AI协作');
  assert.ok(row.detail.includes('MIG'), 'detail 应保留结构化说明');
});
check('AI Usage 精确归属，剩余成本保持未归属', () => {
  const usage = readCS('ai_usage')[0];
  assert.strictEqual(usage.total_token, 1000);
  assert.strictEqual(usage.credit, 1.2);
  assert.strictEqual(usage.attribution_status, 'exact');
  const m = ME.buildMetrics(LOGDIR, '2026-09-21');
  assert.strictEqual(m.cost.usage_attribution.allocated_token, 1000);
  assert.strictEqual(
    m.cost.usage_attribution.unallocated_token,
    m.agent.total_token - 1000,
    '未归属应为会话总账减已精确归属'
  );
  assert.strictEqual(m.cost.usage_attribution.by_status.exact, 1);
});
check('AI Usage 可按项目精确聚合', () => {
  const m = ME.buildMetrics(LOGDIR, '2026-09-21');
  const row = m.cost.allocated_by_project.find((x) => x.key === '异构算力平台');
  assert.ok(row, '缺少项目精确归属');
  assert.strictEqual(row.total_token, 1000);
  assert.strictEqual(row.total_credit, 1.2);
});
check('unallocated 不得携带 activity_id/segment_id', () => {
  const invalid = path.join(SANDBOX, 'ai-usage-invalid.json');
  fs.writeFileSync(
    invalid,
    JSON.stringify([
      {
        activity_index: 0,
        attribution_status: 'unallocated',
        total_token: 10,
      },
    ])
  );
  const before = readCS('ai_usage').length;
  const res = runSettle([
    '--session',
    SESSION_FULL,
    '--activities-file',
    ACTIVITY_FILE,
    '--ai-usage-file',
    invalid,
  ]);
  assert.strictEqual(res.json.reports[0].action, 'failed');
  assert.strictEqual(readCS('ai_usage').length, before);
});
check('重复写入 Segment / AI Usage 保持幂等', () => {
  const before = {
    segment: readCS('work_segment').length,
    usage: readCS('ai_usage').length,
  };
  const res = runSettle([
    '--session',
    SESSION_FULL,
    '--segments-file',
    SEGMENT_FILE,
    '--activities-file',
    ACTIVITY_FILE,
    '--ai-usage-file',
    USAGE_FILE,
  ]);
  assert.strictEqual(res.json.reports[0].action, 'already_settled');
  assert.strictEqual(readCS('work_segment').length, before.segment);
  assert.strictEqual(readCS('ai_usage').length, before.usage);
});
check('200 字只限制展示日志，不截断 detail', () => {
  const raw = 'GPU调度设计'.repeat(50);
  const sec = { ai_summarize: false, max_activity_length: 200, max_detail_length: 4000 };
  const short = SEC.filterContent(raw, { security: sec });
  assert.strictEqual(short.content.length, 200);
  const detail = SEC.filterDetail(raw, { security: sec });
  assert.ok(detail.detail.length > 200, 'detail 应保留超过 200 字的结构化说明');
  const activity = CS.normalizeWorkActivity({
    project_name: '异构算力平台',
    work_type: '方案设计',
    content: 'X'.repeat(200),
    detail: detail.detail,
  });
  assert.strictEqual(activity.log_length, 200);
});

/* ---------------- 7. 每日复盘只读结构化日志（§17-§19） ---------------- */
section('7. 每日复盘：只读结构化日志');

check('metrics-engine 不依赖解析器（物理上无法重扫历史对话）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'lib', 'metrics-engine.js'), 'utf8');
  // 只看真实的 require：注释里提到 settle-conversation.js 是**说明性文字**，不是依赖
  const requires = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  assert.ok(
    !requires.some((r) => /conversation-parser|settle-conversation/.test(r)),
    `metrics-engine 不得依赖解析器，实际 require：${requires.join(', ')}`
  );
  // 反向确认它确实只从结构化日志读数据
  assert.ok(requires.some((r) => /conversation-store/.test(r)), '应通过 conversation-store 读结构化日志');
  assert.ok(/structured_logs_only/.test(src), '应声明数据来源为 structured_logs_only');
});
check('汇总值与日志一致（Token / Score）', () => {
  const m = ME.buildMetrics(LOGDIR, '2026-09-21');
  const rows = readConv();
  const expected = rows.reduce((a, r) => a + (typeof r.total_token === 'number' ? r.total_token : 0), 0);
  assert.strictEqual(m.agent.total_token, expected);
  assert.strictEqual(m.agent.conversation_count, rows.length);
});
check('汇总标注积分为下界', () => {
  const m = ME.buildMetrics(LOGDIR, '2026-09-21');
  assert.strictEqual(m.agent.score_is_lower_bound, true);
});
check('Skill 汇总：失败调用计入 failed，且不计入 load_token_total', () => {
  const m = ME.buildMetrics(LOGDIR, '2026-09-21');
  assert.strictEqual(m.skill.failed, 1);
  const ghost = m.skill.by_skill.find((s) => s.skill_id === 'ghost-skill');
  assert.strictEqual(ghost.skill_token, null);
  assert.ok(m.skill.load_token_total > 0);
});
check('Skill 分布包含未记录 Skill 的 Conversation', () => {
  const m = ME.buildMetrics(LOGDIR, '2026-09-21');
  assert.strictEqual(
    m.skill.conversation_count_with_skill + m.skill.conversation_count_without_skill,
    m.agent.conversation_count
  );
});
check('Conversation 项目分布按会话直接汇总且不丢会话', () => {
  const m = ME.buildMetrics(LOGDIR, '2026-09-21');
  assert.ok(Array.isArray(m.cost.conversation_projects));
  const conversations = m.cost.conversation_projects.reduce(
    (a, r) => a + r.conversations,
    0
  );
  assert.strictEqual(conversations, m.agent.conversation_count);
  const apiOnly = m.cost.conversation_projects.find(
    (r) => r.score_not_applicable > 0 && r.score_known === 0
  );
  if (apiOnly) assert.strictEqual(apiOnly.score_status, 'not_applicable');
});
check('API not_applicable 不进入积分下界分母', () => {
  const m = ME.buildMetrics(LOGDIR, '2026-09-21');
  assert.ok(m.agent.score_not_applicable_conversations >= 1);
  assert.ok(m.agent.score_applicable_requests < m.agent.request_count);
});
check('metrics 文本包含未记录 Skill 与 Conversation 项目分布', () => {
  const text = ME.renderMetrics(ME.buildMetrics(LOGDIR, '2026-09-21')).join('\n');
  assert.match(text, /（未记录 Skill）/);
  assert.match(text, /AI 使用 · Conversation 项目分布/);
});
check('汇总不把 manual 事项算进对话', () => {
  const m = ME.buildMetrics(LOGDIR, '2026-09-21');
  assert.strictEqual(m.activity.manual_count, 1);
  assert.strictEqual(m.activity.without_conversation, 1);
});
check('关联链只在有 conversation_id 时生成', () => {
  const m = ME.buildMetrics(LOGDIR, '2026-09-21');
  for (const g of m.linkage.groups) {
    for (const a of g.activities) {
      assert.ok(a.activity_id, '关联项必须来自真实记录');
    }
  }
  // manual 事项没有 conversation_id → 不得出现在关联链里
  const linked = m.linkage.groups.flatMap((g) => g.activities.map((a) => a.display_content));
  assert.ok(!linked.some((t) => t && t.includes('人工补录')), 'manual 事项不应进入关联链');
});

/* ---------------- 8. 存储层单元约束 ---------------- */
section('8. 存储层约束');

check('V3.1 目录布局：写入 logs/<date>/<kind>.jsonl', () => {
  const day = path.join(LOGDIR, 'logs', '2026-09-21');
  assert.ok(fs.existsSync(day), `缺少目录 ${day}`);
  for (const name of ['conversations.jsonl', 'skill-usage.jsonl', 'work-activities.jsonl']) {
    assert.ok(fs.existsSync(path.join(day, name)), `缺少 logs/2026-09-21/${name}`);
  }
  // 不应再产生 V3.0 旧布局
  assert.ok(!fs.existsSync(path.join(LOGDIR, 'structured')), '不应再创建 structured/ 旧布局');
});

check('V3.1 字段：settlement_status 与 status 分离', () => {
  const r = readConv().find((x) => x.session_id === SESSION_FULL);
  assert.strictEqual(r.settlement_status, 'settled');
  assert.strictEqual(r.status, 'completed', `宿主状态应映射为 completed，实际 ${r.status}`);
  assert.ok(r.settled_at, '应记录 settled_at');
});

check('V3.1 字段：Score 为 total_score + score_source', () => {
  const r = readConv().find((x) => x.session_id === SESSION_FULL);
  assert.strictEqual(r.total_score, 3.5);
  assert.strictEqual(r.score_source, 'workbuddy_credit');
});

check('V3.1 字段：Skill Usage 带 agent 与 trigger_type', () => {
  for (const s of readSkill()) {
    assert.ok(s.agent, `agent 缺失：${s.usage_id}`);
    assert.ok(['agent', 'user', 'hook', 'automation', 'unknown'].includes(s.trigger_type), s.trigger_type);
  }
});

check('V3.1 字段：Work Activity 带 project_name 与 duration_minutes', () => {
  const manual = readAct().find((a) => a.source === 'manual');
  assert.strictEqual(manual.project_name, '异构算力平台');
  assert.strictEqual(manual.duration_minutes, 60);
  assert.strictEqual(manual.display_content, '【异构算力平台】【需求分析】人工补录：评审会议结论整理');
});

check('取不到的值写 null，而不是字符串哨兵', () => {
  // 注意区分两件事：
  //   · 不适用（走模型 API）→ 0 + score_source='not_applicable'
  //   · 该报没报            → null + score_source='unavailable'
  // 这里验证的是后者：Skill Token 拿不到时写 null，不得写 'unavailable' 字符串。
  const skill = readSkill().find((s) => s.skill_token === null);
  assert.ok(skill, '应存在拿不到 Skill Token 的调用');
  assert.strictEqual(skill.skill_token, null);
  // ⚠️ score_source / token_source 是**标签**，其合法值里就含 'unavailable'，
  //    因此它们**不参与**「不得写字符串哨兵」的扫描。
  assert.strictEqual(skill.token_source, 'unavailable');
  const ghost = readSkill().find((s) => s.skill_id === 'ghost-skill');
  if (ghost) {
    assert.strictEqual(ghost.skill_token, null);
    assert.strictEqual(ghost.token_source, 'unavailable');
  }
  const LABEL_FIELDS = new Set(['score_source', 'token_source']);
  for (const t of [readConv(), readSkill(), readAct()]) {
    for (const rec of t) {
      for (const [k, v] of Object.entries(rec)) {
        if (LABEL_FIELDS.has(k)) continue;
        assert.ok(
          !(typeof v === 'string' && v.toLowerCase() === 'unavailable'),
          `字段 ${k} 仍写入了字符串哨兵：${v}`
        );
      }
    }
  }
});

check('标签字段必须是受控枚举（不得自由文本）', () => {
  for (const s of readSkill()) {
    assert.ok(CS.VALID_TOKEN_SOURCE.includes(s.token_source), s.token_source);
  }
  for (const c of readConv()) {
    assert.ok(
      ['workbuddy_credit', 'not_applicable', 'unavailable'].includes(c.score_source),
      c.score_source
    );
  }
});

check('HH:MM 时刻也能算出 duration_minutes（Work Activity 的时间就是纯时刻）', () => {
  assert.strictEqual(CS.hhmmDurationMinutes('14:00', '15:00'), 60);
  assert.strictEqual(CS.hhmmDurationMinutes('23:30', '00:20'), 50, '跨午夜应按 +24h 处理');
  assert.strictEqual(CS.hhmmDurationMinutes('09:00', null), null, '缺端点应为 null');
  assert.strictEqual(CS.hhmmDurationMinutes('bad', '10:00'), null);
});

check('normalize 是纯函数（同输入两次结果一致）', () => {
  const rec = {
    conversation_id: 'CON-TEST-1',
    agent: 'craft',
    model_name: 'm',
    start_time: '2026-09-21T09:00:00+08:00',
    end_time: '2026-09-21T10:00:00+08:00',
    status: 'settled',
    total_token: 100,
    total_score: 1.5,
    source: 'workbuddy',
    session_id: 's',
  };
  const a = CS.normalizeConversation(rec);
  const b = CS.normalizeConversation(rec);
  a.created_at = b.created_at = a.updated_at = b.updated_at = 'X';
  assert.deepStrictEqual(a, b);
});
check('哨兵不覆盖有效值', () => {
  const prev = { conversation_id: 'C', total_token: 999, total_score: 5, created_at: 't0', updated_at: 't0' };
  const merged = CS.mergeRecord('conversation', prev, {
    conversation_id: 'C',
    total_token: null,
    total_score: null,
    created_at: 't0',
    updated_at: 't1',
  });
  assert.strictEqual(merged.total_token, 999);
  assert.strictEqual(merged.total_score, 5);
  assert.strictEqual(merged.updated_at, 't0', '无实质变化时不应刷新 updated_at');
});
check('有效值覆盖哨兵', () => {
  const prev = { conversation_id: 'C', total_token: null, created_at: 't0', updated_at: 't0' };
  const merged = CS.mergeRecord('conversation', prev, {
    conversation_id: 'C',
    total_token: 42,
    created_at: 't0',
    updated_at: 't1',
  });
  assert.strictEqual(merged.total_token, 42);
});
check('跨日期记录按各自日期分桶写入（长活会话的真实形态）', () => {
  // 回归用例：Provider 的对话可以跨天存活（同一 session_id 用了二十天），
  // 因此一次结算产出的 Skill Usage 本就可能分布在多个日期。
  // 曾经这里硬性禁止跨日期并抛错，导致 38 个真实会话里有 7 个整条失败。
  const dir = path.join(SANDBOX, 'log-multidate');
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    {
      date: '2026-09-01',
      conversation_id: 'CON-MULTI',
      skill_id: 'alpha',
      start_time: '2026-09-01T10:00:00+08:00',
      skill_token: 100,
      token_source: 'injection',
      status: 'completed',
    },
    {
      date: '2026-09-03',
      conversation_id: 'CON-MULTI',
      skill_id: 'beta',
      start_time: '2026-09-03T11:00:00+08:00',
      skill_token: 200,
      token_source: 'injection',
      status: 'completed',
    },
  ];
  const stats = CS.upsertSkillUsage(dir, rows, { date: '2026-09-01' });
  assert.strictEqual(stats.created, 2, `created=${stats.created}`);
  assert.deepStrictEqual(stats.dates, ['2026-09-01', '2026-09-03']);
  assert.strictEqual(CS.read(dir, 'skill_usage', '2026-09-01').length, 1);
  assert.strictEqual(CS.read(dir, 'skill_usage', '2026-09-03').length, 1);
  // 记录落在**自身 start_time** 所属日期，而不是会话创建日
  assert.strictEqual(CS.read(dir, 'skill_usage', '2026-09-03')[0].skill_id, 'beta');
});

check('跨日期记录重复写入仍然幂等', () => {
  const dir = path.join(SANDBOX, 'log-multidate');
  const stats = CS.upsertSkillUsage(
    dir,
    [
      {
        date: '2026-09-01',
        conversation_id: 'CON-MULTI',
        skill_id: 'alpha',
        start_time: '2026-09-01T10:00:00+08:00',
        skill_token: 100,
        token_source: 'injection',
        status: 'completed',
      },
      {
        date: '2026-09-03',
        conversation_id: 'CON-MULTI',
        skill_id: 'beta',
        start_time: '2026-09-03T11:00:00+08:00',
        skill_token: 200,
        token_source: 'injection',
        status: 'completed',
      },
    ],
    { date: '2026-09-01' }
  );
  assert.strictEqual(stats.created, 0);
  assert.strictEqual(stats.unchanged, 2);
});

check('strictSingleDate 才要求单日期写入', () => {
  const dir = path.join(SANDBOX, 'log-strict');
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(
    () =>
      CS.upsert(
        dir,
        'work_activity',
        [
          { date: '2026-09-21', content: 'a', source: 'manual' },
          { date: '2026-09-22', content: 'b', source: 'manual' },
        ],
        { strictSingleDate: true }
      ),
    /跨越多个日期/
  );
});

/* ---------------- 9. WorkItem → Work Activity 永久导出 ---------------- */
section('9. WorkItem 永久导出（export-work-activities）');

check('导出函数可被 require 复用（不触发 CLI 副作用）', () => {
  const before = process.exitCode;
  const exp = require('./export-work-activities');
  assert.strictEqual(typeof exp.exportForDate, 'function');
  assert.strictEqual(typeof exp.exportRecords, 'function');
  assert.strictEqual(typeof exp.toActivity, 'function');
  assert.strictEqual(process.exitCode, before, 'require 不应改动 process.exitCode');
});

check('字段映射：WorkItem → Work Activity', () => {
  const { toActivity } = require('./export-work-activities');
  const a = toActivity({
    id: 'WI-20260921-TEST0001',
    date: '2026-09-21',
    project_name: '气象数据',
    work_type: '原型设计',
    content: '改造查询交互',
    display_content: '【气象数据】【原型设计】改造查询交互',
    start_time: '17:10',
    end_time: '17:40',
    actual_duration: 30,
    status: 'completed',
    source: 'auto',
    confidence: 'high',
  });
  assert.strictEqual(a.project_name, '气象数据');
  assert.strictEqual(a.work_type, '原型设计');
  assert.strictEqual(a.duration_minutes, 30);
  assert.strictEqual(a.source, 'agent', 'WorkItem 的 auto 来源应映射为 agent');
  assert.strictEqual(a.status, 'completed');
  assert.strictEqual(a.work_item_id, 'WI-20260921-TEST0001');
  assert.ok(a.activity_id.startsWith('ACT-20260921-'), a.activity_id);
  assert.strictEqual(a.display_content, '【气象数据】【原型设计】改造查询交互');
});

check('activity_id 由 work_item_id 派生 → 改写内容仍是同一条', () => {
  const { toActivity } = require('./export-work-activities');
  const base = {
    id: 'WI-20260921-STABLE01',
    date: '2026-09-21',
    content: '原始内容',
    status: 'completed',
    source: 'auto',
    start_time: '09:00',
  };
  const a1 = toActivity(base);
  const a2 = toActivity(Object.assign({}, base, { content: '改写后的内容' }));
  assert.strictEqual(a1.activity_id, a2.activity_id, '内容变了但 id 必须不变');
});

check('导出幂等：重复导出不新增记录', () => {
  const dir = path.join(SANDBOX, 'log-export');
  fs.mkdirSync(dir, { recursive: true });
  const { exportRecords } = require('./export-work-activities');
  const records = [
    {
      id: 'WI-20260921-EXPORT01',
      date: '2026-09-21',
      content: '导出测试事项',
      project_name: 'P',
      work_type: '开发',
      start_time: '09:00',
      end_time: '10:00',
      actual_duration: 60,
      status: 'completed',
      source: 'auto',
      confidence: 'high',
    },
  ];
  const r1 = exportRecords(dir, '2026-09-21', records);
  assert.strictEqual(r1.action, 'exported');
  assert.strictEqual(r1.written.created, 1);
  const r2 = exportRecords(dir, '2026-09-21', records);
  assert.strictEqual(r2.action, 'already_exported');
  assert.strictEqual(r2.written.created, 0);
  assert.strictEqual(r2.written.unchanged, 1);
  assert.strictEqual(CS.read(dir, 'work_activity', '2026-09-21').length, 1);
});

check('导出的记录通过 work_item_id 可追溯（validate 不应误报）', () => {
  const dir = path.join(SANDBOX, 'log-export');
  const rows = CS.read(dir, 'work_activity', '2026-09-21');
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].work_item_id, '必须带 work_item_id');
  assert.strictEqual(rows[0].conversation_id, null, 'WorkItem 天然不带 conversation_id');
});
check('畸形日期被拒绝（防路径穿越）', () => {
  assert.throws(() => CS.assertDate('../../etc/passwd'), /YYYY-MM-DD/);
});
check('skill_usage 缺少 conversation_id 被拒绝（§12 必须关联）', () => {
  assert.throws(() => CS.normalizeSkillUsage({ skill_id: 'x' }), /conversation_id/);
});
check('坏行不影响其余行（JSONL 逐行独立）', () => {
  const file = path.join(SANDBOX, 'bad.jsonl');
  fs.writeFileSync(file, '{"a":1}\nnot json\n{"a":2}\n', 'utf8');
  const out = CS.readJsonl(file);
  assert.strictEqual(out.records.length, 2);
  assert.strictEqual(out.bad_lines, 1);
});

/* ---------------- 9. 原始快照与重新解析 ---------------- */
section('9. 原始快照');

check('原始快照按 session_id 落盘，含请求明细', () => {
  const file = CS.findRawSnapshot(LOGDIR, SESSION_FULL);
  assert.ok(file, '未找到原始快照');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw.session_id, SESSION_FULL);
  assert.ok(Array.isArray(raw.requests) && raw.requests.length === 2);
  assert.ok(Array.isArray(raw.skill_calls) && raw.skill_calls.length === 3);
  assert.ok(Array.isArray(raw.source_files) && raw.source_files.length === 1);
  assert.strictEqual(raw.session_usage.credit_total, 3.5);
});
check('--no-raw 不写快照', () => {
  const dir3 = path.join(SANDBOX, 'log-noraw');
  fs.mkdirSync(dir3, { recursive: true });
  runSettle(['--session', SESSION_FULL, '--no-raw'], { dir: dir3 });
  assert.strictEqual(CS.findRawSnapshot(dir3, SESSION_FULL), null);
  assert.strictEqual(CS.read(dir3, 'conversation', '2026-09-21').length, 1);
});
check('--dry-run 不写任何文件', () => {
  const dir4 = path.join(SANDBOX, 'log-dry');
  fs.mkdirSync(dir4, { recursive: true });
  const res = runSettle(['--session', SESSION_FULL, '--dry-run'], { dir: dir4 });
  assert.strictEqual(res.code, 0);
  assert.strictEqual(res.json.reports[0].action, 'dry_run');
  assert.strictEqual(CS.read(dir4, 'conversation', '2026-09-21').length, 0);
  assert.ok(!fs.existsSync(path.join(dir4, 'raw')));
});

/* ---------------- 10. 重新解析（覆盖而非新增） ---------------- */
section('10. 重新解析（--backfill）');

check('--backfill 覆盖旧值，不新增记录', () => {
  const before = readConv();
  const res = runSettle(['--backfill', '--since', '2026-09-21', '--until', '2026-09-21', '--quiet', '--exit-zero']);
  assert.strictEqual(res.code, 0);
  const after = readConv();
  assert.strictEqual(after.length, before.length, '重新解析不得新增 Conversation 记录');
  for (const b of before) {
    const a = after.find((x) => x.conversation_id === b.conversation_id);
    assert.ok(a, `记录 ${b.conversation_id} 丢失`);
    assert.strictEqual(a.total_token, b.total_token, '重新解析导致 Token 变化（应为覆盖，值相同）');
  }
});

/* ------------------------------------------------------------------ *
 * 收尾
 * ------------------------------------------------------------------ */

// 守卫：确认真实定位器没有被指向沙箱（否则生产侧 Hook 会失效）
const realLocator = path.join(os.homedir(), '.workbuddy', 'work-time-tracking.json');
let locatorLeak = false;
try {
  if (fs.existsSync(realLocator)) {
    const j = JSON.parse(fs.readFileSync(realLocator, 'utf8'));
    locatorLeak = String(j.log_directory || '').includes(SANDBOX);
  }
} catch (e) {
  locatorLeak = false;
}
check('真实日志定位器未被测试污染', () => assert.strictEqual(locatorLeak, false));

fs.rmSync(SANDBOX, { recursive: true, force: true });

process.stdout.write(
  `\n结果：${passed} 通过，${failed} 失败（共 ${passed + failed} 项）\n`
);
if (failed) {
  process.stdout.write('\n失败明细：\n');
  failures.forEach((f) => process.stdout.write(`  ✗ ${f.name}\n      ${f.error}\n`));
  process.exitCode = 1;
}
