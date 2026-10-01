#!/usr/bin/env node
'use strict';
/**
 * settle-conversation.js — 对话结束后的**实时结算**（V3.0 新增，用户 §5/§14/§22 任务A）。
 *
 * ## 一句话定位
 *
 * > 一次 Agent 对话结束后**立即**把它结算成结构化日志，
 * > 而不是等到当天复盘再去翻历史对话。
 *
 * ```text
 * Conversation 结束
 *      ↓
 * 本脚本（纯脚本，零 LLM、零 token）
 *      ├── 解析 Conversation（Model / 起止时间 / Token / WorkBuddy Score）
 *      ├── 解析 Skill（用了哪些 Skill、各载入多少 token、版本）
 *      └── 写入结构化日志（幂等 upsert，重复跑不产生重复数据）
 *      ↓
 * Conversation Log + Skill Usage Log (+ Work Activity Log)
 * ```
 *
 * ## 它不做什么（用户 §8/§19/§23）
 *
 * - **不调用 LLM**：Token / Score / Skill 都是确定性数据，用脚本取。
 * - **不重新扫描历史**：每日复盘只读本脚本写入的结构化日志。
 * - **不计算「Skill 独占 token」**：拿不到就写 `null`，
 *   绝不用「总额 ÷ Skill 数」或按调用次数摊派（明令禁止）。
 * - **不自建定时器**：谁在什么时机调用本脚本由宿主决定（用户 §23）。
 *
 * ## 用法
 *
 * ```bash
 * # 结算指定会话
 * node settle-conversation.js --session <sessionId>
 * # 结算最近有活动的会话（宿主 Conversation End 场景）
 * node settle-conversation.js --latest
 * # 只看结果不写盘
 * node settle-conversation.js --session <id> --dry-run
 * # 顺带把用户输入兜底成候选工作事项
 * node settle-conversation.js --session <id> --activities prompts
 * # 由 LLM 判定出的工作事项写回来（source=agent）
 * node settle-conversation.js --session <id> --activities-file ./acts.json
 * # 批量补算（迁移 / 重新解析，用户 §16）
 * node settle-conversation.js --backfill --since 2026-09-01 --until 2026-09-21
 * # 可作为宿主 Hook / 定时任务调用，绝不因失败阻断宿主
 * node settle-conversation.js --latest --quiet --exit-zero
 * ```
 */

const fs = require('fs');
const path = require('path');

const C = require('./lib/log-core');
const CS = require('./lib/conversation-store');
const CP = require('./lib/conversation-parser');
const CodexCP = require('./lib/codex-conversation-parser');
const AL = require('./lib/activity-link');
const SE = require('./lib/summary-engine');
const RP = require('./lib/role-profile');

/** 本地退出码：会话不存在（区别于用法错误） */
const EXIT_SESSION_NOT_FOUND = 7;

const USAGE = `settle-conversation.js — 对话结束后的实时结算（任务A：Conversation End Handler）

  位置 / 选项：
    --session <id>            结算指定会话（<id> 也可作为位置参数直接给出）
    --latest                  结算最近有活动的会话
    --backfill                批量补算：配合 --since/--until 重新解析一批会话
    --relink                  只回链：把「有 session_id 但缺 conversation_id」的事项补上
                              （不解析会话、不写 Conversation Log；可配 --session / --dry-run）
    --since <YYYY-MM-DD>      批量补算起始日期（按会话最后活动时间筛选）
    --until <YYYY-MM-DD>      批量补算结束日期（默认今天）
    --limit <n>               --latest / --backfill 最多处理几个会话（默认 1 / 200）

  写入内容：
    --activities <mode>       off（默认）| prompts
                              prompts = 把用户输入过滤噪声后登记为**候选**工作事项
                              （source=agent、status=needs_confirmation、confidence=low）
    --activities-file <file>  由 LLM 判定出的工作事项数组（source=agent，关联本次对话）
    --activity "<项目>|<类型>|<内容>|<开始>|<结束>"   单条事项，可重复
    --segments-file <file>    本次对话的 Work Segment 数组
    --segment "<主题>|<摘要>|<开始>|<结束>|<序号>"     单条 Segment，可重复
    --ai-usage-file <file>    可精确归属的 AI Usage 数组
    --no-raw                  不写原始快照（raw/workbuddy/<date>/<conversation_id>.json）
    --no-relink               不做结算后回链（默认会补「本会话 → 事项」的 conversation_id）

  行为：
    --dry-run                 只解析并打印，不写任何文件
    --json                    输出 JSON（默认也是 JSON）
    --quiet                   不输出（供 Hook / 定时任务使用）
    --exit-zero               无论成败都退出码 0（Hook 安全）
    --force                   允许重算（默认也会重算，此参数仅为显式声明幂等安全）
    --dir <路径>              日志目录
    --home <路径>             WorkBuddy 数据目录（默认 ~/.workbuddy）
    --codex-home <路径>       Codex 数据目录（默认 CODEX_HOME 或 ~/.codex）

  幂等：以 conversation_id 为唯一业务键 upsert；
        Skill Usage 以 skill_invocation_id（或 conversation_id+skill_id+version）去重。
        重复执行不会产生重复记录，也不会重复累加 Token / Score。
`;

/* ------------------------------------------------------------------ *
 * 参数
 * ------------------------------------------------------------------ */

function activityFromInline(spec, conversationId, date) {
  const parts = String(spec).split('|').map((s) => s.trim());
  const [project, workType, content, start, end] = parts;
  if (!content) {
    throw new C.LogError(`--activity 至少需要「内容」，格式：项目|类型|内容|开始|结束。收到：${spec}`);
  }
  return {
    date,
    project_name: project || null,
    work_type: workType || null,
    content,
    start_time: start || null,
    end_time: end || null,
    source: 'agent',
    conversation_id: conversationId,
    status: 'needs_confirmation',
    confidence: 'low',
  };
}

function segmentFromInline(spec, conversationId, date) {
  const parts = String(spec).split('|').map((s) => s.trim());
  const [topic, summary, start, end, ordinal] = parts;
  if (!topic) {
    throw new C.LogError(
      `--segment 至少需要「主题」，格式：主题|摘要|开始|结束|序号。收到：${spec}`
    );
  }
  return {
    date,
    conversation_id: conversationId,
    ordinal: Number(ordinal) || 0,
    topic,
    summary: summary || null,
    start_time: start || null,
    end_time: end || null,
    source: 'agent',
    status: 'completed',
    confidence: 'medium',
  };
}

function readRecordList(file, key) {
  const raw = C.readJSON(path.resolve(file), null);
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw[key]) ? raw[key] : null;
  if (!list) {
    throw new C.LogError(`${file} 必须是数组，或含 ${key} 数组的对象。`);
  }
  return list;
}

/**
 * 从用户输入兜底生成**候选**工作事项。
 *
 * 这是「确定性兜底」而非「LLM 识别」：只做噪声过滤 + 原样登记，
 * 工作类型一律留空（§5/§11 不猜），状态标 `needs_confirmation`，
 * 由用户或后续 `/analyze` 确认。
 *
 * V3.6（用户 2026-09-24）：**项目归属从会话继承**（仅在高置信度时）。
 * 用户要求「按项目 / 项目阶段 / 工作类型看 Token 分布」，而这三张表依赖
 * 带 `conversation_id` 的 Work Activity；项目名若一律留空，表永远是空的。
 * 会话的 `project` 是**已解析出的证据**（project_source/project_confidence 可复核），
 * 因此置信度为 high 时继承为候选项目名，低置信度仍留空 —— 不猜。
 * 分类只在项目命中「探索沉淀项目」时给出，其余留给总结层的二次确认。
 */
function activitiesFromPrompts(prompts, conversationId, date, source, sessionId, conv, section) {
  const out = [];
  const seen = new Set();
  const c = conv || {};
  // 只有 high 置信度才继承项目名（medium/low 视为未确认 → 留空，不猜）
  const inheritedProject =
    c.project && String(c.project_confidence || '').toLowerCase() === 'high'
      ? String(c.project)
      : null;
  const inheritedCategory = inheritedProject
    ? RP.categoryForProject(inheritedProject, section)
    : null;
  for (const p of prompts) {
    const text = String(p.text || '').trim();
    if (!text) continue;
    // 复用总结层同一套噪声规则，避免「总结今日」这类对话混进工作事项
    let verdict;
    try {
      verdict = SE.classify({ content: text, source: source || 'workbuddy' });
    } catch (e) {
      verdict = { include: true, reason: '规则不可用，按候选保留' };
    }
    if (verdict && verdict.include === false) continue;
    // 去重：同一对话里反复出现的相同输入只登记一次
    const key = text.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      date,
      project_name: inheritedProject,
      work_type: null,
      category: inheritedCategory,
      content: text.length > C.MAX_CONTENT_LENGTH ? `${text.slice(0, C.MAX_CONTENT_LENGTH)}…` : text,
      // 只知提问时刻，不编造结束时间
      start_time: CP.hhmmOfMs(p.time),
      end_time: null,
      source: 'agent',
      conversation_id: conversationId,
      session_id: sessionId || null,
      status: 'needs_confirmation',
      confidence: 'low',
      // V3.6：候选归属待总结层二次确认；确认后不再重复验证
      classification_status: 'pending_review',
    });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 结算
 * ------------------------------------------------------------------ */

/**
 * 结算单个会话。
 *
 * @returns {object} 结算报告（含各结构化日志的 created/updated/unchanged 明细）
 */
function settleOne(sessionId, ctx) {
  const { dir, config, flags } = ctx;
  // 传 `dir` 是为了让解析器能读「空间项目 id→名称」缓存，
  // 从而把会话的 `project` 真正解析出来（此前恒为 null）。
  const codexFile = CodexCP.findCodexSessionFile(ctx.codexHome, sessionId);
  const collected = codexFile
    ? CodexCP.collectConversation(sessionId, {
        config,
        codexHome: ctx.codexHome,
        dir,
      })
    : CP.collectConversation(sessionId, { config, home: ctx.home, dir });
  if (!collected || !collected.conversation) {
    throw new C.LogError(`无法解析会话 ${sessionId}（WorkBuddy / Codex 均未找到可读数据）。`);
  }
  const conv = collected.conversation;
  const date = CS.assertDate(conv.date);
  const collectedTurns = Array.isArray(collected.turns) ? collected.turns : [];

  const report = {
    action: 'settled',
    session_id: String(sessionId),
    conversation_id: conv.conversation_id,
    date,
    status: conv.settlement_status,
    host_status: conv.status,
    source: conv.source,
    agent: conv.agent,
    model_name: conv.model_name,
    start_time: conv.start_time,
    end_time: conv.end_time,
    total_token: conv.total_token,
    total_score: conv.total_score,
    request_count: conv.request_count,
    turn_count: conv.turn_count,
    skill_count: conv.skill_count,
    skill_invocation_count: conv.skill_invocation_count,
    distinct_skill_count: conv.distinct_skill_count,
    missing_fields: conv.missing_fields,
    skills: collected.skill_usages.map((s) => ({
      skill_id: s.skill_id,
      skill_version: s.skill_version,
      skill_token: s.skill_token,
      token_source: s.token_source,
      status: s.status,
    })),
    written: {
      conversation: null,
      turn: null,
      skill_usage: null,
      work_segment: null,
      work_activity: null,
      ai_usage: null,
      raw_snapshot: null,
    },
    notes: collected.diagnostics.notes,
  };

  if (C.flagBool(flags, 'dry-run')) {
    report.action = 'dry_run';
    report.raw_preview = {
      conversation: conv,
      turns: collectedTurns,
      skill_usages: collected.skill_usages,
    };
    return report;
  }

  // ⓪ 先把本批全部记录**构建出来**，再整体归一化校验，最后才写盘。
  //
  //    为什么需要：② ③ ④ 是三个文件、三次 upsert，天然不是原子的。曾经出现过
  //    「Conversation 已写入、Skill Usage 因跨日期抛错未写」的半写状态 ——
  //    数据本身没坏（重新结算会补齐），但审计时会看到 skill_count 与实际不符，
  //    徒增排查成本。把校验提前到「零写入」阶段就能整类避免。
  const activityMode = (
    C.flagStr(flags, 'activities') ||
    config.settlement.capture_work_activities ||
    'off'
  ).toLowerCase();
  const activities = [];
  if (activityMode === 'prompts' && collected.prompts.length) {
    activities.push(
      ...activitiesFromPrompts(
        collected.prompts,
        conv.conversation_id,
        date,
        conv.source,
        conv.session_id,
        conv,
        config.work
      )
    );
  }
  const activitiesFile = C.flagStr(flags, 'activities-file');
  if (activitiesFile) {
    const raw = C.readJSON(path.resolve(activitiesFile), null);
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.activities) ? raw.activities : null;
    if (!list) {
      throw new C.LogError(
        `--activities-file 必须是数组，或含 activities 数组的对象：${activitiesFile}`
      );
    }
    for (const a of list) {
      activities.push(
        Object.assign({ date, source: 'agent', conversation_id: conv.conversation_id }, a)
      );
    }
  }
  for (const spec of C.flagList(flags, 'activity')) {
    activities.push(activityFromInline(spec, conv.conversation_id, date));
  }

  const segments = [];
  const segmentsFile = C.flagStr(flags, 'segments-file');
  if (segmentsFile) {
    for (const s of readRecordList(segmentsFile, 'segments')) {
      segments.push(
        Object.assign({ date, source: 'agent', conversation_id: conv.conversation_id }, s)
      );
    }
  }
  for (const spec of C.flagList(flags, 'segment')) {
    segments.push(segmentFromInline(spec, conv.conversation_id, date));
  }

  // 结算入口同样不能绕过 Security Filter。旧版本只对 Hook / 手工写入做过滤，
  // 这里补上 activities-file / segments-file / ai-usage-file 的长期日志入口。
  for (const s of segments) {
    if (s.topic) {
      const f = C.security.filterContent(s.topic, { security: config.security });
      s.topic = f.content;
      s.topic_compression = C.security.compressionMeta(f);
    }
    if (s.summary) {
      const f = C.security.filterDetail(s.summary, { security: config.security });
      s.summary = f.detail;
      s.summary_compression = C.security.detailMeta(f);
    }
  }
  for (const a of activities) {
    const rawContent = a.content;
    if (a.content) {
      const f = C.security.filterContent(a.content, { security: config.security });
      a.content = f.content;
      a.content_compression = C.security.compressionMeta(f);
    }
    const detailRaw =
      a.detail || (rawContent && rawContent.length > C.MAX_CONTENT_LENGTH ? rawContent : null);
    if (detailRaw) {
      const f = C.security.filterDetail(detailRaw, { security: config.security });
      a.detail = f.detail;
      a.detail_compression = C.security.detailMeta(f);
    }
  }
  // 先归一化 Segment / Activity，再把 AI Usage 的 index 引用解析成稳定业务键。
  const normalizedSegments = segments.map((s) => CS.normalizeWorkSegment(s));
  const normalizedActivities = activities.map((a) => {
    const item = Object.assign({}, a);
    if (Number.isInteger(item.segment_index)) {
      const target = normalizedSegments[item.segment_index];
      if (!target) throw new C.LogError(`Work Activity 的 segment_index 越界：${item.segment_index}`);
      item.segment_id = target.segment_id;
    }
    delete item.segment_index;
    return CS.normalizeWorkActivity(item);
  });
  const aiUsages = [];
  const aiUsageFile = C.flagStr(flags, 'ai-usage-file');
  if (aiUsageFile) {
    for (const u of readRecordList(aiUsageFile, 'ai_usage')) {
      const item = Object.assign({ date, source: 'other', conversation_id: conv.conversation_id }, u);
      if (Number.isInteger(item.segment_index)) {
        const target = normalizedSegments[item.segment_index];
        if (!target) throw new C.LogError(`AI Usage 的 segment_index 越界：${item.segment_index}`);
        item.segment_id = target.segment_id;
      }
      if (Number.isInteger(item.activity_index)) {
        const target = normalizedActivities[item.activity_index];
        if (!target) throw new C.LogError(`AI Usage 的 activity_index 越界：${item.activity_index}`);
        item.activity_id = target.activity_id;
      }
      delete item.segment_index;
      delete item.activity_index;
      aiUsages.push(item);
    }
  }
  for (const u of aiUsages) {
    if (u.note) {
      const f = C.security.filterDetail(u.note, { security: config.security });
      u.note = f.detail;
    }
  }
  const normalizedAiUsages = aiUsages.map((u) => CS.normalizeAiUsage(u));
  const existingSegments = CS.read(dir, 'work_segment', date);
  const existingActivities = CS.read(dir, 'work_activity', date);
  const knownSegments = new Set([
    ...existingSegments.map((s) => String(s.segment_id)),
    ...normalizedSegments.map((s) => String(s.segment_id)),
  ]);
  const knownActivities = new Set([
    ...existingActivities.map((a) => String(a.activity_id)),
    ...normalizedActivities.map((a) => String(a.activity_id)),
  ]);
  const existsInAllLoggedDates = (kind, keyName, key) => {
    if (!key) return false;
    return CS.listLoggedDates(dir).some((loggedDate) =>
      CS.read(dir, kind, loggedDate).some((row) => String(row[keyName]) === String(key))
    );
  };
  for (const a of normalizedActivities) {
    if (
      a.segment_id &&
      !knownSegments.has(String(a.segment_id)) &&
      !existsInAllLoggedDates('work_segment', 'segment_id', a.segment_id)
    ) {
      throw new C.LogError(
        `Work Activity ${a.activity_id} 引用了不存在的 segment_id：${a.segment_id}`
      );
    }
  }
  for (const u of normalizedAiUsages) {
    if (u.attribution_status === 'unallocated' && (u.segment_id || u.activity_id)) {
      throw new C.LogError(
        `AI Usage ${u.ai_usage_id} 标记为 unallocated，却写了 segment_id/activity_id。`
      );
    }
    if (u.attribution_status !== 'unallocated' && !u.segment_id && !u.activity_id) {
      throw new C.LogError(
        `AI Usage ${u.ai_usage_id} 标记为 ${u.attribution_status}，但缺少 Segment/Activity 归属。`
      );
    }
    if (
      u.activity_id &&
      !knownActivities.has(String(u.activity_id)) &&
      !existsInAllLoggedDates('work_activity', 'activity_id', u.activity_id)
    ) {
      throw new C.LogError(`AI Usage ${u.ai_usage_id} 引用了不存在的 activity_id：${u.activity_id}`);
    }
    if (
      u.segment_id &&
      !knownSegments.has(String(u.segment_id)) &&
      !existsInAllLoggedDates('work_segment', 'segment_id', u.segment_id)
    ) {
      throw new C.LogError(`AI Usage ${u.ai_usage_id} 引用了不存在的 segment_id：${u.segment_id}`);
    }
  }
  const usageById = new Map();
  for (const old of CS.listLoggedDates(dir).flatMap((loggedDate) =>
    CS.read(dir, 'ai_usage', loggedDate)
  )) {
    usageById.set(String(old.ai_usage_id), old);
  }
  for (const next of normalizedAiUsages) usageById.set(String(next.ai_usage_id), next);
  const conversationUsages = [...usageById.values()].filter(
    (u) => String(u.conversation_id) === String(conv.conversation_id) && u.attribution_status !== 'unallocated'
  );
  const allocatedToken = conversationUsages.reduce(
    (sum, u) => sum + (typeof u.total_token === 'number' ? u.total_token : 0),
    0
  );
  const allocatedCredit = conversationUsages.reduce(
    (sum, u) => sum + (typeof u.credit === 'number' ? u.credit : 0),
    0
  );
  if (typeof conv.total_token === 'number' && allocatedToken > conv.total_token) {
    throw new C.LogError(
      `本次 AI Usage 精确归属 Token（${allocatedToken}）超过 Conversation 总账（${conv.total_token}）。`
    );
  }
  if (typeof conv.total_score === 'number' && allocatedCredit > conv.total_score) {
    throw new C.LogError(
      `本次 AI Usage 精确归属 Credit（${allocatedCredit}）超过 Conversation 总账（${conv.total_score}）。`
    );
  }

  try {
    CS.normalizeConversation(conv);
    collectedTurns.forEach((t) => CS.normalizeTurn(t));
    collected.skill_usages.forEach((s) => CS.normalizeSkillUsage(s));
    normalizedSegments.forEach((s) => CS.normalizeWorkSegment(s));
    normalizedActivities.forEach((a) => CS.normalizeWorkActivity(a));
    normalizedAiUsages.forEach((u) => CS.normalizeAiUsage(u));
  } catch (e) {
    report.action = 'failed';
    report.error = `记录预校验失败（未写入任何数据）：${String((e && e.message) || e)}`;
    return report;
  }

  // ① 原始快照先落盘：即使后续归一化失败，原始数据仍在，可重新解析（用户 §二十）
  //    文件名用 session_id（宿主原生稳定键），payload 里带 conversation_id。
  //    快照是**短期缓存**（storage.raw_log.retention_days，默认 7 天），
  //    由 cleanup-raw-logs.js 定期清理；Structured Logs 才是永久数据。
  const rawEnabled = config.storage.raw_log.enabled !== false;
  const rawBySettlement = config.settlement.write_raw_snapshot !== false;
  if (rawEnabled && rawBySettlement && !C.flagBool(flags, 'no-raw')) {
    try {
      report.written.raw_snapshot = CS.writeRawSnapshot(
        dir,
        date,
        String(sessionId),
        Object.assign({ conversation_id: conv.conversation_id }, collected.raw),
        conv.source
      );
    } catch (e) {
      report.notes.push(`原始快照写入失败：${String((e && e.message) || e)}（不影响结构化日志）`);
    }
  }

  // ② Conversation Log —— 以 conversation_id 为唯一业务键，绝对值覆盖而非累加
  report.written.conversation = CS.upsertConversation(dir, conv, { date });

  // ③ Turn Log —— 每个用户请求一轮一条；Token 来自 turn_token_usage 绝对值
  if (collectedTurns.length) {
    report.written.turn = CS.upsertTurn(dir, collectedTurns, { date });
    report.turn_count = collectedTurns.length;
  }

  // ④ Skill Usage Log —— 每个 Skill 调用一条，互不合并
  if (collected.skill_usages.length) {
    report.written.skill_usage = CS.upsertSkillUsage(dir, collected.skill_usages, { date });
  }

  // ⑤ Work Segment Log —— 可选，只描述连续主题，不承担成本总账
  if (normalizedSegments.length) {
    report.written.work_segment = CS.upsertWorkSegment(dir, normalizedSegments, { date });
    report.segment_count = normalizedSegments.length;
  }

  // ⑥ Work Activity Log —— 可选（记录已在 ⓪ 构建并校验完毕）
  if (normalizedActivities.length) {
    report.written.work_activity = CS.upsertWorkActivity(dir, normalizedActivities, { date });
    report.activity_count = normalizedActivities.length;
  }

  // ⑦ AI Usage Log —— 只写可精确表达或明确未归属的记录，不做比例拆分
  if (normalizedAiUsages.length) {
    report.written.ai_usage = CS.upsertAiUsage(dir, normalizedAiUsages, { date });
    report.ai_usage_count = normalizedAiUsages.length;
  }

  // ⑧ 回链（V3.4）：把「本次会话 → conversation_id」补到已经存在的事项与已导出日志上。
  //
  //    为什么必须做：事项通常**先**被记录/导出，会话**后**才结束结算，
  //    导出那一刻没有 conversation_id 可写。少了这一步，「按项目看 Token」
  //    就会因为关联缺失而长期空着 —— 而这正是本次要修的问题。
  //    只处理当前会话，且只在缺失时补；失败不影响结算结果本身。
  if (!C.flagBool(flags, 'no-relink')) {
    try {
      // conversation_id 此刻是**已知**的（刚算出来）—— 直接把答案传给回链，
      // 省掉「为查一个已知答案而读遍全部会话日志」的开销（Hook 热路径友好）。
      const linkOpts = { onlySessionId: sessionId, knownConversationId: conv.conversation_id };
      report.relinked = {
        work_items: AL.linkWorkItems(dir, linkOpts),
        activities: AL.linkActivitiesForSession(dir, sessionId, linkOpts),
      };
    } catch (e) {
      report.notes.push(`回链失败：${String((e && e.message) || e)}（不影响已写入的结构化日志）`);
    }
  }

  // 幂等自证：重复结算时各结构化日志的 created 都应为 0
  report.idempotent = {
    conversation_created: report.written.conversation.created,
    skill_usage_created: report.written.skill_usage ? report.written.skill_usage.created : 0,
    work_segment_created: report.written.work_segment ? report.written.work_segment.created : 0,
    work_activity_created: report.written.work_activity ? report.written.work_activity.created : 0,
    ai_usage_created: report.written.ai_usage ? report.written.ai_usage.created : 0,
  };
  const createdTotal =
    report.idempotent.conversation_created +
    report.idempotent.skill_usage_created +
    report.idempotent.work_segment_created +
    report.idempotent.work_activity_created +
    report.idempotent.ai_usage_created;
  report.action = createdTotal === 0 ? 'already_settled' : 'settled';
  report.message =
    createdTotal === 0
      ? '该对话此前已结算，本次仅刷新（未新增记录，Token 与 Score 未被重复累加）。'
      : '结算完成，已写入结构化日志。';
  return report;
}

/* ------------------------------------------------------------------ *
 * 回链（V3.4）
 * ------------------------------------------------------------------ */

/**
 * `--relink`：把「有会话证据但没有 conversation_id」的事项补上关联。
 *
 * 使用场景：
 * ```text
 * · 结算发生在导出之后（Hook 时序不确定）
 * · 历史数据是用旧版本写下的（本版本修复前的记录）
 * · 想确认「还有多少条真的挂不上」以及原因
 * ```
 *
 * 只走证据（`session_id` 且会话日志里确实存在），**不推断**。
 */
function runRelink(flags, ctx) {
  const dryRun = C.flagBool(flags, 'dry-run');
  const only = C.flagStr(flags, 'session') || null;
  const built = AL.buildSessionConversationIndex(ctx.dir);
  const activities = AL.relinkActivities(ctx.dir, {
    dryRun,
    onlySessionId: only,
    index: built.index,
  });
  const workItems = AL.linkWorkItems(ctx.dir, {
    dryRun,
    onlySessionId: only,
    index: built.index,
  });
  return {
    action: dryRun ? 'relink_dry_run' : 'relink_done',
    log_directory: ctx.dir,
    conversation_index: {
      sessions: Object.keys(built.index).length,
      dates_scanned: built.dates.length,
    },
    scope: only ? { session_id: String(only) } : 'all',
    activities,
    work_items: workItems,
    rule:
      '只按事项自身的 session_id、且该会话确实存在于 Conversation Log 时才建立关联；' +
      '没有证据或会话尚未结算的一律保持 null，不做任何推断或按时间/项目名凑合。',
    hint:
      activities.linked || workItems.linked
        ? '已补齐关联，重新执行 aggregate-logs.js / daily-summary.js 即可看到项目维度成本。'
        : '本次没有可补的关联。若 no_evidence 较多，说明这些事项是人工记录或历史批量导入 —— ' +
          '无对话可挂属正常，不必强行补齐。',
  };
}

/* ------------------------------------------------------------------ *
 * 会话挑选
 * ------------------------------------------------------------------ */

function mergeSessionRows(rows) {
  const byId = new Map();
  for (const row of rows || []) {
    if (!row || !row.id) continue;
    const id = String(row.id);
    const prev = byId.get(id);
    const next = Object.assign({}, row, { id });
    if (!prev) {
      byId.set(id, next);
      continue;
    }
    const prevAt = Number(prev.last_activity_at || prev.updated_at || prev.created_at || 0);
    const nextAt = Number(next.last_activity_at || next.updated_at || next.created_at || 0);
    if (nextAt >= prevAt) byId.set(id, Object.assign({}, prev, next));
    else byId.set(id, Object.assign({}, next, prev));
  }
  return [...byId.values()].sort(
    (a, b) =>
      Number(b.last_activity_at || b.updated_at || b.created_at || 0) -
      Number(a.last_activity_at || a.updated_at || a.created_at || 0)
  );
}

function resolveTargets(flags, ctx) {
  const positional = ctx.positional || [];
  const explicit = C.flagStr(flags, 'session') || positional[0] || null;

  if (C.flagBool(flags, 'backfill')) {
    const since = CS.assertDate(C.flagStr(flags, 'since') || C.today());
    const until = CS.assertDate(C.flagStr(flags, 'until') || C.today());
    const limit = C.flagNum(flags, 'limit') || 200;
    const from = new Date(`${since}T00:00:00`).getTime();
    const to = new Date(`${until}T23:59:59`).getTime();
    const rows = mergeSessionRows([
      ...CP.listRecentSessions(ctx.home, 5000),
      ...CodexCP.listRecentSessions(ctx.codexHome, 5000),
    ]);
    const picked = rows
      .filter((r) => {
        const last = Number(r.last_activity_at || r.updated_at || r.created_at);
        const created = Number(r.created_at);
        return (
          (Number.isFinite(last) && last >= from && last <= to) ||
          (Number.isFinite(created) && created >= from && created <= to)
        );
      })
      .slice(0, limit)
      .map((r) => String(r.id));
    return { mode: 'backfill', sessions: picked, since, until };
  }

  if (explicit && !C.flagBool(flags, 'latest')) {
    return { mode: 'session', sessions: [String(explicit)] };
  }

  const limit = C.flagNum(flags, 'limit') || 1;
  const rows = mergeSessionRows([
    ...CP.listRecentSessions(ctx.home, Math.max(limit * 4, 20)),
    ...CodexCP.listRecentSessions(ctx.codexHome, Math.max(limit * 4, 20)),
  ]).slice(0, limit);
  if (!rows.length) {
    throw new C.LogError(
      '无法从 WorkBuddy / Codex 本地数据读取最近会话。请显式传 --session <id>。',
      EXIT_SESSION_NOT_FOUND
    );
  }
  return { mode: 'latest', sessions: rows.map((r) => String(r.id)) };
}

/** 会话是否真实存在（避免把打错的 ID 静默结算成一条空记录） */
function assertSessionExists(dir, sessionId, ctx) {
  if (CS.findRawSnapshot(dir, sessionId)) return true;
  if (CS.findConversationBySession(dir, sessionId)) return true;
  if (CP.readSessionRow(ctx.home, sessionId)) return true;
  if (CP.findSessionFile(ctx.home, sessionId)) return true;
  if (CodexCP.readThreadRow(ctx.codexHome, sessionId)) return true;
  return Boolean(CodexCP.findCodexSessionFile(ctx.codexHome, sessionId));
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function run() {
  const { pos, flags } = C.parseArgs(process.argv.slice(2));
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  C.ensureWritable(dir);
  const config = C.readConfig(dir);
  const home = CP.resolveHome({ home: C.flagStr(flags, 'home') });
  const codexHome = CodexCP.resolveCodexHome({
    codexHome: C.flagStr(flags, 'codex-home'),
  });
  const ctx = { dir, config, flags, home, codexHome, positional: pos };

  // 总开关：允许用户整体关闭结算（记录链路仍是原始采集，不受影响）
  if (config.settlement && config.settlement.enabled === false) {
    if (!C.flagBool(flags, 'quiet')) {
      C.emit({
        action: 'skipped',
        reason: 'settlement_disabled',
        message: 'config.settlement.enabled = false，已跳过结算（用户显式关闭）。',
      });
    }
    return C.EXIT.OK;
  }

  // 独立子命令：只做回链，不重新解析任何会话
  if (C.flagBool(flags, 'relink')) {
    const rep = runRelink(flags, ctx);
    if (!C.flagBool(flags, 'quiet')) C.emit(rep);
    return C.EXIT.OK;
  }

  const target = resolveTargets(flags, ctx);
  const reports = [];
  let notFound = 0;

  for (const sessionId of target.sessions) {
    try {
      if (!assertSessionExists(dir, sessionId, ctx)) {
        notFound += 1;
        reports.push({
          action: 'not_found',
          session_id: sessionId,
          message:
            '未在 WorkBuddy / Codex 本地数据中找到该会话（sessions 表 / rollout / 已结算快照）。',
        });
        continue;
      }
      reports.push(settleOne(sessionId, ctx));
    } catch (err) {
      // 单个会话失败不影响其余会话；原始数据仍可后续重新解析（用户 §16）
      reports.push({
        action: 'failed',
        session_id: sessionId,
        error: String((err && err.message) || err),
      });
    }
  }

  const summary = {
    action: target.mode === 'backfill' ? 'backfill_done' : 'settle_done',
    mode: target.mode,
    date_range: target.mode === 'backfill' ? { since: target.since, until: target.until } : null,
    processed: reports.length,
    settled: reports.filter((r) => r.action === 'settled').length,
    already_settled: reports.filter((r) => r.action === 'already_settled').length,
    failed: reports.filter((r) => r.action === 'failed').length,
    not_found: notFound,
    reports,
    hint:
      'Token 与 Score 以「绝对值覆盖」方式写入，重复结算不会累加；' +
      'Skill 独占 token 缺失时一律记 null；AI Usage 只记录明确归属，未归属不摊派。',
  };

  if (!C.flagBool(flags, 'quiet')) C.emit(summary);

  // 绝不重复累加的自证：把本次结果与「当前日志中的实际值」对照
  if (!C.flagBool(flags, 'quiet') && target.mode === 'session') {
    const r = reports[0];
    if (r && r.conversation_id) {
      const stored = CS.read(dir, 'conversation', r.date).find(
        (x) => x.conversation_id === r.conversation_id
      );
      if (stored && stored.total_token !== r.total_token) {
        C.emitText(
          `\n⚠ 日志中的 total_token（${stored.total_token}）与本次解析值（${r.total_token}）不一致；` +
            '若会话仍在进行，后续重跑会把日志更新为更大值（覆盖，不累加）。'
        );
      }
    }
  }

  if (reports.length && notFound === reports.length) return EXIT_SESSION_NOT_FOUND;
  return C.EXIT.OK;
}

/**
 * 入口：`--exit-zero` 时无论成败都返回 0。
 *
 * 这一条是给宿主 Hook / 定时任务用的 —— 结算失败**绝不能**阻断或回滚用户会话
 * （与 `hook-bridge.js` 同一纪律：Hook 永远不阻断用户）。
 */
function main() {
  const argv = process.argv.slice(2);
  const exitZero = argv.includes('--exit-zero') || argv.includes('--exit-zero=true');
  try {
    const code = run();
    process.exitCode = exitZero ? 0 : typeof code === 'number' ? code : C.EXIT.OK;
  } catch (err) {
    const code = err instanceof C.LogError ? err.code : C.EXIT.USAGE;
    if (!argv.includes('--quiet')) {
      process.stderr.write(
        `${JSON.stringify({ error: String((err && err.message) || err), code })}\n`
      );
    }
    process.exitCode = exitZero ? 0 : code;
  }
}

main();
