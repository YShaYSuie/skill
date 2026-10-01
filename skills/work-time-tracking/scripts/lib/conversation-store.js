'use strict';
/**
 * conversation-store.js — 结构化日志的存储层（V3.5）。
 *
 * ## 六日志模型（V3.26 兼容扩展）
 *
 * ```text
 * Conversation Log      一次 Agent 对话本身（Token / Score / Model / 起止时间）
 *      │                业务键 conversation_id，一个对话 1 条
 *      ├── Turn Log          一次用户请求 + 后续 Agent 工作
 *      │                业务键 turn_id，一个对话 0~N 条
 *      ├── Skill Usage Log   这次对话用了哪些 Skill、各消耗多少
 *      │                业务键 usage_id，一个 Skill 调用 1 条
 *      ├── Work Segment Log  这次对话内部的连续工作主题
 *      │                业务键 segment_id，0~N 条
 *      ├── Work Activity Log 这次对话（或人工）产出了哪些工作事项
 *      │                业务键 activity_id，0~N 条；人工事项允许 conversation_id = null
 *      └── AI Usage Log     可精确归属于 Segment / Activity 的 AI 用量
 *                       业务键 ai_usage_id；Conversation 仍是原始总账
 * ```
 *
 * `conversation_id` 是**关联键**，不是所有日志的统一主键 ——
 * 各类数据各用自己的 ID。
 *
 * ## 目录布局（V3.1：按日期组织，与 GitHub 远端 1:1 对齐）
 *
 * ```text
 * <log_dir>/logs/2026-09-21/
 *     ├── conversations.jsonl
 *     ├── turns.jsonl
 *     ├── skill-usage.jsonl
 *     ├── work-segments.jsonl
 *     ├── work-activities.jsonl
 *     └── ai-usage.jsonl
 * ```
 *
 * 选「按日期分目录」而不是「按类型分目录」，是因为 GitHub 远端归档
 * （`worktimeLog/2026-09-21/...`）就是同一形状 —— 同步时是逐文件比对，
 * 不需要任何路径映射。V3.0 的旧布局 `structured/<kind>/<date>.jsonl` 仍可**读取**
 * （兼容），但新写入一律走 `logs/`。
 *
 * ## 取不到的值：`null` + 来源字段
 *
 * 不可获取的数据一律写 `null`（**不是 0、不是猜测值**），
 * 并用配套的 `*_source` / `settlement_status` 字段说明**为什么取不到**：
 *
 * ```text
 * 0        → 真实观测到的 0 消耗（有意义，与 null 不同）
 * null     → 该数据不可获取（本技能不得估算）
 * score_source = 'workbuddy_credit' | 'not_applicable' | 'unavailable'
 * token_source = 'injection' | 'unavailable'
 * ```
 *
 * 读取时**仍容忍**早期的 `'unavailable'` 字符串哨兵（见 `isUnavailable()`），
 * 以便平滑迁移，但不会再写出该字符串。
 *
 * ## 幂等
 *
 * 核心机制是「**确定性业务键 + 按键替换**」：ID 由内容派生，Token / Score 存
 * **绝对值**，重复结算只会覆盖同一行，不会新增、不会累加。
 * 内容完全无变化时连 `updated_at` 都不刷新（否则幂等无法自证）。
 */

const fs = require('fs');
const path = require('path');
const C = require('./log-core');

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const PARSER_VERSION = '3.3.0';

/**
 * 结构化日志的类型定义。
 *
 * `file` 是落在 `logs/<date>/` 下的文件名（与 GitHub 远端一致）。
 * `legacyDir` 是 V3.0 的旧目录名，仅用于兼容读取。
 */
const KINDS = {
  conversation: {
    file: 'conversations.jsonl',
    legacyDir: 'conversations',
    key: 'conversation_id',
    idPrefix: 'CON',
  },
  turn: {
    file: 'turns.jsonl',
    legacyDir: 'turns',
    key: 'turn_id',
    idPrefix: 'TURN',
  },
  skill_usage: {
    file: 'skill-usage.jsonl',
    legacyDir: 'skill-usage',
    key: 'usage_id',
    idPrefix: 'SU',
  },
  work_segment: {
    file: 'work-segments.jsonl',
    legacyDir: 'work-segments',
    key: 'segment_id',
    idPrefix: 'SEG',
  },
  work_activity: {
    file: 'work-activities.jsonl',
    legacyDir: 'work-activities',
    key: 'activity_id',
    idPrefix: 'ACT',
  },
  ai_usage: {
    file: 'ai-usage.jsonl',
    legacyDir: 'ai-usage',
    key: 'ai_usage_id',
    idPrefix: 'AUS',
  },
};

/** 结算结果（用户 §二十五） */
const VALID_SETTLEMENT_STATUS = ['settled', 'partial', 'failed'];
/** 对话本身在宿主侧的状态（与结算结果分开，二者含义不同） */
const VALID_CONVERSATION_HOST_STATUS = ['completed', 'working', 'archived', 'interrupted', 'unknown'];
/** Skill 调用结果 */
const VALID_USAGE_STATUS = ['completed', 'failed', 'unknown'];
/** Skill token 的来源口径 */
const VALID_TOKEN_SOURCE = ['injection', 'unavailable'];
/** Work Activity 来源（用户 §十） */
const VALID_ACTIVITY_SOURCE = ['agent', 'manual', 'imported', 'system'];
/** Skill 调用的触发方式 */
const VALID_TRIGGER_TYPE = ['agent', 'user', 'hook', 'automation', 'unknown'];
/**
 * V3.22：这条 Skill Usage 是**凭什么**认定「用了这个 Skill」的。
 *   explicit_invocation —— 用户在本轮输入里显式调用了它（`$skill` / 技能路径引用）
 *   skill_md_loaded     —— 会话中真实载入了该技能的 SKILL.md（模型读了技能定义）
 * 取不到（如 WorkBuddy 由宿主调用 id 判定）写 null —— 不猜、不套用默认值。
 */
const VALID_SKILL_EVIDENCE = ['explicit_invocation', 'skill_md_loaded'];
/** 会话可归属的宿主（不要把 WorkBuddy 字段当成唯一模型） */
const VALID_CONVERSATION_SOURCE = ['workbuddy', 'codex', 'other'];
/** Work Activity 中 AI 的实际角色。 */
const VALID_AI_ROLE = ['AI主导', 'AI协作', 'AI辅助', 'AI查询', 'AI排障', '未知'];
/** AI Usage 的归属状态。 */
const VALID_ATTRIBUTION_STATUS = ['exact', 'partial', 'unallocated'];
/** Work Segment / AI Usage 的结果状态。 */
const VALID_SEGMENT_STATUS = ['completed', 'in_progress', 'needs_confirmation', 'cancelled'];
/** Turn 的执行结果。 */
const VALID_TURN_STATUS = ['completed', 'working', 'interrupted', 'unknown'];
/** Turn Token 的来源标签；取不到时 token 字段本身仍为 null。 */
const VALID_TURN_TOKEN_SOURCE = ['turn_usage', 'unavailable'];

/**
 * V3.6：归属二次确认状态。
 *
 * ```text
 * confirmed      已确认（AI 复核或用户显式回写）→ 总结默认跳过，不重复验证
 * pending_review 待复核（默认）→ 总结层用上下文确认一次
 * ```
 */
const VALID_CLASSIFICATION_STATUS = ['confirmed', 'pending_review'];

/**
 * 「取不到」的规范值：`null`。
 *
 * 同时导出旧名 `UNAVAILABLE` 指向同一个 `null`，避免历史调用点静默写错值。
 */
const NA = null;
const UNAVAILABLE = NA;

/* ------------------------------------------------------------------ *
 * 路径
 * ------------------------------------------------------------------ */

const logsDir = (dir) => path.join(dir, 'logs');
const dayDir = (dir, date) => path.join(logsDir(dir), assertDate(date));
const dayFile = (dir, kind, date) => path.join(dayDir(dir, date), KINDS[kind].file);

/** V3.0 旧布局（只读兼容） */
const legacyStructuredDir = (dir) => path.join(dir, 'structured');
const legacyLogPath = (dir, kind, date) =>
  path.join(dir, 'structured', KINDS[kind].legacyDir, `${assertDate(date)}.jsonl`);

/**
 * 按写入语义解析路径。
 *
 * 若**只有**旧路径存在，返回旧路径，让「读—改—写」落在同一份文件上，
 * 避免迁移期出现「读 A 写 B、数据看似消失」。新旧都存在时以新路径为准。
 */
function resolveLogPath(dir, kind, date) {
  const next = dayFile(dir, kind, date);
  if (fs.existsSync(next)) return next;
  const legacy = legacyLogPath(dir, kind, date);
  if (fs.existsSync(legacy)) return legacy;
  return next;
}

/** 规范的（新）路径，写盘时用 */
const logPath = (dir, kind, date) => dayFile(dir, kind, date);

/** 原始会话快照（用户 §二十）。source 缺省为 workbuddy，Codex 走 raw/codex。 */
const rawDir = (dir, date, source) =>
  path.join(dir, 'raw', String(source || 'workbuddy'), assertDate(date));
const rawSourceDir = (dir, source) => path.join(dir, 'raw', String(source || 'workbuddy'));
const summariesDir = (dir) => path.join(dir, 'summaries');

/** 保留旧名的只读兼容导出（V3.0 的调用点） */
const structuredDir = legacyStructuredDir;
const kindDir = (dir, kind) => path.join(legacyStructuredDir(dir), KINDS[kind].legacyDir);

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

/** date 必须是 YYYY-MM-DD —— 日志目录名直接用它，必须挡住路径穿越与畸形值 */
function assertDate(date) {
  const d = String(date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
    throw new C.LogError(`日期格式必须是 YYYY-MM-DD，收到：${JSON.stringify(date)}`);
  }
  return d;
}

/** 从 ISO 时间或毫秒时间戳取日期（本地时区，与日志口径一致） */
function dateOf(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${C.pad(d.getMonth() + 1)}-${C.pad(d.getDate())}`;
}

/**
 * 「不可用」判定。
 *
 * 覆盖：`null` / `undefined` / 空串，以及 V3.0 的 `'unavailable'` 字符串哨兵 ——
 * 后者只为读取老数据，新写入不再产生。
 */
function isUnavailable(v) {
  return (
    v === null ||
    v === undefined ||
    v === '' ||
    (typeof v === 'string' && v.toLowerCase() === 'unavailable')
  );
}

/** 数值归一化：非有限数一律回落 `null`（不写 0，避免与真实的 0 混淆） */
function numOrNull(v) {
  if (isUnavailable(v)) return NA;
  const n = Number(v);
  return Number.isFinite(n) ? n : NA;
}

/** 字符串归一化：空串回落 `null` */
function strOrNull(v) {
  if (isUnavailable(v)) return NA;
  const s = String(v).trim();
  return s ? s : NA;
}

/** 保留旧名（V3.0 调用点） */
const numOrUnavailable = numOrNull;
const strOrUnavailable = strOrNull;

/** 深度相等（幂等判定用） */
function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (typeof a === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.some((k, i) => k !== kb[i])) return false;
    return ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

/** 浮点求和去噪（3.1500000000000004 → 3.15）—— 通用场景用 6 位 */
const round6 = (n) => Math.round(Number(n) * 1e6) / 1e6;

/**
 * Score / Credit 一律保留**两位小数**（用户 2026-09-21 指定的记录口径）。
 *
 * 宿主下发的 credit 本身精度不高，累加后会出现 `245.61999999999998` 这类浮点噪声；
 * 保留两位既符合人的阅读习惯，也让「同一天的合计」在不同次汇总间稳定可比。
 * 注意：只用于**计分**字段，其他需要更高精度的比例/系数仍用 `round6`。
 */
const round2 = (n) => Math.round(Number(n) * 100) / 100;

/** 时长（秒）；端点缺失给 `null`，不猜 */
function durationSeconds(startTime, endTime) {
  const s = startTime ? new Date(startTime) : null;
  const e = endTime ? new Date(endTime) : null;
  if (!s || !e || Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return NA;
  const diff = Math.round((e.getTime() - s.getTime()) / 1000);
  return diff >= 0 ? diff : NA;
}

/** 兼容：分钟口径（由秒派生，仅供人类可读展示） */
function durationMinutes(startTime, endTime) {
  const sec = durationSeconds(startTime, endTime);
  return sec === NA ? NA : Math.round(sec / 60);
}

/**
 * `HH:MM` 形式的时长（分钟）。
 *
 * Work Activity 的时间按 §十 就是 `09:00` / `09:30` 这种**纯时刻**，
 * `new Date('09:00')` 解析不出有效日期，因此不能用 ISO 那套算时长 ——
 * 否则每条人工事项的 `duration_minutes` 都会是 null。
 *
 * 跨午夜（23:30 → 00:20）按 +24h 处理，得 50 分钟。
 */
function hhmmDurationMinutes(start, end) {
  const parse = (v) => {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(v === undefined || v === null ? '' : v));
    if (!m) return null;
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  };
  const s = parse(start);
  const e = parse(end);
  if (s === null || e === null) return NA;
  return (e - s + 1440) % 1440;
}

/* ------------------------------------------------------------------ *
 * 确定性 ID（幂等的基石）
 * ------------------------------------------------------------------ */

/**
 * Conversation ID：`CON-YYYYMMDD-<8位hash>`
 *
 * 由 `session_id` 派生而非随机 —— 同一次对话结算一百次都得到同一个 ID，
 * 这是「按键替换」能生效的前提。
 */
const makeConversationId = (date, sessionId) =>
  `${KINDS.conversation.idPrefix}-${String(date).replace(/-/g, '')}-${C.sha1(String(sessionId))
    .slice(0, 8)
    .toUpperCase()}`;

/**
 * Turn ID：`TURN-YYYYMMDD-<10位hash>`。
 *
 * 优先使用宿主原始 turn_id；原始值缺失时退化为会话、轮次序号和开始时间。
 */
function makeTurnId(date, conversationId, providerTurnId, ordinal, startTime) {
  const basis = providerTurnId
    ? `turn:${providerTurnId}`
    : `${conversationId}|turn|${ordinal || 0}|${startTime || ''}`;
  return `${KINDS.turn.idPrefix}-${String(date).replace(/-/g, '')}-${C.sha1(basis)
    .slice(0, 10)
    .toUpperCase()}`;
}

/**
 * Skill Usage ID：`SU-YYYYMMDD-<10位hash>`
 *
 * 优先用宿主的 `skill_invocation_id`（= JSONL 的 `callId`）；
 * 没有时退化为 `conversation_id + skill_id + skill_version + 序号` ——
 * 序号是本次对话内该组合的出现次序，重新解析同一份原始数据时顺序稳定，
 * 因此仍然幂等（用户 §二十四规定的去重键正是这一组字段）。
 */
function makeUsageId(date, conversationId, skillId, skillVersion, ordinal, invocationId) {
  const basis = invocationId
    ? `inv:${invocationId}`
    : `${conversationId}|${skillId}|${skillVersion}|${ordinal}`;
  return `${KINDS.skill_usage.idPrefix}-${String(date).replace(/-/g, '')}-${C.sha1(basis)
    .slice(0, 10)
    .toUpperCase()}`;
}

/** Work Segment ID：`SEG-YYYYMMDD-<10位hash>`。 */
function makeSegmentId(date, conversationId, ordinal, startTime, topic) {
  const basis = `${conversationId}|${ordinal || 0}|${startTime || ''}|${topic || ''}`;
  return `${KINDS.work_segment.idPrefix}-${String(date).replace(/-/g, '')}-${C.sha1(basis)
    .slice(0, 10)
    .toUpperCase()}`;
}

/** Work Activity ID：`ACT-YYYYMMDD-<10位hash>`（由内容 + 时间派生，重跑不产生新条目） */
function makeActivityId(date, conversationId, content, startTime) {
  const basis = `${conversationId || 'manual'}|${content}|${startTime || ''}`;
  return `${KINDS.work_activity.idPrefix}-${String(date).replace(/-/g, '')}-${C.sha1(basis)
    .slice(0, 10)
    .toUpperCase()}`;
}

/** AI Usage ID：`AUS-YYYYMMDD-<10位hash>`。 */
function makeAiUsageId(date, conversationId, activityId, segmentId, ordinal, explicitId) {
  const basis = explicitId
    ? `explicit:${explicitId}`
    : `${conversationId}|${activityId || ''}|${segmentId || ''}|${ordinal || 0}`;
  return `${KINDS.ai_usage.idPrefix}-${String(date).replace(/-/g, '')}-${C.sha1(basis)
    .slice(0, 10)
    .toUpperCase()}`;
}

/**
 * 由 WorkItem 导出 Work Activity 时使用的 ID。
 *
 * 用 **WorkItem id 本身** 作为派生依据，而不是内容 ——
 * 这样「一个 WorkItem ↔ 一条 Work Activity」是硬性 1:1：
 *
 * ```text
 * ✓ 内容改写了，activity_id 不变 → 仍然是同一条记录（更新，不新增）
 * ✓ 两条 WorkItem 内容恰好相同也不会互相覆盖
 * ✗ 若用内容派生：改写内容会变成「新增一条」，历史越积越脏
 * ```
 */
function makeActivityIdFromWorkItem(date, workItemId) {
  return `${KINDS.work_activity.idPrefix}-${String(date).replace(/-/g, '')}-${C.sha1(
    `wi:${workItemId}`
  )
    .slice(0, 10)
    .toUpperCase()}`;
}

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

/**
 * Conversation Log（用户 §八）。
 *
 * ```text
 * conversation_id  agent  model_name  start_time  end_time  duration_seconds
 * total_token  total_score  status  settlement_status  settled_at  source
 * ```
 *
 * 可选（宿主能给才记）：input/output/cached/reasoning_token、session_id、project、
 * workspace、title、request_count、skill_count、missing_fields、raw_ref。
 */
function normalizeConversation(rec) {
  const r = rec || {};
  const sessionId = r.session_id ? String(r.session_id) : NA;
  const startTime = r.start_time || NA;
  const endTime = r.end_time || NA;
  const date = assertDate(r.date || dateOf(startTime) || C.today());
  const conversationId =
    r.conversation_id || (sessionId ? makeConversationId(date, sessionId) : NA);
  if (!conversationId) {
    throw new C.LogError('Conversation 缺少 conversation_id，且无 session_id 可派生。');
  }

  // `settlement_status` 与 `status` 是两件事：
  //   settlement_status = 本次结算的结果（settled / partial / failed）
  //   status            = 对话本身在宿主侧的结果（completed / working / …）
  // V3.0 曾把两者合成一个 `status`，这里做兼容读取。
  const settlementStatus = VALID_SETTLEMENT_STATUS.includes(r.settlement_status)
    ? r.settlement_status
    : VALID_SETTLEMENT_STATUS.includes(r.status)
      ? r.status
      : 'settled';

  const hostStatus = VALID_CONVERSATION_HOST_STATUS.includes(r.status)
    ? r.status
    : VALID_CONVERSATION_HOST_STATUS.includes(r.host_status)
      ? r.host_status
      : 'unknown';

  const totalScoreRaw = numOrNull(r.total_score !== undefined ? r.total_score : r.usage_score);
  // 计分按两位小数落库（用户 2026-09-21 口径）
  const totalScore = totalScoreRaw === NA ? NA : round2(totalScoreRaw);

  return {
    conversation_id: conversationId,
    agent: strOrNull(r.agent),
    model_name: strOrNull(r.model_name),
    // 一次对话可能中途换模型 —— 保留分布，不做平均
    models: Array.isArray(r.models) ? [...new Set(r.models.map(String))] : [],
    start_time: startTime,
    end_time: endTime,
    duration_seconds: durationSeconds(startTime, endTime),
    // Token：分开记，与 Score 是两个独立指标（用户 §七）
    total_token: numOrNull(r.total_token),
    input_token: numOrNull(r.input_token),
    output_token: numOrNull(r.output_token),
    cached_token: numOrNull(r.cached_token),
    reasoning_token: numOrNull(r.reasoning_token),
    // Score / Credit：独立指标，**禁止**与 Token 建立换算关系
    total_score: totalScore,
    // ⚠️ `score_source` 是**标签**而不是取值：它的合法值里就包含 'unavailable'，
    // 因此绝不能走 strOrNull（那会把标签本身当成「无值」抹成 null）。
    score_source: r.score_source
      ? String(r.score_source)
      : totalScore === NA
        ? 'unavailable'
        : 'workbuddy_credit',
    // 积分覆盖率：宿主只为部分请求落 credit，因此 total_score 是**下界**
    score_request_count: Number.isFinite(Number(r.score_request_count))
      ? Number(r.score_request_count)
      : 0,
    status: hostStatus,
    settlement_status: settlementStatus,
    settled_at: r.settled_at || C.nowIso(),
    source: VALID_CONVERSATION_SOURCE.includes(r.source) ? r.source : 'other',
    session_id: sessionId,
    // 项目归属（V3.4）：`project` 是**名称**，`project_id` 留作溯源与后续重新解析。
    // 拿不到名称时 project = null 且 project_source 说明原因 —— 不猜、不用目录名顶替。
    project: r.project ? String(r.project) : NA,
    project_id: r.project_id ? String(r.project_id) : NA,
    // ⚠️ `project_source` 同样含 'none' / 'space_project_unmapped' 这类**语义值**，
    // 不走 strOrNull（避免把「明确判定为不属于任何项目」抹成「没解析出来」）。
    project_source: r.project_source ? String(r.project_source) : NA,
    project_confidence: C.VALID_CONFIDENCE.includes(r.project_confidence)
      ? r.project_confidence
      : NA,
    workspace: r.workspace ? String(r.workspace) : NA,
    title: r.title ? String(r.title) : NA,
    // V3.26：turn 与 Skill 数量采用显式字段。旧日志没有采集时保持 null，
    // 不把“历史数据未采集”伪装成真实 0。
    turn_count: Number.isFinite(Number(r.turn_count)) ? Number(r.turn_count) : NA,
    skill_invocation_count: Number.isFinite(Number(r.skill_invocation_count))
      ? Number(r.skill_invocation_count)
      : Number.isFinite(Number(r.skill_count))
        ? Number(r.skill_count)
        : 0,
    distinct_skill_count: Number.isFinite(Number(r.distinct_skill_count))
      ? Number(r.distinct_skill_count)
      : NA,
    request_count: Number.isFinite(Number(r.request_count)) ? Number(r.request_count) : 0,
    skill_count: Number.isFinite(Number(r.skill_invocation_count))
      ? Number(r.skill_invocation_count)
      : Number.isFinite(Number(r.skill_count))
        ? Number(r.skill_count)
        : 0,
    // 只记「哪些字段没拿到」，不丢弃整条记录（用户 §二十五）
    missing_fields: Array.isArray(r.missing_fields) ? r.missing_fields.map(String) : [],
    raw_ref: r.raw_ref ? String(r.raw_ref) : NA,
    parser_version: r.parser_version || PARSER_VERSION,
    created_at: r.created_at || C.nowIso(),
    updated_at: C.nowIso(),
  };
}

/**
 * Turn Log（V3.26）。
 *
 * 一个 Conversation 0..N 条。Turn 是「一次用户请求 + 后续全部 Agent 工作」，
 * 内部可以包含多次模型请求；Token 总量以 `turn_token_usage` 最后一笔为准。
 */
function normalizeTurn(rec) {
  const r = rec || {};
  if (!r.conversation_id) {
    throw new C.LogError('Turn 必须关联 conversation_id。');
  }
  const conversationId = String(r.conversation_id);
  const providerTurnId = strOrNull(r.provider_turn_id || r.host_turn_id);
  const ordinal = Number.isFinite(Number(r.ordinal)) ? Number(r.ordinal) : 0;
  const startTime = r.start_time || NA;
  const endTime = r.end_time || NA;
  const date = assertDate(r.date || dateOf(startTime) || dateOf(endTime) || C.today());
  const turnId =
    r.turn_id || makeTurnId(date, conversationId, providerTurnId, ordinal, startTime);
  const requestIds = Array.isArray(r.request_ids)
    ? [...new Set(r.request_ids.map(String).filter(Boolean))]
    : [];
  const tokenSource = VALID_TURN_TOKEN_SOURCE.includes(r.token_source)
    ? r.token_source
    : NA;

  return {
    turn_id: turnId,
    conversation_id: conversationId,
    provider_turn_id: providerTurnId,
    date,
    ordinal,
    start_time: startTime,
    end_time: endTime,
    duration_seconds: durationSeconds(startTime, endTime),
    request_count: Number.isFinite(Number(r.request_count))
      ? Number(r.request_count)
      : requestIds.length,
    request_ids: requestIds,
    total_token: numOrNull(r.total_token),
    input_token: numOrNull(r.input_token),
    output_token: numOrNull(r.output_token),
    cached_token: numOrNull(r.cached_token),
    reasoning_token: numOrNull(r.reasoning_token),
    token_source: tokenSource,
    status: VALID_TURN_STATUS.includes(r.status) ? r.status : 'unknown',
    source: VALID_CONVERSATION_SOURCE.includes(r.source) ? r.source : 'other',
    model: strOrNull(r.model),
    created_at: r.created_at || C.nowIso(),
    updated_at: C.nowIso(),
  };
}

/**
 * Skill Usage Log（用户 §九）。
 *
 * 一个 Conversation 可以有**多条** —— 每个 Skill 调用一条，各关联同一个 conversation_id。
 */
function normalizeSkillUsage(rec) {
  const r = rec || {};
  if (!r.conversation_id) {
    throw new C.LogError('Skill Usage 必须关联 conversation_id（用户 §十二）。');
  }
  // Skill 调用按**自身**的 start_time 归档 —— 长活会话的调用会分散在多天，
  // 每个调用应落在它实际发生的那一天；start_time 缺失时才回退到会话日期。
  const date = assertDate(dateOf(r.start_time) || r.date || C.today());
  const skillId = String(r.skill_id || '').trim();
  if (!skillId) throw new C.LogError('Skill Usage 缺少 skill_id。');
  // P0-1 防御纵深：skill_id 是业务键，必须是**稳定英文 id**。
  // 上游已做归一化（conversation-parser 走 SI.resolveSkillId），这里只做**非破坏性告警**：
  // 含非 ASCII 说明上游漏了一处归一化点 —— 记录问题，但**不 throw**，
  // 否则会把「一条记录命名不规范」升级成「整次结算失败」，那是拿丢数据当修 bug。
  if (/[^\x00-\x7F]/.test(skillId)) {
    process.emitWarning(
      `skill_id "${skillId}" 含非 ASCII 字符；skill_id 应为稳定英文 id（display_name 只用于展示）。` +
        '疑似上游未归一化，请检查 conversation-parser 的 SI.resolveSkillId 接入点。',
      { code: 'WBT_NON_ASCII_SKILL_ID' }
    );
  }
  const skillVersion = strOrNull(r.skill_version);
  const invocationId = r.skill_invocation_id ? String(r.skill_invocation_id) : NA;
  const usageId =
    r.usage_id ||
    makeUsageId(date, r.conversation_id, skillId, skillVersion, r.ordinal || 0, invocationId);

  // V3.0 的字段名是 skill_token_source，V3.1 起统一为 token_source（用户 §九）
  const rawSource = r.token_source !== undefined ? r.token_source : r.skill_token_source;
  const method = VALID_TOKEN_SOURCE.includes(rawSource) ? rawSource : 'unavailable';
  // 只有 injection 口径才允许出现数值；其余一律 null（§六 禁止自行估算）
  const skillToken = method === 'injection' ? numOrNull(r.skill_token) : NA;

  return {
    usage_id: usageId,
    conversation_id: r.conversation_id,
    // V3.26：Turn 关联。旧数据没有 turn_id 时保持 null，不猜测归属。
    turn_id: r.turn_id ? String(r.turn_id) : NA,
    provider_turn_id: r.provider_turn_id ? String(r.provider_turn_id) : NA,
    turn_ordinal: Number.isFinite(Number(r.turn_ordinal)) ? Number(r.turn_ordinal) : NA,
    event_ordinal: Number.isFinite(Number(r.event_ordinal)) ? Number(r.event_ordinal) : NA,
    // 该调用自身所属日期（决定它落在哪个 logs/<date>/ 目录）
    date,
    agent: strOrNull(r.agent),
    skill_id: skillId,
    skill_name: r.skill_name ? String(r.skill_name) : skillId,
    skill_version: skillVersion,
    start_time: r.start_time || NA,
    end_time: r.end_time || NA,
    duration_seconds: durationSeconds(r.start_time, r.end_time),
    // Skill 消耗：只有能**精确归因**的口径才填数值，否则 null
    skill_token: skillToken,
    token_source: method,
    // 以下为「精确但非独占」的旁证，绝不与 skill_token 混用
    call_request_id: r.call_request_id ? String(r.call_request_id) : NA,
    call_request_total_token: numOrNull(r.call_request_total_token),
    // V3.22：此前是 `Number.isFinite(Number(r.load_chars)) ? … : NA`，
    // 而 `Number(null) === 0`、`Number('') === 0` —— 「取不到」被写成 0，
    // 报表上看起来像「载入了 0 个字符」（编造观测值）。统一走 numOrNull。
    load_chars: numOrNull(r.load_chars),
    args: r.args ? String(r.args).slice(0, 500) : NA,
    status: VALID_USAGE_STATUS.includes(r.status) ? r.status : 'unknown',
    trigger_type: VALID_TRIGGER_TYPE.includes(r.trigger_type) ? r.trigger_type : 'unknown',
    // V3.22：认定「用了这个 Skill」的证据类型（取不到写 null）
    evidence: VALID_SKILL_EVIDENCE.includes(r.evidence) ? r.evidence : NA,
    source: VALID_CONVERSATION_SOURCE.includes(r.source) ? r.source : 'other',
    skill_invocation_id: invocationId,
    created_at: r.created_at || C.nowIso(),
    updated_at: C.nowIso(),
  };
}

/**
 * Work Segment Log（V3.5）。
 *
 * Segment 是 Conversation 内连续主题的轻量划分，用于把多主题会话拆成
 * 可归属的 Work Activity。它不替代 Conversation，也不承担成本总账。
 */
function normalizeWorkSegment(rec) {
  const r = rec || {};
  if (!r.conversation_id) {
    throw new C.LogError('Work Segment 必须关联 conversation_id。');
  }
  const topic = String(r.topic || '').trim();
  if (!topic) throw new C.LogError('Work Segment 缺少 topic。');
  const startTime = r.start_time || NA;
  const date = assertDate(r.date || dateOf(startTime) || C.today());
  const conversationId = String(r.conversation_id);
  const ordinal = Number.isFinite(Number(r.ordinal)) ? Number(r.ordinal) : 0;
  const segmentId =
    r.segment_id || makeSegmentId(date, conversationId, ordinal, startTime, topic);

  return {
    segment_id: segmentId,
    conversation_id: conversationId,
    date,
    ordinal,
    topic,
    summary: strOrNull(r.summary),
    start_time: startTime,
    end_time: r.end_time || NA,
    duration_seconds: durationSeconds(startTime, r.end_time),
    source: VALID_ACTIVITY_SOURCE.includes(r.source) ? r.source : 'agent',
    status: VALID_SEGMENT_STATUS.includes(r.status) ? r.status : 'completed',
    confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'medium',
    created_at: r.created_at || C.nowIso(),
    updated_at: C.nowIso(),
  };
}

/**
 * Work Activity Log（用户 §十）。
 *
 * **不依赖 Conversation**：人工记录的事项 `conversation_id = null` 是合法常态。
 */
function normalizeWorkActivity(rec) {
  const r = rec || {};
  const content = String(r.content || '').trim();
  if (!content) throw new C.LogError('Work Activity 缺少 content。');
  const date = assertDate(r.date || dateOf(r.start_time) || C.today());
  const conversationId = r.conversation_id ? String(r.conversation_id) : NA;
  const source = VALID_ACTIVITY_SOURCE.includes(r.source) ? r.source : 'manual';

  // V3.0 的字段名是 project，V3.1 起统一为 project_name（与 WorkItem 对齐）
  const projectName = r.project_name
    ? String(r.project_name)
    : r.project
      ? String(r.project)
      : NA;
  const workType = r.work_type ? String(r.work_type) : NA;
  // V3.3（用户 2026-09-22）：分类 / 项目阶段 / 成果 —— 三个归因维度 + 成果描述。
  // 均为**可空**：非工作事项天然没有项目阶段，不强制填写。
  const category = r.category ? String(r.category).trim() || NA : NA;
  // 项目阶段只适用于工作；探索沉淀允许保存成果（Skill 能力变化），
  // 生活 / 运动等其它分类仍清空成果。
  const isWork = !category || category === '工作';
  const allowsOutput = isWork || category === '探索沉淀';
  const projectStage = isWork && r.project_stage ? String(r.project_stage).trim() || NA : NA;
  const output = allowsOutput && r.output ? String(r.output).trim() || NA : NA;
  const detail = r.detail ? String(r.detail).trim() || NA : NA;
  const detailCompression = C.normalizeDetailCompression({
    detail_compression: r.detail_compression,
  }).detail_compression;
  const aiRole = r.ai_role && VALID_AI_ROLE.includes(String(r.ai_role))
    ? String(r.ai_role)
    : r.ai_role
      ? '未知'
      : NA;
  const segmentId = r.segment_id ? String(r.segment_id) : NA;
  const skills = Array.isArray(r.skills)
    ? [...new Set(r.skills.map((x) => String(x).trim()).filter(Boolean))]
    : [];
  const models = Array.isArray(r.models)
    ? [...new Set(r.models.map((x) => String(x).trim()).filter(Boolean))]
    : r.model
      ? [String(r.model)]
      : [];

  // 统一格式：有项目 →【项目名称】【工作类型】内容；无项目 →【工作类型】内容（§十一）
  const display =
    r.display_content ||
    C.buildDisplayContent({ project_name: projectName, work_type: workType, content });
  const log = display.length > 200 ? display.slice(0, 200) : display;

  return {
    activity_id:
      r.activity_id || makeActivityId(date, conversationId, content, r.start_time || NA),
    date,
    project_name: projectName,
    work_type: workType,
    // V3.3：分类（工作/生活/…）、项目阶段、成果
    category,
    project_stage: projectStage,
    output,
    content,
    detail,
    detail_compression: detailCompression,
    ai_role: aiRole,
    segment_id: segmentId,
    skills,
    models,
    display_content: display,
    log,
    log_length: log.length,
    start_time: r.start_time || NA,
    end_time: r.end_time || NA,
    // V3.24（用户 2026-09-28）：**AI 生成记录不产出时长**。
    //   非 manual 来源一律 NA（此前还会退回按 start/end 时刻推算 —— 那同样是会话收尾，不是工作时长）。
    //   同时修掉 `Number.isFinite(Number(null)) === true` 导致的「取不到写成 0」
    //   （与 V3.22 修的 load_chars 是同一类错误：0 与「不可获取」必须分开）。
    duration_minutes: (() => {
      if (source !== 'manual') return NA;
      const raw = r.duration_minutes;
      if (raw === null || raw === undefined || raw === '') {
        const viaHHMM = hhmmDurationMinutes(r.start_time, r.end_time);
        return viaHHMM === NA ? durationMinutes(r.start_time, r.end_time) : viaHHMM;
      }
      return Number.isFinite(Number(raw)) ? Number(raw) : NA;
    })(),
    // agent = 由对话产生；manual = 用户自己记录（允许没有 conversation_id）
    source,
    conversation_id: conversationId,
    status: ['completed', 'in_progress', 'needs_confirmation', 'cancelled'].includes(r.status)
      ? r.status
      : 'needs_confirmation',
    confidence: ['high', 'medium', 'low'].includes(r.confidence) ? r.confidence : 'low',
    // V3.6（用户 2026-09-24）：归属**二次确认**状态。
    //
    // 为什么需要：工作会话里会混进探索类 message，记录时按项目归属只能给出候选；
    // 总结时用上下文复核一次，复核结果落 `confirmed`，之后**默认不再重复验证**
    // （用户明确：「已经总结过的 message，若无明确要求重复总结时无需重复验证」）。
    //   confirmed     已确认（AI 复核或用户显式指定）
    //   pending_review 待复核（默认值；总结层只处理这一类）
    classification_status: ['confirmed', 'pending_review'].includes(r.classification_status)
      ? r.classification_status
      : 'pending_review',
    confirmed_at: r.confirmed_at ? String(r.confirmed_at) : NA,
    confirmed_by: r.confirmed_by ? String(r.confirmed_by) : NA,
    // 若该事项已被 WorkItem 收录，记下对应 id，便于与同步链路对齐
    work_item_id: r.work_item_id ? String(r.work_item_id) : NA,
    // V3.23（用户 2026-09-28）：TickTick 对应关系也随事项长期保留。
    //   原因：WorkItem 会随跨日被丢弃、`pending/` 也可能被清理，而永久活动日志不清理 ——
    //   taskId 只有落在这一层才不会失传（实测 09-20~09-23 的 taskId 已全部缺失）。
    //   无 taskId 时为 null（与 WorkItem 的 normalizeTicktick 同一口径，不保留半截对象）。
    // V3.24（用户 2026-09-28）：时长来源标签。
    //   AI 会话推导的事项 duration_minutes 恒为 null（不产出时长），
    //   此处把原因一并保留，避免「null 无法解释」。
    duration_source:
      r.duration_source && C.VALID_DURATION_SOURCE.includes(String(r.duration_source))
        ? String(r.duration_source)
        : NA,
    ticktick: C.normalizeTicktick(r).ticktick,
    // V3.4：宿主会话 id（**关联证据**，不是关联本身）。
    //   有了它，`conversation_id` 可以在结算之后被重新解析出来 ——
    //   「事项先导出、会话后结算」的时序问题因此可以自愈，而不是永久留 null。
    session_id: r.session_id ? String(r.session_id) : NA,
    created_at: r.created_at || C.nowIso(),
    updated_at: C.nowIso(),
  };
}

/**
 * AI Usage Log（V3.5）。
 *
 * Conversation 仍是原始总账。这里只保存**可精确表达**的归属记录：
 * exact / partial 表示该记录有明确 Segment 或 Activity；unallocated 表示用量已知但事项未知。
 * 不记录比例拆分，不从会话总量推算子事项用量。
 */
function normalizeAiUsage(rec) {
  const r = rec || {};
  if (!r.conversation_id) {
    throw new C.LogError('AI Usage 必须关联 conversation_id。');
  }
  const conversationId = String(r.conversation_id);
  const segmentId = r.segment_id ? String(r.segment_id) : NA;
  const activityId = r.activity_id ? String(r.activity_id) : NA;
  const startTime = r.start_time || NA;
  const date = assertDate(r.date || dateOf(startTime) || C.today());
  const ordinal = Number.isFinite(Number(r.ordinal)) ? Number(r.ordinal) : 0;
  const aiUsageId =
    r.ai_usage_id ||
    makeAiUsageId(date, conversationId, activityId, segmentId, ordinal, r.idempotency_key);

  const inputToken = numOrNull(r.input_token);
  const outputToken = numOrNull(r.output_token);
  const explicitTotal = numOrNull(r.total_token);
  const totalToken =
    explicitTotal !== NA
      ? explicitTotal
      : inputToken !== NA && outputToken !== NA
        ? inputToken + outputToken
        : NA;
  const credit = numOrNull(r.credit !== undefined ? r.credit : r.total_score);
  const requestedStatus = String(r.attribution_status || '').toLowerCase();
  const attributionStatus = VALID_ATTRIBUTION_STATUS.includes(requestedStatus)
    ? requestedStatus
    : activityId || segmentId
      ? 'exact'
      : 'unallocated';
  if (attributionStatus === 'unallocated' && (activityId || segmentId)) {
    throw new C.LogError('AI Usage 标记为 unallocated 时不得关联 activity_id/segment_id。');
  }
  if (attributionStatus !== 'unallocated' && !activityId && !segmentId) {
    throw new C.LogError(
      `AI Usage 标记为 ${attributionStatus} 时必须有 activity_id 或 segment_id。`
    );
  }
  const models = Array.isArray(r.models)
    ? [...new Set(r.models.map((x) => String(x).trim()).filter(Boolean))]
    : r.model
      ? [String(r.model)]
      : [];
  const skills = Array.isArray(r.skills)
    ? [...new Set(r.skills.map((x) => String(x).trim()).filter(Boolean))]
    : r.skill
      ? [String(r.skill)]
      : [];

  return {
    ai_usage_id: aiUsageId,
    conversation_id: conversationId,
    segment_id: segmentId,
    activity_id: activityId,
    date,
    attribution_status: attributionStatus,
    input_token: inputToken,
    output_token: outputToken,
    total_token: totalToken,
    credit: credit === NA ? NA : round2(credit),
    model: models[0] || strOrNull(r.model),
    models,
    agent: strOrNull(r.agent),
    skills,
    start_time: startTime,
    end_time: r.end_time || NA,
    duration_seconds: durationSeconds(startTime, r.end_time),
    source: VALID_CONVERSATION_SOURCE.includes(r.source) ? r.source : 'other',
    note: strOrNull(r.note),
    created_at: r.created_at || C.nowIso(),
    updated_at: C.nowIso(),
  };
}

const NORMALIZERS = {
  conversation: normalizeConversation,
  turn: normalizeTurn,
  skill_usage: normalizeSkillUsage,
  work_segment: normalizeWorkSegment,
  work_activity: normalizeWorkActivity,
  ai_usage: normalizeAiUsage,
};

/* ------------------------------------------------------------------ *
 * JSONL 读写
 * ------------------------------------------------------------------ */

/** 逐行解析；坏行跳过并计数，不因一行损坏丢掉整份日志 */
function readJsonl(file) {
  const out = { records: [], bad_lines: 0 };
  if (!fs.existsSync(file)) return out;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return out;
  }
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === 'object' && !Array.isArray(o)) out.records.push(o);
      else out.bad_lines += 1;
    } catch (e) {
      out.bad_lines += 1;
    }
  }
  return out;
}

/** 原子整文件重写（临时文件 → 回读校验 → rename），避免半截文件 */
function writeJsonlAtomic(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = records.length ? `${records.map((r) => JSON.stringify(r)).join('\n')}\n` : '';
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, body, 'utf8');
  readJsonl(tmp); // 回读校验：写坏了宁可失败，也不污染日志
  fs.renameSync(tmp, file);
}

/** 读取某天的结构化日志之一（新路径优先，回落 V3.0 旧路径） */
function read(dir, kind, date) {
  if (!KINDS[kind]) throw new C.LogError(`未知日志类型：${kind}`);
  return readJsonl(resolveLogPath(dir, kind, assertDate(date))).records;
}

/** 读取日期区间 [from, to]（含两端），用于 7/30 天周期分析（用户 §十二） */
function readRange(dir, kind, from, to) {
  const out = [];
  const start = new Date(`${assertDate(from)}T00:00:00`);
  const end = new Date(`${assertDate(to)}T00:00:00`);
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const date = `${d.getFullYear()}-${C.pad(d.getMonth() + 1)}-${C.pad(d.getDate())}`;
    out.push(...read(dir, kind, date));
  }
  return out;
}

/** 列出已有结构化日志的日期（倒序），供 GitHub 同步与 Raw 清理使用 */
function listLoggedDates(dir) {
  const root = logsDir(dir);
  if (!fs.existsSync(root)) return [];
  try {
    return fs
      .readdirSync(root)
      .filter(
        (n) => /^\d{4}-\d{2}-\d{2}$/.test(n) && fs.statSync(path.join(root, n)).isDirectory()
      )
      .sort()
      .reverse();
  } catch (e) {
    return [];
  }
}

/* ------------------------------------------------------------------ *
 * upsert（幂等写入）
 * ------------------------------------------------------------------ */

/**
 * 是否为「有效值」（合并时优先取有效值）。
 *
 * `null` / `'unavailable'` **不算有效值** —— 否则一次失败解析会把此前成功拿到的
 * Token 覆盖成空，造成「越修越差」。
 */
const isMeaningful = (v) => !isUnavailable(v) && !(Array.isArray(v) && !v.length);

/**
 * 按业务键合并两条记录。
 *
 * 语义是「**同一条记录的新版本**」，不是「两条记录相加」：
 *
 * ```text
 * 有效值（数值/字符串） → 覆盖
 * null / unavailable    → 不覆盖已有的有效值
 * 完全无变化            → 原样返回旧记录（连 updated_at 都不动）
 * ```
 *
 * `updated_at` / `settled_at` 只在**内容真的变了**时才刷新 ——
 * 否则重复结算每跑一次就改一次 mtime，既丢失「有没有新数据」的信号，
 * 也让幂等性无法自证。
 */
function mergeRecord(kind, prev, next) {
  const out = Object.assign({}, prev);
  let changed = false;
  for (const [k, v] of Object.entries(next)) {
    if (k === 'created_at' || k === 'updated_at' || k === 'settled_at') continue;
    if (!isMeaningful(v) && isMeaningful(prev[k])) continue;
    if (deepEqual(prev[k], v)) continue;
    out[k] = v;
    changed = true;
  }
  if (!changed) return prev;
  out.created_at = prev.created_at || next.created_at;
  out.updated_at = next.updated_at || C.nowIso();
  if (next.settled_at) out.settled_at = next.settled_at;
  return out;
}

/**
 * 幂等写入：按业务键 upsert 一批记录。
 *
 * ## 跨日期：按记录自身的日期分桶（真实数据驱动的重要修正）
 *
 * Provider 的会话**可以跨天存活** —— 同一个 `session_id` 在 9-01 创建、9-21 还在用。
 * 因此一次结算产出的 Skill Usage 记录，其 `start_time` 可能分散在多个日期，
 * 这不是错误，而是真实形态。
 *
 * 正确的归档语义是「**每个事件按其发生日归档**」：
 *
 * ```text
 * Conversation   → 会话创建日（start_time 那天），一条
 * Skill Usage    → 每个调用自己的 start_time 那天（可能跨多日）
 * Work Activity  → 事项自己的 start_time 那天（可跨多日）
 * ```
 *
 * 因此本函数把入参**按日期分组**，各组写入各自的 `logs/<date>/`，
 * 最后合并统计返回。`opts.strictSingleDate = true` 可要求「必须同一天」，
 * 供调用方在语义上确实只应有一天时做断言。
 *
 * **绝对不追加重复条目**。返回值区分 created / updated / unchanged，
 * 让调用方能明确回答「这次重复处理有没有产生新数据」。
 */
function upsert(dir, kind, records, opts) {
  const meta = KINDS[kind];
  if (!meta) throw new C.LogError(`未知日志类型：${kind}`);
  const opts2 = opts || {};
  const list = (records || []).filter(Boolean);
  const fallbackDate = assertDate(opts2.date || C.today());
  if (!list.length) {
    return {
      created: 0,
      updated: 0,
      unchanged: 0,
      total: 0,
      bad_lines: 0,
      dates: [],
      files: [],
      file: logPath(dir, kind, fallbackDate),
      date: fallbackDate,
    };
  }

  const normalize = NORMALIZERS[kind];
  const normalized = list.map((r) => normalize(r));

  // 按记录自身的日期分桶：date → records[]
  const groups = new Map();
  for (const rec of normalized) {
    const d = assertDate(rec.date || dateOf(rec.start_time) || fallbackDate);
    if (!groups.has(d)) groups.set(d, []);
    groups.get(d).push(rec);
  }
  if (groups.size > 1 && opts2.strictSingleDate) {
    throw new C.LogError(
      `一次 upsert 的 ${kind} 记录跨越多个日期（${[...groups.keys()].join(', ')}），` +
        '但调用方要求单日期写入。'
    );
  }

  const stats = {
    created: 0,
    updated: 0,
    unchanged: 0,
    bad_lines: 0,
    total: 0,
    dates: [...groups.keys()].sort(),
    files: [],
    per_date: {},
  };

  // 锁文件用 O_CREAT|O_EXCL 创建，父目录必须先存在。
  // 所有分组共用同一个 logs/ 锁，因此整个多日期写入是一个原子操作。
  fs.mkdirSync(logsDir(dir), { recursive: true });
  C.withLock(logsDir(dir), () => {
    for (const date of stats.dates) {
      const records = groups.get(date);
      const file = resolveLogPath(dir, kind, date);
      const existing = readJsonl(file);
      stats.bad_lines += existing.bad_lines;

      const index = new Map();
      existing.records.forEach((r, i) => {
        const k = r[meta.key];
        if (k) index.set(String(k), i);
      });

      const sub = { created: 0, updated: 0, unchanged: 0 };
      for (const rec of records) {
        const key = String(rec[meta.key]);
        const at = index.get(key);
        if (at === undefined) {
          index.set(key, existing.records.length);
          existing.records.push(rec);
          sub.created += 1;
          continue;
        }
        const merged = mergeRecord(kind, existing.records[at], rec);
        if (deepEqual(merged, existing.records[at])) {
          sub.unchanged += 1;
          continue;
        }
        existing.records[at] = merged;
        sub.updated += 1;
      }

      // 该日期下全部 unchanged 时不写盘：重复处理不产生任何磁盘副作用
      if (sub.created || sub.updated) writeJsonlAtomic(file, existing.records);

      stats.created += sub.created;
      stats.updated += sub.updated;
      stats.unchanged += sub.unchanged;
      stats.total += existing.records.length;
      stats.files.push(file);
      stats.per_date[date] = sub;
    }
  });

  // 向后兼容：单日期时给出 file / date 两个便捷字段
  stats.file = stats.files.length === 1 ? stats.files[0] : logPath(dir, kind, stats.dates[0]);
  stats.date = stats.dates.length === 1 ? stats.dates[0] : null;
  return stats;
}

const upsertConversation = (dir, rec, opts) => upsert(dir, 'conversation', [rec], opts);
const upsertTurn = (dir, recs, opts) =>
  upsert(dir, 'turn', Array.isArray(recs) ? recs : [recs], opts);
const upsertSkillUsage = (dir, recs, opts) =>
  upsert(dir, 'skill_usage', Array.isArray(recs) ? recs : [recs], opts);
const upsertWorkSegment = (dir, recs, opts) =>
  upsert(dir, 'work_segment', Array.isArray(recs) ? recs : [recs], opts);
const upsertWorkActivity = (dir, recs, opts) =>
  upsert(dir, 'work_activity', Array.isArray(recs) ? recs : [recs], opts);
const upsertAiUsage = (dir, recs, opts) =>
  upsert(dir, 'ai_usage', Array.isArray(recs) ? recs : [recs], opts);

/* ------------------------------------------------------------------ *
 * 原始快照（支持重新解析，用户 §二十）
 * ------------------------------------------------------------------ */

/**
 * 落盘解析结果的原始快照。
 *
 * 只存**解析产物**（请求级 usage 明细 + Skill 调用 + 会话行），不复制原始 JSONL ——
 * 后者单会话可达数十 MB；快照里记下 `source_files`，需要完整回溯时按路径回读。
 */
function writeRawSnapshot(dir, date, sessionId, payload, source) {
  const file = path.join(rawDir(dir, date, source), `${sessionId}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  C.atomicWriteJSON(file, Object.assign({ parser_version: PARSER_VERSION }, payload));
  return file;
}

function readRawSnapshot(dir, date, sessionId, source) {
  return C.readJSON(
    path.join(rawDir(dir, assertDate(date), source), `${sessionId}.json`),
    null
  );
}

/** 按 session_id 在所有日期目录里找原始快照（不能假定就是今天） */
function findRawSnapshot(dir, sessionId) {
  const rawRoot = path.join(dir, 'raw');
  if (!fs.existsSync(rawRoot)) return null;
  const want = `${String(sessionId)}.json`;
  let sources = [];
  try {
    sources = fs.readdirSync(rawRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    return null;
  }
  for (const source of sources) {
    const root = path.join(rawRoot, source.name);
    let dates = [];
    try {
      dates = fs.readdirSync(root);
    } catch (e) {
      continue;
    }
    for (const date of dates) {
      const file = path.join(root, date, want);
      if (fs.existsSync(file)) return file;
    }
  }
  return null;
}

/** 列出某天所有宿主的 raw 快照文件（status 统计用）。 */
function listRawSnapshotFiles(dir, date) {
  const rawRoot = path.join(dir, 'raw');
  const day = assertDate(date);
  if (!fs.existsSync(rawRoot)) return [];
  const out = [];
  let sources = [];
  try {
    sources = fs.readdirSync(rawRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    return out;
  }
  for (const source of sources) {
    const dayDir = path.join(rawRoot, source.name, day);
    if (!fs.existsSync(dayDir)) continue;
    try {
      for (const name of fs.readdirSync(dayDir)) {
        if (name.endsWith('.json')) out.push(path.join(dayDir, name));
      }
    } catch (e) {
      /* 忽略 */
    }
  }
  return out;
}

/** 按 session_id 在所有日期的 Conversation Log 里查找已结算记录 */
function findConversationBySession(dir, sessionId) {
  const want = String(sessionId);
  for (const date of listLoggedDates(dir)) {
    const hit = read(dir, 'conversation', date).find((r) => String(r.session_id) === want);
    if (hit) return hit;
  }
  // 兼容 V3.0 旧布局
  const legacyKonv = path.join(legacyStructuredDir(dir), KINDS.conversation.legacyDir);
  if (!fs.existsSync(legacyKonv)) return null;
  try {
    for (const f of fs.readdirSync(legacyKonv).filter((x) => x.endsWith('.jsonl'))) {
      const hit = readJsonl(path.join(legacyKonv, f)).records.find(
        (r) => String(r.session_id) === want
      );
      if (hit) return hit;
    }
  } catch (e) {
    /* 忽略 */
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 汇总（供每日复盘与周期分析）
 * ------------------------------------------------------------------ */

/**
 * 汇总一批记录里的数值字段。
 *
 * `null` **既不计入分子也不计入分母**，并单独报出覆盖度 ——
 * 否则「10 条里有 3 条拿不到 Score」会被静默算成「总分少了一截」。
 */
function sumField(records, field) {
  let sum = 0;
  let known = 0;
  let unknown = 0;
  for (const r of records) {
    const v = r[field];
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v;
      known += 1;
    } else {
      unknown += 1;
    }
  }
  return {
    value: known ? sum : NA,
    known,
    unknown,
    coverage: records.length ? Number((known / records.length).toFixed(3)) : NA,
  };
}

/** 按字段分组计数（不可用值统一记为 `null` 桶，不伪装成字符串） */
function countBy(records, field) {
  const out = {};
  for (const r of records) {
    const k = isUnavailable(r[field]) ? 'null' : String(r[field]);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

module.exports = {
  // 常量
  PARSER_VERSION,
  KINDS,
  NA,
  UNAVAILABLE,
  VALID_SETTLEMENT_STATUS,
  VALID_CONVERSATION_HOST_STATUS,
  VALID_USAGE_STATUS,
  VALID_TOKEN_SOURCE,
  VALID_ACTIVITY_SOURCE,
  VALID_TRIGGER_TYPE,
  VALID_SKILL_EVIDENCE,
  VALID_CONVERSATION_SOURCE,
  VALID_AI_ROLE,
  VALID_ATTRIBUTION_STATUS,
  VALID_SEGMENT_STATUS,
  VALID_CLASSIFICATION_STATUS,
  VALID_TURN_STATUS,
  VALID_TURN_TOKEN_SOURCE,
  // 路径
  logsDir,
  dayDir,
  dayFile,
  logPath,
  resolveLogPath,
  structuredDir,
  kindDir,
  legacyStructuredDir,
  legacyLogPath,
  rawDir,
  rawSourceDir,
  summariesDir,
  // 工具
  assertDate,
  dateOf,
  isUnavailable,
  isMeaningful,
  numOrNull,
  strOrNull,
  numOrUnavailable,
  strOrUnavailable,
  deepEqual,
  round6,
  round2,
  durationSeconds,
  durationMinutes,
  hhmmDurationMinutes,
  // ID
  makeConversationId,
  makeTurnId,
  makeUsageId,
  makeSegmentId,
  makeActivityId,
  makeActivityIdFromWorkItem,
  makeAiUsageId,
  // 归一化
  normalizeConversation,
  normalizeTurn,
  normalizeSkillUsage,
  normalizeWorkSegment,
  normalizeWorkActivity,
  normalizeAiUsage,
  mergeRecord,
  // 读写
  readJsonl,
  writeJsonlAtomic,
  read,
  readRange,
  listLoggedDates,
  upsert,
  upsertConversation,
  upsertTurn,
  upsertSkillUsage,
  upsertWorkSegment,
  upsertWorkActivity,
  upsertAiUsage,
  writeRawSnapshot,
  readRawSnapshot,
  findRawSnapshot,
  listRawSnapshotFiles,
  findConversationBySession,
  // 汇总
  sumField,
  countBy,
};
