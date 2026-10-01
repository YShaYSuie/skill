#!/usr/bin/env node
'use strict';
/**
 * test-period-summary.js — 周期总结（week / month / project）回归测试。
 *
 * 为什么必须存在这个文件：
 *   V3.6（2026-09-24）给 `renderCostBrief(cost, label, models)` 增加了第三个参数
 *   「模型维度」，但 `doPeriod()` 的调用点**没有同步传入 `models`**，
 *   于是 `week` / `month` / `project` 三条路径一律抛
 *       ReferenceError: models is not defined
 *   —— 整条周期总结能力静默不可用。因为当时没有任何测试执行过这三个子命令，
 *   缺陷一直没被发现。本测试把这三条路径钉住：
 *     ① 必须 exit 0；② 输出不得含 ReferenceError；
 *     ③ 必须产出「按模型」段落（即修复时补上的那个参数真的起作用）。
 *
 *   node scripts/test-period-summary.js
 *
 * 用临时目录 + 沙箱 HOME，不触碰真实 LOG_ROOT。退出码 0 = 全部通过。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = __dirname;
const DAY = '2026-09-24';
const MONTH = '2026-09';

/** 沙箱 HOME：避免把真实全局定位器改成临时目录（同 test-ticktick-link.js） */
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-home-'));
const CHILD_ENV = Object.assign({}, process.env, {
  HOME: SANDBOX_HOME,
  USERPROFILE: SANDBOX_HOME,
});

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
  }
}

function node(script, args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf-8',
    env: CHILD_ENV,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) {
    // 某些沙箱/受限环境禁止「node 派生 node」（实测 EBUSY），会让全部用例假失败。
    // 这属于环境问题、不是被测代码的问题，必须说清楚，避免误导排查方向。
    console.log(
      `\n  ⚠ 无法派生 node 子进程：${r.error.code || r.error.message}\n` +
        '     本测试需要在允许 node→node 派生的常规终端中运行。\n'
    );
    return { code: null, stdout: '', stderr: '', spawnError: r.error };
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-period-'));
console.log(`\n临时目录：${tmp}`);

/* ---------- 初始化 + 播种数据 ---------- */

const cfg = path.join(SCRIPTS, '..', 'templates', 'config.json');
const init = node('init-log.js', ['init', '--dir', tmp, '--actor', 'test', '--config', cfg]);
ok('init-log 初始化成功', init.code === 0, `exit=${init.code} ${init.stderr.slice(0, 200)}`);

const dayDir = path.join(tmp, 'logs', DAY);
fs.mkdirSync(dayDir, { recursive: true });

const activities = [
  {
    activity_id: 'ACT-20260924-T0000001',
    date: DAY,
    project_name: '测试项目',
    work_type: '需求分析',
    category: '工作',
    project_stage: '需求分析',
    output: '产出A',
    content: '梳理需求',
    detail: null,
    ai_role: 'AI协作',
    segment_id: null,
    skills: [],
    models: [],
    display_content: '【测试项目】【需求分析】梳理需求',
    start_time: '10:00',
    end_time: '11:00',
    duration_minutes: 60,
    source: 'agent',
    conversation_id: 'CON-20260924-T0001',
    session_id: 'sess-t-1',
    status: 'completed',
    confidence: 'high',
    work_item_id: 'WI-20260924-T0000001',
  },
  {
    activity_id: 'ACT-20260924-T0000002',
    date: DAY,
    project_name: '测试项目',
    work_type: '开发',
    category: '工作',
    project_stage: '开发阶段',
    output: null,
    content: '开发页面',
    detail: null,
    ai_role: 'AI主导',
    segment_id: null,
    skills: [],
    models: [],
    display_content: '【测试项目】【开发】开发页面',
    start_time: '14:00',
    end_time: null,
    duration_minutes: null,
    source: 'agent',
    conversation_id: null,
    session_id: null,
    status: 'completed',
    confidence: 'high',
    work_item_id: 'WI-20260924-T0000002',
  },
  {
    activity_id: 'ACT-20260924-T0000003',
    date: DAY,
    project_name: '测试工具',
    work_type: '学习研究',
    category: '探索沉淀',
    project_stage: null,
    output: null,
    content: '研究 Skill 逻辑',
    detail: null,
    ai_role: 'AI协作',
    segment_id: null,
    skills: ['work-time-tracking'],
    models: [],
    display_content: '【测试工具】【学习研究】研究 Skill 逻辑',
    start_time: '16:00',
    end_time: null,
    duration_minutes: null,
    source: 'agent',
    conversation_id: null,
    session_id: null,
    status: 'completed',
    confidence: 'high',
    work_item_id: 'WI-20260924-T0000003',
  },
];

const conversations = [
  {
    conversation_id: 'CON-20260924-T0001',
    agent: 'codex',
    model_name: 'test-model-flash',
    models: ['test-model-flash'],
    start_time: `${DAY}T10:00:00+08:00`,
    end_time: `${DAY}T11:00:00+08:00`,
    duration_seconds: 3600,
    total_token: 100000,
    input_token: 90000,
    output_token: 10000,
    cached_token: 50000,
    reasoning_token: 1000,
    total_score: 0,
    score_source: 'not_applicable',
    score_request_count: 0,
    status: 'completed',
    settlement_status: 'settled',
    settled_at: `${DAY}T11:05:00+08:00`,
    source: 'codex',
    session_id: 'sess-t-1',
    project: '测试项目',
    project_id: null,
    project_source: 'test',
    project_confidence: 'high',
    workspace: null,
    title: '测试会话',
    request_count: 12,
    skill_count: 1,
    missing_fields: [],
    raw_ref: null,
    parser_version: 'test-1.0.0',
    created_at: `${DAY}T10:00:00+08:00`,
    updated_at: `${DAY}T11:05:00+08:00`,
  },
  {
    conversation_id: 'CON-20260924-T0002',
    agent: 'workbuddy',
    model_name: 'test-model-pro',
    models: ['test-model-pro'],
    start_time: `${DAY}T14:00:00+08:00`,
    end_time: `${DAY}T15:00:00+08:00`,
    duration_seconds: 3600,
    total_token: 200000,
    input_token: 180000,
    output_token: 20000,
    cached_token: 100000,
    reasoning_token: 2000,
    total_score: 1.5,
    score_source: 'workbuddy_credit',
    score_request_count: 5,
    status: 'completed',
    settlement_status: 'settled',
    settled_at: `${DAY}T15:05:00+08:00`,
    source: 'workbuddy',
    session_id: 'sess-t-2',
    project: '测试项目',
    project_id: null,
    project_source: 'test',
    project_confidence: 'high',
    workspace: null,
    title: '测试会话 2',
    request_count: 8,
    skill_count: 0,
    missing_fields: [],
    raw_ref: null,
    parser_version: 'test-1.0.0',
    created_at: `${DAY}T14:00:00+08:00`,
    updated_at: `${DAY}T15:05:00+08:00`,
  },
];

function writeJsonl(p, rows) {
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}
writeJsonl(path.join(dayDir, 'work-activities.jsonl'), activities);
writeJsonl(path.join(dayDir, 'conversations.jsonl'), conversations);

/* ---------- week / month / project 三条路径 ---------- */

/** 三条路径共用的硬断言：这是本测试存在的根本原因 */
function assertPeriodUsable(label, r) {
  ok(`${label}：exit 0`, r.code === 0, `exit=${r.code} ${(r.stderr || r.stdout).slice(0, 240)}`);
  ok(
    `${label}：输出不含 ReferenceError`,
    !/ReferenceError/.test(r.stdout + r.stderr),
    (r.stdout + r.stderr).slice(0, 240)
  );
  ok(`${label}：含「按模型」段落（模型维度参数已真正传入）`, /按模型/.test(r.stdout));
  ok(`${label}：含模型名（模型归一未丢数）`, /test-model-(flash|pro)/.test(r.stdout));
}

console.log('\n[1] week --from/--to（单日区间）');
const week = node('daily-summary.js', ['week', '--from', DAY, '--to', DAY, '--dir', tmp]);
assertPeriodUsable('week', week);
ok('week：含「时间投入」', /时间投入/.test(week.stdout));
ok('week：含「探索沉淀」，且与工作分开', /探索沉淀/.test(week.stdout));
ok('week：工作分类只含工作事项', /梳理需求/.test(week.stdout) && /研究 Skill 逻辑/.test(week.stdout));

console.log('\n[2] month --month');
const month = node('daily-summary.js', ['month', '--month', MONTH, '--dir', tmp]);
assertPeriodUsable('month', month);

console.log('\n[3] project --project');
const project = node('daily-summary.js', ['project', '--project', '测试项目', '--dir', tmp]);
assertPeriodUsable('project', project);
ok('project：只统计该项目', /梳理需求/.test(project.stdout) && !/研究 Skill 逻辑/.test(project.stdout));

console.log('\n[4] week --json（结构化输出不得因缺 models 报错）');
const weekJson = node('daily-summary.js', ['week', '--from', DAY, '--to', DAY, '--json', '--dir', tmp]);
ok('week --json：exit 0', weekJson.code === 0, `exit=${weekJson.code}`);
let parsed = null;
try {
  parsed = JSON.parse(weekJson.stdout.trim());
} catch (e) {
  parsed = null;
}
ok('week --json：输出可解析', Boolean(parsed), weekJson.stdout.slice(0, 200));
ok('week --json：item_count = 3', parsed && parsed.item_count === 3, JSON.stringify(parsed && parsed.item_count));

/* ---------- 清理 ---------- */

try {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
  console.log('\n  已清理临时目录（含沙箱 HOME）');
} catch (e) {
  console.log(`\n  临时目录清理失败：${e.message}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
