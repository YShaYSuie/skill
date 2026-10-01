'use strict';
/**
 * skill-receipt.js — 由 Turn 与 Skill Usage 事件派生的只读回执视图。
 *
 * 这里不写任何事实日志：
 *   fact       skill-usage.jsonl
 *   turn total turns.jsonl
 *   receipt   本模块在读取时 join + 去重 + 排序
 *
 * 回执只回答两个问题：
 *   1. 某个 turn 截至某个事件位置用了哪些不同 Skill；
 *   2. 某个 turn 最终用了哪些不同 Skill。
 */

function eventOrder(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sortEvents(events) {
  return (events || [])
    .slice()
    .sort(
      (a, b) =>
        eventOrder(a.event_ordinal, Number.MAX_SAFE_INTEGER) -
          eventOrder(b.event_ordinal, Number.MAX_SAFE_INTEGER) ||
        String(a.start_time || '').localeCompare(String(b.start_time || '')) ||
        String(a.usage_id || '').localeCompare(String(b.usage_id || ''))
    );
}

function buildReceiptFromEvents(turn, events, options) {
  const opts = options || {};
  const phase = opts.phase === 'intermediate' ? 'intermediate' : 'final';
  const cutoff = Number.isFinite(Number(opts.upToEventOrdinal))
    ? Number(opts.upToEventOrdinal)
    : null;
  const eligible = events.filter(
    (event) => cutoff === null || eventOrder(event.event_ordinal, 0) <= cutoff
  );
  const bySkill = new Map();
  for (const event of eligible) {
    const skillId = String(event.skill_id || '').trim();
    if (!skillId) continue;
    if (!bySkill.has(skillId)) {
      bySkill.set(skillId, {
        skill_id: skillId,
        invocation_count: 0,
        evidence: new Set(),
        usage_ids: [],
        first_seen_at: null,
        last_seen_at: null,
      });
    }
    const row = bySkill.get(skillId);
    row.invocation_count += 1;
    if (event.evidence) row.evidence.add(String(event.evidence));
    if (event.usage_id) row.usage_ids.push(String(event.usage_id));
    if (event.start_time && !row.first_seen_at) row.first_seen_at = event.start_time;
    if (event.start_time) row.last_seen_at = event.start_time;
  }
  const skills = [...bySkill.values()]
    .map((row) => ({
      skill_id: row.skill_id,
      invocation_count: row.invocation_count,
      evidence: [...row.evidence].sort(),
      usage_ids: row.usage_ids,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
    }))
    .sort((a, b) => a.skill_id.localeCompare(b.skill_id));

  return {
    conversation_id: turn.conversation_id,
    turn_id: turn.turn_id,
    provider_turn_id: turn.provider_turn_id || null,
    turn_ordinal: Number.isFinite(Number(turn.ordinal)) ? Number(turn.ordinal) : null,
    phase,
    up_to_event_ordinal: cutoff,
    skills,
    distinct_skill_count: skills.length,
    invocation_count: eligible.length,
  };
}

/**
 * 为单个 turn 生成最终回执或截至某个事件序号的中间回执。
 */
function buildTurnReceipt(turn, skillUsages, options) {
  if (!turn || !turn.turn_id) {
    throw new Error('buildTurnReceipt 需要带 turn_id 的 Turn。');
  }
  const events = sortEvents(
    (skillUsages || []).filter(
      (event) =>
        String(event.turn_id || '') === String(turn.turn_id) ||
        (turn.provider_turn_id &&
          String(event.provider_turn_id || '') === String(turn.provider_turn_id))
    )
  );
  return buildReceiptFromEvents(turn, events, options);
}

/**
 * 为一个 Conversation 的全部 Turn 生成只读回执视图。
 *
 * 每个 Turn 返回：
 *   - final：本轮最终去重后的 Skill 集合
 *   - snapshots：初始空回执 + 每个事件后的“截至本条”回执
 */
function buildTurnReceipts(turns, skillUsages) {
  const list = (turns || []).slice().sort((a, b) => {
    const ao = Number.isFinite(Number(a.ordinal)) ? Number(a.ordinal) : 0;
    const bo = Number.isFinite(Number(b.ordinal)) ? Number(b.ordinal) : 0;
    return ao - bo;
  });
  return list.map((turn) => {
    const events = sortEvents(
      (skillUsages || []).filter(
        (event) =>
          String(event.turn_id || '') === String(turn.turn_id) ||
          (turn.provider_turn_id &&
            String(event.provider_turn_id || '') === String(turn.provider_turn_id))
      )
    );
    const snapshots = [
      buildReceiptFromEvents(turn, events, {
        phase: 'intermediate',
        upToEventOrdinal: -1,
      }),
    ];
    for (const event of events) {
      snapshots.push(
        buildReceiptFromEvents(turn, events, {
          phase: 'intermediate',
          upToEventOrdinal: eventOrder(event.event_ordinal, 0),
        })
      );
    }
    return {
      turn_id: turn.turn_id,
      provider_turn_id: turn.provider_turn_id || null,
      final: buildReceiptFromEvents(turn, events, { phase: 'final' }),
      snapshots,
    };
  });
}

module.exports = {
  buildTurnReceipt,
  buildTurnReceipts,
};
