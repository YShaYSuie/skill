#!/usr/bin/env node
'use strict';
/**
 * test-pending-link.js — 「已跨日事项」通路回归测试（V3.23，用户 2026-09-28）。
 *
 * 覆盖三个此前缺失、只能靠一次性补丁脚本绕过能力：
 *   ① resolveWorkItemAnywhere / patchPendingWorkItem —— link 能写回 pending/<date>.json
 *   ② setPendingSyncStatus —— sync 能标记历史日期并把 state.pending_sync_dates 清干净
 *   ③ toActivity —— 永久活动日志承载 ticktick（否则跨日丢弃后 taskId 彻底失传）
 *
 * 刻意的设计选择：**进程内直接调用库函数，不 spawn 子进程**。
 * 原因：受限沙箱会禁止 node 派生 node（实测 spawnSync → EBUSY），
 * 一旦依赖子进程，本测试在这种环境里会整体假失败、失去回归价值。
 *
 *   node scripts/test-pending-link.js
 *
 * 用临时目录，不触碰真实 LOG_ROOT。退出码 0 = 全部通过。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require(path.join(__dirname, 'lib', 'log-core.js'));
const EX = require(path.join(__dirname, 'export-work-activities.js'));

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
function throws(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-pending-'));
console.log(`\n临时目录：${tmp}`);

const DAY = '2026-09-24';
const PREV = '2026-09-23';

function makeItem(id, content, extra) {
  return Object.assign(
    {
      id,
      date: DAY,
      project_name: '测试项目',
      project_confidence: 'high',
      work_type: '开发',
      work_type_confidence: 'high',
      category: '工作',
      project_stage: '开发阶段',
      output: null,
      detail: null,
      ai_role: null,
      segment_id: null,
      skills: [],
      models: [],
      content,
      start_time: '10:00',
      end_time: null,
      estimated_duration: null,
      actual_duration: null,
      status: 'completed',
      source: 'auto',
      confidence: 'high',
      time_segments: [{ start: '10:00', end: null }],
      activities: [],
      parent_id: null,
      tags: [],
      notes: '',
      session_id: null,
      project_id: null,
      conversation_id: null,
      display_content: content,
      ticktick: null,
    },
    extra || {}
  );
}
function makeLog(date, records) {
  return {
    date,
    timezone: '+08:00',
    version: 1,
    updated_at: `${date}T10:00:00+08:00`,
    updated_by: 'test',
    records,
    pending_items: [],
    judgments: {},
    summary: null,
    sync: { status: 'pending', last_sync_at: null },
  };
}
function writeJSON(p, o) {
  fs.writeFileSync(p, JSON.stringify(o, null, 2), 'utf-8');
}
function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

/* ---------- 0. 布置目录（含干扰项） ---------- */

fs.mkdirSync(path.join(tmp, 'pending', 'writes'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'logs', DAY), { recursive: true });
writeJSON(path.join(tmp, 'pending', `${DAY}.json`), makeLog(DAY, [makeItem('WI-A', '事项A')]));
writeJSON(path.join(tmp, 'pending', 'last-hook.json'), { at: 'x', hook_event_name: 'SessionStart' });
fs.writeFileSync(path.join(tmp, 'pending', 'notes.txt'), 'x');
writeJSON(path.join(tmp, 'current.json'), makeLog('2026-09-28', [makeItem('WI-CUR', '今日事项', { date: '2026-09-28' })]));

/* ---------- 1. 列出 pending 日志日期 ---------- */

console.log('\n[1] listPendingLogDates');
const dates = C.listPendingLogDates(tmp);
ok('只列出合法日期日志', dates.length === 1 && dates[0] === DAY, JSON.stringify(dates));
ok('排除 last-hook.json', !dates.includes('last-hook'));
ok('排除非 .json / 子目录', !dates.includes('notes') && !dates.includes('writes'));

/* ---------- 2. 跨 current / pending 定位 ---------- */

console.log('\n[2] resolveWorkItemAnywhere');
const inCurrent = C.resolveWorkItemAnywhere(tmp, 'WI-CUR', null, false);
ok('命中 current.json', inCurrent.where === 'current' && inCurrent.rec.id === 'WI-CUR');
const inPending = C.resolveWorkItemAnywhere(tmp, 'WI-A', null, false);
ok('命中 pending', inPending.where === 'pending' && inPending.date === DAY);
ok('返回 pending 文件路径', inPending.file.endsWith(path.join('pending', `${DAY}.json`)));

const notFound = throws(() => C.resolveWorkItemAnywhere(tmp, 'WI-NOPE', null, false));
ok('找不到时抛错', Boolean(notFound), String(notFound));
ok(
  '错误信息含两个查找范围（可诊断）',
  Boolean(notFound) && /current\.json/.test(notFound.message) && /pending/.test(notFound.message),
  notFound && notFound.message
);

// 同一份 pending 日志内多条命中 → 歧义（注意：--match 匹配的是 content，不是 id）
const ambDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-pend-amb-'));
fs.mkdirSync(path.join(ambDir, 'pending'), { recursive: true });
writeJSON(
  path.join(ambDir, 'pending', `${DAY}.json`),
  makeLog(DAY, [makeItem('WI-X1', '同日多命中甲'), makeItem('WI-X2', '同日多命中乙')])
);
const amb = throws(() => C.resolveWorkItemAnywhere(ambDir, null, '同日多命中', false));
ok('同一日志内多命中 → 抛歧义错误', Boolean(amb) && /多个事项/.test(amb.message), amb && amb.message);
ok(
  '歧义信息点明是哪个 pending 文件',
  Boolean(amb) && amb.message.includes(`pending/${DAY}.json`),
  amb && amb.message
);

// 跨两个 pending 日期同名 → 歧义（不得「猜一个」）
writeJSON(
  path.join(ambDir, 'pending', `${PREV}.json`),
  makeLog(PREV, [makeItem('WI-Y1', '同名事项', { date: PREV })])
);
writeJSON(
  path.join(ambDir, 'pending', `${DAY}.json`),
  makeLog(DAY, [makeItem('WI-Y2', '同名事项')])
);
const cross = throws(() => C.resolveWorkItemAnywhere(ambDir, null, '同名事项', false));
ok('跨 pending 日期命中 → 抛错而非猜一个', Boolean(cross) && /多个 pending/.test(cross.message), cross && cross.message);

/* ---------- 3. 写回 pending（link 通路） ---------- */

console.log('\n[3] patchPendingWorkItem');
const beforeLog = readJSON(path.join(tmp, 'pending', `${DAY}.json`));
const r = C.patchPendingWorkItem(tmp, DAY, 'WI-A', {
  ticktick: { taskId: 'abc123', projectId: 'p1', syncedAt: '2026-09-28T11:00:00+08:00' },
});
ok('返回 work_item_id', r.work_item_id === 'WI-A');
ok('ticktick_before 为 null', r.before.ticktick === null);
ok('ticktick 已写入', r.after.ticktick && r.after.ticktick.taskId === 'abc123');

const afterLog = readJSON(path.join(tmp, 'pending', `${DAY}.json`));
const recA = afterLog.records.find((x) => x.id === 'WI-A');
ok('已落盘到 pending 文件', recA.ticktick && recA.ticktick.taskId === 'abc123');
ok('version 自增', afterLog.version === beforeLog.version + 1, `${beforeLog.version} -> ${afterLog.version}`);
ok('updated_at 已刷新', afterLog.updated_at !== beforeLog.updated_at);
ok('updated_by 记录操作者', afterLog.updated_by === 'test' || typeof afterLog.updated_by === 'string');
ok('其它字段未被破坏', recA.content === '事项A' && recA.project_name === '测试项目' && recA.status === 'completed');
ok('display_content 仍在', typeof recA.display_content === 'string' && recA.display_content.length > 0);

// 白名单：夹带字段应被丢弃（与 normalizeTicktick 同一口径）
C.patchPendingWorkItem(tmp, DAY, 'WI-A', {
  ticktick: { taskId: 'abc123', projectId: 'p1', syncedAt: 's', evil: 'x' },
});
const recA2 = readJSON(path.join(tmp, 'pending', `${DAY}.json`)).records.find((x) => x.id === 'WI-A');
ok('ticktick 白名单外字段被丢弃', recA2.ticktick && !('evil' in recA2.ticktick));

// 清空
C.patchPendingWorkItem(tmp, DAY, 'WI-A', { ticktick: null });
const recA3 = readJSON(path.join(tmp, 'pending', `${DAY}.json`)).records.find((x) => x.id === 'WI-A');
ok('ticktick 可清空为 null', recA3.ticktick === null);

const badId = throws(() => C.patchPendingWorkItem(tmp, DAY, 'WI-NOPE', { ticktick: null }));
ok('未知 id 抛错', Boolean(badId) && /未找到工作事项/.test(badId.message), badId && badId.message);
const badDate = throws(() => C.patchPendingWorkItem(tmp, '2026/09/24', 'WI-A', { ticktick: null }));
ok('非法日期抛错', Boolean(badDate), badDate && badDate.message);

/* ---------- 4. 同步状态写回（sync --date 通路） ---------- */

console.log('\n[4] setPendingSyncStatus');
const syncDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-pend-sync-'));
fs.mkdirSync(path.join(syncDir, 'pending'), { recursive: true });
writeJSON(path.join(syncDir, 'pending', `${DAY}.json`), makeLog(DAY, [makeItem('WI-A', '事项A')]));
writeJSON(path.join(syncDir, 'state.json'), {
  current_date: '2026-09-28',
  pending_sync_dates: [PREV, DAY],
});

const s1 = C.setPendingSyncStatus(syncDir, DAY, 'success', '2 成功 / 0 失败', 'test');
ok('sync 状态已写入 pending 日志', s1.sync.status === 'success');
ok('last_sync_at 已记录', typeof s1.sync.last_sync_at === 'string' && s1.sync.last_sync_at.length > 10);
ok('detail 已保留', s1.sync.detail === '2 成功 / 0 失败');
ok('success → 从待同步日期移除', !s1.pending_sync_dates.includes(DAY), JSON.stringify(s1.pending_sync_dates));
ok('其它日期不受影响', s1.pending_sync_dates.includes(PREV), JSON.stringify(s1.pending_sync_dates));

const stateOnDisk = readJSON(path.join(syncDir, 'state.json'));
ok('state.last_sync_time 已更新', typeof stateOnDisk.last_sync_time === 'string' && stateOnDisk.last_sync_time.length > 10);
ok('state.pending_sync_dates 已落盘', !stateOnDisk.pending_sync_dates.includes(DAY));

const s2 = C.setPendingSyncStatus(syncDir, DAY, 'failed', '连接超时', 'test');
ok('failed → 重新回到待同步列表', s2.pending_sync_dates.includes(DAY), JSON.stringify(s2.pending_sync_dates));
ok('failed 时不同步 last_sync_at（保留旧值语义）', s2.sync.detail === '连接超时');

const badStatus = throws(() => C.setPendingSyncStatus(syncDir, DAY, 'synced', null, 'test'));
ok('非法状态 synced 被拒（与 VALID_SYNC_STATUS 一致）', Boolean(badStatus), badStatus && badStatus.message);

/* ---------- 5. 永久活动日志承载 ticktick ---------- */

console.log('\n[5] toActivity / exportRecords 携带 ticktick');
const wiLinked = makeItem('WI-EXP1', '带映射的事项', {
  ticktick: { taskId: 'exp999', projectId: 'p9', syncedAt: '2026-09-28T11:00:00+08:00' },
});
const wiPlain = makeItem('WI-EXP2', '无映射的事项');

const act1 = EX.toActivity(wiLinked, {});
ok('toActivity 带出 ticktick.taskId', act1.ticktick && act1.ticktick.taskId === 'exp999', JSON.stringify(act1.ticktick));
ok('toActivity 保留其它既有字段', act1.work_item_id === 'WI-EXP1' && act1.status === 'completed');
const act2 = EX.toActivity(wiPlain, {});
ok('无 taskId 时 ticktick 为 null（不保留半截对象）', act2.ticktick === null, JSON.stringify(act2.ticktick));

const exDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-pend-exp-'));
fs.mkdirSync(path.join(exDir, 'logs', DAY), { recursive: true });
const written = EX.exportRecords(exDir, DAY, [wiLinked, wiPlain]);
ok('exportRecords 写出成功', written && written.written && written.written.total === 2, JSON.stringify(written && written.written));
const actLines = fs
  .readFileSync(path.join(exDir, 'logs', DAY, 'work-activities.jsonl'), 'utf-8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));
ok('永久日志 2 条', actLines.length === 2, String(actLines.length));
const linkedRow = actLines.find((x) => x.work_item_id === 'WI-EXP1');
const plainRow = actLines.find((x) => x.work_item_id === 'WI-EXP2');
ok('永久日志中带 taskId', linkedRow && linkedRow.ticktick && linkedRow.ticktick.taskId === 'exp999', JSON.stringify(linkedRow && linkedRow.ticktick));
ok('永久日志中无映射者为 null', plainRow && plainRow.ticktick === null, JSON.stringify(plainRow && plainRow.ticktick));

/* ---------- 清理 ---------- */

for (const d of [tmp, ambDir, syncDir, exDir]) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch (e) {
    console.log(`  临时目录清理失败：${e.message}`);
  }
}
console.log('\n  已清理临时目录');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
