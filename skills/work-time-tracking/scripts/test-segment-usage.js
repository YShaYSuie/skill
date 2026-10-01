#!/usr/bin/env node
'use strict';
/**
 * test-segment-usage.js — Work Segment / AI Usage 的存储与自检回归。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const INIT = path.join(ROOT, 'scripts', 'init-log.js');
const VALIDATE = path.join(ROOT, 'scripts', 'validate-log.js');

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-segment-'));
const HOME = path.join(SANDBOX, 'home');
const DIR = path.join(SANDBOX, 'log');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(DIR, { recursive: true });

const ENV = Object.assign({}, process.env, {
  HOME,
  USERPROFILE: HOME,
});

function run(script, args) {
  return spawnSync(NODE, [script].concat(args), {
    env: ENV,
    encoding: 'utf8',
    timeout: 60000,
  });
}

function parseJson(res) {
  try {
    return JSON.parse(String(res.stdout || '').trim());
  } catch (e) {
    return null;
  }
}

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✔ ${name}\n`);
  } catch (e) {
    process.stdout.write(`  ✘ ${name}\n      ${e.message}\n`);
    process.exitCode = 1;
  }
}

process.stdout.write('test-segment-usage.js — Segment / AI Usage 回归测试\n');
process.stdout.write(`沙箱：${SANDBOX}\n`);

const init = run(INIT, ['init', '--dir', DIR, '--create']);
assert.strictEqual(init.status, 0, String(init.stderr || init.stdout));

const configFile = path.join(DIR, 'config.json');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
config.security.ai_summarize = false;
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));

const CS = require(path.join(ROOT, 'scripts', 'lib', 'conversation-store'));
const C = require(path.join(ROOT, 'scripts', 'lib', 'log-core'));
const date = C.today();
const conversationId = CS.makeConversationId(date, 'segment-usage-session');
const segmentId = CS.makeSegmentId(date, conversationId, 0, '10:00', 'GPU 调度设计');
const activityId = CS.makeActivityId(date, conversationId, '完成 GPU 调度方案设计', '10:00');

CS.upsertConversation(
  DIR,
  {
    conversation_id: conversationId,
    date,
    session_id: 'segment-usage-session',
    start_time: `${date}T10:00:00+08:00`,
    end_time: `${date}T10:30:00+08:00`,
    total_token: 1000,
    input_token: 700,
    output_token: 300,
    total_score: 2,
    score_source: 'workbuddy_credit',
    score_request_count: 1,
    request_count: 1,
    status: 'completed',
    settlement_status: 'settled',
    source: 'other',
  },
  { date }
);
CS.upsertWorkSegment(
  DIR,
  {
    segment_id: segmentId,
    conversation_id: conversationId,
    date,
    topic: 'GPU 调度设计',
    summary: '设计调度方案。',
    start_time: `${date}T10:00:00+08:00`,
    end_time: `${date}T10:30:00+08:00`,
    source: 'agent',
    status: 'completed',
  },
  { date }
);
CS.upsertWorkActivity(
  DIR,
  {
    activity_id: activityId,
    conversation_id: conversationId,
    segment_id: segmentId,
    date,
    project_name: '异构算力平台',
    work_type: '方案设计',
    project_stage: '方案设计',
    content: '完成 GPU 调度方案设计',
    detail: '明确 MIG、显存隔离和节点调度规则。',
    ai_role: 'AI协作',
    skills: ['work-time-tracking'],
    models: ['gpt-test'],
    start_time: '10:00',
    end_time: '10:30',
    source: 'agent',
    status: 'completed',
  },
  { date }
);
CS.upsertAiUsage(
  DIR,
  {
    ai_usage_id: 'AUS-TEST-001',
    conversation_id: conversationId,
    activity_id: activityId,
    segment_id: segmentId,
    date,
    attribution_status: 'exact',
    input_token: 400,
    output_token: 200,
    credit: 0.8,
    model: 'gpt-test',
    source: 'other',
  },
  { date }
);

check('合法 Segment / Activity / AI Usage 通过自检', () => {
  const res = run(VALIDATE, ['--dir', DIR]);
  const json = parseJson(res);
  assert.strictEqual(res.status, 0, JSON.stringify(json && json.problems));
  assert.deepStrictEqual(json.problems, []);
});

check('Token 由 input + output 精确计算', () => {
  const row = CS.read(DIR, 'ai_usage', date)[0];
  assert.strictEqual(row.total_token, 600);
  assert.strictEqual(row.credit, 0.8);
});

check('精确归属超过 Conversation 总账时自检失败', () => {
  CS.upsertAiUsage(
    DIR,
    {
      ai_usage_id: 'AUS-TEST-001',
      conversation_id: conversationId,
      activity_id: activityId,
      segment_id: segmentId,
      date,
      attribution_status: 'exact',
      total_token: 1200,
      credit: 0.8,
      source: 'other',
    },
    { date }
  );
  const res = run(VALIDATE, ['--dir', DIR]);
  const json = parseJson(res);
  assert.notStrictEqual(res.status, 0);
  assert.ok(
    json.problems.some((p) => p.includes('精确归属 Token 大于 Conversation 总账')),
    JSON.stringify(json.problems)
  );
});

fs.rmSync(SANDBOX, { recursive: true, force: true });
process.stdout.write(`\n结果：${passed} 通过\n`);
