#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const INIT = path.join(ROOT, 'scripts', 'init-log.js');
const COLLECT = path.join(ROOT, 'scripts', 'collect-activity.js');
const SETTLE = path.join(ROOT, 'scripts', 'settle-conversation.js');
const CS = require(path.join(ROOT, 'scripts', 'lib', 'conversation-store'));
const CPR = require(path.join(ROOT, 'scripts', 'lib', 'codex-project-resolver'));
const CXP = require(path.join(ROOT, 'scripts', 'lib', 'codex-conversation-parser'));
const PR = require(path.join(ROOT, 'scripts', 'lib', 'project-resolver'));
const SKR = require(path.join(ROOT, 'scripts', 'lib', 'skill-receipt'));

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

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-codex-'));
const HOME = path.join(SANDBOX, 'home');
const WB_HOME = path.join(HOME, '.workbuddy');
const CODEX_HOME = path.join(HOME, '.codex');
const LOGDIR = path.join(SANDBOX, 'log');
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const PROJECT_ID = '11111111-2222-4333-8444-555555555555';
const PROJECT_NAME = 'Codex 项目兼容测试';
const CWD = 'D:/codex/2026-09-21/codex-parser';
const START = new Date('2026-09-21T09:00:00+08:00').getTime();
const END = new Date('2026-09-21T10:00:00+08:00').getTime();
const CONTINUATION_START = new Date('2026-09-21T09:10:00+08:00').getTime();
const FINAL_END = new Date('2026-09-21T10:10:00+08:00').getTime();
const CONTINUATION_ID = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const GUARDIAN_ID = 'cccccccc-dddd-4eee-8fff-000000000000';
const REPLAY_ID = 'dddddddd-eeee-4fff-8000-111111111111';
const FINAL_TOKEN = 5678;
const FINAL_INPUT = 4000;
const FINAL_OUTPUT = 1678;
const FINAL_CACHED = 1200;
const FINAL_REASONING = 100;

fs.mkdirSync(WB_HOME, { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });

function iso(ms) {
  return new Date(ms).toISOString();
}

function writeRollout() {
  const day = path.join(CODEX_HOME, 'sessions', '2026', '09', '21');
  fs.mkdirSync(day, { recursive: true });
  const rows = [
    {
      timestamp: iso(START),
      ordinal: 0,
      type: 'session_meta',
      payload: {
        session_id: SESSION,
        timestamp: iso(START),
        cwd: 'D:/codex/2026-09-21/codex-parser',
        runtime_workspace_roots: ['D:/codex/2026-09-21/codex-parser'],
        model_provider: 'custom',
        originator: 'Codex Desktop',
      },
    },
    {
      timestamp: iso(START + 1000),
      ordinal: 1,
      type: 'turn_context',
      payload: {
        cwd: 'D:/codex/2026-09-21/codex-parser',
        workspace_roots: ['D:/codex/2026-09-21/codex-parser'],
        current_date: '2026-09-21',
        timezone: 'Asia/Shanghai',
      },
    },
    {
      timestamp: iso(START + 2000),
      ordinal: 2,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: '<environment_context><cwd>D:/codex/2026-09-21/codex-parser</cwd></environment_context>',
          },
        ],
      },
    },
    {
      timestamp: iso(START + 3000),
      ordinal: 3,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '完善 Codex 对话结算解析' }],
      },
    },
    {
      timestamp: iso(START + 4000),
      ordinal: 4,
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-main-1' },
    },
    {
      timestamp: iso(START + 5000),
      ordinal: 5,
      type: 'token_usage_record',
      payload: {
        thread_id: SESSION,
        turn_id: 'turn-main-1',
        response_id: 'resp-1',
        usage: { input_tokens: 1000, output_tokens: 234, total_tokens: 1234 },
        turn_token_usage: { input_tokens: 1000, output_tokens: 234, total_tokens: 1234 },
        thread_token_usage: {
          input_tokens: 1000,
          cached_input_tokens: 400,
          output_tokens: 234,
          reasoning_output_tokens: 12,
          total_tokens: 1234,
        },
      },
    },
    {
      timestamp: iso(END),
      ordinal: 6,
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-main-1' },
    },
  ];
  const file = path.join(day, `rollout-2026-09-21T09-00-00-${SESSION}.jsonl`);
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}

function writeContinuationRollout() {
  const day = path.join(CODEX_HOME, 'sessions', '2026', '09', '21');
  fs.mkdirSync(day, { recursive: true });
  const rows = [
    {
      timestamp: iso(CONTINUATION_START),
      ordinal: 6,
      type: 'session_meta',
      payload: {
        session_id: SESSION,
        id: SESSION,
        timestamp: iso(CONTINUATION_START),
        cwd: CWD,
        runtime_workspace_roots: ['D:/codex/2026-09-21/codex-parser'],
        thread_source: 'user',
        history_base: {
          thread_id: SESSION,
          end_ordinal_exclusive: 6,
        },
      },
    },
    {
      timestamp: iso(CONTINUATION_START + 1000),
      ordinal: 7,
      type: 'turn_context',
      payload: { cwd: CWD, workspace_roots: ['D:/codex/2026-09-21/codex-parser'] },
    },
    {
      timestamp: iso(CONTINUATION_START + 2000),
      ordinal: 8,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '继续补齐续写分片的用户问答' }],
      },
    },
    {
      timestamp: iso(CONTINUATION_START + 3000),
      ordinal: 9,
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'turn-main-2' },
    },
    {
      timestamp: iso(FINAL_END - 1000),
      ordinal: 10,
      type: 'token_usage_record',
      payload: {
        thread_id: SESSION,
        turn_id: 'turn-main-2',
        response_id: 'resp-2',
        usage: {
          input_tokens: FINAL_INPUT,
          output_tokens: FINAL_OUTPUT,
          total_tokens: FINAL_TOKEN,
        },
        turn_token_usage: {
          input_tokens: FINAL_INPUT,
          cached_input_tokens: FINAL_CACHED,
          output_tokens: FINAL_OUTPUT,
          reasoning_output_tokens: FINAL_REASONING,
          total_tokens: FINAL_TOKEN,
        },
        thread_token_usage: {
          input_tokens: FINAL_INPUT,
          cached_input_tokens: FINAL_CACHED,
          output_tokens: FINAL_OUTPUT,
          reasoning_output_tokens: FINAL_REASONING,
          total_tokens: FINAL_TOKEN,
        },
      },
    },
    {
      timestamp: iso(FINAL_END),
      ordinal: 11,
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-main-2' },
    },
  ];
  const file = path.join(
    day,
    `rollout-2026-09-21T09-10-00-${SESSION}_${CONTINUATION_ID}.jsonl`
  );
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}

function writeGuardianRollout() {
  const day = path.join(CODEX_HOME, 'sessions', '2026', '09', '21');
  const ts = START + 5 * 60 * 1000;
  const rows = [
    {
      timestamp: iso(ts),
      ordinal: 0,
      type: 'session_meta',
      payload: {
        session_id: SESSION,
        id: GUARDIAN_ID,
        timestamp: iso(ts),
        cwd: CWD,
        thread_source: 'guardian_review',
        source: { subagent: { other: 'guardian' } },
      },
    },
    {
      timestamp: iso(ts + 1000),
      ordinal: 1,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: 'The following is the Codex agent history whose request action you are assessing.',
          },
        ],
      },
    },
    {
      timestamp: iso(ts + 2000),
      ordinal: 2,
      type: 'token_usage_record',
      payload: {
        thread_id: SESSION,
        response_id: 'guardian-resp',
        usage: { input_tokens: 90000, output_tokens: 100, total_tokens: 90100 },
        thread_token_usage: {
          input_tokens: 90000,
          cached_input_tokens: 0,
          output_tokens: 100,
          reasoning_output_tokens: 0,
          total_tokens: 90100,
        },
      },
    },
  ];
  const file = path.join(day, `rollout-2026-09-21T09-05-00-${GUARDIAN_ID}.jsonl`);
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}

function writeReplayRollout() {
  const day = path.join(CODEX_HOME, 'sessions', '2026', '09', '21');
  const ts = START + 20 * 60 * 1000;
  const rows = [
    {
      timestamp: iso(ts),
      ordinal: 0,
      type: 'session_meta',
      payload: {
        session_id: SESSION,
        id: REPLAY_ID,
        timestamp: iso(ts),
        cwd: CWD,
        thread_source: 'user',
      },
    },
    {
      timestamp: iso(ts + 1000),
      ordinal: 1,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '重复回放不应进入主分片历史链' }],
      },
    },
    {
      timestamp: iso(ts + 2000),
      ordinal: 2,
      type: 'token_usage_record',
      payload: {
        thread_id: SESSION,
        response_id: 'replay-resp',
        usage: { input_tokens: 100, output_tokens: 11, total_tokens: 111 },
        thread_token_usage: {
          input_tokens: 100,
          cached_input_tokens: 0,
          output_tokens: 11,
          reasoning_output_tokens: 0,
          total_tokens: 111,
        },
      },
    },
  ];
  const file = path.join(day, `rollout-2026-09-21T09-20-00-${REPLAY_ID}.jsonl`);
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}

function writeThreadDb(canonicalRollout) {
  const { DatabaseSync } = require('node:sqlite');
  const file = path.join(CODEX_HOME, 'state_5.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      position INTEGER NOT NULL,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL
    );
    CREATE TABLE project_roots (
      project_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      path TEXT NOT NULL,
      PRIMARY KEY (project_id, position)
    );
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT,
      cwd TEXT,
      title TEXT,
      name TEXT,
      model TEXT,
      created_at INTEGER,
      updated_at INTEGER,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      archived INTEGER,
      project_id TEXT,
      tokens_used INTEGER,
      source TEXT,
      originator TEXT
    );
  `);
  db.prepare(
    'INSERT INTO projects (id, name, metadata, position, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(PROJECT_ID, PROJECT_NAME, '{}', 0, START, END);
  db.prepare('INSERT INTO project_roots (project_id, position, path) VALUES (?, ?, ?)').run(
    PROJECT_ID,
    0,
    'D:/codex/2026-09-21'
  );
  db.prepare(
    'INSERT INTO threads (id, rollout_path, cwd, title, name, model, created_at, updated_at, created_at_ms, updated_at_ms, archived, project_id, tokens_used, source, originator) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    SESSION,
    canonicalRollout,
    CWD,
    'Codex 对话结算解析',
    'Codex 对话结算解析',
    'test-codex-model',
    Math.floor(START / 1000),
    Math.floor(END / 1000),
    START,
    END,
    0,
    PROJECT_ID,
    FINAL_TOKEN,
    'vscode',
    'Codex Desktop'
  );
  db.close();
}

const CHILD_ENV = Object.assign({}, process.env, {
  HOME,
  USERPROFILE: HOME,
  WORKBUDDY_HOME: WB_HOME,
  CODEX_HOME,
});

function runSettle(args, dir) {
  const res = spawnSync(
    process.execPath,
    [SETTLE, '--dir', dir || LOGDIR, '--home', WB_HOME, '--codex-home', CODEX_HOME].concat(args),
    { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 }
  );
  let json = null;
  try {
    json = JSON.parse(String(res.stdout || '').trim());
  } catch (e) {
    json = null;
  }
  return { code: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || ''), json };
}

function runCollect(args, dir) {
  const res = spawnSync(
    process.execPath,
    [COLLECT, '--dir', dir].concat(args),
    { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 }
  );
  let json = null;
  try {
    json = JSON.parse(String(res.stdout || '').trim());
  } catch (e) {
    json = null;
  }
  return { code: res.status, stdout: String(res.stdout || ''), stderr: String(res.stderr || ''), json };
}

writeRollout();
const continuationRollout = writeContinuationRollout();
writeGuardianRollout();
writeReplayRollout();
writeThreadDb(continuationRollout);

section('1. Codex session settlement');

const first = runSettle(['--session', SESSION]);
check('exit code 0', () => assert.strictEqual(first.code, 0));
check('report source=codex', () => assert.strictEqual(first.json.reports[0].source, 'codex'));
check('listRecentSessions deduplicates user rollouts and excludes guardian review', () => {
  const rows = CXP.listRecentSessions(CODEX_HOME, 20);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].id, SESSION);
  assert.strictEqual(rows[0].file, continuationRollout);
});
check('conversation written', () => {
  const rows = CS.read(LOGDIR, 'conversation', '2026-09-21');
  assert.strictEqual(rows.length, 1);
  const r = rows[0];
  assert.strictEqual(r.source, 'codex');
  assert.strictEqual(r.agent, 'codex');
  assert.strictEqual(r.project, PROJECT_NAME);
  assert.strictEqual(r.project_id, PROJECT_ID);
  assert.strictEqual(r.project_source, 'codex_project');
  assert.strictEqual(r.project_confidence, 'high');
  assert.strictEqual(r.model_name, 'test-codex-model');
  assert.strictEqual(r.total_token, FINAL_TOKEN);
  assert.strictEqual(r.input_token, FINAL_INPUT);
  assert.strictEqual(r.output_token, FINAL_OUTPUT);
  assert.strictEqual(r.cached_token, FINAL_CACHED);
  assert.strictEqual(r.reasoning_token, FINAL_REASONING);
  assert.strictEqual(r.request_count, 2);
  assert.strictEqual(r.turn_count, 2);
  assert.match(r.start_time, /^2026-09-21T09:00:00\+08:00$/);
  assert.match(r.end_time, /^2026-09-21T10:10:00\+08:00$/);
  assert.strictEqual(r.total_score, 0);
  assert.strictEqual(r.score_source, 'not_applicable');
  assert.strictEqual(r.skill_count, 0);
  assert.strictEqual(r.status, 'completed');
});

check('Codex Turn Log：两轮分别落盘，并保留原始 turn_id', () => {
  const rows = CS.read(LOGDIR, 'turn', '2026-09-21');
  assert.strictEqual(rows.length, 2, JSON.stringify(rows));
  assert.deepStrictEqual(
    rows.map((r) => r.provider_turn_id).sort(),
    ['turn-main-1', 'turn-main-2']
  );
  const conversations = CS.read(LOGDIR, 'conversation', '2026-09-21');
  assert.strictEqual(rows[0].conversation_id, conversations[0].conversation_id);
  assert.strictEqual(rows[0].total_token, 1234);
  assert.strictEqual(rows[0].token_source, 'turn_usage');
  assert.strictEqual(rows[0].status, 'completed');
});
check('raw snapshot lands under raw/codex', () => {
  const file = path.join(LOGDIR, 'raw', 'codex', '2026-09-21', `${SESSION}.json`);
  assert.ok(fs.existsSync(file), file);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(raw.session_id, SESSION);
  assert.strictEqual(raw.token_usage.total_tokens, FINAL_TOKEN);
  assert.strictEqual(raw.source_files.length, 2);
  assert.ok(raw.source_files.includes(continuationRollout));
  assert.strictEqual(raw.prompts.length, 2);
  assert.ok(raw.prompts.some((p) => /完善 Codex 对话结算解析/.test(p.text)));
  assert.ok(raw.prompts.some((p) => /继续补齐续写分片的用户问答/.test(p.text)));
  assert.ok(!raw.prompts.some((p) => /重复回放/.test(p.text)));
  assert.ok(!raw.prompts.some((p) => /request action you are assessing/.test(p.text)));
  assert.strictEqual(raw.internal_rollouts.length, 1);
  assert.strictEqual(raw.ignored_user_rollouts.length, 1);
});
check('repeat settlement is idempotent', () => {
  const second = runSettle(['--session', SESSION]);
  assert.strictEqual(second.code, 0);
  assert.strictEqual(second.json.reports[0].action, 'already_settled');
  assert.strictEqual(second.json.reports[0].written.conversation.created, 0);
});

section('2. backfill / latest');

const backfillDir = path.join(SANDBOX, 'log-backfill');
fs.mkdirSync(backfillDir, { recursive: true });
check('--backfill discovers Codex sessions', () => {
  const res = runSettle(
    ['--backfill', '--since', '2026-09-21', '--until', '2026-09-21', '--quiet', '--exit-zero'],
    backfillDir
  );
  assert.strictEqual(res.code, 0);
  const rows = CS.read(backfillDir, 'conversation', '2026-09-21');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].source, 'codex');
});
check('--latest can select the Codex session when WorkBuddy is empty', () => {
  const latestDir = path.join(SANDBOX, 'log-latest');
  fs.mkdirSync(latestDir, { recursive: true });
  const res = runSettle(['--latest', '--limit', '1', '--quiet', '--exit-zero'], latestDir);
  assert.strictEqual(res.code, 0);
  const rows = CS.read(latestDir, 'conversation', '2026-09-21');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].source, 'codex');
});

section('3. prompt fallback');

check('--activities prompts creates a linked candidate activity', () => {
  const promptDir = path.join(SANDBOX, 'log-prompts');
  fs.mkdirSync(promptDir, { recursive: true });
  const res = runSettle(['--session', SESSION, '--activities', 'prompts'], promptDir);
  assert.strictEqual(res.code, 0);
  const acts = CS.read(promptDir, 'work_activity', '2026-09-21');
  assert.ok(acts.length >= 1, '应至少生成一条候选事项');
  assert.ok(acts.some((a) => a.session_id === SESSION), '候选事项应保留 session_id 证据');
  assert.ok(acts.some((a) => /Codex/.test(a.content)), '应保留 Codex 相关用户输入');
});

section('4. Codex project root fallback');

check('cwd matches longest project_roots prefix without thread project_id', () => {
  const r = CPR.resolveCodexProject(
    { cwd: 'D:/codex/2026-09-21/codex-parser/src' },
    { codexHome: CODEX_HOME }
  );
  assert.strictEqual(r.project_name, PROJECT_NAME);
  assert.strictEqual(r.project_id, PROJECT_ID);
  assert.strictEqual(r.project_source, 'codex_project_root');
  assert.strictEqual(r.project_confidence, 'high');
});

check('explicit project_map overrides Codex local project name', () => {
  const r = PR.resolveProjectContext(
    { codexSessionId: SESSION, cwd: CWD },
    {
      config: { project_map: { 'D:/codex/2026-09-21': '显式映射项目' } },
      codexResolver: (src) => CPR.resolveCodexProject(src, { codexHome: CODEX_HOME }),
    }
  );
  assert.strictEqual(r.project_name, '显式映射项目');
  assert.strictEqual(r.project_source, 'project_map');
  assert.strictEqual(r.project_confidence, 'high');
});

section('5. Codex work item project propagation');

const ingestDir = path.join(SANDBOX, 'log-ingest');
fs.mkdirSync(ingestDir, { recursive: true });
const init = spawnSync(
  process.execPath,
  [INIT, 'init', '--dir', ingestDir, '--create'],
  { env: CHILD_ENV, encoding: 'utf8', timeout: 60000 }
);
assert.strictEqual(init.status, 0, init.stderr || init.stdout);

const ingest = runCollect(
  [
    'ingest',
    '--host',
    'codex',
    '--source',
    'auto',
    '--event',
    'UserPromptSubmit',
    '--content',
    '完善 Codex 项目归属记录与工作事项关联',
    '--session',
    SESSION,
    '--cwd',
    CWD,
    '--force',
    '--rollover',
    'keep',
  ],
  ingestDir
);
check('Codex ingest succeeds', () => assert.strictEqual(ingest.code, 0, ingest.stderr || ingest.stdout));
check('pending item keeps session and Codex project evidence', () => {
  const log = JSON.parse(fs.readFileSync(path.join(ingestDir, 'current.json'), 'utf8'));
  const item = (log.pending_items || [])[0];
  assert.ok(item, '应生成待判断事项');
  assert.strictEqual(item.session_id, SESSION);
  assert.strictEqual(item.project_name, PROJECT_NAME);
  assert.strictEqual(item.project_id, PROJECT_ID);
  assert.strictEqual(item.project_source, 'codex_project');
  assert.strictEqual(item.project_confidence, 'high');
});
check('apply --new carries Codex project evidence into WorkItem', () => {
  const log = JSON.parse(fs.readFileSync(path.join(ingestDir, 'current.json'), 'utf8'));
  const hash = (log.pending_items || [])[0].hash;
  const applied = runCollect(
    [
      'apply',
      '--hash',
      hash,
      '--new',
      '--start',
      '10:00',
      '--work-type',
      '开发协作',
      '--trigger',
      'manual',
    ],
    ingestDir
  );
  assert.strictEqual(applied.code, 0, applied.stderr || applied.stdout);
  const next = JSON.parse(fs.readFileSync(path.join(ingestDir, 'current.json'), 'utf8'));
  const item = (next.records || [])[0];
  assert.ok(item, '应生成 WorkItem');
  assert.strictEqual(item.session_id, SESSION);
  assert.strictEqual(item.project_name, PROJECT_NAME);
  assert.strictEqual(item.project_id, PROJECT_ID);
});

section('6. Skill 使用证据（V3.22）');

const SKILL_SESSION = 'ffffffff-1111-4222-8333-444444444444';
const DEMO_SKILL = 'demo-skill';
const skillMdPath = `<USER_HOME>/.skills-manager/skills/${DEMO_SKILL}/SKILL.md`;

// 假的中央库：knownSkillIds() 只认本机真实装过的 Skill，测试里就装一个
const fakeSkillDir = path.join(HOME, '.skills-manager', 'skills', DEMO_SKILL);
fs.mkdirSync(fakeSkillDir, { recursive: true });
fs.writeFileSync(
  path.join(fakeSkillDir, 'SKILL.md'),
  `---\nname: ${DEMO_SKILL}\ndescription: 测试用技能\nversion: "1.0"\n---\n\n# Demo\n`,
  'utf8'
);

function writeSkillRollout() {
  const day = path.join(CODEX_HOME, 'sessions', '2026', '09', '22');
  fs.mkdirSync(day, { recursive: true });
  const start = new Date('2026-09-22T09:00:00+08:00').getTime();
  const rows = [
    {
      timestamp: iso(start),
      ordinal: 0,
      type: 'session_meta',
      payload: {
        session_id: SKILL_SESSION,
        timestamp: iso(start),
        cwd: CWD,
        model_provider: 'custom',
        originator: 'Codex Desktop',
      },
    },
    {
      timestamp: iso(start + 1000),
      ordinal: 1,
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `请用 $${DEMO_SKILL} 整理一下` }],
      },
    },
    {
      // 真实载入 SKILL.md → 应记一条 skill_md_loaded
      timestamp: iso(start + 2000),
      ordinal: 2,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'exec_command',
        call_id: 'call-skill-load',
        arguments: JSON.stringify({ cmd: `Get-Content -LiteralPath '${skillMdPath}' -Encoding UTF8` }),
      },
    },
    {
      // 改技能源码（apply_patch）不是「使用技能」→ 必须不计
      timestamp: iso(start + 3000),
      ordinal: 3,
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'apply_patch',
        call_id: 'call-skill-edit',
        arguments: JSON.stringify({ patch: `*** Update File: ${skillMdPath}\n+一行改动` }),
      },
    },
    {
      timestamp: iso(start + 4000),
      ordinal: 4,
      type: 'token_usage_record',
      payload: {
        thread_id: SKILL_SESSION,
        turn_id: 'turn-skill-1',
        response_id: 'resp-skill',
        usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        turn_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        thread_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
      },
    },
    {
      timestamp: iso(start + 5000),
      ordinal: 5,
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-skill-1' },
    },
  ];
  const file = path.join(day, `rollout-2026-09-22T09-00-00-${SKILL_SESSION}.jsonl`);
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`, 'utf8');
  return file;
}
writeSkillRollout();

const skillLogDir = path.join(SANDBOX, 'log-skill');
fs.mkdirSync(skillLogDir, { recursive: true });
const skillRes = runSettle(['--session', SKILL_SESSION], skillLogDir);

check('skill 会话结算成功', () => assert.strictEqual(skillRes.code, 0, skillRes.stderr || skillRes.stdout));
check('显式调用 → evidence=explicit_invocation / trigger_type=user', () => {
  const rows = CS.read(skillLogDir, 'skill_usage', '2026-09-22');
  const hit = rows.filter((r) => r.evidence === 'explicit_invocation');
  assert.strictEqual(hit.length, 1, JSON.stringify(rows));
  assert.strictEqual(hit[0].skill_id, DEMO_SKILL);
  assert.strictEqual(hit[0].trigger_type, 'user');
});
check('真实载入 SKILL.md → evidence=skill_md_loaded / trigger_type=agent', () => {
  const rows = CS.read(skillLogDir, 'skill_usage', '2026-09-22');
  const hit = rows.filter((r) => r.evidence === 'skill_md_loaded');
  assert.strictEqual(hit.length, 1, JSON.stringify(rows));
  assert.strictEqual(hit[0].skill_id, DEMO_SKILL);
  assert.strictEqual(hit[0].trigger_type, 'agent');
  assert.strictEqual(hit[0].load_chars, null, '取不到载入体积时必须是 null，不是 0');
  assert.strictEqual(hit[0].skill_token, null);
  assert.strictEqual(hit[0].token_source, 'unavailable');
});
check('apply_patch 改技能源码不算使用（只 2 条：显式调用 + 载入）', () => {
  const rows = CS.read(skillLogDir, 'skill_usage', '2026-09-22');
  assert.strictEqual(rows.length, 2, JSON.stringify(rows.map((r) => r.evidence)));
});
check('conversation.skill_count = Skill 调用次数（与日志条数一致）', () => {
  const rows = CS.read(skillLogDir, 'conversation', '2026-09-22');
  assert.strictEqual(rows.length, 1);
  // 2 条记录 = 2 次调用（显式引用 1 次 + 载入 SKILL.md 1 次），与 WorkBuddy 侧口径一致
  assert.strictEqual(rows[0].skill_count, 2);
  assert.strictEqual(rows[0].skill_invocation_count, 2);
  assert.strictEqual(rows[0].distinct_skill_count, 1);
  assert.strictEqual(rows[0].turn_count, 1);
});
check('Skill Usage 关联 Turn，并记录事件顺序', () => {
  const turns = CS.read(skillLogDir, 'turn', '2026-09-22');
  const rows = CS.read(skillLogDir, 'skill_usage', '2026-09-22');
  assert.strictEqual(turns.length, 1, JSON.stringify(turns));
  assert.strictEqual(turns[0].provider_turn_id, 'turn-skill-1');
  assert.strictEqual(rows.length, 2);
  assert.ok(rows.every((r) => r.turn_id === turns[0].turn_id));
  assert.deepStrictEqual(
    rows.map((r) => r.event_ordinal).sort((a, b) => a - b),
    [1, 2]
  );
});
check('Skill Receipt 视图：中间为空，最终按 Skill 去重', () => {
  const turns = CS.read(skillLogDir, 'turn', '2026-09-22');
  const rows = CS.read(skillLogDir, 'skill_usage', '2026-09-22');
  const views = SKR.buildTurnReceipts(turns, rows);
  assert.strictEqual(views.length, 1);
  assert.strictEqual(views[0].snapshots[0].distinct_skill_count, 0);
  assert.strictEqual(views[0].final.distinct_skill_count, 1);
  assert.strictEqual(views[0].final.invocation_count, 2);
  assert.strictEqual(views[0].final.skills[0].skill_id, DEMO_SKILL);
});
check('重放幂等：再结算一次不新增记录', () => {
  const again = runSettle(['--session', SKILL_SESSION], skillLogDir);
  assert.strictEqual(again.code, 0, again.stderr || again.stdout);
  const rows = CS.read(skillLogDir, 'skill_usage', '2026-09-22');
  assert.strictEqual(rows.length, 2, `重放后应为 2 条，实际 ${rows.length}`);
});

fs.rmSync(SANDBOX, { recursive: true, force: true });

process.stdout.write(`\n结果：${passed} 通过，${failed} 失败（共 ${passed + failed} 项）\n`);
if (failed) {
  failures.forEach((f) => process.stdout.write(`  ✗ ${f.name}\n      ${f.error}\n`));
  process.exitCode = 1;
}
