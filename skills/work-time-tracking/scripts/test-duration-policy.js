#!/usr/bin/env node
'use strict';
/**
 * test-duration-policy.js — 时长口径回归测试（V3.24，用户 2026-09-28）。
 *
 * 被固化的决定：**AI 生成记录不产出时长**。
 *   AI 会话推导出的时刻（首个相关消息、会话收尾、批量封段时刻）都不代表真实工作时长，
 *   因此非 manual 来源的 `actual_duration` 恒为 null，并带 `duration_source` 说明原因。
 *
 * 覆盖：
 *   ① recalc 的分档规则（来源优先于「有没有 end_time」）+ 确定性（不依赖 now）
 *   ② unionMinutes 不再用 now 补开放段
 *   ③ Work Activity 侧：duration_minutes 为 null 而非 0、duration_source 随行落库
 *   ④ validate-log 的新不变量（AI 不得带时长 / duration_source 枚举 / live 不得落盘）
 *
 * 进程内调用，不 spawn（受限沙箱禁止 node 派生 node：spawnSync → EBUSY）。
 *
 *   node scripts/test-duration-policy.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require(path.join(__dirname, 'lib', 'log-core.js'));
const EX = require(path.join(__dirname, 'export-work-activities.js'));
const VL = require(path.join(__dirname, 'validate-log.js'));

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

const AI_SOURCES = ['codex', 'workbuddy', 'auto', 'generic', 'other'];
const NOW_1 = 9 * 60 + 30; // 09:30
const NOW_2 = 21 * 60 + 4; // 21:04 —— 与 NOW_1 差 11 小时，用来证明「不依赖 now」

function rec(over) {
  return Object.assign(
    {
      id: 'WI-T-1',
      date: '2026-09-20',
      content: '测试事项',
      project_name: null,
      work_type: null,
      category: '工作',
      source: 'manual',
      status: 'completed',
      start_time: '09:00',
      end_time: null,
      actual_duration: null,
      time_segments: [],
      time_unknown: false,
    },
    over || {}
  );
}

/* ---------- 1. AI 来源：不产出时长 ---------- */

console.log('\n[1] AI 来源不产出时长（即使带 end_time / 闭合时段）');

for (const src of AI_SOURCES) {
  const r = rec({
    source: src,
    start_time: '09:00',
    end_time: '09:30',
    time_segments: [{ start: '09:00', end: '09:30' }],
    actual_duration: 30,
  });
  C.recalc(r, NOW_1, false);
  ok(`${src}：时长置 null`, r.actual_duration === null, String(r.actual_duration));
  ok(`${src}：来源标为 not_applicable_ai_session`, r.duration_source === 'not_applicable_ai_session');
  ok(`${src}：起始时间保留（不丢时间）`, r.start_time === '09:00' && r.end_time === '09:30');
}

const aiLive = rec({
  source: 'codex',
  time_segments: [{ start: '09:00', end: null }],
});
C.recalc(aiLive, NOW_2, true);
ok('AI 来源即使 live 也不产出时长', aiLive.actual_duration === null && aiLive.duration_source === 'not_applicable_ai_session');

/* ---------- 2. manual：只算闭合时段，且不依赖 now ---------- */

console.log('\n[2] manual 来源：只算闭合时段');

const mClosed = rec({ time_segments: [{ start: '09:00', end: '09:30' }, { start: '10:00', end: '10:15' }] });
C.recalc(mClosed, NOW_1, false);
ok('闭合时段求和 = 45 分钟', mClosed.actual_duration === 45, String(mClosed.actual_duration));
ok('来源标为 segments', mClosed.duration_source === 'segments');

const mOpen = rec({ time_segments: [{ start: '09:00', end: null }], start_time: '09:00' });
C.recalc(mOpen, NOW_1, false);
const openMin1 = mOpen.actual_duration;
C.recalc(mOpen, NOW_2, false);
const openMin2 = mOpen.actual_duration;
ok('开放式：时长 null', openMin1 === null, String(openMin1));
ok('开放式：来源标为 open_segment', mOpen.duration_source === 'open_segment');
ok('开放式：**确定性** —— 换 now 结果不变（旧实现会给出 30 分 vs 724 分）', openMin1 === openMin2);

const mMixed = rec({ time_segments: [{ start: '09:00', end: '09:30' }, { start: '11:00', end: null }] });
C.recalc(mMixed, NOW_2, false);
ok('混合：只算闭合部分 = 30 分钟', mMixed.actual_duration === 30, String(mMixed.actual_duration));
ok('混合：来源标为 segments_partial', mMixed.duration_source === 'segments_partial');

const mSE = rec({ start_time: '09:00', end_time: '09:40', time_segments: [] });
C.recalc(mSE, NOW_1, false);
ok('manual 无片段但有 start+end：按区间计时 40 分钟', mSE.actual_duration === 40, String(mSE.actual_duration));

const mNone = rec({ start_time: null, end_time: null, time_segments: [], time_unknown: true });
C.recalc(mNone, NOW_1, false);
ok('无任何时间：null + unknown', mNone.actual_duration === null && mNone.duration_source === 'unknown');

const mIP = rec({ status: 'in_progress', time_segments: [{ start: '09:00', end: null }] });
C.recalc(mIP, NOW_1, false);
ok('manual 进行中（非 live）：不落盘易变耗时', mIP.actual_duration === null);

const mLive = rec({ status: 'in_progress', time_segments: [{ start: '09:00', end: null }] });
C.recalc(mLive, 9 * 60 + 45, true);
ok('manual 进行中 live：按 now 现算 45 分钟', mLive.actual_duration === 45, String(mLive.actual_duration));
ok('live 标注为 live（据此禁止落盘）', mLive.duration_source === 'live');

const mLiveMixed = rec({ time_segments: [{ start: '09:00', end: '09:30' }, { start: '10:00', end: null }] });
C.recalc(mLiveMixed, 10 * 60 + 20, true);
ok('live 混合 = 闭合 30 + 开放 20 = 50 分钟', mLiveMixed.actual_duration === 50, String(mLiveMixed.actual_duration));

/* ---------- 3. unionMinutes 不再用 now 补开放段 ---------- */

console.log('\n[3] unionMinutes');
const u = [
  rec({ time_segments: [{ start: '09:00', end: '10:00' }] }),
  rec({ time_segments: [{ start: '09:30', end: null }] }),
];
ok('开放段不计入（重叠合并后 = 60 分钟）', C.unionMinutes(u) === 60, String(C.unionMinutes(u)));
ok('换 now 结果不变', C.unionMinutes(u) === C.unionMinutes(u));

/* ---------- 4. 归一化：脏值处置 ---------- */

console.log('\n[4] normalizeItem / 归一化');
const dirty = rec({ duration_source: '瞎写的值' });
C.normalizeItem(dirty);
ok('duration_source 脏值 → null', dirty.duration_source === null, JSON.stringify(dirty.duration_source));
const good = rec({ duration_source: 'open_segment' });
C.normalizeItem(good);
ok('duration_source 合法值保留', good.duration_source === 'open_segment');

/* ---------- 5. Work Activity 侧：null ≠ 0，且携带 duration_source ---------- */

console.log('\n[5] Work Activity：duration_minutes 与 duration_source');

const aiWi = rec({ id: 'WI-AI', source: 'codex', time_segments: [{ start: '09:00', end: null }] });
C.recalc(aiWi, NOW_1, false);
const aiAct = EX.toActivity(aiWi, {});
ok('AI 事项导出：duration_minutes 为 null（不是 0）', aiAct.duration_minutes === null, JSON.stringify(aiAct.duration_minutes));
ok('AI 事项导出：duration_source 随行', aiAct.duration_source === 'not_applicable_ai_session');

const manWi = rec({ id: 'WI-MAN', time_segments: [{ start: '09:00', end: '09:30' }] });
C.recalc(manWi, NOW_1, false);
const manAct = EX.toActivity(manWi, {});
ok('人工事项导出：45→时长 30 分钟', manAct.duration_minutes === 30, String(manAct.duration_minutes));
ok('人工事项导出：duration_source=segments', manAct.duration_source === 'segments');

/* ---------- 6. validate-log 的新不变量 ---------- */

console.log('\n[6] validate-log 不变量');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-dur-'));
const cfg = path.join(__dirname, '..', 'templates', 'config.json');
fs.copyFileSync(cfg, path.join(dir, 'config.json'));
fs.writeFileSync(
  path.join(dir, '.log-manifest.json'),
  JSON.stringify({ type: C.MANIFEST_TYPE, version: C.MANIFEST_VERSION, log_id: 'log_test000' }),
  'utf-8'
);
fs.writeFileSync(
  path.join(dir, 'current.json'),
  JSON.stringify({ date: '2026-09-28', version: 1, records: [], pending_items: [], sync: { status: 'pending' } }),
  'utf-8'
);

function seedActivity(rows) {
  const d = path.join(dir, 'logs', '2026-09-28');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'work-activities.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
}
function baseAct(over) {
  return Object.assign(
    {
      activity_id: 'ACT-20260928-AAAAAAA1',
      date: '2026-09-28',
      project_name: null,
      work_type: null,
      category: '工作',
      project_stage: null,
      output: null,
      content: '测试事项',
      detail: null,
      detail_compression: null,
      ai_role: null,
      segment_id: null,
      skills: [],
      models: [],
      display_content: '【其他】测试事项',
      log: '【其他】测试事项',
      log_length: 8,
      start_time: '09:00',
      end_time: null,
      duration_minutes: null,
      duration_source: 'not_applicable_ai_session',
      source: 'agent',
      conversation_id: null,
      status: 'completed',
      confidence: 'high',
      classification_status: 'confirmed',
      confirmed_at: null,
      confirmed_by: null,
      work_item_id: 'WI-20260928-AAAAAAA1',
      session_id: null,
      created_at: '2026-09-28T10:00:00+08:00',
      updated_at: '2026-09-28T10:00:00+08:00',
      ticktick: null,
    },
    over || {}
  );
}

seedActivity([baseAct()]);
const clean = VL.runValidate(dir, false);
ok('合规数据：无 duration 类问题', !clean.problems.some((p) => /duration|时长/.test(p)), clean.problems.join(' | ').slice(0, 200));

seedActivity([baseAct({ duration_minutes: 446 })]);
const bad1 = VL.runValidate(dir, false);
ok('AI 记录带时长 → 报 problem', bad1.problems.some((p) => /非人工来源不得产出时长/.test(p)), bad1.problems.join(' | ').slice(0, 200));

seedActivity([baseAct({ duration_source: 'whatever' })]);
const bad2 = VL.runValidate(dir, false);
ok('duration_source 非法 → 报 problem', bad2.problems.some((p) => /duration_source 非法/.test(p)), bad2.problems.join(' | ').slice(0, 200));

seedActivity([baseAct({ duration_source: 'live' })]);
const bad3 = VL.runValidate(dir, false);
ok('duration_source=live 落盘 → 报 problem', bad3.problems.some((p) => /live 不得落盘/.test(p)), bad3.problems.join(' | ').slice(0, 200));

seedActivity([baseAct({ source: 'manual', duration_minutes: 30, duration_source: 'segments', end_time: '09:30', start_time: '09:00' })]);
const goodAct = VL.runValidate(dir, false);
ok('人工 + 闭合时段 → 不报 duration 类问题', !goodAct.problems.some((p) => /duration|时长/.test(p)), goodAct.problems.join(' | ').slice(0, 200));

try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch (e) {
  console.log(`  临时目录清理失败：${e.message}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
