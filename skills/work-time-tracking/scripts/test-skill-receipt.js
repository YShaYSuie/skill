#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
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

const turns = [
  {
    turn_id: 'TURN-1',
    provider_turn_id: 'host-turn-1',
    conversation_id: 'CON-1',
    ordinal: 0,
  },
  {
    turn_id: 'TURN-2',
    provider_turn_id: 'host-turn-2',
    conversation_id: 'CON-1',
    ordinal: 1,
  },
];

const usages = [
  {
    usage_id: 'SU-1',
    conversation_id: 'CON-1',
    turn_id: 'TURN-1',
    provider_turn_id: 'host-turn-1',
    event_ordinal: 1,
    skill_id: 'openai-docs',
    evidence: 'explicit_invocation',
    start_time: '2026-09-28T10:00:01+08:00',
  },
  {
    usage_id: 'SU-2',
    conversation_id: 'CON-1',
    turn_id: 'TURN-1',
    provider_turn_id: 'host-turn-1',
    event_ordinal: 2,
    skill_id: 'openai-docs',
    evidence: 'skill_md_loaded',
    start_time: '2026-09-28T10:00:02+08:00',
  },
  {
    usage_id: 'SU-3',
    conversation_id: 'CON-1',
    turn_id: 'TURN-1',
    provider_turn_id: 'host-turn-1',
    event_ordinal: 3,
    skill_id: 'spreadsheets',
    evidence: 'skill_md_loaded',
    start_time: '2026-09-28T10:00:03+08:00',
  },
  {
    usage_id: 'SU-4',
    conversation_id: 'CON-1',
    turn_id: 'TURN-2',
    provider_turn_id: 'host-turn-2',
    event_ordinal: 1,
    skill_id: 'work-time-tracking',
    evidence: 'skill_md_loaded',
    start_time: '2026-09-28T10:05:00+08:00',
  },
  {
    usage_id: 'SU-OLD',
    conversation_id: 'CON-1',
    turn_id: null,
    event_ordinal: null,
    skill_id: 'legacy-skill',
    evidence: 'skill_md_loaded',
    start_time: '2026-09-28T10:06:00+08:00',
  },
];

process.stdout.write('test-skill-receipt.js — Skill Receipt 派生视图回归测试\n');

check('每个 Turn 独立生成回执，不串轮', () => {
  const views = SKR.buildTurnReceipts(turns, usages);
  assert.strictEqual(views.length, 2);
  assert.deepStrictEqual(
    views[0].final.skills.map((s) => s.skill_id),
    ['openai-docs', 'spreadsheets']
  );
  assert.deepStrictEqual(
    views[1].final.skills.map((s) => s.skill_id),
    ['work-time-tracking']
  );
});

check('最终回执按 skill_id 去重，但保留调用次数', () => {
  const [view] = SKR.buildTurnReceipts(turns, usages);
  assert.strictEqual(view.final.distinct_skill_count, 2);
  assert.strictEqual(view.final.invocation_count, 3);
  const docs = view.final.skills.find((s) => s.skill_id === 'openai-docs');
  assert.strictEqual(docs.invocation_count, 2);
  assert.deepStrictEqual(docs.evidence, ['explicit_invocation', 'skill_md_loaded']);
  assert.deepStrictEqual(docs.usage_ids, ['SU-1', 'SU-2']);
});

check('中间快照按 event_ordinal 累计', () => {
  const [view] = SKR.buildTurnReceipts(turns, usages);
  assert.strictEqual(view.snapshots.length, 4);
  assert.strictEqual(view.snapshots[0].distinct_skill_count, 0);
  assert.deepStrictEqual(
    view.snapshots[1].skills.map((s) => s.skill_id),
    ['openai-docs']
  );
  assert.strictEqual(view.snapshots[2].invocation_count, 2);
  assert.deepStrictEqual(
    view.snapshots[3].skills.map((s) => s.skill_id),
    ['openai-docs', 'spreadsheets']
  );
});

check('无 turn_id 的历史 Skill Usage 不进入回执，也不报错', () => {
  const views = SKR.buildTurnReceipts(turns, usages);
  for (const view of views) {
    assert.ok(!view.final.skills.some((s) => s.skill_id === 'legacy-skill'));
  }
});

check('缺少 turn_id 时拒绝生成回执', () => {
  assert.throws(() => SKR.buildTurnReceipt({ conversation_id: 'CON-1' }, []), /turn_id/);
});

process.stdout.write(`\n结果：${passed} 通过，${failed} 失败（共 ${passed + failed} 项）\n`);
if (failed) {
  failures.forEach((f) => process.stdout.write(`  ✗ ${f.name}\n      ${f.error}\n`));
  process.exitCode = 1;
}
