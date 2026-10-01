'use strict';
/**
 * work-time-tracking 共享核心库（V1.9）。
 *
 * 职责边界（§2.1/§2.2/§60/§61）：
 *   宿主工具（Codex / WorkBuddy）决定「什么时候运行」——通过 Hook / Event / 自动任务。
 *   本 Skill 决定「运行以后做什么」——Activity → Security Filter → WorkItem → DailyLog
 *   → DailySummary → 准备同步数据。
 *
 *   **Skill 不是后台服务**：不创建常驻进程、不创建系统定时器、不自行监听电脑、
 *   不自行推送 TickTick。因此本库与全部脚本中**没有任何定时器或自动化创建逻辑**。
 *
 * 核心原则：**AI 负责理解，脚本负责确定性操作。**
 * 任何对 current.json 的修改都必须表达为 op，经由 runMutation() 在锁内重读、
 * 重放 spool、递增 version、原子写入。禁止无保护的文本覆盖。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const security = require('./security');
const roleProfile = require('./role-profile');

/* V2.1 数据契约（§12 项目/工作类型、§8 展示格式、§42 自检） */
const CONFIG_VERSION = '3.6';
const SCHEMA_VERSION = '3.2';
const MANIFEST_TYPE = 'work-time-log';
const MANIFEST_VERSION = '1.0';
const SKILL_NAME = 'work-time-tracking';
const SYNC_SKILL = 'ticktick-work-review';

/**
 * §6 工作类型的推荐基础类型。
 * §6 明确「工作类型不是固定死的，如果具体业务需要可以扩展」，
 * 因此 config.work_types 可覆盖/扩展本清单。
 */
const DEFAULT_WORK_TYPES = [
  '需求分析',
  '需求梳理',
  '产品设计',
  '交互设计',
  '原型设计',
  'UI设计',
  '技术方案',
  '开发',
  '测试',
  '问题排查',
  '项目会议',
  '沟通协调',
  '文档整理',
  '数据分析',
  '项目管理',
  '项目跟进',
  '方案评审',
  '学习研究',
  '方案设计',
  'PRD编写',
  '技术沟通',
  '开发协作',
  '测试验证',
  '资料查询',
  '其他',
];

/** 无项目事项在汇总时统一归入（§24.3） */
const UNASSIGNED_PROJECT_LABEL = '其他工作';

/**
 * 事项分类（V3.3，用户 2026-09-22）—— 回答「这是工作还是生活」。
 *
 * 总结必须先分类再组织：生活/运动/休闲不得被套上职业视角（用户明确要求）。
 * 取值可在 `config.work.categories` 中扩展。
 */
// V3.6（用户 2026-09-24）：「探索沉淀」升为独立分类 ——
// AI 工具 / Skill / MCP / 提示词建设是**个人方向的沉淀**，不再混进「工作」。
const DEFAULT_WORK_CATEGORIES = [
  '工作',
  '探索沉淀',
  '生活',
  '个人成长',
  '健康运动',
  '休闲娱乐',
  '其他',
];

/**
 * 探索沉淀项目的默认白名单（`config.work.exploration_projects` 可扩展）。
 *
 * 留空是**有意义**的默认：项目名本身命中工具词表（skill / hook / MCP …）时
 * 也会被判为探索类，白名单用于补充「名字里没有工具词」的探索项目。
 */
const DEFAULT_EXPLORATION_PROJECTS = [];

/**
 * 工作类型：**产品经理口径**（V3.3，用户 2026-09-22）。
 *
 * 与「项目阶段」是两个独立维度：工作类型 = 在做什么事，项目阶段 = 项目走到哪一段。
 */
const DEFAULT_PM_WORK_TYPES = [
  '产品规划',
  '需求分析',
  '需求沟通',
  '需求文档',
  '竞品/行业研究',
  '产品设计',
  '原型设计',
  '交互设计',
  '数据分析',
  '项目管理',
  '研发协作',
  '测试验收',
  '上线发布',
  '问题处理',
  '产品运营',
  '产品复盘',
  '会议',
  '其他工作',
];

/**
 * 项目阶段（V3.3，用户 2026-09-22）—— AI 成本的第三个归因维度。
 *
 * **无法确定时留空**（不猜阶段）—— 猜出来的阶段会让「阶段成本分布」失真。
 */
const DEFAULT_PROJECT_STAGES = [
  '需求分析',
  '方案设计',
  '交互设计',
  '原型设计',
  'PRD编写',
  '技术沟通',
  '开发协作',
  '测试验证',
  '问题排查',
  '上线发布',
  '运营维护',
  '需求阶段',
  '设计阶段',
  '开发阶段',
  '测试阶段',
  '上线阶段',
  '运营/迭代阶段',
  '其他',
];

/** 旧版本标识，仅用于识别并迁移既有日志目录 */
const LEGACY_MANIFEST_TYPES = ['work-time-shared-log'];
const LEGACY_MANIFEST_FORMATS = ['work-time-log'];

const VALID_STATUS = [
  'not_started',
  'in_progress',
  'paused',
  'completed',
  'cancelled',
  'needs_confirmation',
];
/** §11.1/§13：source 取值。auto 表示宿主事件自动产生，generic 表示其他宿主工具 */
const VALID_SOURCE = ['codex', 'workbuddy', 'manual', 'auto', 'generic', 'other'];
const VALID_CONFIDENCE = ['high', 'medium', 'low'];
/** §51：部分成功时 success / partial / failed 分别记录 */
const VALID_SYNC_STATUS = ['pending', 'syncing', 'success', 'partial', 'failed'];
const VALID_TRACKING_STATUS = ['tracking', 'paused', 'disabled', 'initializing', 'error'];
/** §5 允许的 Activity 事件类型（注意：不含 ai_response，且新增 interrupt） */
const VALID_EVENT_TYPE = [
  'session_start',
  'session_end',
  'user_interaction',
  'tool_activity',
  'file_operation',
  'command',
  'manual_input',
  'interrupt',
];
const VALID_MECHANISM = ['hooks', 'skill', 'manual', 'unavailable', 'unknown'];
const VALID_AI_ROLE = ['AI主导', 'AI协作', 'AI辅助', 'AI查询', 'AI排障', '未知'];

/**
 * `actual_duration` 的来源标签（V3.24，用户 2026-09-28）。
 *
 * 用户决定：**AI 生成记录不产出时长** —— 会话推导出的时刻（首个相关消息、会话收尾、
 * 批量封段时刻）都不代表真实工作时长。因此时长只在「人工明确给出时段」时才有值，
 * 其余一律 `null` 并附可解释的原因（与「取不到写 null，禁止估算」同一纪律）。
 *
 * 为什么必须区分来源而不是「有没有 end_time」：实测 09-20~09-24 的 112 条记录里，
 * 有 end_time 的 36 条中 28 条是 AI 推导（其中 7 条的 end 全是当天同步时刻 18:56），
 * 按「有无 end」分档会把 2,164 分的假时长当成事实。
 */
const VALID_DURATION_SOURCE = [
  'segments', // 全部来自已闭合时段（人工明确给出）
  'segments_partial', // 含未闭合时段，时长只算了闭合部分
  'open_segment', // 只有未闭合时段 → 无法计时
  'unknown', // 无任何时间数据
  'not_applicable_ai_session', // AI 会话推导：不产出时长（用户 2026-09-28）
  'live', // 实时视图（含开放段现值）—— **不得落盘**
];
const DEFAULT_TOOLS = ['codex', 'workbuddy', 'manual', 'other'];
const AUTO_TOOLS = ['codex', 'workbuddy', 'other'];

/**
 * `WorkItem.ticktick` 子字段（§30/§31 taskId 回写）。
 *
 * 由 `ticktick-work-review` 产生并在同步回报中给出，本技能只**保存**，不操作 TickTick API。
 * 保存的目的是消除「每次同步靠标题搜索匹配」的失手风险（§39）。
 */
const VALID_TICKTICK_FIELDS = ['taskId', 'projectId', 'syncedAt'];
/** taskId 形如 6aaf6b5ee4b066c22040c33d（24 位十六进制），但允许其他形态，仅拦明显非法值 */
const MAX_TICKTICK_ID_LENGTH = 128;

const STATUS_LEVEL = {
  recording: { emoji: '🟢', label: '正在记录' },
  idle: { emoji: '🟡', label: '已开启但暂无活动' },
  error: { emoji: '🔴', label: '记录异常' },
  off: { emoji: '⚪', label: '未开启' },
  unconfigured: { emoji: '⚪', label: '未配置' },
};

const LOCK_STALE_MS = 90 * 1000;
/**
 * 写锁最长等待。
 *
 * **必须小于宿主给 Hook 的预算**（WorkBuddy 为 10s，hook-bridge 自身再收窄到 4s）：
 * 若允许等待时间超过宿主预算，进程会在等锁途中被宿主杀死，既拿不到锁又留下
 * 一个「看起来失败」的记录。宁可早日放弃并让 collect-activity 把 op 暂存到 spool
 * （下次写入自动重放），也不要死等到被杀。
 */
const LOCK_TIMEOUT_MS = 3 * 1000;
/** 两次抢锁之间的间隔（毫秒），用于非忙等休眠 */
const LOCK_RETRY_INTERVAL_MS = 50;
const MAX_CONTENT_LENGTH = security.MAX_ACTIVITY_LENGTH;

const LOCATOR_PATH = path.join(os.homedir(), '.workbuddy', 'work-time-tracking.json');

const EXIT = {
  OK: 0,
  USAGE: 2,
  NO_DIR: 3,
  NEED_DECISION: 4,
  CONFLICT: 5,
  BAD_DIR: 6,
};

class LogError extends Error {
  constructor(message, code) {
    super(message);
    this.code = typeof code === 'number' ? code : EXIT.USAGE;
  }
}

/* ------------------------------------------------------------------ *
 * 时间：WorkItem 使用 HH:MM，日期由 date 字段承载
 * ------------------------------------------------------------------ */

const pad = (n, w) => String(n).padStart(w || 2, '0');

function tzOffset(date) {
  const d = date || new Date();
  const total = -d.getTimezoneOffset();
  const sign = total >= 0 ? '+' : '-';
  const abs = Math.abs(total);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function nowIso() {
  const d = new Date();
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tzOffset(d)}`
  );
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowMinutes() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

const nowHHMM = () => fmtHHMM(nowMinutes());

function parseHHMM(value) {
  const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(value));
  if (!m) throw new LogError(`时间格式应为 HH:MM，收到：${value}`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) throw new LogError(`时间超出范围：${value}`);
  return h * 60 + mi;
}

function fmtHHMM(minutes) {
  let v = Math.round(minutes);
  if (!Number.isFinite(v) || v < 0) v = 0;
  return `${pad(Math.floor(v / 60))}:${pad(v % 60)}`;
}

/** 从 "HH:MM" 或带时区 ISO 时间戳中取当日分钟数（兼容旧版 ISO） */
function toMinutes(value) {
  if (!value) return null;
  const text = String(value);
  const m = /T(\d{2}):(\d{2})/.exec(text);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/^\d{1,2}:\d{2}/.test(text)) return parseHHMM(text);
  return null;
}

const isHHMM = (value) => typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value.trim());

function randomHex(n) {
  return crypto.randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}

const sha1 = (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');

/** §10.2：WorkItem 全局唯一 ID，例如 WI-20260920-A8F2C1D3 */
function makeId() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  return `WI-${stamp}-${randomHex(8).toUpperCase()}`;
}

/** §11.1：Activity ID，例如 ACT-2f9a1c7e */
const makeActivityId = () => `ACT-${randomHex(8)}`;

/* ------------------------------------------------------------------ *
 * 项目与工作类型（§4-§11 / §28）
 * ------------------------------------------------------------------ */

/**
 * §8/§28/§44：展示内容
 *   有项目 → 【项目名称】【工作类型】事项内容
 *   无项目 → 【工作类型】事项内容
 */
function buildDisplayContent(item) {
  const content = String((item && item.content) || '').trim();
  const workType = item && item.work_type ? String(item.work_type).trim() : '';
  const project = item && item.project_name ? String(item.project_name).trim() : '';
  if (project && workType) return `【${project}】【${workType}】${content}`;
  if (workType) return `【${workType}】${content}`;
  return content;
}

/**
 * 归一化 WorkItem 的项目/工作类型字段，并重算 display_content（§9/§28）。
 *
 * §5/§11 硬约束：`confidence = low` 时不得写入项目名称或工作类型 ——
 * 宁可留空，也不为了格式完整而猜测。
 */
function normalizeItem(rec) {
  if (!rec) return rec;
  if (rec.project_name === undefined) rec.project_name = null;
  if (rec.work_type === undefined) rec.work_type = null;
  if (rec.project_confidence === undefined) {
    rec.project_confidence = rec.project_name ? 'high' : null;
  }
  if (rec.work_type_confidence === undefined) {
    rec.work_type_confidence = rec.work_type ? 'high' : null;
  }
  // 只有 high 或经上下文充分确认的 medium 才可保留（§5）
  if (rec.project_name && !['high', 'medium'].includes(rec.project_confidence)) {
    rec.project_name = null;
    rec.project_confidence = null;
  }
  if (rec.work_type && !['high', 'medium'].includes(rec.work_type_confidence)) {
    rec.work_type = null;
    rec.work_type_confidence = null;
  }
  if (!rec.project_name) rec.project_confidence = null;
  if (!rec.work_type) rec.work_type_confidence = null;
  // V3.3（用户 2026-09-22）：三个归因字段 + 成果描述。
  //   不强制填写：不确定一律 null（禁止为「格式完整」而猜测或编造成果）。
  //   值本身由 AI / 用户显式给出（枚举见 config.work），此处只做类型归一化。
  const strField = (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'object') return null;
    const s = String(v).trim();
    return s || null;
  };
  rec.category = strField(rec.category);
  rec.project_stage = strField(rec.project_stage);
  rec.output = strField(rec.output);
  // V3.5：200 字只限制展示日志；detail 保存脱敏后的结构化说明。
  rec.detail = strField(rec.detail);
  rec.ai_role = strField(rec.ai_role);
  if (rec.ai_role && !VALID_AI_ROLE.includes(rec.ai_role)) rec.ai_role = '未知';
  rec.segment_id = strField(rec.segment_id);
  const listField = (v) =>
    Array.isArray(v)
      ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))]
      : [];
  rec.skills = listField(rec.skills);
  rec.models = listField(rec.models);
  // V3.4（2026-09-22）：宿主会话 id 与空间项目 id —— 事项侧的**关联证据**。
  //   为什么不展示也要留：导出 Work Activity 时要用 `session_id` 把事项对回
  //   它所属的 Conversation，从而挂上 `conversation_id`（AI 成本归因的唯一入口）。
  //   此前这两个字段在「批量判定回写」这一步被整个丢掉，导致导出后全是 null。
  rec.session_id = strField(rec.session_id);
  rec.project_id = strField(rec.project_id);
  // 项目阶段只适用于工作；探索沉淀允许保存成果（Skill 能力变化），
  // 但不能套用产品阶段，避免把 AI 能力建设算成产品交付物。
  if (rec.category && rec.category !== '工作') {
    rec.project_stage = null;
    if (rec.category !== '探索沉淀') rec.output = null;
  }
  // §14（2026-09-20 扩展）：允许「已完成 · 时间未知」
  //   无 start_time 的条目若被显式标记 time_unknown，则 completed 合法；
  //   未标记时仍按原规则要求 needs_confirmation（避免掩盖数据错误）。
  const hasSeg = (rec.time_segments || []).some((s) => s && s.start);
  if (!rec.start_time && !hasSeg) {
    if (rec.time_unknown === true && ['completed', 'cancelled'].includes(rec.status)) {
      // 合法：时间未知的已完成事项 —— 时间类字段必须全空（§13 不编造）
      rec.start_time = null;
      rec.end_time = null;
      rec.actual_duration = null;
    } else if (rec.time_unknown === undefined) {
      rec.time_unknown = false;
    }
  } else if (rec.time_unknown === undefined) {
    rec.time_unknown = false;
  }
  // V3.24：时长来源标签必须落在枚举内，脏值一律置 null（否则报表口径会被悄悄污染）
  if (!VALID_DURATION_SOURCE.includes(rec.duration_source)) rec.duration_source = null;
  rec.display_content = buildDisplayContent(rec);
  normalizeTicktick(rec);
  normalizeContentCompression(rec);
  normalizeDetailCompression(rec);
  return rec;
}

/**
 * 归一化 `content_compression`（§12 超长内容的处理留痕）。
 *
 * 只在**确实发生过压缩/截断**时才保留该字段，形态为：
 *
 *   { summarized: boolean, truncated: boolean, original_length: number|null,
 *     final_length: number|null, reason: string }
 *
 * 规则（与 `ticktick` 一致的两条硬约束）：
 *   - **无意义时置 null** —— 没有 original_length 或既未压缩也未截断 → 整个置 null，
 *     避免给每条正常记录都挂一个空对象。
 *   - **归一化必须幂等** —— 已归一化的记录再跑一次结果不得变化。
 */
function normalizeContentCompression(rec) {
  if (!rec) return rec;
  const cc = rec.content_compression;
  if (!cc || typeof cc !== 'object' || Array.isArray(cc)) {
    rec.content_compression = null;
    return rec;
  }
  const summarized = cc.summarized === true;
  const truncated = cc.truncated === true;
  // 二者互斥：摘要了就没截断，截断了就没摘要。都 false → 无意义。
  if (!summarized && !truncated) {
    rec.content_compression = null;
    return rec;
  }
  const finalLength = Number(cc.final_length);
  const out = {
    // 数据自相矛盾时以**更保守**的一方为准：截断意味着信息已丢失，
    // 宁可把它标成「丢过数据」，也不要误标成「只是压缩过」。
    summarized: summarized && !truncated,
    truncated,
    original_length: Number.isFinite(Number(cc.original_length)) ? Number(cc.original_length) : null,
    final_length: Number.isFinite(finalLength) ? finalLength : null,
    reason: typeof cc.reason === 'string' && cc.reason.trim() ? cc.reason.trim() : null,
  };
  // 没有原始长度就无法判断「压了多少」，视为无意义
  if (out.original_length === null) {
    rec.content_compression = null;
    return rec;
  }
  rec.content_compression = out;
  return rec;
}

/** 归一化 detail 截断留痕；没有截断时置 null。 */
function normalizeDetailCompression(rec) {
  const d = rec.detail_compression;
  if (!d || typeof d !== 'object' || Array.isArray(d) || d.truncated !== true) {
    rec.detail_compression = null;
    return rec;
  }
  const original = Number(d.original_length);
  const final = Number(d.final_length);
  rec.detail_compression = {
    truncated: true,
    original_length: Number.isFinite(original) && original >= 0 ? original : null,
    final_length: Number.isFinite(final) && final >= 0 ? final : null,
    reason: d.reason ? String(d.reason) : 'detail 已按安全上限截断',
  };
  return rec;
}

/**
 * 归一化 `WorkItem.ticktick`（§30/§31 taskId 回写）。
 *
 * 语义：本地 WorkItem 与 TickTick Task 的对应关系。
 * 本技能**只保存、不操作** TickTick API（§4 职责边界）——
 * 值由 `ticktick-work-review` 在同步回报中给出。
 *
 * 规则：
 *   - 无 taskId  → 整个字段置 null（不保留半截残缺对象，避免"看起来同步过"）
 *   - 有 taskId  → 只保留白名单字段，其余丢弃（防脏数据扩散）
 *   - projectId / syncedAt 允许缺省为 null（可分次补齐）
 */
function normalizeTicktick(rec) {
  if (!rec) return rec;
  const tt = rec.ticktick;
  if (tt === undefined || tt === null) {
    rec.ticktick = null;
    return rec;
  }
  if (typeof tt !== 'object' || Array.isArray(tt)) {
    rec.ticktick = null;
    return rec;
  }
  const taskId = typeof tt.taskId === 'string' ? tt.taskId.trim() : '';
  if (!taskId) {
    // 没有 taskId 就没有对应关系，整个字段无意义
    rec.ticktick = null;
    return rec;
  }
  const out = { taskId };
  for (const f of ['projectId', 'syncedAt']) {
    const v = tt[f];
    out[f] = typeof v === 'string' && v.trim() ? v.trim() : null;
  }
  rec.ticktick = out;
  return rec;
}

/**
 * §22：解析用户显式指定项目/工作类型的写法。
 *   【异构算力平台】【需求梳理】完善GPU调度需求 → 项目 + 类型 + 内容
 *   【项目会议】讨论本周项目计划             → 仅类型 + 内容
 *   异构算力平台：完善GPU调度需求             → 项目 + 内容
 */
function parseDisplayInput(text) {
  const raw = String(text || '').trim();
  const two = /^【([^】]+)】【([^】]+)】\s*(.*)$/.exec(raw);
  if (two) {
    return { project_name: two[1].trim(), work_type: two[2].trim(), content: two[3].trim() };
  }
  const one = /^【([^】]+)】\s*(.*)$/.exec(raw);
  if (one) {
    return { project_name: null, work_type: one[1].trim(), content: one[2].trim() };
  }
  // 冒号写法：避免把 "14:00-14:40 项目会议" 误判为项目
  if (!/^\d{1,2}:\d{2}/.test(raw)) {
    const colon = /^([^：:]{1,30})[：:]\s*(.+)$/.exec(raw);
    if (colon) {
      return { project_name: colon[1].trim(), work_type: null, content: colon[2].trim() };
    }
  }
  return { project_name: null, work_type: null, content: raw };
}

/**
 * §16 项目连续性：给出**建议**，不直接写入（§11 禁止猜测）。
 * 调用方（AI 或用户）确认后再通过 --project 落盘；--project auto 表示接受本建议。
 */
function suggestProject(log) {
  const withProject = (log.records || []).filter(
    (r) => r.status === 'in_progress' && r.project_name
  );
  if (withProject.length === 1) {
    return {
      project_name: withProject[0].project_name,
      confidence: 'medium',
      source: 'context_inherit',
      reason: `继承当前唯一进行中事项的项目（${withProject[0].content}）`,
    };
  }
  if (withProject.length > 1) {
    const names = [...new Set(withProject.map((r) => r.project_name))];
    if (names.length === 1) {
      return {
        project_name: names[0],
        confidence: 'medium',
        source: 'context_inherit',
        reason: '当前全部进行中事项同属该项目',
      };
    }
    return {
      project_name: null,
      confidence: 'low',
      source: 'ambiguous',
      reason: `当前有多个项目在进行（${names.join('、')}），不得猜测项目名称（§11）`,
    };
  }
  return {
    project_name: null,
    confidence: 'low',
    source: 'none',
    reason: '无可用上下文，project_name 保持 null（§11）',
  };
}

/* ------------------------------------------------------------------ *
 * 项目上下文推导（§4.1 C：宿主上下文明确指向项目目录）
 * ------------------------------------------------------------------ */

/**
 * 不能作为项目名的目录段。
 *
 * 分三类：
 *   ① 构建/工具目录      node_modules、dist、src…
 *   ② 操作系统层级目录   Users、home、data、mnt…（时间戳工作区会一路回退到这里）
 *   ③ 通用容器目录       项目文档、work、projects…
 *
 * 宁可返回 null（项目留空，§11）也不要给出 "User" / "data" 这种错误项目名。
 */
const MEANINGLESS_SEGMENTS =
  /^(?:node_modules|dist|build|out|src|tmp|temp|test|tests|docs?|\.git|workbuddy|users?|home|data|mnt|volumes|var|opt|root|public|shared|library|appdata|desktop|documents|downloads)$/i;
const TIMESTAMP_LIKE = /^\d{4}-\d{2}-\d{2}(?:-\d{2}(?:-\d{2}(?:-\d{2})?)?)?$/;
const GENERIC_PARENTS = /^(?:项目文档|文档|资料|work|works?|projects?|repos?|code|dev|soft|program)$/i;

function isMeaningfulSegment(seg) {
  const s = String(seg || '').trim();
  if (s.length < 2) return false;
  if (/^[a-zA-Z]:$/.test(s)) return false; // 盘符 "C:" / "D:"（长度恰好为 2，须显式排除）
  if (/^\d+$/.test(s)) return false; // 纯数字
  if (TIMESTAMP_LIKE.test(s)) return false; // 2026-09-20 / 2026-09-20-10-24-52
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s)) return false; // GUID
  if (MEANINGLESS_SEGMENTS.test(s)) return false;
  if (GENERIC_PARENTS.test(s)) return false;
  if (!/[\u4e00-\u9fa5a-zA-Z]/.test(s)) return false; // 需含中英文
  return true;
}

/**
 * 确定一条活动所属的项目。
 *
 * **以宿主「已新建的项目」为准**，不去解析对话内容 ——
 * 项目应在 WorkBuddy / Codex 里已经建好，记录时只需把 cwd 对上去。
 *
 * 优先级：
 *   ① \`config.project_map\` 最长前缀匹配 —— 用户/AI 确认过的**正式项目名** → high
 *   ② 命中宿主已登记项目（Codex config.toml / WorkBuddy sessions.json）→ high
 *      （项目名取该项目目录的最后一段有意义名称）
 *   ③ 都不是 → \`null\`（**不再从任意目录推断项目名**，避免产生工作区目录之类的假项目）
 *
 * @param {string} cwd 宿主传入的工作目录
 * @param {object} [ctx] { config, log, hostProjects }
 */
function projectFromCwd(cwd, ctx) {
  const none = {
    project_name: null,
    project_confidence: null,
    source: 'none',
    reason: '宿主未提供可用工作目录',
  };
  const raw = String(cwd || '').trim();
  if (!raw) return none;

  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalized) return none;

  const config = (ctx && ctx.config) || {};
  const hostProjects = (ctx && ctx.hostProjects) || readHostProjects();

  // ① 显式映射：**最长前缀匹配** —— cwd 可能是映射目录的子目录，
  //    只做精确相等会漏掉（例如 cwd = <项目>/src）。
  const map = config.project_map || {};
  const mapped = Object.entries(map)
    .map(([k, v]) => [String(k).replace(/\\/g, '/').replace(/\/+$/, ''), String(v).trim()])
    .filter(([k, v]) => k && v && isMeaningfulSegment(v))
    .sort((a, b) => b[0].length - a[0].length); // 长的优先，避免被短前缀抢占
  const lower = normalized.toLowerCase();
  for (const [dir, name] of mapped) {
    const d = dir.toLowerCase();
    if (lower === d || lower.startsWith(d + '/')) {
      return {
        project_name: name,
        project_confidence: 'high',
        source: 'project_map',
        reason: `命中项目映射：${dir} → ${name}`,
      };
    }
  }

  // ② 宿主已登记的项目
  const hit = matchHostProject(normalized, hostProjects.paths);
  if (hit) {
    const name = projectNameFromDir(hit);
    if (name) {
      return {
        project_name: name,
        project_confidence: 'high',
        source: 'host_project',
        reason: `命中宿主已建项目：${hit}`,
      };
    }
    return {
      project_name: null,
      project_confidence: null,
      source: 'host_project_unnamed',
      reason: `命中宿主项目但目录名不可用作项目名：${hit}`,
    };
  }

  // ③ 未登记 → 不猜
  return {
    project_name: null,
    project_confidence: null,
    source: 'cwd_unregistered',
    reason: `工作目录不在宿主已建项目中：${normalized}（不推测项目名，可加入 config.project_map）`,
  };
}

/* ------------------------------------------------------------------ *
 * 宿主项目注册表（§4.1 C：以宿主「已新建的项目」为准）
 * ------------------------------------------------------------------ */

/**
 * 读取宿主工具中**已新建的项目**清单。
 *
 * 宿主都用「工作目录」标识项目（本地不存单独的显示名），因此这里读取权威路径清单：
 *
 *   Codex      `~/.codex/config.toml` 的 `[projects.'<路径>']` 段
 *   WorkBuddy  `~/.workbuddy/app/sessions.json` 的 sessions[].workDir
 *
 * **只读**，失败即静默跳过 —— 宿主配置格式变化不得影响记录功能。
 *
 * @param {object} [opts] { home } 便于测试注入
 * @returns {{paths: string[], bySource: object}}
 */
function readHostProjects(opts) {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const home = (opts && opts.home) || os.homedir();
  const out = { paths: [], bySource: {} };

  const add = (source, raw) => {
    const v = String(raw || '').trim();
    if (!v) return;
    const norm = v.replace(/\\/g, '/').replace(/\/+$/, '');
    if (!norm) return;
    if (out.paths.includes(norm)) return;
    out.paths.push(norm);
    (out.bySource[source] = out.bySource[source] || []).push(norm);
  };

  // ① Codex：config.toml 里的 [projects.'<路径>']
  try {
    const f = path.join(home, '.codex', 'config.toml');
    if (fs.existsSync(f)) {
      const text = fs.readFileSync(f, 'utf8');
      const re = /^\s*\[projects\s*\.\s*'([^']+)'\]\s*$/gm;
      let m;
      while ((m = re.exec(text)) !== null) add('codex', m[1]);
      // 兼容双引号写法
      const re2 = /^\s*\[projects\s*\.\s*"([^"]+)"\]\s*$/gm;
      while ((m = re2.exec(text)) !== null) add('codex', m[1]);
    }
  } catch (e) {
    /* 静默 */
  }

  // ② WorkBuddy：app/sessions.json 的 workDir
  try {
    const f = path.join(home, '.workbuddy', 'app', 'sessions.json');
    if (fs.existsSync(f)) {
      const o = JSON.parse(fs.readFileSync(f, 'utf8'));
      for (const s of (o && o.sessions) || []) add('workbuddy', s && s.workDir);
    }
  } catch (e) {
    /* 静默 */
  }

  return out;
}

/** 从已登记的宿主项目路径里做最长前缀匹配 */
function matchHostProject(cwdNormalized, hostPaths) {
  // Windows 路径大小写不敏感，比较时统一转小写
  const cwd = String(cwdNormalized || '').toLowerCase();
  let best = null;
  for (const dir of hostPaths || []) {
    const d = String(dir).toLowerCase();
    if (cwd === d || cwd.startsWith(d + '/')) {
      if (!best || dir.length > best.length) best = dir;
    }
  }
  return best;
}

/** 取路径中最后一个「有意义的」段作为项目名（跳过 src / 时间戳 / 盘符等） */
function lastNameSegment(dirNormalized) {
  const parts = String(dirNormalized || '').split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    if (isMeaningfulSegment(parts[i])) return parts[i];
  }
  return null;
}

/** 通用根目录标记：其**下一段**通常就是项目名 */
const PROJECT_ROOT_MARKERS = /^(?:项目文档|项目|文档|资料|projects?|repos?|works?|code)$/i;

/**
 * 从宿主项目目录取项目名。
 *
 * 优先取「通用根目录」之后的第一段 —— 宿主里项目常按
 * `<根>/<项目名>/<阶段>/<子目录>` 组织，末段往往是阶段或子目录：
 *
 *   E:/work/项目文档/粤企知/第三期/1-需求管理   → 粤企知        （而非 1-需求管理）
 *   E:/work/项目文档/数字国资/基金金融/…/202609 → 数字国资      （而非 202609）
 *   E:/work/项目文档/云浮门户2609/原型          → 云浮门户2609
 *   d:/codex/2026-09-20/system-config-html     → system-config-html（无根标记，取末段）
 */
function projectNameFromDir(dirNormalized) {
  const parts = String(dirNormalized || '').split('/').filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (PROJECT_ROOT_MARKERS.test(parts[i]) && isMeaningfulSegment(parts[i + 1])) {
      return parts[i + 1];
    }
  }
  return lastNameSegment(dirNormalized);
}

/**
 * 读取 WorkBuddy 的「空间项目」索引（session_id → project_id）。
 *
 * WorkBuddy 的项目实体是**空间里的项目**（id 形如 `p_<hex>`），项目名称由服务端下发、
 * 本地不落地。但本地 SQLite 的 `sessions` 表保存了 **session_id → project_id** 的归属，
 * 而宿主 Hook 恰好会传 `session_id` —— 因此可以按「空间项目」而不是文件路径来确定项目。
 *
 * **只读**（readOnly 打开，WAL 下安全），失败静默跳过。
 *
 * @returns {{bySession:Object<string,string>, projectCwds:Object<string,string[]>, ok:boolean}}
 */
function readSessionProjectIndex(opts) {
  const out = { bySession: {}, projectCwds: {}, ok: false };
  try {
    const os = require('os');
    const path = require('path');
    const fs = require('fs');
    const home = (opts && opts.home) || os.homedir();
    const dbFile = path.join(home, '.workbuddy', 'workbuddy.db');
    if (!fs.existsSync(dbFile)) return out;
    // node:sqlite 为 Node 22+ 内置（试验特性）；不可用时静默降级
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbFile, { readOnly: true });
    const rows = db
      .prepare('SELECT id, cwd, project_id FROM sessions WHERE project_id IS NOT NULL')
      .all();
    for (const r of rows) {
      if (!r || !r.id || !r.project_id) continue;
      out.bySession[String(r.id)] = String(r.project_id);
      const list = (out.projectCwds[String(r.project_id)] =
        out.projectCwds[String(r.project_id)] || []);
      if (r.cwd && !list.includes(r.cwd)) list.push(String(r.cwd));
    }
    db.close();
    out.ok = true;
  } catch (e) {
    /* 无 sqlite / 库被占用 / 结构变化 —— 一律降级，不影响记录 */
  }
  return out;
}

/**
 * 按「空间项目」确定项目名。
 *
 * `config.project_map` 支持直接用 project_id 作键（形如 `p_...`），
 * 这样项目名就来自「WorkBuddy 空间里的项目」而不是文件路径。
 *
 * @param {string} sessionId 宿主 Hook 传入的 session_id
 * @param {object} [ctx] { config, index }
 */
function projectFromSession(sessionId, ctx) {
  const none = {
    project_name: null,
    project_confidence: null,
    source: 'none',
    reason: '宿主未提供 session_id',
  };
  const sid = String(sessionId || '').trim();
  if (!sid) return none;

  const config = (ctx && ctx.config) || {};
  const index = (ctx && ctx.index) || readSessionProjectIndex();
  const pid = index.bySession[sid];
  if (!pid) {
    return {
      project_name: null,
      project_confidence: null,
      source: 'session_unmapped',
      reason: `session ${sid} 未关联到 WorkBuddy 空间项目`,
    };
  }

  const map = config.project_map || {};
  // 大小写不敏感查找 project_id
  const lower = pid.toLowerCase();
  for (const [k, v] of Object.entries(map)) {
    const key = String(k).trim();
    if (key.toLowerCase() === lower && String(v).trim()) {
      return {
        project_name: String(v).trim(),
        project_confidence: 'high',
        source: 'space_project',
        reason: `命中空间项目映射：${pid} → ${String(v).trim()}`,
        project_id: pid,
      };
    }
  }
  return {
    project_name: null,
    project_confidence: null,
    source: 'space_project_unmapped',
    reason: `空间项目 ${pid} 尚未在 config.project_map 中配置名称`,
    project_id: pid,
  };
}

/** §7 本地工作类型提示：仅做关键词匹配，命不中则留给 AI */
const WORK_TYPE_HINTS = [
  // ── V3.3 产品经理口径（顺序敏感：具体先于宽泛）
  { type: '产品规划', re: /产品规划|版本规划|路线图|roadmap|规划版本|蓝图/i },
  { type: 'PRD编写', re: /PRD|需求规格|需求说明书|写需求文档|需求文档编写/i },
  { type: '方案设计', re: /方案设计|技术方案|架构设计|方案编写|设计.*方案/ },
  { type: '技术沟通', re: /技术沟通|技术对齐|研发沟通|架构沟通|接口沟通/ },
  { type: '开发协作', re: /开发协作|联调|接口对接|开发对齐|研发协作/ },
  { type: '测试验证', re: /测试验证|测试|用例|验收|回归|缺陷|bug/i },
  { type: '资料查询', re: /资料查询|查资料|搜索资料|查询资料|资料收集/ },
  { type: '需求文档', re: /需求文档|需求规格|需求说明|PRD|需求清单|需求池|写文档|需求书/i },
  { type: '需求沟通', re: /需求沟通|需求澄清|需求对齐|需求确认|与.{0,6}(业务|客户|用户).{0,4}(沟通|确认)/ },
  { type: '竞品/行业研究', re: /竞品|友商|对标|行业研究|市场调研|行业分析/ },
  { type: '数据分析', re: /数据分析|统计|报表|指标|看板|埋点/ },
  { type: '研发协作', re: /研发协作|与开发|联调|技术评审|技术方案|接口对接|开发对齐/ },
  { type: '测试验收', re: /测试|用例|验收|回归|缺陷|bug/i },
  { type: '上线发布', re: /上线|发布|灰度|部署|发版/ },
  { type: '产品运营', re: /运营|推广|用户反馈|客服|活动运营/ },
  { type: '产品复盘', re: /复盘|总结复盘|迭代总结|回顾/ },
  { type: '问题处理', re: /问题处理|排查|定位问题|修复|异常|报错/ },
  // ── 保留既有口径（向后兼容，仍是合法取值）
  { type: '需求梳理', re: /需求(规格|清单|梳理|文档|说明)/ },
  { type: '需求分析', re: /需求分析|分析需求|需求梳理/ },
  { type: '产品设计', re: /产品设计|页面设计|界面设计|设计.*页面|设计.*界面/ },
  { type: '交互设计', re: /交互设计|交互规则|交互方案|交互稿/ },
  { type: '原型设计', re: /原型/ },
  { type: 'UI设计', re: /\bUI\b|视觉设计|样式设计/i },
  { type: '技术方案', re: /技术方案|架构设计|方案设计/ },
  { type: '开发', re: /开发|编码|实现|联调|写代码|重构/ },
  { type: '测试', re: /测试|用例|验证/ },
  { type: '问题排查', re: /排查|定位问题|修复|异常|报错|bug/i },
  { type: '项目会议', re: /会议|评审会|周会|例会|沟通会/ },
  { type: '会议', re: /会议|评审会|周会|例会|沟通会/ },
  { type: '沟通协调', re: /沟通|协调|对接|同步进度/ },
  { type: '文档整理', re: /整理.*文档|文档整理|写文档|纪要/ },
  { type: '项目管理', re: /项目管理|排期|计划|任务分配|进度跟进/ },
  { type: '项目跟进', re: /跟进|推进|跟踪/ },
  { type: '方案评审', re: /评审/ },
  { type: '学习研究', re: /学习|研究|调研|了解/ },
];

/** V3.3 项目阶段提示（仅建议，不自动落盘；命不中留空，不猜阶段） */
const PROJECT_STAGE_HINTS = [
  { stage: '需求阶段', re: /需求(分析|梳理|调研|澄清|拆解|文档|沟通|确认)|PRD|竞品|立项|范围/ },
  { stage: '设计阶段', re: /(方案|原型|交互|流程|结构|页面|界面)设计|原型|线框|交互稿|信息架构|功能规划|UI/ },
  { stage: '开发阶段', re: /开发|编码|联调|技术方案|接口|实现|研发协作|重构/ },
  { stage: '测试阶段', re: /测试|用例|验收|回归|缺陷|bug|缺陷修复/i },
  { stage: '上线阶段', re: /上线|发布|发版|灰度|部署|切流/ },
  { stage: '运营/迭代阶段', re: /运营|迭代|复盘|用户反馈|数据跟踪|版本优化/ },
];

/** V3.3 事项分类提示（仅建议；工作信号优先，避免把「需求评审会」判成「会议→休闲」） */
const CATEGORY_HINTS = [
  { category: '健康运动', re: /散步|跑步|运动|健身|瑜伽|拉伸|锻炼|游泳|骑行|爬山|打球|徒步|pilates|普拉提|八段锦/i },
  { category: '休闲娱乐', re: /看电影|追剧|游戏|旅游|逛街|音乐会|展览|读书会|闲聊|放松/ },
  { category: '生活', re: /吃饭|早餐|午餐|晚餐|做饭|家务|打扫|购物|买菜|理发|就医|看病|接送|通勤|陪家人|睡觉|午休/ },
  { category: '个人成长', re: /学习|研究|调研|探索|了解|试用|摸索|自学|教程|读书|课程|考试|技能|方法论/ },
  {
    category: '工作',
    re: /需求|方案|设计|评审|开发|研发|联调|接口|测试|验收|缺陷|bug|上线|发布|项目|会议|排期|进度|排期|文档|原型|数据|指标|运营|复盘|对接|沟通|汇报|协调/i,
  },
];

function suggestWorkType(text, allowedTypes) {
  const list = Array.isArray(allowedTypes) && allowedTypes.length ? allowedTypes : DEFAULT_WORK_TYPES;
  const src = String(text || '');
  for (const hint of WORK_TYPE_HINTS) {
    if (!list.includes(hint.type)) continue;
    if (hint.re.test(src)) {
      return { work_type: hint.type, confidence: 'medium', source: 'keyword', reason: '本地关键词匹配' };
    }
  }
  return {
    work_type: null,
    confidence: 'low',
    source: 'none',
    reason: '本地关键词未命中，work_type 保持 null，交由 AI 判断（§7/§13）',
  };
}

/** V3.3：项目阶段建议（命中给出 medium 建议，命不中留空） */
function suggestProjectStage(text, allowedStages) {
  const list =
    Array.isArray(allowedStages) && allowedStages.length ? allowedStages : DEFAULT_PROJECT_STAGES;
  const src = String(text || '');
  for (const hint of PROJECT_STAGE_HINTS) {
    if (!list.includes(hint.stage)) continue;
    if (hint.re.test(src)) {
      return {
        project_stage: hint.stage,
        confidence: 'medium',
        source: 'keyword',
        reason: '本地关键词匹配（仅建议，需确认后写入）',
      };
    }
  }
  return {
    project_stage: null,
    confidence: 'low',
    source: 'none',
    reason: '无法可靠判断阶段，保持 null（不猜阶段）',
  };
}

/** V3.3：事项分类建议（工作/生活/个人成长/健康运动/休闲娱乐/其他） */
function suggestCategory(text, allowedCategories) {
  const list =
    Array.isArray(allowedCategories) && allowedCategories.length
      ? allowedCategories
      : DEFAULT_WORK_CATEGORIES;
  const src = String(text || '');
  for (const hint of CATEGORY_HINTS) {
    if (!list.includes(hint.category)) continue;
    if (hint.re.test(src)) {
      return {
        category: hint.category,
        confidence: 'medium',
        source: 'keyword',
        reason: '本地关键词匹配（仅建议，需确认后写入）',
      };
    }
  }
  return {
    category: null,
    confidence: 'low',
    source: 'none',
    reason: '无法可靠分类，保持 null（不猜）',
  };
}

/* ------------------------------------------------------------------ *
 * 文件
 * ------------------------------------------------------------------ */

function readJSON(file, fallback) {
  if (!fs.existsSync(file)) return fallback === undefined ? null : fallback;
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return fallback === undefined ? null : fallback;
  return JSON.parse(text);
}

/** 写 .tmp → 校验可解析 → rename 原子替换（§35） */
function atomicWriteJSON(file, data) {
  const dir = path.dirname(path.resolve(file));
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, file);
}

const manifestPath = (dir) => path.join(dir, '.log-manifest.json');
const currentPath = (dir) => path.join(dir, 'current.json');
const configPath = (dir) => path.join(dir, 'config.json');
const statePath = (dir) => path.join(dir, 'state.json');
const spoolDir = (dir) => path.join(dir, 'pending', 'writes');

/** §52：识别共享日志。V1.6 使用 type=work-time-log，并兼容两种旧标识。 */
function manifestKind(dir) {
  let man = null;
  try {
    man = readJSON(manifestPath(dir), null);
  } catch (e) {
    return 'unreadable';
  }
  if (!man) return 'none';
  if (man.type === MANIFEST_TYPE && !man.format) return 'current';
  if (LEGACY_MANIFEST_TYPES.includes(man.type) || LEGACY_MANIFEST_FORMATS.includes(man.format)) {
    return 'legacy';
  }
  return 'foreign';
}

const isOurDir = (dir) => ['current', 'legacy'].includes(manifestKind(dir));

const readManifest = (dir) => readJSON(manifestPath(dir), {}) || {};

/* ------------------------------------------------------------------ *
 * 配置（§50：嵌套结构，version 1.6）
 * ------------------------------------------------------------------ */

const firstOf = (...vals) => vals.find((v) => v !== undefined && v !== null);

/**
 * V3.3（用户 2026-09-22）：归一化「工作分类 / 工作类型 / 项目阶段」三个枚举。
 *
 * 兼容策略：
 *   - 新写法 `config.work.{categories,work_types,project_stages}` 为准；
 *   - 旧写法顶层 `config.work_types` 仍然**合并保留**（不静默丢弃用户已有取值）；
 *   - 默认值始终并入 —— 删空某个字段不会让识别能力整体失效。
 */
function normalizeWorkEnums(c) {
  const src = c || {};
  const w = src.work && typeof src.work === 'object' && !Array.isArray(src.work) ? src.work : {};
  const arr = (v) => (Array.isArray(v) ? v.map(String).map((x) => x.trim()).filter(Boolean) : []);
  const categories = [...new Set([...DEFAULT_WORK_CATEGORIES, ...arr(w.categories)])];
  const workTypes = [
    ...new Set([
      ...DEFAULT_PM_WORK_TYPES,
      ...DEFAULT_WORK_TYPES,
      ...arr(src.work_types),
      ...arr(w.work_types),
    ]),
  ];
  const projectStages = [...new Set([...DEFAULT_PROJECT_STAGES, ...arr(w.project_stages)])];
  // V3.6：探索沉淀的项目白名单与关键词表。关键词留空时由 role-profile 用内置默认。
  const explorationProjects = [
    ...new Set([...DEFAULT_EXPLORATION_PROJECTS, ...arr(w.exploration_projects)]),
  ];
  const explorationKeywords = arr(w.exploration_keywords);
  return {
    categories,
    work_types: workTypes,
    project_stages: projectStages,
    exploration_projects: explorationProjects,
    exploration_keywords: explorationKeywords,
  };
}

/**
 * 把任意版本的 config 归并为 V2.0 结构（§44）。
 *
 * 兼容来源：V1.4 扁平结构、V1.6 顶层 ai 字段、V1.9 的 ai.auto_task 命名。
 *
 * 注意 §44 不含 summary.schedule 与 sync.trigger：
 * 何时运行由宿主 Scheduled Task 决定，不由本 Skill 的配置驱动（§43/§45）。
 */
function normalizeConfig(raw, dir) {
  const c = raw || {};
  // V3.3：工作维度枚举（分类 / 工作类型 / 项目阶段）只归并一次，
  // `work` 与向后兼容的顶层 `work_types` 共享同一份数组，避免两处不一致。
  const workEnums = normalizeWorkEnums(c);
  const tracking = c.tracking || {};
  const hostEvents = c.host_events || {};
  const ai = c.ai || {};
  const autoAnalysis = ai.auto_analysis || ai.auto_task || {};
  const manualAi = ai.manual || {};
  const summary = c.summary || {};
  const sync = c.sync || {};
  const log = c.log || {};
  const sec = c.security || {};
  return {
    skill: SKILL_NAME,
    version: CONFIG_VERSION,
    log_directory: firstOf(c.log_directory, dir) || '',
    timezone: firstOf(c.timezone, tzOffset()),
    tracking: {
      enabled: Boolean(firstOf(tracking.enabled, c.auto_tracking, true)),
      auto_tracking: Boolean(firstOf(tracking.auto_tracking, c.auto_tracking, true)),
      idle_threshold_minutes: Number(
        firstOf(tracking.idle_threshold_minutes, c.idle_threshold_minutes, 30)
      ),
    },
    // §44/§45：宿主事件捕获开关，决定采集哪几类 Activity
    host_events: {
      enabled: Boolean(firstOf(hostEvents.enabled, true)),
      capture_user_interaction: Boolean(firstOf(hostEvents.capture_user_interaction, true)),
      capture_tool_activity: Boolean(firstOf(hostEvents.capture_tool_activity, true)),
      capture_file_activity: Boolean(firstOf(hostEvents.capture_file_activity, true)),
      capture_session_lifecycle: Boolean(firstOf(hostEvents.capture_session_lifecycle, true)),
    },
    ai: {
      enabled: Boolean(firstOf(ai.enabled, true)),
      // §33/§34：宿主自动任务/事件触发后产生的 AI 分析
      auto_analysis: {
        enabled: Boolean(firstOf(autoAnalysis.enabled, true)),
        batch_interval_minutes: Number(
          firstOf(autoAnalysis.batch_interval_minutes, 20)
        ),
        cooldown_minutes: Number(firstOf(autoAnalysis.cooldown_minutes, 10)),
        // §35：保护阈值，不是目标调用量
        safety_max_calls_per_day: Number(
          firstOf(
            autoAnalysis.safety_max_calls_per_day,
            ai.max_ai_calls_per_day,
            c.max_ai_calls_per_day,
            50
          )
        ),
        max_context_items: Number(firstOf(autoAnalysis.max_context_items, 20)),
        enable_cache: Boolean(firstOf(autoAnalysis.enable_cache, true)),
        batch_max_pending: Number(firstOf(autoAnalysis.batch_max_pending, 5)),
      },
      // §35：用户手动 /analyze、/summary 不受安全熔断限制
      manual: {
        enabled: Boolean(firstOf(manualAi.enabled, true)),
        unlimited: Boolean(firstOf(manualAi.unlimited, true)),
      },
      // V3.6（用户 2026-09-24）：模型名归一出别名表，用于「模型使用对比」。
      // 键为日志里出现的原始 model_name，值为统一展示名；未列出时按
      // 「去掉 custom-local: 之类前缀」的通用规则归并。
      model_aliases: (() => {
        const raw = ai.model_aliases && typeof ai.model_aliases === 'object' && !Array.isArray(ai.model_aliases)
          ? ai.model_aliases
          : {};
        const out = {};
        for (const [k, v] of Object.entries(raw)) {
          const kk = String(k || '').trim();
          const vv = String(v || '').trim();
          if (kk && vv) out[kk] = vv;
        }
        return out;
      })(),
      // V3.6：记录层分流阈值（字符）。
      // 内容 ≤ 阈值 → 按原文入库；> 阈值 → 才允许 AI 摘要，原文留在 detail。
      record_summarize_threshold_chars: (() => {
        const n = Number(firstOf(ai.record_summarize_threshold_chars, 120));
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 120;
      })(),
    },
    summary: {
      enabled: Boolean(firstOf(summary.enabled, c.summary_enabled, true)),
      auto_scheduled: Boolean(firstOf(summary.auto_scheduled, false)),
      // V3.6：AI 使用洞察报告（Skill / 模型 / 项目 / 项目阶段分布）
      insights: (() => {
        const ins = summary.insights || {};
        const days = Number(firstOf(ins.stale_days, 30));
        return {
          enabled: Boolean(firstOf(ins.enabled, true)),
          // 「装了但一直没用」的判据：多少天未调用算低频/未用
          stale_days: Number.isFinite(days) && days > 0 ? Math.floor(days) : 30,
          // 「高频」判据：调用次数达到该值进入高频清单
          top_n: (() => {
            const n = Number(firstOf(ins.top_n, 5));
            return Number.isFinite(n) && n > 0 ? Math.floor(n) : 5;
          })(),
          // 扫描哪些目录来盘点「已安装 / 已部署」（见 lib/skill-inventory.js）。
          // 留空 = 用内置默认（中央库 + 各 Agent 全局技能目录）。
          skill_roots: Array.isArray(ins.skill_roots) ? ins.skill_roots : [],
        };
      })(),
      // V3.27：日报过期检测阈值 —— 日报生成后新增多少个 Conversation 才提示「建议重新生成」。
      // 必须在这里登记：normalizeConfig 是**白名单**，未登记的键会被静默丢弃，
      // 导致用户在 config.json 里写了也不生效（改了等于没改）。
      stale_conversation_threshold: (() => {
        const n = Number(firstOf(summary.stale_conversation_threshold, 3));
        return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
      })(),
    },
    sync: {
      enabled: Boolean(firstOf(sync.enabled, true)),
      skill: firstOf(sync.skill, c.sync_skill, SYNC_SKILL),
      // §30：禁止实时同步，恒为 false
      realtime: false,
      auto_scheduled: Boolean(firstOf(sync.auto_scheduled, false)),
    },
    log: {
      keep_days: Number(firstOf(log.keep_days, c.keep_days, 1)),
      protect_unsynced: Boolean(firstOf(log.protect_unsynced, c.protect_unsynced, true)),
      // 注：`archive_enabled` 已于 2026-09-21 移除。
      // 它属于旧「current.json 历史备份」模型，与本技能现模型冲突：
      // 历史现在由 logs/（WorkItem 永久导出 + 对话成本）与 summaries/（永久）承担，
      // 再往 archive/ 存一份就是第三个副本、且与「不做历史备份」的约定自相矛盾。
    },
    // §6 / V3.3：工作分类、工作类型、项目阶段（用户 2026-09-22）
    //   分类 = 工作/生活/个人成长/健康运动/休闲娱乐/其他
    //   工作类型 = 产品经理口径（在做什么事）
    //   项目阶段 = 项目走到哪一段（AI 成本的第三个归因维度）
    work: workEnums,
    // 向后兼容：既有调用点仍然读 `config.work_types`（= work.work_types 的**同一份数组**）
    work_types: workEnums.work_types,
    // §24 扩展（2026-09-21）：角色画像 —— 决定总结按什么职业视角组织。
    // 用户可自行修改 config.role（角色描述、需求阶段词表、交付物词表），无需改代码。
    role: roleProfile.normalizeRole(c.role),
    // V3.0（用户需求 §5/§22/§24）：对话结束后的实时结算。
    // 决定「对话结束时由脚本写哪些结构化日志」，以及 Skill token 用哪个口径。
    settlement: (() => {
      const st = c.settlement || {};
      const method = String(firstOf(st.skill_token_method, 'injection')).toLowerCase();
      const perChar = Number(firstOf(st.token_per_char, 0.28));
      return {
        enabled: Boolean(firstOf(st.enabled, true)),
        // 由宿主 Conversation End 触发（任务A）；本技能不自行创建触发器
        auto_on_conversation_end: Boolean(firstOf(st.auto_on_conversation_end, true)),
        // injection = 记「Skill 载入体积」（精确、可归因）；off = 一律 unavailable。
        // 没有第三种：官方不存在 Skill 级 token 口径，禁止自行摊派（§6）。
        skill_token_method: method === 'off' ? 'off' : 'injection',
        // 字符 → token 系数（默认 0.28，实测值；可在 config 调整）
        token_per_char: Number.isFinite(perChar) && perChar > 0 ? perChar : 0.28,
        // 是否把 WorkBuddy 积分写进 total_score（与 Token 分开记录，不做换算）
        score_enabled: Boolean(firstOf(st.score_enabled, true)),
        // 是否落盘原始快照，供后续重新解析（§16）
        write_raw_snapshot: Boolean(firstOf(st.write_raw_snapshot, true)),
        // off（默认）| prompts —— prompts 会把用户输入兜底登记为候选工作事项。
        // 默认 off：工作内容识别属 LLM 职责（§8），脚本不擅自造事项。
        //
        // 取值：off（默认）| on / prompts
        //
        // 2026-09-21 曾复核维持 off：事项采集已由事件管线
        // （Hook → collect-activity → 本地匹配 → pending → AI 归类）承担，
        // 再在结算里从对话提示词兜底生成一份，会与上面那条链路**重复记账**。
        //
        // V3.6（用户 2026-09-24）起改为**按需开启**：用户明确要求
        // 「按项目 / 项目阶段 / 工作类型的 Token 分布」，而这三张表依赖
        // 带 conversation_id 的 Work Activity。开启后结算会从对话提示词
        // 生成**候选事项**（project/work_type 留空或取会话已解析项目，
        // 状态 needs_confirmation），由总结层二次确认，不静默充数。
        capture_work_activities: (() => {
          const v = String(firstOf(st.capture_work_activities, 'off')).toLowerCase();
          return v === 'on' ? 'prompts' : v;
        })(),
        // 注意：结构化日志的保留期统一由 `storage.structured_log_retention` 管理（永久保留）。
        // 这里曾有一个 `settlement.retain_days`（0 = 只保留当天），
        // 与「logs/ 永久保留」直接矛盾且无任何消费者 —— 2026-09-21 已移除。
      };
    })(),
    // V3.1（用户 §十九~§二十二）：三层存储生命周期。
    //   Raw Conversation → 短期缓存（默认 7 天）→ 清理
    //   Structured Logs  → **永久保留**（体积小，是长期历史数据）
    //   Daily Summary    → **永久保留**
    // 与既有 `log.keep_days`（只管 current.json 的一天一档）互不影响。
    storage: (() => {
      const s = c.storage || {};
      const raw = s.raw_log || {};
      const days = Number(firstOf(raw.retention_days, 7));
      return {
        structured_log_retention: 'permanent',
        raw_log: {
          enabled: Boolean(firstOf(raw.enabled, true)),
          // 上限收敛到 3650 天（10 年）：配错成 999999 会让清理形同虚设且难以察觉
          retention_days: Number.isFinite(days) && days >= 0 ? Math.min(days, 3650) : 7,
        },
        daily_summary: { retention: 'permanent' },
      };
    })(),
    // V3.1（用户 §十五~§十八）：Structured Logs 的远端归档。
    // ⚠️ 默认 **enabled: false** —— 用户明确「日志暂不自动推送 GitHub」，
    // 需要时显式打开。开启后唯一的 git 出口是 scripts/sync-github.js。
    github: (() => {
      const g = c.github || {};
      const vis = String(firstOf(g.visibility, 'private')).toLowerCase();
      const days = Number(firstOf(g.sync_days, 1));
      return {
        enabled: Boolean(firstOf(g.enabled, false)),
        repository: String(firstOf(g.repository, 'worktimeLog')),
        // 安全规则（用户 §二十九）：只接受 private，public 一律回落
        visibility: vis === 'public' ? 'private' : 'private',
        sync_days: Number.isFinite(days) && days >= 1 ? Math.min(Math.floor(days), 365) : 1,
        // 默认不上传 Raw —— Raw 含完整对话痕迹，体积也大
        sync_raw_logs: Boolean(firstOf(g.sync_raw_logs, false)),
        // 本地工作副本位置（留空则用 <log_dir>/.github-sync）
        work_directory: firstOf(g.work_directory, '') || '',
        // 远端名（默认 origin）；也允许指向本地裸仓库以便离线测试
        remote: String(firstOf(g.remote, 'origin')),
        branch: String(firstOf(g.branch, 'main')),
        commit_message: String(firstOf(g.commit_message, 'chore(logs): sync {date}')),
      };
    })(),
    daily_summary: {
      enabled: Boolean(firstOf((c.daily_summary || {}).enabled, true)),
    },
    // 与既有 sync.skill（ticktick-work-review）保持一致：TickTick 是**派生**外部同步，
    // 不是核心日志的数据源；同步失败不得影响本地日志与复盘。
    ticktick: {
      enabled: Boolean(firstOf((c.ticktick || {}).enabled, true)),
    },
    // §4.1 C：工作目录 → 项目正式名 的显式映射（留空则按目录名推导为 medium）
    project_map: (() => {
      const raw =
        (c.project_map && typeof c.project_map === 'object' && c.project_map) ||
        (c.projects && typeof c.projects === 'object' && c.projects) ||
        {};
      const out = {};
      for (const [k, v] of Object.entries(raw)) {
        if (typeof k === 'string' && k.trim() && typeof v === 'string' && v.trim()) {
          out[k.replace(/\\/g, '/')] = v.trim();
        }
      }
      return out;
    })(),
    // §44/§55：安全边界。fail-closed —— allow_* 为 true 会被忽略并回落为 false
    security: security.normalizeSecurityConfig(sec),
  };
}

/** §33/§34：自动 AI 分析是否可用（宿主自动任务路径） */
const autoAnalysisEnabled = (config) =>
  config.ai.enabled !== false &&
  config.ai.auto_analysis.enabled !== false &&
  config.tracking.enabled !== false &&
  config.tracking.auto_tracking !== false;

const readConfig = (dir) => normalizeConfig(readJSON(configPath(dir), {}) || {}, dir);

/**
 * state.json（§8.1）。
 * §8.1 给出的是核心字段；为使 §35（AI 保护阈值）、§50（自检）、§56（进行中/触发来源）
 * 可落地，额外保留 AI 计数、hosts 与 active_work_items。
 */
function defaultState() {
  return {
    tracking_status: 'initializing',
    current_date: today(),
    active_work_items: [],
    // §8.1：最近一次宿主事件时间
    last_event_time: null,
    // 内部：最近一次成功写入日志的时间（/status 排障用）
    last_log_write_time: null,
    pending_sync_dates: [],
    last_summary_time: null,
    // §18 每日自动总结最多一次
    last_automatic_summary_date: null,
    last_sync_time: null,
    // §35：自动与手动 AI 调用分别计数
    automatic_ai_calls_today: 0,
    manual_ai_calls_today: 0,
    ai_date: today(),
    automatic_ai_last_call_at: null,
    // §52/§57：宿主触发状态（key 为宿主工具名）
    hosts: {},
  };
}

/**
 * 旧版本 state 键名归一化。
 * V1.6/V1.9 使用 last_activity_at / last_summary_date / last_sync_date，
 * V2.0 §8.1 改为 last_event_time / last_summary_time / last_sync_time。
 */
function migrateState(state) {
  if (!state.last_event_time && state.last_activity_at) {
    state.last_event_time = state.last_activity_at;
  }
  if (!state.last_log_write_time && state.last_log_write_at) {
    state.last_log_write_time = state.last_log_write_at;
  }
  if (!state.last_summary_time && state.last_summary_date) {
    state.last_summary_time = state.last_summary_date;
  }
  if (!state.last_sync_time && state.last_sync_date) {
    state.last_sync_time = state.last_sync_date;
  }
  // V1.6 的 ai.calls_today 未区分来源，按自动调用延续计数
  if (state.ai && Number.isInteger(state.ai.calls_today)) {
    if (!Number.isInteger(state.automatic_ai_calls_today)) {
      state.automatic_ai_calls_today = state.ai.calls_today;
    }
    if (!state.ai_date && state.ai.date) state.ai_date = state.ai.date;
    if (!state.automatic_ai_last_call_at && state.ai.last_call_at) {
      state.automatic_ai_last_call_at = state.ai.last_call_at;
    }
  }
  if (!state.hosts) state.hosts = state.collectors || {};
  delete state.last_activity_at;
  delete state.last_log_write_at;
  delete state.last_summary_date;
  delete state.last_sync_date;
  delete state.collectors;
  delete state.ai;
  // 补齐 §8.1 核心字段，避免读取方因缺字段而误判
  if (!state.current_date) state.current_date = today();
  if (!Array.isArray(state.active_work_items)) state.active_work_items = [];
  if (!Array.isArray(state.pending_sync_dates)) state.pending_sync_dates = [];
  for (const k of [
    'last_event_time',
    'last_log_write_time',
    'last_summary_time',
    'last_automatic_summary_date',
    'last_sync_time',
  ]) {
    if (!(k in state)) state[k] = null;
  }
  return state;
}

function emptyDailyLog(dateStr) {
  return {
    date: dateStr || today(),
    timezone: tzOffset(),
    version: 1, // §10.1：整数版本号，每次成功写入 +1
    updated_at: nowIso(),
    updated_by: null,
    records: [],
    // §20/§40：低置信度候选与待判断活动统一存入 pending_items
    pending_items: [],
    // §32/§34：AI 判断结果缓存，键为 Activity hash
    judgments: {},
    summary: null,
    sync: { status: 'pending', last_sync_at: null },
  };
}

/* ------------------------------------------------------------------ *
 * 日志目录定位
 * ------------------------------------------------------------------ */

function loadLocator() {
  try {
    return readJSON(LOCATOR_PATH, {}) || {};
  } catch (e) {
    return {};
  }
}

/**
 * 写入全局定位器（~/.workbuddy/work-time-tracking.json）。
 *
 * ⚠ **两条硬保护**（真实踩到：跑一次端到端测试后，用户的全局定位器被改成
 * `%TEMP%\wtt-e2e2`，之后所有正式调用都会把日志写进临时目录）：
 *
 *  1. `WORK_TIME_TRACKING_DIR` 环境变量是**临时 / 测试用**的作用域覆盖。
 *     它只影响本次进程，**绝不**允许把全局定位器改写过去 —— 否则一次沙箱
 *     运行就会污染用户的真实配置。
 *  2. 目标目录落在系统临时目录下时同样不写：临时目录本身就是「用完即弃」，
 *     不可能成为用户长期使用的共享日志目录。
 *
 * 返回值表示是否真的写入（供调用方判断/测试断言）。
 */
function isTempDir(dir) {
  const t = String(dir || '').toLowerCase();
  if (!t) return true;
  const tmp = os.tmpdir().toLowerCase();
  return t === tmp || t.startsWith(tmp.endsWith(path.sep) ? tmp : tmp + path.sep);
}

function saveLocator(dir) {
  // 只有当**定位器文件本身也在临时目录下**（测试已重定向 HOME / 临时目录）时，
  // 才认为处于隔离沙箱，允许正常写入 —— 否则测试无法断言「沙箱定位器已生成」。
  const sandboxed = isTempDir(LOCATOR_PATH);
  if (!sandboxed) {
    // 真实定位器：绝不允许被指向临时目录（否则一次沙箱 init 就会让用户
    // 之后的全部正式调用写进 %TEMP%，数据等于丢失）。
    if (isTempDir(dir)) return false;
    // 环境变量是**临时作用域覆盖**，不参与持久化配置。
    if (process.env.WORK_TIME_TRACKING_DIR) return false;
  }
  fs.mkdirSync(path.dirname(LOCATOR_PATH), { recursive: true });
  let existing = {};
  try {
    existing = readJSON(LOCATOR_PATH, {}) || {};
  } catch (e) {
    existing = {};
  }
  existing.log_directory = path.resolve(dir);
  existing.updated_at = nowIso();
  atomicWriteJSON(LOCATOR_PATH, existing);
  return true;
}

/** --dir > 环境变量 > 定位器文件；都没有则报错，要求用户指定（§32） */
function resolveDir(dirOpt) {
  let candidate = dirOpt || process.env.WORK_TIME_TRACKING_DIR;
  if (!candidate) candidate = loadLocator().log_directory;
  if (!candidate) {
    throw new LogError(
      '尚未配置工作日志目录。请先询问用户希望把共享日志放在哪个本地文件夹，' +
        '然后运行 init-log.js 初始化。不得默认使用技能安装目录（§2.7/§33）。',
      EXIT.NO_DIR
    );
  }
  return path.resolve(String(candidate).replace(/^~/, os.homedir()));
}

function ensureWritable(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new LogError(
      `日志目录不存在：${dir}。请先运行 init-log.js 初始化（新建需加 --create）。`,
      EXIT.BAD_DIR
    );
  }
  try {
    fs.accessSync(dir, fs.constants.R_OK | fs.constants.W_OK);
  } catch (e) {
    throw new LogError(`日志目录不可读写：${dir}`, EXIT.BAD_DIR);
  }
}

/** 只读探测目录可用性，供 /status 使用（不抛异常，§28） */
function probeDir(dir) {
  const out = { exists: false, readable: false, writable: false };
  try {
    out.exists = fs.existsSync(dir) && fs.statSync(dir).isDirectory();
    if (!out.exists) return out;
    try {
      fs.accessSync(dir, fs.constants.R_OK);
      out.readable = true;
    } catch (e) {
      /* 保留 false */
    }
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      out.writable = true;
    } catch (e) {
      /* 保留 false */
    }
  } catch (e) {
    /* 保留默认值 */
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 锁（§35）
 * ------------------------------------------------------------------ */

const lockPath = (dir) => path.join(dir, '.write.lock');

function lockInfo(dir) {
  const file = lockPath(dir);
  if (!fs.existsSync(file)) return null;
  const stat = fs.statSync(file);
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  } catch (e) {
    meta = {};
  }
  return {
    file,
    pid: meta.pid,
    token: meta.token || null,
    holder: meta.holder || null,
    created_at: meta.created_at || stat.mtime.toISOString(),
    age_ms: Date.now() - stat.mtimeMs,
    stale: Date.now() - stat.mtimeMs > LOCK_STALE_MS,
  };
}

/**
 * 非忙等休眠。
 *
 * 原实现是 `while (Date.now() < end) {}` 纯自旋：在锁竞争时会**跑满一个 CPU 核心**，
 * 笔记本上表现为明显发热与掉电，而且它烧的是别人（宿主 Agent）正在用的资源。
 *
 * 这里用 `Atomics.wait` 阻塞主线程，不占 CPU。本库全程是同步执行模型，
 * 没有事件循环可让出，因此不能用 `await`/`setTimeout` —— `Atomics.wait` 是
 * 同步阻塞且不烧 CPU 的唯一手段。
 *
 * 需要 SharedArrayBuffer，不可用时回退到自旋（保持行为正确，仅耗 CPU）。
 */
function sleepSync(ms) {
  const wait = Math.max(0, Math.floor(ms));
  if (wait === 0) return;
  try {
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, wait);
  } catch (e) {
    // 环境不支持 Atomics.wait（或非主线程限制）→ 回退自旋
    const end = Date.now() + wait;
    while (Date.now() < end) {
      /* 回退路径 */
    }
  }
}

function withLock(dir, fn, timeoutMs) {
  const file = lockPath(dir);
  const deadline = Date.now() + (timeoutMs || LOCK_TIMEOUT_MS);
  for (;;) {
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({ pid: process.pid, created_at: nowIso(), holder: 'auto' }),
        { flag: 'wx' }
      );
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > LOCK_STALE_MS) {
          fs.unlinkSync(file);
          continue;
        }
      } catch (e2) {
        continue;
      }
      if (Date.now() > deadline) {
        throw new LogError(
          `获取写锁超时（${file}）。可能有其他工具正在写入，请稍后重试。`,
          EXIT.CONFLICT
        );
      }
      sleepSync(LOCK_RETRY_INTERVAL_MS);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      /* 已释放 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * 时间口径（§18/§19）
 * ------------------------------------------------------------------ */

function segMinutes(seg, nowMin) {
  const start = parseHHMM(seg.start);
  if (seg.end) return Math.max(0, parseHHMM(seg.end) - start);
  return Math.max(0, (nowMin === undefined ? nowMinutes() : nowMin) - start);
}

function closeOpenSegments(rec, hhmm) {
  for (const seg of rec.time_segments || []) {
    if (!seg.end) {
      seg.end = parseHHMM(hhmm) < parseHHMM(seg.start) ? seg.start : hhmm;
    }
  }
  return rec;
}

function openSegmentAt(rec, hhmm) {
  rec.time_segments = rec.time_segments || [];
  if (rec.time_segments.some((s) => !s.end)) return false;
  const last = rec.time_segments[rec.time_segments.length - 1];
  if (last && last.end && last.end === hhmm) last.end = null;
  else rec.time_segments.push({ start: hhmm, end: null });
  return true;
}

/**
 * 有效时间段。
 * needs_confirmation 表示时间信息不可靠，把「从开始到此刻」算成工作时长等于猜测
 * （§2.4 不可靠的预估必须为空），因此该状态的开放时段不计入任何统计。
 */
function effectiveSegments(rec) {
  const segments = rec.time_segments || [];
  if (rec.status === 'needs_confirmation') return segments.filter((s) => s.end);
  return segments;
}

/**
 * 重算 `actual_duration`（V3.24 重写，用户 2026-09-28）。
 *
 * 分档依据是**时间证据的来源**，不是「有没有 end_time」：
 *
 *   ① 非 manual 来源（codex / workbuddy / auto / generic / other）
 *        → AI 会话推导：**不产出时长**。即便身上带着 end_time（会话收尾或批量封段时刻）
 *          也不得据此计时 —— 记 null + duration_source='not_applicable_ai_session'。
 *   ② manual + 有闭合时段 → 时长 = 闭合时段之和（'segments'）。
 *   ③ manual + 只有开放时段 → null + 'open_segment'；**绝不用 now 兜底**
 *        （旧行为 `now − start` 使同一份历史数据换个时刻重算就变，且实质是编造结束时间）。
 *   ④ live=true 仅用于展示，才允许把开放段算到 now，标 'live'，且不得落盘。
 *
 * 进行中事项非实时时仍不落盘易变耗时（保持既有语义，validate-log 有对应告警）。
 */
function recalc(rec, nowMin, live) {
  const isLive = live === true;
  const nowThe = nowMin === undefined ? nowMinutes() : nowMin;

  // ① AI 会话推导：不产出时长（用户 2026-09-28）
  if (rec.source !== 'manual') {
    rec.actual_duration = null;
    rec.duration_source = 'not_applicable_ai_session';
    return rec;
  }

  const segments = effectiveSegments(rec);
  const closed = segments.filter((s) => s && s.end);
  const open = segments.filter((s) => s && !s.end);

  // ② 进行中且非实时：不落盘易变耗时
  if (rec.status === 'in_progress' && !isLive) {
    rec.actual_duration = null;
    rec.duration_source = closed.length
      ? 'segments_partial'
      : open.length
        ? 'open_segment'
        : 'unknown';
    return rec;
  }

  // ③ 无时段记录：若人工给了完整的 start + end，仍按区间计时
  if (!segments.length) {
    if (rec.start_time && rec.end_time) {
      const s = toMinutes(rec.start_time);
      const e = toMinutes(rec.end_time);
      rec.actual_duration = s !== null && e !== null ? Math.max(0, e - s) : null;
      rec.duration_source = rec.actual_duration === null ? 'unknown' : 'segments';
      return rec;
    }
    rec.actual_duration = null;
    rec.duration_source = 'unknown';
    return rec;
  }

  // ④ 计时：闭合段必算；开放段**仅 live 展示态**按现值计入
  let minutes = closed.reduce((sum, s) => sum + segMinutes(s), 0);
  let source = open.length ? 'segments_partial' : 'segments';
  if (isLive && open.length) {
    minutes += open.reduce((sum, s) => sum + segMinutes(s, nowThe), 0);
    source = 'live';
  }
  // 非 live 且只有开放段 → 无法计时（**绝不用 now 兜底**）
  if (!closed.length && source !== 'live') {
    rec.actual_duration = null;
    rec.duration_source = 'open_segment';
    return rec;
  }
  rec.actual_duration = minutes;
  rec.duration_source = source;
  return rec;
}

/**
 * 所有时间段合并重叠 —— 实际占用时间 Elapsed Time（§19）
 *
 * V3.24（用户 2026-09-28）：**开放段不参与**。旧实现用 `now` 给未闭合的时段封口，
 * 导致 wall_clock_minutes 随查询时刻漂移、且越晚查越大。无法确定结束的时段一律不计，
 * 需要在报表里单列「未闭合 N 段」由调用方提示。
 */
function unionMinutes(records) {
  const intervals = [];
  for (const rec of records) {
    for (const seg of effectiveSegments(rec)) {
      if (!seg.end) continue;
      const start = parseHHMM(seg.start);
      const end = parseHHMM(seg.end);
      if (end > start) intervals.push([start, end]);
    }
  }
  if (!intervals.length) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let [cs, ce] = intervals[0];
  for (let i = 1; i < intervals.length; i += 1) {
    const [s, e] = intervals[i];
    if (s <= ce) ce = Math.max(ce, e);
    else {
      total += ce - cs;
      cs = s;
      ce = e;
    }
  }
  return total + (ce - cs);
}

function overlapsOf(records, nowMin) {
  const segs = [];
  for (const rec of records) {
    for (const s of rec.time_segments || []) {
      if (!s.start) continue;
      segs.push({
        id: rec.id,
        content: rec.content,
        start: parseHHMM(s.start),
        end: s.end ? parseHHMM(s.end) : nowMin,
      });
    }
  }
  const found = [];
  for (let i = 0; i < segs.length; i += 1) {
    for (let j = i + 1; j < segs.length; j += 1) {
      const a = segs[i];
      const b = segs[j];
      if (a.id === b.id) continue;
      if (a.start < b.end && b.start < a.end) {
        const label = `${fmtHHMM(Math.max(a.start, b.start))}-${fmtHHMM(
          Math.min(a.end, b.end)
        )}  ${a.content} 与 ${b.content}`;
        if (!found.includes(label)) found.push(label);
      }
    }
  }
  return found;
}

const SOURCE_LABEL = { codex: 'Codex', workbuddy: 'WorkBuddy', manual: '手动', other: '其他' };
const STATUS_LABEL = {
  not_started: '未开始',
  in_progress: '进行中',
  paused: '已暂停',
  completed: '已完成',
  cancelled: '已取消',
  needs_confirmation: '待确认',
};
const STATUS_ICON = {
  not_started: '○',
  in_progress: '▶',
  paused: '‖',
  completed: '✓',
  cancelled: '✕',
  needs_confirmation: '?',
};

function recordSpan(rec) {
  const segments = (rec.time_segments || []).filter((s) => s.start);
  const openMark = rec.status === 'needs_confirmation' ? '?' : '…';
  if (segments.length) {
    const last = segments[segments.length - 1];
    // 末端未闭合时若记录自带 end_time，用它补上（只补最后一段，不臆造中间段）
    return segments
      .map((s, i) =>
        i === segments.length - 1 && !s.end && rec.end_time
          ? `${s.start}-${rec.end_time}`
          : `${s.start}-${s.end || openMark}`
      )
      .join('、');
  }
  const s = toMinutes(rec.start_time);
  if (s !== null) return `${fmtHHMM(s)}-${rec.end_time ? rec.end_time : openMark}`;
  return rec.time_unknown === true ? '时间未记录' : '时间未知';
}

/**
 * 时间线渲染。
 *
 * @param {object} log           日志对象（取 log.records）
 * @param {function} [labelOf]   自定义标签渲染
 * @param {Array} [recordsOverride] 用这套记录替代 log.records。
 *   总结层传入**合并后**的事项，避免「工作事项 3 条 / 时间线 4 行」的口径错位。
 */
function timeline(log, labelOf, recordsOverride) {
  const nowMin = nowMinutes();
  const src = Array.isArray(recordsOverride) ? recordsOverride : log.records || [];
  const recs = src.slice().sort((a, b) => {
    const av = toMinutes(a.start_time);
    const bv = toMinutes(b.start_time);
    return (
      (av === null ? Number.MAX_SAFE_INTEGER : av) - (bv === null ? Number.MAX_SAFE_INTEGER : bv)
    );
  });
  return recs.map((rec) => {
    recalc(rec, nowMin, true);
    const closed = (rec.time_segments || []).filter((s) => s.end);
    let durText;
    if (rec.status === 'needs_confirmation' && !closed.length) durText = '结束时间未知';
    else if (rec.actual_duration === null) durText = '时长未记录';
    else durText = `累计 ${rec.actual_duration} 分钟`;
    // labelOf 可注入自定义显示（总结层用「【项目】【模块】内容」格式）
    const label = typeof labelOf === 'function' ? labelOf(rec) : rec.display_content || rec.content;
    const mergedTag = rec.merged_count > 1 ? `  ·  合并 ${rec.merged_count} 条` : '';
    return `${recordSpan(rec)}   ${label}  ·  ${
      SOURCE_LABEL[rec.source] || rec.source
    }  ·  ${STATUS_LABEL[rec.status] || rec.status}  ·  ${durText}${mergedTag}`;
  });
}

function buildStats(input) {
  const log = JSON.parse(JSON.stringify(input));
  const nowMin = nowMinutes();
  const records = log.records || [];
  const items = records.map((rec) => {
    recalc(rec, nowMin, true);
    return {
      id: rec.id,
      content: rec.content,
      source: rec.source,
      status: rec.status,
      start_time: rec.start_time,
      end_time: rec.end_time,
      actual_duration: rec.actual_duration,
      duration_source: rec.duration_source,
      estimated_duration: rec.estimated_duration,
      confidence: rec.confidence,
    };
  });
  const bySource = {};
  for (const it of items) {
    const key = it.source || 'other';
    bySource[key] = bySource[key] || { items: 0, minutes: 0 };
    bySource[key].items += 1;
    bySource[key].minutes += it.actual_duration || 0;
  }
  return {
    date: log.date,
    work_item_count: records.length,
    // V3.24：AI 会话推导事项不产出时长（actual_duration 恒为 null），因此该项天然只累计人工时段
    work_item_total_minutes: items.reduce((s, r) => s + (r.actual_duration || 0), 0),
    wall_clock_minutes: unionMinutes(records),
    parallel_note:
      'work_item_total_minutes 为各事项自身时间段累计；wall_clock_minutes 为合并重叠后的实际占用时间。' +
      '两者可能不同（§19），不得把前者当作真实经过时间。' +
      'V3.24：只统计「人工明确给出闭合时段」的时长；AI 会话推导事项与未闭合时段一律不计（见 duration_source）。',
    by_source: bySource,
    items,
    completed: items.filter((r) => r.status === 'completed').map((r) => r.id),
    in_progress: items.filter((r) => r.status === 'in_progress').map((r) => r.id),
    unfinished: items
      .filter((r) => ['in_progress', 'paused', 'not_started'].includes(r.status))
      .map((r) => r.id),
    needs_confirmation: items.filter((r) => r.status === 'needs_confirmation').map((r) => r.id),
    unrecorded_duration: items.filter((r) => r.actual_duration === null).map((r) => r.id),
    // §25「异常/缺失记录」
    anomalies: items
      .filter(
        (r) =>
          r.actual_duration === null ||
          r.status === 'needs_confirmation' ||
          (r.status === 'completed' && !r.end_time)
      )
      .map((r) => ({
        id: r.id,
        content: r.content,
        reason:
          r.status === 'needs_confirmation'
            ? '待确认'
            : r.actual_duration === null
            ? '时长未记录'
            : '已完成但缺少结束时间',
      })),
  };
}

/* ------------------------------------------------------------------ *
 * 项目维度汇总（§24.3 / §25）
 * ------------------------------------------------------------------ */

/**
 * 按「项目 → 工作类型 → 事项」归纳当天工作（§24.3）。
 * 无项目事项统一归入「其他工作」。
 */
function groupByProject(input) {
  const log = JSON.parse(JSON.stringify(input));
  const nowMin = nowMinutes();
  const groups = new Map();
  for (const rec of log.records || []) {
    recalc(rec, nowMin, true);
    const project = rec.project_name || UNASSIGNED_PROJECT_LABEL;
    const workType = rec.work_type || '未分类';
    if (!groups.has(project)) groups.set(project, { project_name: project, items: 0, minutes: 0, types: new Map() });
    const g = groups.get(project);
    g.items += 1;
    g.minutes += rec.actual_duration || 0;
    if (!g.types.has(workType)) g.types.set(workType, []);
    g.types.get(workType).push({
      id: rec.id,
      content: rec.content,
      display_content: rec.display_content || buildDisplayContent(rec),
      status: rec.status,
      actual_duration: rec.actual_duration,
    });
  }
  return [...groups.values()]
    .sort((a, b) => b.minutes - a.minutes || a.project_name.localeCompare(b.project_name))
    .map((g) => ({
      project_name: g.project_name,
      items: g.items,
      minutes: g.minutes,
      unassigned: g.project_name === UNASSIGNED_PROJECT_LABEL,
      types: [...g.types.entries()].map(([work_type, items]) => ({
        work_type,
        items,
        minutes: items.reduce((s, i) => s + (i.actual_duration || 0), 0),
      })),
    }));
}

/* ------------------------------------------------------------------ *
 * op 模型
 * ------------------------------------------------------------------ */

function findRecords(log, ident, match, onlyOpen) {
  return (log.records || []).filter((rec) => {
    if (ident && rec.id !== ident && !String(rec.id).startsWith(ident)) return false;
    if (match && !String(rec.content || '').toLowerCase().includes(String(match).toLowerCase()))
      return false;
    if (onlyOpen && !['in_progress', 'paused'].includes(rec.status)) return false;
    return true;
  });
}

function resolveOne(log, ident, match, onlyOpen) {
  const hits = findRecords(log, ident, match, onlyOpen);
  if (!hits.length) {
    throw new LogError(`未找到匹配的工作事项（id=${ident || '-'}，内容≈${match || '-'}）。`);
  }
  if (hits.length > 1) {
    const listing = hits
      .map((h) => `  - ${h.id}  ${h.content}  [${STATUS_LABEL[h.status] || h.status}]`)
      .join('\n');
    throw new LogError(`匹配到多个事项，请用 --id 精确指定：\n${listing}`);
  }
  return hits[0];
}

function findPendingItem(log, ident, match) {
  const hits = (log.pending_items || []).filter((p) => {
    if (ident && p.id !== ident && p.hash !== ident && !String(p.id || '').startsWith(ident)) {
      return false;
    }
    if (match && !String(p.content || '').toLowerCase().includes(String(match).toLowerCase()))
      return false;
    return true;
  });
  if (!hits.length) throw new LogError(`未找到匹配的待确认候选（id=${ident || '-'}）。`);
  if (hits.length > 1) {
    throw new LogError(
      `匹配到多个待确认候选，请用 --pending <id> 指定：\n${hits
        .map((h) => `  - ${h.id}  ${h.content}`)
        .join('\n')}`
    );
  }
  return hits[0];
}

function ensureUniqueId(log, id) {
  const taken = new Set((log.records || []).map((r) => r.id));
  let candidate = id;
  while (taken.has(candidate)) candidate = `${candidate}${randomHex(2)}`;
  return candidate;
}

/* ─────────── pending/<date>.json 的定位与写回（V3.23，用户 2026-09-28） ───────────
 *
 * 背景：本机只保留当天 current.json（`log.keep_days = 1`），跨日且未同步的日志会被
 * 转入 `pending/<date>.json`。但 `update-work-item.js`（link / done / edit …）与
 * `init-log.js sync` 此前**只读 current.json**，于是「已跨日的事项」再也无法
 * 回写 taskId、也无法把该日期的同步状态标为成功 —— 2026-09-28 实测只能靠
 * 一次性补丁脚本绕过。下面三个函数把该能力补进库层，CLI 与测试共用。
 *
 * 写回 pending 日志**不走 runMutation**：pending 日志不在 state 的活动日志位上，
 * runMutation 会改到 current.json。因此这里显式归一化 + 原子写；
 * 同步状态那一份额外维护 `state.pending_sync_dates`，规则与 `syncState()` 对齐。
 */

const PENDING_RESERVED_FILES = new Set(['last-hook.json']);
const PENDING_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function pendingDir(dir) {
  return path.join(dir, 'pending');
}

function pendingLogPath(dir, date) {
  if (!PENDING_DATE_RE.test(String(date || ''))) {
    throw new LogError(`pending 日志日期非法（应为 YYYY-MM-DD）：${date}`);
  }
  return path.join(pendingDir(dir), `${date}.json`);
}

/** 列出 pending/ 下可用的日志日期（升序）。排除 last-hook.json 等非日志文件与子目录。 */
function listPendingLogDates(dir) {
  let names = [];
  try {
    names = fs.readdirSync(pendingDir(dir));
  } catch (e) {
    return [];
  }
  const dates = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const base = n.slice(0, -'.json'.length);
    if (PENDING_RESERVED_FILES.has(n)) continue;
    if (!PENDING_DATE_RE.test(base)) continue;
    if (!fs.statSync(path.join(pendingDir(dir), n)).isFile()) continue;
    dates.push(base);
  }
  return dates.sort();
}

/** 读取 pending/<date>.json；不存在或结构不可用时返回 null。 */
function readPendingLog(dir, date) {
  const log = readJSON(pendingLogPath(dir, date), null);
  if (!log || !Array.isArray(log.records)) return null;
  return log;
}

/** 原子写回 pending/<date>.json（保留全部既有字段）。 */
function writePendingLog(dir, date, log) {
  const p = pendingLogPath(dir, date);
  atomicWriteJSON(p, log);
  return p;
}

/**
 * 跨 current.json 与 pending/*.json 定位一个 WorkItem。
 *
 * @returns {{log:object,date:string,file:string,where:'current'|'pending',rec:object}}
 * @throws {LogError} 未找到、或命中歧义（同一日志内多条 / 多个 pending 日期都有）
 *
 * 刻意不做「猜一个」：命中多个 pending 日期时报错并列出候选，
 * 宁可让人用 --id 精确指定，也不能改错事项（§7「宁可不动，不可改错」）。
 */
function resolveWorkItemAnywhere(dir, ident, match, onlyOpen) {
  const cur = readJSON(currentPath(dir), null);
  if (cur && Array.isArray(cur.records)) {
    const hits = findRecords(cur, ident, match, onlyOpen);
    if (hits.length === 1) {
      return { log: cur, date: cur.date, file: currentPath(dir), where: 'current', rec: hits[0] };
    }
    if (hits.length > 1) {
      throw new LogError(
        `匹配到多个事项，请用 --id 精确指定：\n${hits
          .map((h) => `  - ${h.id}  ${h.content}  [${STATUS_LABEL[h.status] || h.status}]`)
          .join('\n')}`
      );
    }
  }

  const found = [];
  for (const date of listPendingLogDates(dir)) {
    const log = readPendingLog(dir, date);
    if (!log) continue;
    for (const rec of findRecords(log, ident, match, onlyOpen)) {
      found.push({ log, date, file: pendingLogPath(dir, date), where: 'pending', rec });
    }
  }
  if (found.length === 1) return found[0];
  if (found.length > 1) {
    // 区分两种歧义：同一份 pending 日志内多条 vs 跨多个 pending 日期。
    //   报错必须说清是哪种，否则用户无法判断该改用 --id 还是先缩小日期范围。
    const byDate = new Map();
    for (const h of found) byDate.set(h.date, (byDate.get(h.date) || 0) + 1);
    const dates = [...byDate.keys()];
    if (dates.length === 1) {
      throw new LogError(
        `pending/${dates[0]}.json 中匹配到多个事项，请用 --id 精确指定：\n${found
          .map((h) => `  - ${h.rec.id}  ${h.rec.content}  [${STATUS_LABEL[h.rec.status] || h.rec.status}]`)
          .join('\n')}`
      );
    }
    throw new LogError(
      `该事项在多个 pending 日志中匹配到，请用 --id 精确指定：\n${found
        .map((h) => `  - [pending/${h.date}.json] ${h.rec.id}  ${h.rec.content}`)
        .join('\n')}`
    );
  }
  throw new LogError(
    `未找到匹配的工作事项（id=${ident || '-'}，内容≈${match || '-'}）。\n` +
      `已查：current.json${listPendingLogDates(dir).length ? `、pending/{${listPendingLogDates(dir).join(',')}}.json` : '（无 pending 日志）'}`
  );
}

/**
 * 就地修改「已跨日」pending 日志中的一个 WorkItem（link / done / edit 等的 pending 通路）。
 *
 * 归一化与 `applyOp` 的 patch 分支保持一致：Object.assign → normalizeItem → recalc。
 * 原地修改会同时更新 `version` / `updated_at` / `updated_by`，保持日志自身的修订语义。
 *
 * @returns {{date:string,file:string,work_item_id:string,before:object,after:object}}
 */
function patchPendingWorkItem(dir, date, id, set, opts) {
  const o = opts || {};
  const log = readPendingLog(dir, date);
  if (!log) throw new LogError(`pending/${date}.json 不存在或不可读。`);
  const idx = (log.records || []).findIndex((r) => r.id === id);
  if (idx < 0) throw new LogError(`pending/${date}.json 中未找到工作事项：${id}`);
  const rec = log.records[idx];
  const before = JSON.parse(JSON.stringify(rec));

  Object.assign(rec, set || {});
  if (o.segmentsClose) for (const s of o.segmentsClose) closeOpenSegments(rec, s);
  if (o.segmentsAdd) for (const s of o.segmentsAdd) (rec.time_segments = rec.time_segments || []).push(s);
  normalizeItem(rec);
  recalc(rec, undefined, false);

  log.records[idx] = rec;
  log.version = (log.version || 0) + 1;
  log.updated_at = nowIso();
  log.updated_by = o.actor || 'workbuddy';
  writePendingLog(dir, date, log);
  return { date, file: pendingLogPath(dir, date), work_item_id: id, before, after: rec };
}

/**
 * 把同步状态写进「已跨日」的 pending 日志，并同步维护 `state.pending_sync_dates`。
 *
 * 规则与 `syncState()` 中对当日日志的处理**保持一致**：
 * `success` → 从待同步列表移除该日期并记 `last_sync_time`；其它状态 → 保持在列表中。
 */
function setPendingSyncStatus(dir, date, status, detail, actor) {
  if (!VALID_SYNC_STATUS.includes(status)) {
    throw new LogError(`同步状态非法：${status}（允许：${VALID_SYNC_STATUS.join(', ')}）`);
  }
  const log = readPendingLog(dir, date);
  if (!log) throw new LogError(`pending/${date}.json 不存在或不可读。`);

  const patch = { status, last_attempt_at: nowIso() };
  if (status === 'success') patch.last_sync_at = nowIso();
  if (detail) patch.detail = detail;
  log.sync = Object.assign({ status: 'pending', last_sync_at: null }, log.sync || {}, patch);
  log.version = (log.version || 0) + 1;
  log.updated_at = nowIso();
  log.updated_by = actor || 'workbuddy';
  writePendingLog(dir, date, log);

  const state = migrateState(readJSON(statePath(dir), null) || defaultState());
  const pending = new Set(state.pending_sync_dates || []);
  if (status === 'success') {
    pending.delete(date);
    state.last_sync_time = log.updated_at;
  } else {
    pending.add(date);
  }
  state.pending_sync_dates = [...pending].filter(Boolean).sort();
  atomicWriteJSON(statePath(dir), state);

  return {
    date,
    file: pendingLogPath(dir, date),
    sync: log.sync,
    pending_sync_dates: state.pending_sync_dates,
  };
}

function applyOp(log, op) {
  switch (op.kind) {
    case 'add': {
      const item = JSON.parse(JSON.stringify(op.item));
      item.id = ensureUniqueId(log, item.id);
      normalizeItem(item); // §9/§28：补齐项目/工作类型字段并重算 display_content
      log.records = log.records || [];
      log.records.push(item);
      return { id: item.id, item };
    }
    case 'patch': {
      const rec = resolveOne(log, op.id, op.match, false);
      for (const [k, v] of Object.entries(op.set || {})) rec[k] = v;
      for (const seg of op.segmentsClose || []) closeOpenSegments(rec, seg);
      for (const seg of op.segmentsAdd || []) {
        rec.time_segments = rec.time_segments || [];
        const last = rec.time_segments[rec.time_segments.length - 1];
        if (last && last.end && last.end === seg.start) last.end = seg.end || null;
        else rec.time_segments.push({ start: seg.start, end: seg.end || null });
      }
      for (const seg of op.segmentsDrop || []) {
        rec.time_segments = (rec.time_segments || []).filter((s) => s.start !== seg.start);
      }
      if (op.openSegmentAt) openSegmentAt(rec, op.openSegmentAt);
      if (op.activitiesAdd) {
        rec.activities = [...new Set([...(rec.activities || []), ...op.activitiesAdd])];
      }
      normalizeItem(rec); // §28：项目/工作类型变更后重算 display_content
      recalc(rec, undefined, false);
      return { id: rec.id, item: rec };
    }
    case 'delete': {
      const rec = resolveOne(log, op.id, op.match, false);
      log.records = (log.records || []).filter((r) => r.id !== rec.id);
      return { id: rec.id, content: rec.content };
    }
    case 'park': {
      const candidate = JSON.parse(JSON.stringify(op.item));
      log.pending_items = log.pending_items || [];
      if (log.pending_items.some((p) => p.id === candidate.id)) return { skipped: 'duplicate_id' };
      log.pending_items.push(candidate);
      return { id: candidate.id };
    }
    case 'promote': {
      const candidate = findPendingItem(log, op.id, op.match);
      const item = JSON.parse(JSON.stringify(candidate));
      delete item.reason;
      delete item.detected_at;
      Object.assign(item, op.set || {});
      item.id = ensureUniqueId(log, makeId());
      item.date = log.date;
      item.confidence = op.confidence || 'medium';
      item.activities = [...new Set([...(item.activities || []), ...(op.activitiesAdd || [])])];
      if (item.estimated_duration === undefined) item.estimated_duration = null;
      if (item.parent_id === undefined) item.parent_id = null;
      if (!Array.isArray(item.tags)) item.tags = item.tags || [];
      if (item.notes === undefined) item.notes = '';
      normalizeItem(item);
      if (item.start_time) {
        item.time_segments = [{ start: item.start_time, end: item.end_time || null }];
      } else {
        item.time_segments = [];
      }
      item.status =
        op.status ||
        (item.end_time ? 'completed' : item.start_time ? 'in_progress' : 'needs_confirmation');
      if (op.segmentsClose) for (const s of op.segmentsClose) closeOpenSegments(item, s);
      recalc(item, undefined, false);
      log.records = log.records || [];
      log.records.push(item);
      log.pending_items = log.pending_items.filter((p) => p.id !== candidate.id);
      return { id: item.id, item, promoted_from: candidate.id };
    }
    case 'dismiss': {
      const candidate = findPendingItem(log, op.id, op.match);
      log.pending_items = log.pending_items.filter((p) => p.id !== candidate.id);
      return { id: candidate.id, content: candidate.content };
    }
    case 'queue_item': {
      // §20/§40：无法判断归属时写入 pending_items，等待 /analyze 或自动批量分析
      const item = JSON.parse(JSON.stringify(op.item));
      log.pending_items = log.pending_items || [];
      log.judgments = log.judgments || {};
      if (item.hash && log.pending_items.some((p) => p.hash === item.hash)) {
        return { skipped: 'duplicate_hash', hash: item.hash };
      }
      if (item.hash && Object.prototype.hasOwnProperty.call(log.judgments, item.hash)) {
        return { skipped: 'already_judged', hash: item.hash };
      }
      log.pending_items.push(item);
      return { id: item.id, hash: item.hash, queued: log.pending_items.length };
    }
    case 'dequeue': {
      // 按 hash 或 id 移除已判定的待处理项
      const hashes = new Set(op.hashes || []);
      const before = (log.pending_items || []).length;
      log.pending_items = (log.pending_items || []).filter(
        (p) => !hashes.has(p.hash) && !hashes.has(p.id)
      );
      return { removed: before - log.pending_items.length, remaining: log.pending_items.length };
    }
    case 'judgment': {
      // §13.3：保存最近一次判断结果，相同活动再次出现时直接复用
      log.judgments = log.judgments || {};
      log.judgments[op.entry.activity_hash] = op.entry;
      return { entry: op.entry };
    }
    case 'clear_judgments': {
      const cleared = Object.keys(log.judgments || {}).length;
      log.judgments = {};
      return { cleared };
    }
    case 'patch_pending_batch': {
      // 批量修正待判断项字段（例如按空间项目回填 project_name）。
      // 只更新传入 items 里已有的条目（按 id 匹配），不新增、不删除。
      const items = Array.isArray(op.items) ? op.items : [];
      const byId = new Map(items.map((it) => [it.id, it]));
      log.pending_items = (log.pending_items || []).map((p) => {
        const next = byId.get(p.id);
        return next ? Object.assign({}, p, next) : p;
      });
      return { patched: byId.size };
    }
    case 'summary': {
      log.summary = op.summary;
      return { summary: op.summary };
    }
    case 'sync': {
      log.sync = Object.assign({ status: 'pending', last_sync_at: null }, log.sync || {}, op.sync);
      return { sync: log.sync };
    }
    case 'host': {
      // §57：宿主触发状态上报。state.hosts 是 /status 判断
      // 「Skill 状态 / 宿主触发状态 / 日志记录状态」三态分离的依据。
      const reg = {};
      for (const [k, v] of Object.entries(op.registry || {})) {
        if (v !== undefined) reg[k] = v;
      }
      const delta = typeof reg.activity_delta === 'number' ? reg.activity_delta : 0;
      delete reg.activity_delta;
      const existing = (log.hosts && log.hosts[reg.host]) || null;
      const merged = Object.assign(
        {
          host: reg.host,
          tool: reg.host,
          mechanism: 'unknown',
          trigger_configured: null,
          available: null,
          last_activity_at: null,
          activity_count: 0,
        },
        existing || {},
        reg
      );
      if (reg.mechanism) merged.mechanism = reg.mechanism;
      else if (existing && existing.mechanism && existing.mechanism !== 'unknown') {
        merged.mechanism = existing.mechanism;
        if (existing.available !== undefined && existing.available !== null) {
          merged.available = existing.available;
        }
      } else {
        merged.mechanism = reg.host === 'manual' ? 'manual' : 'skill';
      }
      if (existing && existing.last_activity_at && reg.last_activity_at === undefined) {
        merged.last_activity_at = existing.last_activity_at;
      }
      merged.activity_count = (existing ? existing.activity_count || 0 : 0) + delta;
      log.hosts = Object.assign({}, log.hosts || {}, { [reg.host]: merged });
      return { host: merged };
    }
    case 'space_project': {
      // 登记检测到的 WorkBuddy 空间项目（§4.1 C）。
      // 用途：发现「有 project_id 但还没配名称」的空间项目，供 /status 提示用户补名称。
      // 只累积事实（id/cwd/次数），**不推断名称**。
      const pid = String(op.project_id || '').trim();
      if (!pid) return { space_project: null };
      const existing = (log.space_projects && log.space_projects[pid]) || null;
      const merged = Object.assign(
        {
          project_id: pid,
          cwds: [],
          first_seen: nowIso(),
          last_seen: nowIso(),
          seen_count: 0,
          named: false,
        },
        existing || {}
      );
      if (op.cwd && !merged.cwds.includes(op.cwd)) merged.cwds.push(op.cwd);
      if (op.last_seen) merged.last_seen = op.last_seen;
      merged.seen_count = (existing ? existing.seen_count || 0 : 0) + 1;
      if (op.named === true || op.named === false) merged.named = op.named;
      log.space_projects = Object.assign({}, log.space_projects || {}, { [pid]: merged });
      return { space_project: merged };
    }
    default:
      throw new LogError(`未知的 op 类型：${op.kind}`);
  }
}

/* ------------------------------------------------------------------ *
 * spool：写入失败不得静默丢弃
 * ------------------------------------------------------------------ */

function spoolOps(dir, ops, actor, error) {
  try {
    const d = spoolDir(dir);
    fs.mkdirSync(d, { recursive: true });
    const file = path.join(d, `${Date.now()}_${randomHex(6)}.json`);
    atomicWriteJSON(file, {
      created_at: nowIso(),
      actor: actor || 'workbuddy',
      last_error: String((error && error.message) || error),
      ops,
    });
    return file;
  } catch (e) {
    return null;
  }
}

function listSpool(dir) {
  const d = spoolDir(dir);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => path.join(d, f));
}

/* ------------------------------------------------------------------ *
 * 统一写入通道（§35/§37）
 * ------------------------------------------------------------------ */

/**
 * 旧版本数据就地归一化。
 * 刻意不改动 WorkItem id：id 是 ticktick-work-review 的外部任务映射键（§48）。
 */
function migrateLog(log) {
  const changes = [];
  if (typeof log.version === 'string' || log.schema_version) {
    // 旧版 version 是 schema 标识（"1.4"），整数版本号当时叫 revision
    log.version = Number.isInteger(log.revision) ? log.revision : 1;
    changes.push('version');
  } else if (!Number.isInteger(log.version)) {
    log.version = 1;
    changes.push('version');
  }
  delete log.revision;
  delete log.schema_version;
  // sync 结构归一化：§51 状态为 success / partial / failed；旧版 synced、partial_success、success(旧) 都要映射
  const SYNC_ALIAS = { synced: 'success', partial_success: 'partial' };
  if (!log.sync || typeof log.sync !== 'object') {
    log.sync = { status: 'pending', last_sync_at: null };
    changes.push('sync');
  } else {
    if (SYNC_ALIAS[log.sync.status]) {
      changes.push(`sync.status:${log.sync.status}→${SYNC_ALIAS[log.sync.status]}`);
      log.sync.status = SYNC_ALIAS[log.sync.status];
    }
    if (!VALID_SYNC_STATUS.includes(log.sync.status)) {
      log.sync.status = 'pending';
      changes.push('sync.status');
    }
    if (!('last_sync_at' in log.sync)) log.sync.last_sync_at = null;
  }
  if (!Array.isArray(log.pending_items)) log.pending_items = [];
  if (!log.judgments || typeof log.judgments !== 'object') log.judgments = {};
  // 旧版本把待判断活动单独放在 pending_activities：合并进 pending_items（§20 统一模型）
  if (Array.isArray(log.pending_activities) && log.pending_activities.length) {
    const known = new Set(log.pending_items.map((p) => p.hash).filter(Boolean));
    for (const a of log.pending_activities) {
      if (a.hash && known.has(a.hash)) continue;
      log.pending_items.push(
        Object.assign({ id: a.hash || makeActivityId(), confidence: 'low' }, a)
      );
      if (a.hash) known.add(a.hash);
    }
    changes.push('pending_activities→pending_items');
  }
  delete log.pending_activities;
  for (const rec of log.records || []) {
    if (!Array.isArray(rec.activities)) {
      rec.activities = [];
      changes.push(`activities:${rec.id}`);
    }
    // V2.1 新增字段：旧记录补 null 并重算 display_content
    if (rec.project_name === undefined || rec.work_type === undefined) {
      changes.push(`project/work_type:${rec.id}`);
    }
    normalizeItem(rec);
    for (const f of ['start_time', 'end_time']) {
      const v = rec[f];
      if (v && !isHHMM(v)) {
        const m = toMinutes(v);
        if (m !== null) {
          rec[f] = fmtHHMM(m);
          changes.push(`${f}:${rec.id}`);
        }
      }
    }
  }
  return changes;
}

function syncState(dir, log, actor) {
  const state = migrateState(readJSON(statePath(dir), null) || defaultState());
  state.current_date = log.date;
  state.active_work_items = (log.records || [])
    .filter((r) => r.status === 'in_progress')
    .map((r) => r.id);
  if ((log.records || []).length || (log.pending_items || []).length) {
    state.last_event_time = log.updated_at;
    state.last_log_write_time = log.updated_at;
  }
  const pending = new Set(state.pending_sync_dates || []);
  if ((log.sync || {}).status === 'success') pending.delete(log.date);
  else pending.add(log.date);
  state.pending_sync_dates = [...pending].filter(Boolean).sort();
  if (log.summary) {
    state.last_summary_time = log.summary.generated_at || log.updated_at;
    // §18：每日自动总结最多执行一次
    if ((log.summary || {}).trigger === 'auto_scheduled') {
      state.last_automatic_summary_date = log.date;
    }
  }
  if ((log.sync || {}).status === 'success') state.last_sync_time = log.updated_at;
  if (log.hosts) state.hosts = Object.assign({}, state.hosts || {}, log.hosts);
  // 空间项目登记（§4.1 C）：长期有效，跨日保留在 state 中
  if (log.space_projects) {
    state.space_projects = Object.assign({}, state.space_projects || {}, log.space_projects);
  }
  if (!VALID_TRACKING_STATUS.includes(state.tracking_status)) state.tracking_status = 'tracking';
  if (!Number.isInteger(state.automatic_ai_calls_today)) state.automatic_ai_calls_today = 0;
  if (!Number.isInteger(state.manual_ai_calls_today)) state.manual_ai_calls_today = 0;
  if (!state.ai_date) state.ai_date = today();
  if (!state.hosts) state.hosts = {};
  atomicWriteJSON(statePath(dir), state);
  return state;
}

/**
 * 唯一合法的写入口。
 *   read → lock → re-read → 跨日闸门 → 重放 spool → 应用 op
 *   → version + 1 → atomic write → unlock
 * 仅瞬时故障（锁竞争、I/O 异常）才暂存 op；确定性失败不进入暂存队列。
 */
function runMutation(dir, actor, ops, options) {
  const opts = options || {};
  let committed = false;
  try {
    return withLock(dir, () => {
      let log = readJSON(currentPath(dir), null);
      if (log === null) log = emptyDailyLog();
      else migrateLog(log);
      if (opts.enforceDate) {
        // 新日期记录到达时走非破坏性自动跨日：先导出 WorkItem，
        // 未同步旧日志转 pending/，再继续应用本次写入。
        const effectiveDecision =
          opts.autoRollover && opts.decision == null ? 'keep' : opts.decision;
        const moved = checkDate(log, dir, effectiveDecision, actor);
        if (moved) log = readJSON(currentPath(dir), null) || emptyDailyLog();
      }
      if (opts.expectVersion !== undefined && log.version !== opts.expectVersion) {
        // §37：版本发生变化 → 重新读取 → 重新合并 → 再次写入
        throw new LogError(
          `版本冲突：期望 ${opts.expectVersion}，实际 ${log.version}。请重新读取后合并。`,
          EXIT.CONFLICT
        );
      }
      const replayed = [];
      for (const file of listSpool(dir)) {
        const payload = readJSON(file, null);
        if (!payload || !Array.isArray(payload.ops)) {
          replayed.push(file);
          continue;
        }
        for (const op of payload.ops) applyOp(log, op);
        replayed.push(file);
      }
      const applied = [];
      for (const op of ops) applied.push(applyOp(log, op));
      log.version = (Number.isInteger(log.version) ? log.version : 0) + 1;
      log.updated_at = nowIso();
      log.updated_by = actor || 'workbuddy';
      atomicWriteJSON(currentPath(dir), log);
      committed = true;
      for (const f of replayed) {
        try {
          fs.unlinkSync(f);
        } catch (e) {
          /* 忽略 */
        }
      }
      syncState(dir, log, actor);
      return { log, applied, replayed_spool: replayed.length };
    });
  } catch (err) {
    const transient = err instanceof LogError ? err.code === EXIT.CONFLICT : true;
    if (!committed && transient) {
      const file = spoolOps(dir, ops, actor, err);
      if (file) {
        err.message += `\n本次修改已暂存到 ${path.relative(dir, file)}，下一次写入时会自动重试。`;
        err.spooled = file;
      }
    }
    throw err;
  }
}

/** state.json 的受锁读改写，用于 AI 调用计数等非 DailyLog 数据。 */
function mutateState(dir, fn) {
  return withLock(dir, () => {
    const state = migrateState(readJSON(statePath(dir), null) || defaultState());
    const result = fn(state);
    atomicWriteJSON(statePath(dir), state);
    return { state, result };
  });
}

/* ------------------------------------------------------------------ *
 * AI 调用额度（§13/§14/§15/§16/§17）
 * ------------------------------------------------------------------ */

const readState = (dir) => readJSON(statePath(dir), null) || defaultState();

/**
 * AI 调用能力查询（§32-§35）。
 *
 *   auto_analysis —— 宿主自动任务/事件触发本 Skill 后，Skill 在本次执行中需要 AI 时产生的调用。
 *                    受 batch_interval_minutes（批量窗口）、cooldown_minutes（冷却）、
 *                    safety_max_calls_per_day（安全熔断）约束（§33/§34/§35）。
 *   manual        —— 用户主动 /analyze、/summary，**不受 safety_max_calls_per_day 限制**（§35）。
 */
function aiUsage(dir, kind) {
  const config = readConfig(dir);
  const state = migrateState(readState(dir));
  const t = today();
  const sameDay = state.ai_date === t;
  const automatic = sameDay ? Number(state.automatic_ai_calls_today) || 0 : 0;
  const manual = sameDay ? Number(state.manual_ai_calls_today) || 0 : 0;
  const cap = config.ai.auto_analysis.safety_max_calls_per_day;
  const cooldownMs = config.ai.auto_analysis.cooldown_minutes * 60 * 1000;
  const lastAuto = state.automatic_ai_last_call_at
    ? Date.parse(state.automatic_ai_last_call_at)
    : NaN;
  const cooldownRemaining = Number.isFinite(lastAuto)
    ? Math.max(0, cooldownMs - (Date.now() - lastAuto))
    : 0;
  const kindNorm = kind === 'manual' ? 'manual' : 'auto_analysis';

  let blocked = false;
  let blockReason = null;
  if (config.ai.enabled === false) {
    blocked = true;
    blockReason = 'AI 调用已在配置中关闭（ai.enabled=false）';
  } else if (kindNorm === 'manual') {
    if (config.ai.manual.enabled === false) {
      blocked = true;
      blockReason = '手动 AI 调用已在配置中关闭（ai.manual.enabled=false）';
    }
  } else if (!autoAnalysisEnabled(config) || config.ai.auto_analysis.enabled === false) {
    blocked = true;
    blockReason = '自动 AI 分析未启用（ai.auto_analysis.enabled 或 tracking 未开启）';
  } else if (automatic >= cap) {
    // §35：熔断后停止自动 AI 分析，但记录不受影响
    blocked = true;
    blockReason =
      `已达 AI 自动调用保护阈值 ${cap}，自动 AI 分析停止；` +
      'Activity 与 WorkItem 继续记录，无法判断的事项进入 pending_items（§35）';
  } else if (cooldownRemaining > 0) {
    blocked = true;
    blockReason = `自动 AI 冷却中，剩余 ${Math.ceil(cooldownRemaining / 1000)} 秒（§34）`;
  }

  return {
    kind: kindNorm,
    enabled: config.ai.enabled !== false,
    automatic_calls_today: automatic,
    manual_calls_today: manual,
    safety_max_calls_per_day: cap,
    remaining_safety: Math.max(0, cap - automatic),
    batch_interval_minutes: config.ai.auto_analysis.batch_interval_minutes,
    cooldown_minutes: config.ai.auto_analysis.cooldown_minutes,
    cooldown_remaining_seconds: Math.ceil(cooldownRemaining / 1000),
    unlimited_manual: config.ai.manual.unlimited !== false,
    last_auto_call_at: state.automatic_ai_last_call_at || null,
    blocked,
    block_reason: blockReason,
  };
}

/** 消耗一次 AI 调用额度；被熔断/冷却时返回 allowed:false，由调用方降级处理（§34/§35/§40）。 */
function consumeAiCall(dir, reason, kind) {
  const usage = aiUsage(dir, kind);
  if (usage.blocked) return { allowed: false, usage };
  const { state } = mutateState(dir, (s) => {
    migrateState(s);
    const t = today();
    if (s.ai_date !== t) {
      s.ai_date = t;
      s.automatic_ai_calls_today = 0;
      s.manual_ai_calls_today = 0;
    }
    if (usage.kind === 'manual') {
      s.manual_ai_calls_today = (s.manual_ai_calls_today || 0) + 1;
    } else {
      s.automatic_ai_calls_today = (s.automatic_ai_calls_today || 0) + 1;
      s.automatic_ai_last_call_at = nowIso();
    }
    s.last_ai_reason = reason || null;
    return s;
  });
  return { allowed: true, usage: aiUsage(dir, kind), state };
}

/* ------------------------------------------------------------------ *
 * 跨日（§38-§41）
 * ------------------------------------------------------------------ */

/**
 * 跨日处理（§38-§41，用户约定 2026-09-21 收敛）。
 *
 * 本机策略：**只保留当天日志（current.json）**。跨日时按同步状态分两种：
 *
 *   已同步（sync.status=success/synced）→ **直接丢弃**，不写 archive/。
 *     历史日志不在本机留存；远端备份**不由本技能承担**
 *     （本技能不做 git / GitHub 同步，由独立的 GitHub 同步 Skill 负责）。
 *   未同步 → **中断并提示用户**，由用户决定先同步还是放弃，绝不静默丢弃（§39）。
 *
 * `--decision archive` 仍保留：它是「未同步但用户明确要求归档」时的显式出路，
 * 归档到**本地** archive/，供独立的备份 Skill 后续读取。默认不再产生 archive/ 文件。
 *
 * @param {object} log 当前 DailyLog
 * @param {string} dir 日志目录
 * @param {string} [decision] keep | archive（未同步时的用户选择）
 * @param {string} [actor]
 * @returns {object|null} null = 无需跨日
 */
function checkDate(log, dir, decision, actor) {
  if (log.date === today()) return null;
  const syncStatus = (log.sync || {}).status || 'pending';
  // 合法状态见 VALID_SYNC_STATUS：'success' 才代表已同步。
  // 旧版本的 'synced' 已由 SYNC_ALIAS 迁移为 'success'，这里一并兼容，
  // 否则已同步日志跨日时会被误判为「未同步」而错误转入 pending/（§39）。
  const synced = syncStatus === 'success' || syncStatus === 'synced';

  // 未同步且未选择 → 必须先问用户（用户约定：未同步时先提示）
  if (!synced && !decision) {
    throw new LogError(
      `发现 ${log.date} 存在未同步的工作记录（sync=${syncStatus}）。\n` +
        '本机只保留当天日志，跨日会丢弃 current.json。请选择：\n' +
        `  1. 立即同步 —— 先执行 /sync 走 ${SYNC_SKILL}，成功后再运行 rollover\n` +
        '  2. 仍然丢弃 —— 用 --decision keep（转 pending/ 等待后续同步）\n' +
        '不得直接覆盖未同步的日志（§39）。\n' +
        '（工作事项本身已由 export-work-activities.js 导出到 logs/<date>/work-activities.jsonl，' +
        '永久保留，不会因为跨日而丢失。）',
      EXIT.NEED_DECISION
    );
  }

  const config = readConfig(dir);

  // ★ 跨日丢弃前先做**永久导出**：把已归类的 WorkItem 写入
  //   logs/<date>/work-activities.jsonl（幂等）。
  //
  //   这是补齐长期缺口的关键一步：current.json 是 keep_days=1 且不做历史备份，
  //   此前「已同步 → 直接覆盖」会让当天的工作事项彻底消失，
  //   只剩 summaries/<date>.md 里的文字。而 logs/ 是永久的 ——
  //   「花了多少」（Token/Score/Skill）一直留着，「做了什么」也应该留着。
  //
  //   导出失败**不得阻断跨日**（否则会因为一个归档问题卡死整个流程），
  //   但要连同结果一起回报给调用方，避免静默。
  let exported = null;
  let exportError = null;
  try {
    // 延迟 require：避免 log-core 与 export 脚本之间的循环依赖
    const exporter = require('../export-work-activities');
    exported = exporter.exportRecords(dir, log.date, exporter.exportable(log));
  } catch (e) {
    exportError = String((e && e.message) || e);
  }

  let movedTo;
  if (synced) {
    // 用户约定：已同步 → 直接覆盖，不备份 current.json。
    // 历史由 logs/（永久）与 summaries/（永久）承担 —— 这正是 archive/ 被废弃的原因。
    movedTo = '未备份（已同步；工作事项已导出至 logs/，本机只保留当天 current.json）';
  } else {
    // 未同步且选择 keep：转 pending/ 等待后续同步
    fs.mkdirSync(path.join(dir, 'pending'), { recursive: true });
    atomicWriteJSON(path.join(dir, 'pending', `${log.date}.json`), log);
    movedTo = `pending/${log.date}.json`;
  }

  const fresh = emptyDailyLog(today());
  fresh.updated_by = actor || 'workbuddy';
  fresh.hosts = log.hosts || {};
  atomicWriteJSON(currentPath(dir), fresh);

  const state = readJSON(statePath(dir), null) || defaultState();
  state.current_date = today();
  state.active_work_items = [];
  const pending = new Set(state.pending_sync_dates || []);
  if (synced) pending.delete(log.date);
  else pending.add(log.date);
  state.pending_sync_dates = [...pending].filter(Boolean).sort();
  atomicWriteJSON(statePath(dir), state);
  return {
    moved_to: movedTo,
    new_date: today(),
    previous_synced: synced,
    work_activity_export: exported,
    work_activity_export_error: exportError,
  };
}

/**
 * 收到新日期记录前的统一跨日入口。
 *
 * 行为：只处理 current.json 已落后于本机日期的情况；旧日志先永久导出
 * WorkItem，未同步时转入 pending/<date>.json，然后创建当日日志。
 * 已同步旧日志按既定策略不额外备份 current.json。
 *
 * 该入口幂等且只做一次，适用于 Hook 采集与手工新增事项。
 */
function ensureCurrentDate(dir, actor) {
  const snapshot = readJSON(currentPath(dir), null);
  if (!snapshot || !snapshot.date || snapshot.date === today()) {
    return {
      action: 'none',
      date: snapshot ? snapshot.date : null,
      today: today(),
    };
  }

  const rolled = withLock(dir, () => {
    const latest = readJSON(currentPath(dir), null);
    if (!latest || !latest.date || latest.date === today()) return null;
    return checkDate(latest, dir, 'keep', actor);
  });

  if (!rolled) return { action: 'none', date: today(), today: today() };
  return Object.assign({ action: 'rolled_over' }, rolled);
}

/* ------------------------------------------------------------------ *
 * 运行状态、采集器与安全（§27-§31 / §42）
 * ------------------------------------------------------------------ */

function trackingStatus(dir) {
  const state = readJSON(statePath(dir), null) || defaultState();
  return VALID_TRACKING_STATUS.includes(state.tracking_status)
    ? state.tracking_status
    : 'initializing';
}

function shouldSkipAuto(dir, source, force) {
  if (force) return false;
  if (source === 'manual') return false;
  const status = trackingStatus(dir);
  if (status !== 'tracking') return `tracking_status=${status}`;
  const cfg = readConfig(dir);
  if (cfg.tracking.auto_tracking === false || cfg.tracking.enabled === false) {
    return 'auto_tracking_disabled';
  }
  return false;
}

const levelOf = (key) => ({
  level: key,
  emoji: STATUS_LEVEL[key].emoji,
  status_label: STATUS_LEVEL[key].label,
});

/**
 * 宿主触发状态（§57）。
 *
 * 必须区分三件事，不能因为 Skill 已安装就认为自动记录已启动：
 *   Skill 状态     —— 技能是否加载（由调用环境决定，脚本侧恒为已加载）
 *   宿主触发状态   —— Codex / WorkBuddy 是否配置了 Hook / Event / 自动任务来调用本 Skill
 *   日志记录状态   —— 最近是否真的产生了可写入的活动
 */
function hostStatuses(state, config, nowMs) {
  const registry = (state && state.hosts) || {};
  const idleMs = (config.tracking.idle_threshold_minutes || 30) * 60 * 1000;
  const hosts = AUTO_TOOLS.filter((h) => h !== 'other' || registry[h]);
  return hosts.map((host) => {
    const entry = registry[host] || null;
    const base = {
      host,
      tool: host,
      label: SOURCE_LABEL[host] || host,
      mechanism: entry ? entry.mechanism : null,
      available: entry ? entry.available : null,
      trigger_configured: entry ? entry.trigger_configured : null,
      last_activity_at: entry ? entry.last_activity_at : null,
      activity_count: entry ? entry.activity_count || 0 : 0,
    };
    if (!entry || !entry.mechanism || entry.mechanism === 'unknown') {
      return Object.assign(base, levelOf('unconfigured'), {
        trigger_configured: false,
        reason: '未配置宿主触发（未登记 Hook / Event / 自动任务）',
      });
    }
    if (entry.mechanism === 'unavailable' || entry.available === false) {
      return Object.assign(base, levelOf('error'), {
        trigger_configured: false,
        reason: '自动采集不可用',
      });
    }
    if (entry.mechanism === 'manual') {
      return Object.assign(base, levelOf('idle'), {
        trigger_configured: false,
        manual: true,
        reason: '仅支持手动触发，未配置宿主自动触发',
      });
    }
    if (config.tracking.auto_tracking === false || config.tracking.enabled === false) {
      return Object.assign(base, levelOf('off'), {
        trigger_configured: entry.trigger_configured !== false,
        reason: 'auto_tracking=false（配置未开启自动记录）',
      });
    }
    // §57：宿主触发确实未配置时，不得显示「已开启但暂无活动」，更不能说「已配置」
    if (entry.trigger_configured === false) {
      return Object.assign(base, levelOf('unconfigured'), {
        trigger_configured: false,
        reason: '宿主触发未配置（未接入 Hook / Event / 自动任务），等待手动触发',
      });
    }
    const last = entry.last_activity_at ? Date.parse(entry.last_activity_at) : NaN;
    const recent = Number.isFinite(last) && nowMs - last <= idleMs;
    return Object.assign(base, levelOf(recent ? 'recording' : 'idle'), {
      trigger_configured: true,
      reason: recent
        ? `最近活动于 ${entry.last_activity_at}`
        : entry.last_activity_at
        ? `最近活动于 ${entry.last_activity_at}，已超过空闲阈值`
        : '宿主触发已配置，暂未检测到活动',
    });
  });
}

/** 宿主触发汇总（§56「触发来源」） */
function hostTriggerSummary(hosts) {
  const configured = hosts.filter((h) => h.trigger_configured);
  const sources = configured.map((h) =>
    h.mechanism === 'hooks' ? `${h.label} Hook / Event` : `${h.label} Skill / Event`
  );
  return {
    configured: configured.length > 0,
    level: configured.length ? 'recording' : 'error',
    emoji: configured.length ? '🟢' : '🔴',
    label: configured.length ? '已配置' : '未配置',
    sources,
    text: sources.length ? sources.join(' / ') : '未配置宿主自动触发',
  };
}

/**
 * 完整状态判定（§28）。
 * 链路：配置 → Activity Adapter → 日志目录 → current.json → 最近 Activity → WorkItem
 */
function computeStatus(dir, options) {
  const opts = options || {};
  const nowMs = Date.now();
  const reasons = [];
  const config = readConfig(dir);
  const state = migrateState(readJSON(statePath(dir), null) || defaultState());
  const probe = probeDir(dir);

  if (!probe.exists) reasons.push(`日志目录不存在：${dir}`);
  else if (!probe.readable) reasons.push(`日志目录不可读：${dir}`);
  else if (!probe.writable) reasons.push(`日志目录不可写：${dir}`);

  const kind = manifestKind(dir);
  if (kind === 'foreign') reasons.push('该目录的 .log-manifest.json 不属于本技能');
  if (kind === 'unreadable') reasons.push('.log-manifest.json 无法解析');

  let log = null;
  try {
    log = readJSON(currentPath(dir), null);
  } catch (e) {
    reasons.push(`current.json 无法解析：${String(e.message || e)}`);
  }
  if (!log && probe.exists && kind !== 'none') reasons.push('current.json 不存在');

  const lock = lockInfo(dir);
  if (lock && !lock.stale) reasons.push(`存在未释放的文件锁（holder=${lock.holder || 'unknown'}）`);
  const spool = listSpool(dir);
  if (spool.length) reasons.push(`有 ${spool.length} 份写入失败待重放（pending/writes）`);

  const records = (log && log.records) || [];
  const pendingItems = (log && log.pending_items) || [];
  const lastRecord = records
    .map((r) => (toMinutes(r.end_time) !== null ? toMinutes(r.end_time) : toMinutes(r.start_time)))
    .filter((v) => v !== null)
    .sort((a, b) => b - a)[0];
  const active = records.filter((r) => r.status === 'in_progress');
  const hosts = hostStatuses(state, config, nowMs);
  const hostTrigger = hostTriggerSummary(hosts);

  const initialized = probe.exists && kind !== 'none' && kind !== 'foreign';
  const ts = trackingStatus(dir);
  const offReason =
    ts === 'paused'
      ? '已暂停自动记录（tracking_status=paused）'
      : ts === 'disabled'
      ? '已关闭自动记录（tracking_status=disabled）'
      : ts === 'initializing'
      ? '尚未完成初始化（tracking_status=initializing）'
      : 'auto_tracking=false（配置未开启自动记录）';
  let overall;
  if (!initialized) {
    overall = Object.assign(levelOf('off'), {
      reasons: reasons.length ? reasons : ['尚未完成初始化'],
    });
  } else if (reasons.length) {
    overall = Object.assign(levelOf('error'), { reasons });
  } else if (
    config.tracking.auto_tracking === false ||
    config.tracking.enabled === false ||
    ['paused', 'disabled', 'initializing'].includes(ts)
  ) {
    overall = Object.assign(levelOf('off'), { reasons: [offReason] });
  } else if (!hosts.some((h) => h.level === 'recording')) {
    // V3.21（用户 2026-09-26）：**部分宿主未接入必须点名**。
    //
    // 真实事故：WorkBuddy 侧 Hook 正常、Codex 侧 hooks 段被应用重写后丢失，
    // 于是 Codex 当天的记录全部静默消失，而状态页只显示「已开启但暂无活动」——
    // 用户只能每天手动排查。这里把「哪些宿主没接入」直接写成原因，
    // 并给出可执行的修复入口。
    const missingHosts = hosts
      .filter((h) => !h.trigger_configured && ['codex', 'workbuddy'].includes(h.host))
      .map((h) => h.label);
    const reasonsNow = [
      hostTrigger.configured ? '宿主触发已配置，暂未检测到活动' : '宿主触发未配置，等待手动触发',
    ];
    if (missingHosts.length) {
      reasonsNow.push(
        `⚠ ${missingHosts.join(' / ')} 未接入宿主触发 —— 该工具当天的记录会静默丢失；` +
          '修复：node scripts/ensure-codex-hooks.js --repair'
      );
    }
    overall = Object.assign(levelOf('idle'), { reasons: reasonsNow });
  } else {
    overall = Object.assign(levelOf('recording'), { reasons: [] });
  }

  const hhmmOf = (iso) => {
    const m = toMinutes(iso);
    return m === null ? null : fmtHHMM(m);
  };

  const out = {
    log_directory: dir,
    initialized,
    schema_version: SCHEMA_VERSION,
    // §57：三态必须分开表达
    skill: {
      loaded: true,
      emoji: '🟢',
      label: '已加载',
      note: '脚本已就绪；Skill 本身不是后台服务，不会自行运行（§43）',
    },
    host_trigger: hostTrigger,
    overall,
    checks: {
      config_found: fs.existsSync(configPath(dir)),
      log_directory_exists: probe.exists,
      log_directory_readable: probe.readable,
      log_directory_writable: probe.writable,
      manifest: kind,
      manifest_type: readManifest(dir).type || null,
      log_id: readManifest(dir).log_id || null,
      current_json_readable: Boolean(log),
      lock_held: Boolean(lock && !lock.stale),
      spool_pending: spool.length,
      auto_tracking: config.tracking.auto_tracking,
      tracking_status: ts,
      idle_threshold_minutes: config.tracking.idle_threshold_minutes,
      host_events_enabled: config.host_events.enabled,
      ai_enabled: config.ai.enabled,
      redact_sensitive: config.security.redact_sensitive,
    },
    hosts,
    today: {
      date: log ? log.date : today(),
      count: records.length,
      in_progress: active.length,
      needs_confirmation: records.filter((r) => r.status === 'needs_confirmation').length,
      pending_items: pendingItems.length,
    },
    last_record_time: lastRecord === undefined ? '暂无' : fmtHHMM(lastRecord),
    last_event_time: hhmmOf(state.last_event_time),
    last_write_time: hhmmOf(state.last_log_write_time),
    active_work_items: active.map((r) => ({ id: r.id, content: r.content, source: r.source })),
    sync: (log && log.sync) || { status: 'pending' },
    sync_skill: config.sync.skill,
    sync_modes: ['手动 /sync', '宿主定时任务'],
    summary_saved: Boolean(log && log.summary),
    summary_trigger: (log && log.summary && log.summary.trigger) || null,
    last_automatic_summary_date: state.last_automatic_summary_date || null,
    pending_sync_dates: state.pending_sync_dates || [],
    ai: aiUsage(dir),
    security: security.report(config.security),
  };
  if (opts.includeToday) {
    out.daily_log = log;
    out.timeline = log ? timeline(log) : [];
    out.stats = log ? buildStats(log) : null;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 输出与参数
 * ------------------------------------------------------------------ */

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function emitText(text) {
  process.stdout.write(`${text}\n`);
}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let val = null;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        val = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        val = argv[++i];
      } else {
        val = true;
      }
      if (flags[key] === undefined) flags[key] = val;
      else if (Array.isArray(flags[key])) flags[key].push(val);
      else flags[key] = [flags[key], val];
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function flagStr(flags, key) {
  const v = flags[key];
  if (v === undefined || v === true || v === null) return null;
  if (Array.isArray(v)) return String(v[v.length - 1]);
  return String(v);
}

function flagNum(flags, key) {
  const v = flagStr(flags, key);
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new LogError(`--${key} 需要数字，收到：${v}`);
  return n;
}

function flagList(flags, key) {
  const v = flags[key];
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== true).map(String);
}

function flagBool(flags, key) {
  const v = flags[key];
  return v === true || v === 'true' || v === '1' || v === 'yes';
}

/**
 * CLI 入口包装：统一处理 EPIPE、LogError 与退出码。
 *
 * @param {Function} fn 入口函数
 * @param {object} [callerModule] 调用方的 `module`（**必须是调用方自己的**）。
 *        传了它 → 只有「直接运行该脚本」时才执行 `fn()`；被 `require` 时只导出函数。
 *        不传 → 保持旧行为（无条件执行），兼容既有脚本。
 *
 * ⚠️ 为什么必须由调用方传入 module：
 *
 * ```text
 * 本函数住在 log-core.js 里，`module` 指向的是 **log-core 自己**，
 * 而不是入口脚本（init-log.js / daily-summary.js …）。
 * 若在这里写 `require.main !== module`，条件恒为真，
 * → **所有脚本的 CLI 全部变成空操作**（真实踩过：init 不建 current.json，
 *    整个测试套件从第 5 项开始崩）。
 * ```
 *
 * 因此需要「可被 require 复用」的脚本（目前是 export-work-activities.js）
 * 显式写 `C.runMain(fn, module)`，由它自己承担判定责任。
 */
function runMain(fn, callerModule) {
  if (callerModule && require.main !== callerModule) return; // 被 require：只导出函数
  process.stdout.on('error', (e) => {
    if (e.code === 'EPIPE') process.exit(0);
  });
  try {
    const code = fn();
    process.exitCode = typeof code === 'number' ? code : EXIT.OK;
  } catch (err) {
    if (err instanceof LogError) {
      emit({ error: err.message, code: err.code });
      process.exitCode = err.code;
    } else {
      emit({ error: String((err && err.stack) || err), code: EXIT.USAGE });
      process.exitCode = EXIT.USAGE;
    }
  }
}

module.exports = {
  CONFIG_VERSION,
  SCHEMA_VERSION,
  MANIFEST_TYPE,
  MANIFEST_VERSION,
  LEGACY_MANIFEST_TYPES,
  LEGACY_MANIFEST_FORMATS,
  SKILL_NAME,
  SYNC_SKILL,
  DEFAULT_TOOLS,
  AUTO_TOOLS,
  STATUS_LEVEL,
  VALID_STATUS,
  VALID_SOURCE,
  VALID_CONFIDENCE,
  VALID_SYNC_STATUS,
  VALID_TRACKING_STATUS,
  VALID_EVENT_TYPE,
  VALID_MECHANISM,
  VALID_AI_ROLE,
  VALID_DURATION_SOURCE,
  VALID_TICKTICK_FIELDS,
  MAX_TICKTICK_ID_LENGTH,
  MAX_CONTENT_LENGTH,
  LOCK_STALE_MS,
  LOCK_TIMEOUT_MS,
  LOCK_RETRY_INTERVAL_MS,
  sleepSync,
  LOCATOR_PATH,
  EXIT,
  LogError,
  security,
  pad,
  tzOffset,
  nowIso,
  today,
  nowMinutes,
  nowHHMM,
  parseHHMM,
  fmtHHMM,
  toMinutes,
  isHHMM,
  randomHex,
  sha1,
  makeId,
  makeActivityId,
  DEFAULT_WORK_TYPES,
  DEFAULT_PM_WORK_TYPES,
  DEFAULT_WORK_CATEGORIES,
  DEFAULT_EXPLORATION_PROJECTS,
  DEFAULT_PROJECT_STAGES,
  UNASSIGNED_PROJECT_LABEL,
  buildDisplayContent,
  normalizeItem,
  normalizeTicktick,
  normalizeContentCompression,
  normalizeDetailCompression,
  parseDisplayInput,
  suggestProject,
  suggestWorkType,
  suggestProjectStage,
  suggestCategory,
  normalizeWorkEnums,
  WORK_TYPE_HINTS,
  PROJECT_STAGE_HINTS,
  CATEGORY_HINTS,
  projectFromCwd,
  readHostProjects,
  readSessionProjectIndex,
  projectFromSession,
  matchHostProject,
  lastNameSegment,
  projectNameFromDir,
  isMeaningfulSegment,
  groupByProject,
  readJSON,
  atomicWriteJSON,
  manifestPath,
  currentPath,
  configPath,
  statePath,
  spoolDir,
  manifestKind,
  isOurDir,
  readManifest,
  normalizeConfig,
  readConfig,
  autoAnalysisEnabled,
  defaultState,
  migrateState,
  emptyDailyLog,
  readState,
  loadLocator,
  saveLocator,
  resolveDir,
  ensureWritable,
  probeDir,
  lockPath,
  lockInfo,
  withLock,
  segMinutes,
  closeOpenSegments,
  openSegmentAt,
  effectiveSegments,
  recalc,
  unionMinutes,
  overlapsOf,
  SOURCE_LABEL,
  STATUS_LABEL,
  STATUS_ICON,
  recordSpan,
  timeline,
  buildStats,
  findRecords,
  findPendingItem,
  resolveOne,
  // V3.23：pending/<date>.json 的定位与写回（已跨日事项的 link / sync 通路）
  pendingDir,
  pendingLogPath,
  listPendingLogDates,
  readPendingLog,
  writePendingLog,
  resolveWorkItemAnywhere,
  patchPendingWorkItem,
  setPendingSyncStatus,
  applyOp,
  spoolOps,
  listSpool,
  migrateLog,
  syncState,
  runMutation,
  mutateState,
  aiUsage,
  consumeAiCall,
  checkDate,
  ensureCurrentDate,
  trackingStatus,
  shouldSkipAuto,
  hostStatuses,
  hostTriggerSummary,
  computeStatus,
  emit,
  emitText,
  parseArgs,
  flagStr,
  flagNum,
  flagList,
  flagBool,
  runMain,
};
