'use strict';
/**
 * activity-engine.js — 本地规则引擎（§18/§19/§20/§32-§35）。
 *
 * 职责：在**不调用 AI** 的前提下尽量把 Activity 判定到已有 WorkItem；
 * 无法判定时写入 pending_items，等待宿主再次触发时做一次批量分析。
 *
 *   Activity
 *      ↓ 本地规则匹配（本模块）
 *      ├── 高置信度匹配 → 更新已有 WorkItem（零 Token）
 *      ├── 新主题       → 交由 AI 判断是否新建
 *      └── 低置信度     → pending_items，等待确认（§20）
 *
 * 同时提供 Activity Hash / Context Hash / 判断缓存所需结构（§32「缓存结果」）。
 * 注意：本模块**不含任何定时器** —— 批量窗口只是"宿主再次触发时是否合并分析"的判据（§34）。
 */

const crypto = require('crypto');

/** 默认阈值（可被 config.ai.auto_analysis 覆盖） */
const DEFAULTS = {
  /** §34：批量窗口。不是"每 N 分钟运行一次" */
  batch_interval_minutes: 20,
  /** §34：避免同一宿主运行链路中短时间重复调用 AI */
  cooldown_minutes: 10,
  /** §34：单次批量分析最多携带的条目 */
  max_context_items: 20,
  /** §33：待判断条数达阈值即建议分析 */
  batch_max_pending: 5,
  /** §32：缓存判断结果 */
  enable_cache: true,
};

/** 从 config 中取出 auto_analysis 段，兼容旧版 auto_task 与平铺写法 */
function aiConfigOf(config) {
  const ai = (config && config.ai) || {};
  const auto = ai.auto_analysis || ai.auto_task || ai;
  const pick = (key, fallback) => (auto[key] === undefined ? fallback : auto[key]);
  return Object.assign({}, DEFAULTS, {
    batch_interval_minutes: Number(pick('batch_interval_minutes', DEFAULTS.batch_interval_minutes)),
    cooldown_minutes: Number(pick('cooldown_minutes', DEFAULTS.cooldown_minutes)),
    max_context_items: Number(pick('max_context_items', DEFAULTS.max_context_items)),
    batch_max_pending: Number(pick('batch_max_pending', DEFAULTS.batch_max_pending)),
    enable_cache: Boolean(pick('enable_cache', DEFAULTS.enable_cache)),
  });
}

/**
 * §3.1 第 5 步「判断是否属于工作活动」。
 *
 * 宿主 Hook 会在**每条**用户消息上触发（UserPromptSubmit）。若不先做这一步，
 * 寒暄、确认、测试输入会全部堆进 pending_items，造成日志噪声。纯本地判定，零 Token。
 *
 * 注意：以 `$` 锚定整串，避免把「你好，帮我完善GPU需求」这类真实工作指令误判为非工作。
 */
const NON_WORK_PATTERNS = [
  {
    // 宿主生成的系统通知（任务完成回执、后台命令输出）会经 UserPromptSubmit 通道进来，
    // 形如 <task-notification>…<tool-use-id>…<status>completed</status>，不是用户输入
    re: /^\s*<[a-zA-Z][\w-]*>|<\/[a-zA-Z][\w-]*>|<(?:task-notification|tool-use-id|status|summary|task-id)\b/i,
    reason: '宿主系统通知（非用户输入）',
  },
  {
    re: /^(?:hi|hello|hey|yo|你好|您好|在吗|在么|哈喽|嗨|早上好|晚上好|下午好)[\s。.!！?？~、,，]*$/i,
    reason: '寒暄',
  },
  { re: /^(?:谢谢|多谢|感谢|thanks|thank you|thx|3q)[\s。.!！~]*$/i, reason: '致谢' },
  {
    re: /^(?:好的?|嗯+|哦+|ok|okay|k|收到|明白|了解|可以|行|没问题|继续)\s*[。.!！?？~]*$/i,
    reason: '确认或应答',
  },
  {
    re: /^(?:测试|test|testing|test123|asdf+|aaa+|123+|abc)[\s。.!！]*$/i,
    reason: '测试性输入',
  },
  { re: /^[/／][\w-]+(?:\s.*)?$/, reason: '斜杠命令本身（由命令通道处理）' },
];

function isWorkActivity(content) {
  const text = String(content || '').trim();
  // 先做模式匹配再判长度，这样「你好」「ok」能给出更具体的原因
  for (const p of NON_WORK_PATTERNS) {
    if (p.re.test(text)) return { work: false, reason: `非工作性输入：${p.reason}` };
  }
  if (text.length < 4) return { work: false, reason: '内容过短，不足以构成工作事项' };
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(text)) {
    return { work: false, reason: '不含文字内容（仅符号或表情）' };
  }
  return { work: true, reason: '通过本地工作活动判定' };
}

/** §20 安全阀：待判断队列上限，避免宿主高频触发导致无界增长 */
const PENDING_HARD_CAP = 50;

/** 中文按 2-gram 切分，英文/数字按词切分；用于本地相似度判断 */
const STOPWORDS = new Set([
  '的', '了', '和', '与', '及', '在', '是', '我', '你', '他', '她', '它', '这', '那', '个', '把',
  '帮', '请', '一下', '继续', '然后', '以及', '看看', '我们', '他们', 'the', 'a', 'an', 'to', 'of',
  'and', 'or', 'for', 'in', 'on', 'is', 'are', 'please', 'help', 'me', 'with',
]);

function tokenize(text) {
  const src = String(text || '').toLowerCase();
  const tokens = new Set();
  for (const word of src.match(/[a-z0-9_]{2,}/g) || []) {
    if (!STOPWORDS.has(word)) tokens.add(word);
  }
  for (const run of src.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (run.length === 1) {
      if (!STOPWORDS.has(run)) tokens.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const gram = run.slice(i, i + 2);
      if (!STOPWORDS.has(gram)) tokens.add(gram);
    }
  }
  return tokens;
}

function sharedTokens(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const shared = [];
  for (const t of ta) if (tb.has(t)) shared.push(t);
  return shared;
}

/** Jaccard 相似度，仅用于排序与提示，不作为唯一判据 */
function similarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

const sha1 = (s) => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex');

/** §32 去重键：timestamp + source + event_type + content */
function activityHash(activity) {
  return sha1(
    [activity.timestamp, activity.source, activity.event_type, activity.content].join('|')
  );
}

/** 上下文 Hash：当前 WorkItem + 待判断项 + 当前上下文 */
function contextHash(context) {
  return sha1(JSON.stringify(context));
}

const pendingOf = (log) => (log && log.pending_items) || [];
const pendingHashes = (log) => pendingOf(log).map((p) => p.hash).filter(Boolean);

/**
 * 构造批量 AI 的最小上下文（§36）。
 * 只提供必要结构化信息，**不得发送完整 DailyLog / 聊天记录 / 完整文件内容**。
 */
function buildBatchContext(log, aiCfg) {
  const cfg = Object.assign({}, DEFAULTS, aiCfg || {});
  const max = cfg.max_context_items;
  const items = (log.records || [])
    .filter((r) => ['in_progress', 'paused', 'needs_confirmation'].includes(r.status))
    .slice(-Math.max(3, Math.floor(max / 2)))
    .map((r) => ({
      id: r.id,
      content: r.content,
      // §15：项目与工作类型是归属判断的关键线索，必须一并提供给 AI
      project_name: r.project_name || null,
      work_type: r.work_type || null,
      status: r.status,
      start_time: r.start_time,
    }));
  const pending = pendingOf(log)
    .slice(0, max)
    .map((p) => ({
      hash: p.hash || p.id,
      timestamp: p.time || p.timestamp,
      source: p.source,
      content: p.content,
      confidence: p.confidence || 'low',
      suspected_new_topic: Boolean(p.suspected_new_topic),
    }));
  return {
    recent_work_items: items,
    pending_items: pending,
    note: '仅提供必要结构化信息；不得发送完整聊天记录、完整 AI 回复、完整文件内容（§36）。',
  };
}

function isFreshCache(entry, maxAgeMinutes) {
  if (!entry || !entry.analyzed_at) return false;
  if (!maxAgeMinutes) return true;
  const age = Date.now() - Date.parse(entry.analyzed_at);
  return Number.isFinite(age) && age <= maxAgeMinutes * 60 * 1000;
}

/**
 * 本地匹配（零 Token）。§18 匹配顺序：
 *   Activity → 当前进行中的 WorkItem → 最近暂停的 WorkItem → 语义/上下文匹配
 *   → 高置信度新事项 → 低置信度 Pending
 *
 * 返回 decision：attach（可直接归属）| queue（写入 pending_items）
 */
function localMatch(log, activity, aiCfg) {
  const cfg = Object.assign({}, DEFAULTS, aiCfg || {});
  const hash = activity.hash || activityHash(activity);

  // ① §32 缓存：相同活动直接复用上次判断
  if (cfg.enable_cache && log.judgments && log.judgments[hash]) {
    const cached = log.judgments[hash];
    const target = (log.records || []).find((r) => r.id === cached.matched_work_item);
    if (target) {
      return {
        decision: 'attach',
        work_item_id: target.id,
        confidence: cached.confidence || 'high',
        via: 'cache',
        reason: '命中判断缓存，未重复调用 AI（§32）',
      };
    }
  }

  const records = log.records || [];
  const inProgress = records.filter((r) => r.status === 'in_progress');

  // ② 当前进行中的 WorkItem：只有一个时按本地语义判断
  if (inProgress.length === 1) {
    const target = inProgress[0];
    const shared = sharedTokens(activity.content, target.content);
    if (shared.length) {
      return {
        decision: 'attach',
        work_item_id: target.id,
        confidence: shared.length >= 2 ? 'high' : 'medium',
        via: 'local_match',
        reason: `与当前进行中事项共享关键词：${shared.slice(0, 5).join('、')}`,
      };
    }
    return {
      decision: 'queue',
      confidence: 'low',
      via: 'local_match',
      suspected_new_topic: true,
      reason: '与当前进行中事项无关键词交集，疑似新工作主题（§19）',
      candidate_work_item: target.id,
    };
  }

  // ③ 多个进行中事项 → 本地无法判定，交批量分析
  if (inProgress.length > 1) {
    return {
      decision: 'queue',
      confidence: 'medium',
      via: 'local_match',
      ambiguous_work_items: inProgress.map((r) => r.id),
      reason: `当前有 ${inProgress.length} 个进行中事项，本地无法判定归属`,
    };
  }

  // ④ 最近暂停的 WorkItem
  const paused = records
    .filter((r) => r.status === 'paused')
    .sort((a, b) =>
      String(b.updated_at || b.start_time || '').localeCompare(
        String(a.updated_at || a.start_time || '')
      )
    );
  for (const target of paused.slice(0, 3)) {
    const shared = sharedTokens(activity.content, target.content);
    if (shared.length) {
      return {
        decision: 'attach',
        work_item_id: target.id,
        resume: true,
        confidence: 'medium',
        via: 'local_match',
        reason: `与最近暂停事项共享关键词：${shared.slice(0, 5).join('、')}`,
      };
    }
  }

  // ⑤ 低置信度 → pending_items
  return {
    decision: 'queue',
    confidence: 'low',
    via: 'local_match',
    suspected_new_topic: true,
    reason: '无法匹配任何现有事项，需 AI 判断是否为新工作主题（§18/§20）',
  };
}

/**
 * 是否需要建议执行批量 AI 分析（§33/§34）。
 * 注意：仅返回"建议"，**不会启动任何计时器**（§34）。
 */
function shouldFlush(log, aiCfg, nowMs) {
  const cfg = Object.assign({}, DEFAULTS, aiCfg || {});
  const pending = pendingOf(log);
  const reasons = [];
  if (!pending.length) return { should: false, reasons: [], pending_count: 0 };

  if (pending.length >= cfg.batch_max_pending) {
    reasons.push(`待判断事项达到 ${cfg.batch_max_pending} 条`);
  }
  const windowMin = cfg.batch_interval_minutes;
  const oldest = pending
    .map((p) => Date.parse(p.detected_at || p.timestamp || 0))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b)[0];
  const now = nowMs === undefined ? Date.now() : nowMs;
  if (oldest && now - oldest >= windowMin * 60 * 1000) {
    reasons.push(`最早的待判断事项已超过 ${windowMin} 分钟批量窗口`);
  }
  if (pending.some((p) => p.suspected_new_topic)) reasons.push('检测到疑似新工作主题');

  return { should: reasons.length > 0, reasons, pending_count: pending.length };
}

module.exports = {
  DEFAULTS,
  PENDING_HARD_CAP,
  NON_WORK_PATTERNS,
  isWorkActivity,
  aiConfigOf,
  tokenize,
  sharedTokens,
  similarity,
  activityHash,
  contextHash,
  pendingOf,
  pendingHashes,
  buildBatchContext,
  isFreshCache,
  localMatch,
  shouldFlush,
};
