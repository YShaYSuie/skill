'use strict';
/**
 * activity-link.js — 把 Work Activity 挂回它所属的 Conversation（V3.4 新增）。
 *
 * ## 解决什么问题
 *
 * AI 成本归因**只有一个入口**：`Work Activity.conversation_id`。
 * 没有它，「这个项目花了多少 Token」就只能回答「不可获取」。
 *
 * 而数据链路此前是这样断的：
 *
 * ```text
 * Hook(session_id) → pending_items(session_id ✓)
 *      → [批量判定回写]  ← session_id 在这里被丢掉
 *      → WorkItem(无 session_id) → export → Work Activity(conversation_id: null)
 * ```
 *
 * 本模块负责把这条链补上，并且**只在有证据时**才建立关联：
 *
 * ```text
 * 证据 = 事项自身带的 session_id（宿主原生键）
 * 关联 = 该 session_id 在 Conversation Log 里**确实存在**
 * 两者缺一 → conversation_id 保持 null（不推断、不用时间/项目名去凑）
 * ```
 *
 * ## 为什么要「先查日志」而不是直接算 ID
 *
 * `conversation_id` 确实可以由 `session_id` 确定性派生，但派生式里含**日期**：
 *
 * ```text
 * CON-<YYYYMMDD>-<sha1(session_id)[0:8] 大写>
 * ```
 *
 * 会话可以跨天存活（9-01 建、9-21 还在用），事项的发生日未必等于会话的归档日。
 * 用事项日期去算会得到**一个不存在的 ID** —— 那不是关联，是编造。
 * 因此一律以「Conversation Log 里实际存在的那条」为准。
 */

const CS = require('./conversation-store');

/**
 * 建立 `session_id → conversation_id` 索引。
 *
 * 来源是**已经结算落盘的 Conversation Log**（`logs/<date>/conversations.jsonl`），
 * 因此天然只包含「确实存在的对话」。
 *
 * @param {string} dir 日志目录
 * @param {object} [opts] { dates } 限定日期，缺省扫描全部已记录的日期
 * @returns {{index:Object<string,string>, dates:string[], scanned:number}}
 */
function buildSessionConversationIndex(dir, opts) {
  const o = opts || {};
  const dates = Array.isArray(o.dates) && o.dates.length ? o.dates : CS.listLoggedDates(dir);
  const index = {};
  let scanned = 0;
  for (const date of dates) {
    let rows = [];
    try {
      rows = CS.read(dir, 'conversation', date);
    } catch (e) {
      continue; // 该日目录损坏 → 跳过，不影响其余日期
    }
    for (const r of rows) {
      if (!r || !r.session_id || !r.conversation_id) continue;
      const sid = String(r.session_id);
      // 同一 session 理论上只结算一次；真出现多条时保留**最早**那条，
      // 避免后来的重复记录把已经建立的关联指到别处。
      if (!index[sid]) index[sid] = String(r.conversation_id);
      scanned += 1;
    }
  }
  return { index, dates, scanned };
}

/** 拿一个 session_id 的 conversation_id（查不到返回 null，绝不派生） */
function conversationIdOf(sessionId, index) {
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  const hit = index && index[sid];
  return hit ? String(hit) : null;
}

/**
 * 扫描所有日期的 Work Activity 日志，把「有 session_id 但没 conversation_id」
 * 的记录补上关联（幂等：内容没变不动时间戳）。
 *
 * @param {string} dir 日志目录
 * @param {object} [opts]
 *   `dryRun` 只报告不写盘
 *   `onlySessionId` 只处理某个会话（结算后调用，避免全量扫描的开销与写放大）
 *   `knownConversationId` 调用方**已经知道**的 conversation_id
 *     （结算场景必备：省掉整份索引的构建，Hook 热路径上这个差别很实在）
 *   `index` 复用外部已建好的索引
 * @returns {object} 报告：`{ok, scanned, linked, already_linked, no_evidence, unresolved, updated, unchanged, dates}`
 */
function relinkActivities(dir, opts) {
  const o = opts || {};
  const report = {
    ok: true,
    scanned: 0,
    // 本次新建立关联的条数
    linked: 0,
    // 早就有 conversation_id 的（含本次修复前就对的）
    already_linked: 0,
    // 连 session_id 都没有 —— 无证据，永远无法回链（如实计数，不硬凑）
    no_evidence: 0,
    // 有 session_id 但 Conversation Log 里查不到（会话还没结算 / 已超出本地日志）
    unresolved: 0,
    updated: 0,
    unchanged: 0,
    dates: [],
    unresolved_sessions: [],
  };

  // 结算后调用时光标明确（唯一的 session ↔ 唯一的 conversation_id），
  // 不必为了查一个已知答案去读遍所有会话日志。
  const direct =
    o.onlySessionId && o.knownConversationId
      ? { sid: String(o.onlySessionId), cid: String(o.knownConversationId) }
      : null;
  const index = direct ? null : (o.index || buildSessionConversationIndex(dir, o).index);

  const dates = Array.isArray(o.dates) && o.dates.length ? o.dates : CS.listLoggedDates(dir);
  report.dates = dates;

  const unresolvedSet = new Set();
  const byDate = new Map();

  for (const date of dates) {
    let rows = [];
    try {
      rows = CS.read(dir, 'work_activity', date);
    } catch (e) {
      continue;
    }
    const patched = [];
    for (const a of rows) {
      if (!a) continue;
      report.scanned += 1;
      if (a.conversation_id) {
        report.already_linked += 1;
        continue;
      }
      const sid = a.session_id ? String(a.session_id) : '';
      if (o.onlySessionId && sid !== String(o.onlySessionId)) continue;
      if (!sid) {
        report.no_evidence += 1;
        continue;
      }
      const cid = direct ? (sid === direct.sid ? direct.cid : null) : conversationIdOf(sid, index);
      if (!cid) {
        report.unresolved += 1;
        unresolvedSet.add(sid);
        continue;
      }
      report.linked += 1;
      patched.push(Object.assign({}, a, { conversation_id: cid }));
    }
    if (patched.length) byDate.set(date, patched);
  }

  report.unresolved_sessions = [...unresolvedSet];

  if (o.dryRun) {
    report.dry_run = true;
    return report;
  }

  for (const [date, records] of byDate) {
    try {
      const written = CS.upsertWorkActivity(dir, records, { date });
      report.updated += written.updated || 0;
      report.unchanged += written.unchanged || 0;
    } catch (e) {
      report.ok = false;
      report.error = String((e && e.message) || e);
      break;
    }
  }
  return report;
}

/**
 * 结算后调用：把本次会话的关联补到已有事项上。
 *
 * **只处理刚结算的这一个会话** —— 不做全量扫描、不构建整份索引，
 * 避免每次对话结束都重写历史文件（Hook 热路径上这个差别很实在）。
 *
 * @param {object} [opts] `{ conversationId, ... }` —— 结算时 conversation_id 是已知的
 * @returns {object} 与 `relinkActivities` 同形
 */
function linkActivitiesForSession(dir, sessionId, opts) {
  return relinkActivities(dir, Object.assign({ onlySessionId: sessionId }, opts || {}));
}

/**
 * 把当前 DailyLog 里带 session_id 的 WorkItem 直接标上 conversation_id。
 *
 * 与 `linkActivitiesForSession` 的区别：这里改的是 `current.json`（WorkItem），
 * 让「还没导出的事项」在导出前就带着关联，导出时无需再查。
 * 同样只在 Conversation Log 里确实存在时才写。
 */
function linkWorkItems(dir, opts) {
  const o = opts || {};
  const C = require('./log-core');
  const report = { ok: true, scanned: 0, linked: 0, unresolved: 0, no_evidence: 0, patched: 0 };
  const direct =
    o.onlySessionId && o.knownConversationId
      ? { sid: String(o.onlySessionId), cid: String(o.knownConversationId) }
      : null;
  const index = direct ? null : (o.index || buildSessionConversationIndex(dir, o).index);

  let log;
  try {
    log = C.readJSON(C.currentPath(dir), null);
  } catch (e) {
    return Object.assign(report, { ok: false, error: String((e && e.message) || e) });
  }
  if (!log || !Array.isArray(log.records)) {
    return Object.assign(report, { ok: false, error: 'current.json 不可读或缺少 records' });
  }

  const ops = [];
  for (const rec of log.records) {
    report.scanned += 1;
    if (rec.conversation_id) continue;
    const sid = rec.session_id ? String(rec.session_id) : '';
    if (o.onlySessionId && sid !== String(o.onlySessionId)) continue;
    if (!sid) {
      report.no_evidence += 1;
      continue;
    }
    const cid = direct ? (sid === direct.sid ? direct.cid : null) : conversationIdOf(sid, index);
    if (!cid) {
      report.unresolved += 1;
      continue;
    }
    report.linked += 1;
    ops.push({ kind: 'patch', id: rec.id, set: { conversation_id: cid } });
  }

  if (o.dryRun) return Object.assign(report, { dry_run: true });
  if (!ops.length) return report;
  try {
    C.runMutation(dir, 'workbuddy', ops, {});
    report.patched = ops.length;
  } catch (e) {
    report.ok = false;
    report.error = String((e && e.message) || e);
  }
  return report;
}

module.exports = {
  buildSessionConversationIndex,
  conversationIdOf,
  relinkActivities,
  linkActivitiesForSession,
  linkWorkItems,
};
