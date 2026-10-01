'use strict';
/**
 * metrics-engine.js — 每日复盘 / 周期分析的**只读汇总层**（V3.5）。
 *
 * ## 核心纪律（用户 §十二）：只读 Structured Logs，绝不重算
 *
 * ```text
 * ✗ 错误：每日复盘 → 重新扫描历史 Conversation → 重新解析 Skill / 重算 Token / 重算 Score
 * ✓ 正确：每日复盘 → 读取 Structured Logs → 汇总
 * ```
 *
 * Token 与 Score 在**对话结束那一刻**就已由脚本结算并落盘（`settle-conversation.js`）。
 * 本模块只做 `sum / group / join`，因此：零 LLM 调用、零 token 成本、
 * 结果与「当时结算的值」永远一致、复盘可随时重跑而不会影响数据。
 *
 * **物理约束**：本模块只允许依赖 `conversation-store`（读 `logs/`），
 * 不得 require 解析器 —— 这条线由 `test-egress-guard.js` 与
 * `test-conversation-settlement.js` 静态守住。
 *
 * ## 关联规则（用户 §十二 / 首轮 §20）
 *
 * ```text
 * 项目 → 工作事项 → Conversation → Skill → Token / Score
 * ```
 *
 * **只在有显式关联时才生成**（Work Activity 上非空的 `conversation_id`）。
 * 没有关联就不推断；一个 Conversation 若被两个项目共同引用，则无法归属到单一项目 ——
 * 这类归入 `ambiguous`，不硬分给任何一方。
 */

const CS = require('./conversation-store');
const C = require('./log-core');
const SKR = require('./skill-receipt');

/** `null` = 不可获取（非 0） */
const U = CS.NA;

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

/** 把 sumField 的结果转成标量（无任何已知值时为 null） */
function tokenText(stat) {
  if (stat.unknown && !stat.known) return U;
  return stat.value;
}

/**
 * countBy 的展示友好版：`null` 显示为业务含义，而不是裸 null。
 */
function countByLabeled(records, field, nullLabel) {
  const out = {};
  for (const r of records) {
    const k = CS.isUnavailable(r[field]) ? nullLabel : String(r[field]);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** 秒 → 分钟（展示用）；null 透传 */
const toMinutes = (sec) => (typeof sec === 'number' ? Math.round(sec / 60) : U);

/* ------------------------------------------------------------------ *
 * V3.3：AI 成本多维聚合（Skill / 工作类型 / 项目 / 项目阶段）
 * ------------------------------------------------------------------ */

/** 占比：任一侧不可获取时返回 null（**不是 0%**） */
function shareOf(value, total) {
  if (typeof value !== 'number' || typeof total !== 'number' || !total) return U;
  return Number(((value / total) * 100).toFixed(1));
}

const numList = (arr) => arr.filter((v) => typeof v === 'number' && Number.isFinite(v));

/**
 * Skill 成本统计（用户 §5/§13/§14/§15）。
 *
 * ```text
 * 调用次数  累计 Token  累计积分  平均单次 Token  平均单次积分
 * 最近一次 Token/积分   最大单次 Token   最小单次 Token   Token 占比
 * ```
 *
 * ⚠️ **积分（Score）在 Skill 维度一律为 `null`**：宿主只提供会话级 credit，
 * 不存在 Skill 级积分。按比例把会话积分摊给 Skill 属于**估算**，明令禁止
 * （用户 §5「禁止估算」/§6）。因此这里写 `null` + `score_source: 'unavailable'`，
 * 并给出 `unavailable_reason` 说明原因 —— 而不是写 0。
 *
 * Token 用 **A 口径**（`skill_token` = Skill 载入体积），这是唯一可精确归因的部分。
 */
function buildSkillCost(skillUsages, conversationTokenTotal, activities, aiUsages) {
  const activityIdsBySkill = new Map();
  const bumpActivitySkill = (skill, activityId) => {
    if (!skill || !activityId) return;
    if (!activityIdsBySkill.has(skill)) activityIdsBySkill.set(skill, new Set());
    activityIdsBySkill.get(skill).add(String(activityId));
  };
  for (const a of activities || []) {
    for (const skill of a.skills || []) bumpActivitySkill(String(skill), a.activity_id);
  }
  for (const u of aiUsages || []) {
    if (!u.activity_id) continue;
    for (const skill of u.skills || []) bumpActivitySkill(String(skill), u.activity_id);
  }
  const byKey = new Map();
  for (const s of skillUsages || []) {
    const key = `${s.skill_id}@${s.skill_version}`;
    if (!byKey.has(key)) {
      byKey.set(key, {
        skill_id: s.skill_id,
        skill_version: s.skill_version ?? U,
        invocations: 0,
        failed: 0,
        tokens: [],
        token_unavailable: 0,
        load_chars: 0,
        // 有多少次调用真的提供了载入字符（P2-5）。
        // 为什么需要：codex 通道全部缺该字段，若只看 load_chars 总数，
        // 会误以为「这个 Skill 载入很轻」，实际是「一半样本没数据」。
        load_chars_known: 0,
        conversations: new Set(),
        last_at: U,
        last_token: U,
      });
    }
    const a = byKey.get(key);
    a.invocations += 1;
    if (s.status === 'failed') a.failed += 1;
    if (typeof s.skill_token === 'number') {
      a.tokens.push(s.skill_token);
      // 「最近一次」按调用时间取，与区间内排序无关
      const at = s.start_time || s.end_time || U;
      if (at && (a.last_at === U || String(at) > String(a.last_at))) {
        a.last_at = at;
        a.last_token = s.skill_token;
      }
    } else {
      a.token_unavailable += 1;
    }
    if (typeof s.load_chars === 'number') {
      a.load_chars += s.load_chars;
      a.load_chars_known += 1;
    }
    if (s.conversation_id) a.conversations.add(String(s.conversation_id));
  }

  const rows = [...byKey.values()].map((a) => {
    const nums = numList(a.tokens);
    const total = nums.length ? nums.reduce((x, y) => x + y, 0) : U;
    return {
      skill_id: a.skill_id,
      skill_version: a.skill_version,
      invocations: a.invocations,
      failed: a.failed,
      // —— Token（A 口径，可精确归因）——
      total_token: total,
      avg_token: total === U ? U : Number((total / a.invocations).toFixed(1)),
      max_token: nums.length ? Math.max(...nums) : U,
      min_token: nums.length ? Math.min(...nums) : U,
      last_token: a.last_token,
      // 「最近一次调用时间」—— 内部一直在算（a.last_at），但此前没暴露出来，
      // 导致洞察报告里「最近一次」恒为「不可获取」。V3.6 补上。
      last_at: a.last_at,
      token_known: nums.length,
      token_unavailable: a.token_unavailable,
      // —— 载入字符（A 口径原始值，P2-5）——
      //   `load_chars` 是「这个 Skill 的文档有多长」，与调用了多少次无关；
      //   `avg_load_chars` 才是「平均每次调用读进去多少」。
      //   两者必须分开呈现：只有总数看不出「低频但单次极重」的 Skill。
      load_chars: a.load_chars,
      // 仅当**至少一次**调用提供了载入字符时才给平均值；
      // 一次都没有时是 null（不可获取），不是 0 —— 0 会被读成「载入量为零」。
      avg_load_chars: a.load_chars > 0 && a.invocations > 0
        ? Number((a.load_chars / a.invocations).toFixed(1))
        : U,
      load_chars_known: a.load_chars_known,
      conversation_count: a.conversations.size,
      activity_count: (activityIdsBySkill.get(String(a.skill_id)) || new Set()).size,
      activity_ids: [...(activityIdsBySkill.get(String(a.skill_id)) || new Set())].slice(0, 50),
      // —— Score（不可获取，禁止估算）——
      total_score: U,
      avg_score: U,
      score_source: 'unavailable',
      unavailable_reason:
        '宿主不提供 Skill 级积分；按会话积分比例摊派属于估算，明令禁止（用户 §5/§6）',
      token_share_of_conversations: shareOf(total === U ? U : total, conversationTokenTotal),
    };
  });

  // 载入体积合计（只加可归因的部分；全不可归因时是 null 而不是 0）
  const knownRows = rows.filter((r) => typeof r.total_token === 'number');
  const loadTokenTotal = knownRows.length ? knownRows.reduce((x, r) => x + r.total_token, 0) : U;

  // 版本对比（用户 §15）：同一 Skill 的不同版本「平均单次 Token」对照
  const bySkillId = new Map();
  for (const r of rows) {
    if (!bySkillId.has(r.skill_id)) bySkillId.set(r.skill_id, []);
    bySkillId.get(r.skill_id).push(r);
  }
  const versionComparison = [...bySkillId.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([skillId, list]) => ({
      skill_id: skillId,
      versions: list
        .slice()
        .sort((a, b) => String(a.skill_version).localeCompare(String(b.skill_version)))
        .map((r) => ({
          skill_version: r.skill_version,
          invocations: r.invocations,
          avg_token: r.avg_token,
          total_token: r.total_token,
        })),
      note: '版本间平均单次 Token 的差异仅供参考，未做任何显著性/因果推断（用户 §15）。',
    }));

  return {
    invocations: (skillUsages || []).length,
    total_token: loadTokenTotal,
    total_score: U,
    score_source: 'unavailable',
    token_share_of_conversations: shareOf(loadTokenTotal, conversationTokenTotal),
    by_skill: rows.sort((a, b) => {
      const au = a.total_token === U ? 1 : 0;
      const bu = b.total_token === U ? 1 : 0;
      if (au !== bu) return au - bu;
      if (!au && b.total_token !== a.total_token) return b.total_token - a.total_token;
      return b.invocations - a.invocations;
    }),
    version_comparison: versionComparison,
    notes: [
      '累计 Token 为 A 口径（Skill 载入体积），可精确归因；载入失败或口径关闭时记 null，不做摊派。',
      'Skill 级积分**不可获取**（宿主只提供会话级 credit）→ 一律 null，禁止按比例拆分会话积分。',
    ],
  };
}

/**
 * 把 Work Activity 的时间与 AI 成本归因到某个维度（用户 §7/§13/§14）。
 *
 * ## 归因铁律
 *
 * ```text
 * ✓ 只用记录里**已存在**的 conversation_id 关联
 * ✗ 不推断关联（没有 conversation_id 就没有成本归属）
 * ✗ 一个对话被同一维度的多个取值引用 → 该对话**不计入任何一方**（ambiguous）
 * ```
 *
 * 时间照常统计（时间属于事项本身，不依赖会话关联）；
 * Token / Score 只在**无歧义**的会话上求和，且每个会话只计一次。
 *
 * @param {Array} activities 区间内的 Work Activity
 * @param {Array} conversations 区间内的 Conversation
 * @param {(a:object)=>string|null} keyFn 维度取值函数
 */
function attributeDimension(activities, conversations, keyFn) {
  const convById = new Map(conversations.map((c) => [String(c.conversation_id), c]));
  const linked = (activities || []).filter(
    (a) => a.conversation_id && convById.has(String(a.conversation_id))
  );

  // 同一对话在本维度上映射到多个取值 → 该对话在本维度不可归属
  const convKeys = new Map();
  for (const a of linked) {
    const cid = String(a.conversation_id);
    if (!convKeys.has(cid)) convKeys.set(cid, new Set());
    convKeys.get(cid).add(keyFn(a) ?? '（未标注）');
  }

  const buckets = new Map();
  const ambiguous = [];
  const bump = (key) => {
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        activities: 0,
        minutes: 0,
        open_ended: 0,
        conversations: new Set(),
        ambiguous_conversations: new Set(),
        token: 0,
        token_known: 0,
        token_unknown: 0,
        score: 0,
        score_known: 0,
        score_unknown: 0,
        without_conversation: 0,
        outputs: [],
        titles: [],
      });
    }
    return buckets.get(key);
  };

  for (const a of activities || []) {
    const key = keyFn(a) ?? '（未标注）';
    const b = bump(key);
    b.activities += 1;
    b.minutes += Number(a.duration_minutes) || 0;
    if (!a.end_time) b.open_ended += 1;
    if (a.content) b.titles.push(a.content);
    if (a.output) b.outputs.push(a.output);    const cid = a.conversation_id ? String(a.conversation_id) : null;
    if (!cid || !convById.has(cid)) {
      // 人工事项 / 未关联会话：时间算，成本**不可归属**（不摊派）
      b.without_conversation += 1;
      continue;
    }
    if ((convKeys.get(cid) || new Set()).size > 1) {
      b.ambiguous_conversations.add(cid);
      ambiguous.push({ key, conversation_id: cid });
      continue;
    }
    if (b.conversations.has(cid)) continue; // 一个对话只计一次
    b.conversations.add(cid);
    const conv = convById.get(cid);
    if (typeof conv.total_token === 'number') {
      b.token += conv.total_token;
      b.token_known += 1;
    } else {
      b.token_unknown += 1;
    }
    if (typeof conv.total_score === 'number') {
      b.score += conv.total_score;
      b.score_known += 1;
    } else {
      b.score_unknown += 1;
    }
  }

  const rows = [...buckets.values()].map((b) => ({
    key: b.key,
    activities: b.activities,
    minutes: b.minutes,
    open_ended: b.open_ended,
    conversation_count: b.conversations.size,
    ambiguous_conversation_count: b.ambiguous_conversations.size,
    without_conversation: b.without_conversation,
    // 没有任何可归属会话时记 null（**不是 0** —— 0 表示「真实观察到零消耗」）
    total_token: b.token_known ? b.token : U,
    total_score: b.score_known ? CS.round2(b.score) : U,
    token_known: b.token_known,
    token_unknown: b.token_unknown,
    score_known: b.score_known,
    score_unknown: b.score_unknown,
    outputs: b.outputs,
    // 标题只留前 50 条（长区间下避免 JSON 体积膨胀；明细仍在结构化日志里）
    titles: b.titles.slice(0, 50),
  }));

  rows.sort((a, b) => {
    const at = typeof a.total_token === 'number' ? a.total_token : -1;
    const bt = typeof b.total_token === 'number' ? b.total_token : -1;
    if (at !== bt) return bt - at;
    return b.minutes - a.minutes;
  });

  return {
    rows,
    ambiguous: [...new Map(ambiguous.map((x) => [`${x.key}|${x.conversation_id}`, x])).values()],
    rule:
      '只使用记录中已存在的 conversation_id 关联；一个对话在同一维度被多个取值引用时，' +
      '该对话不计入任何一方的 Token/Score（不推断、不摊派）。',
  };
}

/**
 * 按 AI Usage Record 精确聚合某个维度。
 *
 * 与 `attributeDimension` 的区别：
 *   - `attributeDimension` 是旧的会话级口径，只做全有/全无归属；
 *   - 本函数只消费明确写的 AI Usage，不拆分 Conversation 总量。
 */
function allocatedDimension(aiUsages, activities, keyFn) {
  const activityById = new Map(
    (activities || []).map((a) => [String(a.activity_id), a])
  );
  const rows = new Map();
  for (const u of aiUsages || []) {
    if (u.attribution_status === 'unallocated' || !u.activity_id) continue;
    const a = activityById.get(String(u.activity_id));
    if (!a) continue;
    const key = keyFn(a) ?? '（未标注）';
    if (!rows.has(key)) {
      rows.set(key, {
        key,
        records: 0,
        activities: new Set(),
        token: 0,
        token_known: 0,
        credit: 0,
        credit_known: 0,
      });
    }
    const r = rows.get(key);
    r.records += 1;
    r.activities.add(String(a.activity_id));
    if (typeof u.total_token === 'number') {
      r.token += u.total_token;
      r.token_known += 1;
    }
    if (typeof u.credit === 'number') {
      r.credit += u.credit;
      r.credit_known += 1;
    }
  }
  return [...rows.values()]
    .map((r) => ({
      key: r.key,
      records: r.records,
      activities: r.activities.size,
      total_token: r.token_known ? r.token : U,
      total_credit: r.credit_known ? CS.round2(r.credit) : U,
    }))
    .sort((a, b) => {
      const at = typeof a.total_token === 'number' ? a.total_token : -1;
      const bt = typeof b.total_token === 'number' ? b.total_token : -1;
      return bt - at;
    });
}

/**
 * V3.5 AI Usage 归属视图。
 *
 * Conversation 总量是唯一总账；这里只回答“其中有多少已有精确事项归属，
 * 有多少仍无法归属”。禁止把未归属部分按项目或主题比例摊派。
 */
function buildAiUsageStats(aiUsages, segments, activities, conversations) {
  const list = aiUsages || [];
  const allocated = list.filter((u) => u.attribution_status !== 'unallocated');
  const unallocatedRecords = list.filter((u) => u.attribution_status === 'unallocated');
  const allocatedToken = CS.sumField(allocated, 'total_token');
  const allocatedCredit = CS.sumField(allocated, 'credit');
  const unallocatedRecordToken = CS.sumField(unallocatedRecords, 'total_token');
  const unallocatedRecordCredit = CS.sumField(unallocatedRecords, 'credit');
  const conversationToken = CS.sumField(conversations || [], 'total_token');
  const conversationCredit = CS.sumField(conversations || [], 'total_score');
  const allocatedTokenTotal =
    allocated.length === 0
      ? 0
      : typeof allocatedToken.value === 'number'
        ? allocatedToken.value
        : U;
  const allocatedCreditTotal =
    allocated.length === 0
      ? 0
      : typeof allocatedCredit.value === 'number'
        ? CS.round2(allocatedCredit.value)
        : U;
  const conversationTokenTotal =
    typeof conversationToken.value === 'number' ? conversationToken.value : U;
  const conversationCreditTotal =
    typeof conversationCredit.value === 'number' ? CS.round2(conversationCredit.value) : U;
  const unallocatedToken =
    typeof conversationTokenTotal === 'number' && typeof allocatedTokenTotal === 'number'
      ? Math.max(0, conversationTokenTotal - allocatedTokenTotal)
      : U;
  const unallocatedCredit =
    typeof conversationCreditTotal === 'number' && typeof allocatedCreditTotal === 'number'
      ? CS.round2(Math.max(0, conversationCreditTotal - allocatedCreditTotal))
      : U;
  const allocatedActivityIds = new Set(
    allocated.filter((u) => u.activity_id).map((u) => String(u.activity_id))
  );
  const allocatedConversationIds = new Set(
    allocated.map((u) => String(u.conversation_id)).filter(Boolean)
  );
  const overAllocated =
    typeof conversationTokenTotal === 'number' &&
    typeof allocatedTokenTotal === 'number' &&
    allocatedTokenTotal > conversationTokenTotal;

  return {
    records: list.length,
    by_status: {
      exact: list.filter((u) => u.attribution_status === 'exact').length,
      partial: list.filter((u) => u.attribution_status === 'partial').length,
      unallocated: unallocatedRecords.length,
    },
    allocated_token: allocatedTokenTotal,
    allocated_credit: allocatedCreditTotal,
    unallocated_token: unallocatedToken,
    unallocated_credit: unallocatedCredit,
    explicit_unallocated_record_token:
      typeof unallocatedRecordToken.value === 'number' ? unallocatedRecordToken.value : U,
    explicit_unallocated_record_credit:
      typeof unallocatedRecordCredit.value === 'number'
        ? CS.round2(unallocatedRecordCredit.value)
        : U,
    allocated_token_share: shareOf(allocatedTokenTotal, conversationTokenTotal),
    allocated_credit_share: shareOf(allocatedCreditTotal, conversationCreditTotal),
    coverage: {
      activities: (activities || []).length,
      activities_with_usage: allocatedActivityIds.size,
      segments: (segments || []).length,
      conversations: (conversations || []).length,
      conversations_with_allocated_usage: allocatedConversationIds.size,
    },
    by_activity: [...allocated.reduce((m, u) => {
      if (!u.activity_id) return m;
      const key = String(u.activity_id);
      if (!m.has(key)) {
        m.set(key, {
          activity_id: key,
          segment_id: u.segment_id || null,
          token: 0,
          token_known: 0,
          credit: 0,
          credit_known: 0,
          skills: new Set(),
          models: new Set(),
        });
      }
      const row = m.get(key);
      if (typeof u.total_token === 'number') {
        row.token += u.total_token;
        row.token_known += 1;
      }
      if (typeof u.credit === 'number') {
        row.credit += u.credit;
        row.credit_known += 1;
      }
      for (const s of u.skills || []) row.skills.add(s);
      for (const model of u.models || []) row.models.add(model);
      return m;
    }, new Map()).values()].map((r) => ({
      activity_id: r.activity_id,
      segment_id: r.segment_id,
      total_token: r.token_known ? r.token : U,
      total_credit: r.credit_known ? CS.round2(r.credit) : U,
      skills: [...r.skills],
      models: [...r.models],
    })),
    over_allocated: overAllocated,
    notes: [
      'Conversation 的 total_token / total_score 仍是唯一总账。',
      '只有明确写入的 AI Usage Record 才会进入 allocated_*；剩余部分保持未归属，不按比例拆分。',
      'attribution_status=partial 仍只累加记录中明确给出的数值，不推算缺失部分。',
    ],
  };
}

/**
 * Conversation 级项目分布。
 *
 * 这里的 project 来自 Conversation 自身，不对 Work Activity 做二次推断：
 *   - 回答「AI 使用发生在哪个项目上下文」；
 *   - Token / Credit 仍是会话级范围口径；
 *   - 与按 Work Activity 聚合的 `by_project` 分栏，禁止相加。
 */
function buildConversationProjectStats(conversations) {
  const map = new Map();
  for (const c of conversations || []) {
    const project = c.project || '（未归属项目）';
    if (!map.has(project)) {
      map.set(project, {
        key: project,
        conversations: 0,
        request_count: 0,
        token: 0,
        token_known: 0,
        token_unknown: 0,
        score: 0,
        score_known: 0,
        score_unavailable: 0,
        score_not_applicable: 0,
        agents: {},
        models: {},
        sources: {},
        project_sources: {},
      });
    }
    const row = map.get(project);
    row.conversations += 1;
    row.request_count += Number(c.request_count) || 0;
    if (typeof c.total_token === 'number') {
      row.token += c.total_token;
      row.token_known += 1;
    } else {
      row.token_unknown += 1;
    }
    if (c.score_source === 'not_applicable') {
      row.score_not_applicable += 1;
    } else if (typeof c.total_score === 'number') {
      row.score += c.total_score;
      row.score_known += 1;
    } else {
      row.score_unavailable += 1;
    }
    const agent = c.agent || '（未知）';
    const model = c.model_name || '（未知）';
    const source = c.source || '（未知）';
    const projectSource = c.project_source || '（未标注）';
    row.agents[agent] = (row.agents[agent] || 0) + 1;
    row.models[model] = (row.models[model] || 0) + 1;
    row.sources[source] = (row.sources[source] || 0) + 1;
    row.project_sources[projectSource] = (row.project_sources[projectSource] || 0) + 1;
  }

  return [...map.values()]
    .map((r) => {
      const applicable = r.score_known + r.score_unavailable;
      return {
        key: r.key,
        conversations: r.conversations,
        request_count: r.request_count,
        total_token: r.token_known ? r.token : U,
        token_known: r.token_known,
        token_unknown: r.token_unknown,
        total_score:
          r.score_known > 0
            ? CS.round2(r.score)
            : applicable === 0 && r.score_not_applicable > 0
              ? 0
              : U,
        score_known: r.score_known,
        score_unavailable: r.score_unavailable,
        score_not_applicable: r.score_not_applicable,
        score_status:
          applicable === 0
            ? 'not_applicable'
            : r.score_unavailable > 0
              ? 'lower_bound'
              : 'reported',
        agents: r.agents,
        models: r.models,
        sources: r.sources,
        project_sources: r.project_sources,
      };
    })
    .sort(
      (a, b) =>
        (b.total_token === U ? -1 : b.total_token) -
          (a.total_token === U ? -1 : a.total_token) ||
        String(a.key).localeCompare(String(b.key))
    );
}

/**
 * 组装完整成本视图（用户 §13/§14/§15/§19）。
 *
 * 四个维度 + 一个「项目 × 阶段」嵌套，全部**同时**给出 Token 与 Score。
 * V3.5 另有 AI Usage 精确归属，统一在 `usage_attribution` 下，禁止与会话级口径相加。
 */
/**
 * 项目 × 阶段 的二维格子（V3.6 从 buildCostStats 内联逻辑抽出）。
 *
 * 规则与其它维度完全一致：先按项目聚合，再在项目内按阶段拆分；
 * **同一会话若落进 2 个以上格子 → 归属有歧义 → 不计入任何一格**，
 * 否则「项目 × 阶段」的 Token 合计会大于会话总量。
 *
 * 抽出的原因：用户要的是「项目**工作**哪个阶段更依赖 AI」，
 * 因此需要能对「全量」与「工作口径」分别算同一张表。
 *
 * @returns {{rows: Array, ambiguous: Array}}
 */
function buildProjectStageGrid(activities, conversations) {
  const convById = new Map((conversations || []).map((c) => [String(c.conversation_id), c]));
  const projects = new Map();
  const cells = [];
  const cellOfConv = new Map();
  for (const a of activities || []) {
    const p = a.project_name || '（未归属项目）';
    if (!projects.has(p)) projects.set(p, new Map());
    const stageMap = projects.get(p);
    const s = a.project_stage || '（未标注阶段）';
    if (!stageMap.has(s)) {
      const cell = {
        project: p,
        stage: s,
        activities: 0,
        minutes: 0,
        conversations: new Set(),
        candidates: new Set(),
        token: 0,
        token_known: 0,
        score: 0,
        score_known: 0,
        outputs: [],
      };
      stageMap.set(s, cell);
      cells.push(cell);
    }
    const row = stageMap.get(s);
    row.activities += 1;
    row.minutes += Number(a.duration_minutes) || 0;
    if (a.output) row.outputs.push(a.output);
    const cid = a.conversation_id ? String(a.conversation_id) : null;
    if (cid && convById.has(cid)) {
      row.candidates.add(cid);
      if (!cellOfConv.has(cid)) cellOfConv.set(cid, new Set());
      cellOfConv.get(cid).add(`${p}\u0000${s}`);
    }
  }
  // 只保留「唯一归属」的会话：同一会话落进 2 个以上格子 → 有歧义，全部不计。
  const uniqueCellConv = new Set(
    [...cellOfConv.entries()].filter(([, c]) => c.size === 1).map(([cid]) => cid)
  );
  const ambiguous = [...cellOfConv.entries()]
    .filter(([, c]) => c.size > 1)
    .map(([cid, c]) => ({
      conversation_id: cid,
      dimension: 'project_stage',
      keys: [...c].map((x) => x.split('\u0000').join(' / ')),
    }));
  for (const cell of cells) {
    for (const cid of cell.candidates) {
      if (!uniqueCellConv.has(cid)) continue;
      cell.conversations.add(cid);
      const conv = convById.get(cid);
      if (typeof conv.total_token === 'number') {
        cell.token += conv.total_token;
        cell.token_known += 1;
      }
      if (typeof conv.total_score === 'number') {
        cell.score += conv.total_score;
        cell.score_known += 1;
      }
    }
  }
  const rows = [...projects.entries()]
    .map(([project, stageMap]) => {
      const stages = [...stageMap.values()]
        .map((r) => ({
          stage: r.stage,
          activities: r.activities,
          minutes: r.minutes,
          conversation_count: r.conversations.size,
          total_token: r.token_known ? r.token : U,
          total_score: r.score_known ? CS.round2(r.score) : U,
          outputs: r.outputs,
        }))
        .sort((a, b) => b.minutes - a.minutes);
      const kn = stages.filter((s) => typeof s.total_token === 'number');
      const ks = stages.filter((s) => typeof s.total_score === 'number');
      return {
        project,
        stages,
        total_token: kn.length ? kn.reduce((x, s) => x + s.total_token, 0) : U,
        total_score: ks.length ? CS.round2(ks.reduce((x, s) => x + s.total_score, 0)) : U,
        minutes: stages.reduce((x, s) => x + s.minutes, 0),
      };
    })
    .sort((a, b) => b.minutes - a.minutes);
  return { rows, ambiguous };
}

function buildCostStats(read, ctx) {
  const { conversations, skillUsages, activities, segments, aiUsages } = read;
  const totalToken = CS.sumField(conversations, 'total_token');
  const totalScore = CS.sumField(conversations, 'total_score');
  const tokenTotal = typeof totalToken.value === 'number' ? totalToken.value : U;
  const scoreTotal = typeof totalScore.value === 'number' ? CS.round2(totalScore.value) : U;
  const scoreApplicable = (conversations || []).filter(
    (c) => c.score_source !== 'not_applicable'
  );
  const scoreKnownNumeric = scoreApplicable.filter((c) => typeof c.total_score === 'number');
  const scoreUnavailable = scoreApplicable.filter((c) => typeof c.total_score !== 'number');
  const scoreNotApplicable = (conversations || []).filter(
    (c) => c.score_source === 'not_applicable'
  );

  const skill = buildSkillCost(skillUsages, tokenTotal, activities, aiUsages);
  const skillConversationIds = new Set(
    (skillUsages || [])
      .map((s) => (s.conversation_id ? String(s.conversation_id) : null))
      .filter(Boolean)
  );
  skill.conversation_count_with_skill = skillConversationIds.size;
  skill.conversation_count_without_skill = (conversations || []).filter(
    (c) => !skillConversationIds.has(String(c.conversation_id))
  ).length;
  const byWorkType = attributeDimension(activities, conversations, (a) => a.work_type);
  const byProject = attributeDimension(activities, conversations, (a) => a.project_name);
  const byStage = attributeDimension(activities, conversations, (a) => a.project_stage);

  // V3.6（用户 2026-09-24）：三个维度各出**两套口径**。
  //
  //   `by_*`      全部事项 —— 保留原有语义，向后兼容
  //   `by_*_work` 仅「工作口径」事项 —— 剔除探索沉淀/生活类
  //
  // 为什么需要后者：用户要回答的是「我在**项目工作**上哪个阶段更依赖 AI」。
  // 若把「给 skill 加功能」这类探索事项也算进项目维度，同一会话会横跨
  // 「业务项目」与「AI Skill 探索」，按歧义规则整条会话都归不了属 ——
  // 结果就是项目/阶段两张表永远空着。分类是显式字段，`null` 视为未标注
  // （不给结论也不算非工作），只有**明确标成非工作**的才剔除。
  const isWorkDim = (a) => !a.category || a.category === '工作';
  const workActivities = (activities || []).filter(isWorkDim);
  const workByWorkType = attributeDimension(workActivities, conversations, (a) => a.work_type);
  const workByProject = attributeDimension(workActivities, conversations, (a) => a.project_name);
  const workByStage = attributeDimension(workActivities, conversations, (a) => a.project_stage);

  // 项目 × 阶段（用户 §13 重点）：先按项目聚合，再在项目内按阶段拆分。
  //
  // 这一维也要遵守**同一条归因铁律**（此前遗漏会造成重复计数）：
  // 一个会话若同时出现在**两个不同的 (项目, 阶段) 格子里**，说明归属有歧义，
  // 该会话不计入任何一格 —— 否则「按项目×阶段」的 Token 合计会大于会话总量。
  const convById = new Map(conversations.map((c) => [String(c.conversation_id), c]));
  const projects = new Map();
  const cells = []; // 所有 (项目, 阶段) 格子，供第二轮归属
  const cellOfConv = new Map(); // cid -> Set("project\u0000stage")
  for (const a of activities || []) {
    const p = a.project_name || '（未归属项目）';
    if (!projects.has(p)) projects.set(p, new Map());
    const stageMap = projects.get(p);
    const s = a.project_stage || '（未标注阶段）';
    if (!stageMap.has(s)) {
      const cell = { project: p, stage: s, activities: 0, minutes: 0, conversations: new Set(), candidates: new Set(), token: 0, token_known: 0, score: 0, score_known: 0, outputs: [] };
      stageMap.set(s, cell);
      cells.push(cell);
    }
    const row = stageMap.get(s);
    row.activities += 1;
    row.minutes += Number(a.duration_minutes) || 0;
    if (a.output) row.outputs.push(a.output);
    const cid = a.conversation_id ? String(a.conversation_id) : null;
    if (cid && convById.has(cid)) {
      row.candidates.add(cid);
      if (!cellOfConv.has(cid)) cellOfConv.set(cid, new Set());
      cellOfConv.get(cid).add(`${p}\u0000${s}`);
    }
  }
  // 只保留「唯一归属」的会话：同一会话落进 2 个以上格子 → 有歧义，全部不计。
  const uniqueCellConv = new Set(
    [...cellOfConv.entries()].filter(([, c]) => c.size === 1).map(([cid]) => cid)
  );
  const projectStageAmbiguous = [...cellOfConv.entries()]
    .filter(([, c]) => c.size > 1)
    .map(([cid, c]) => ({
      conversation_id: cid,
      dimension: 'project_stage',
      keys: [...c].map((x) => x.split('\u0000').join(' / ')),
    }));
  for (const cell of cells) {
    for (const cid of cell.candidates) {
      if (!uniqueCellConv.has(cid)) continue;
      cell.conversations.add(cid);
      const conv = convById.get(cid);
      if (typeof conv.total_token === 'number') {
        cell.token += conv.total_token;
        cell.token_known += 1;
      }
      if (typeof conv.total_score === 'number') {
        cell.score += conv.total_score;
        cell.score_known += 1;
      }
    }
  }
  const projectStages = [...projects.entries()].map(([project, stageMap]) => {
    const stages = [...stageMap.values()]
      .map((r) => ({
        stage: r.stage,
        activities: r.activities,
        minutes: r.minutes,
        conversation_count: r.conversations.size,
        total_token: r.token_known ? r.token : U,
        total_score: r.score_known ? CS.round2(r.score) : U,
        outputs: r.outputs,
      }))
      .sort((a, b) => b.minutes - a.minutes);
    const kn = stages.filter((s) => typeof s.total_token === 'number');
    const ks = stages.filter((s) => typeof s.total_score === 'number');
    return {
      project,
      stages,
      total_token: kn.length ? kn.reduce((x, s) => x + s.total_token, 0) : U,
      total_score: ks.length ? CS.round2(ks.reduce((x, s) => x + s.total_score, 0)) : U,
      minutes: stages.reduce((x, s) => x + s.minutes, 0),
    };
  });

  // V3.6：工作口径的同名二维表（剔除探索沉淀/生活），供洞察报告的
  // 「项目阶段侧重」使用；与上面的全量表是并排两张，**不可相加**。
  const workStageGrid = buildProjectStageGrid(workActivities, conversations);

  return {
    total_token: tokenTotal,
    total_score: scoreTotal,
    token_known_conversations: totalToken.known,
    token_unknown_conversations: totalToken.unknown,
    score_known_conversations: scoreKnownNumeric.length,
    score_unknown_conversations: scoreUnavailable.length,
    score_not_applicable_conversations: scoreNotApplicable.length,
    // 会话侧占比分母（供各维度计算占比）。
    // 注意：`tokenTotal` / `scoreTotal` 已经是「标量或 null」，不能再取 `.value`
    // —— 当区间内没有任何可归属会话时它是 null，取属性会抛 TypeError。
    share_basis: { token: tokenTotal, score: scoreTotal },
    skill,
    conversation_projects: buildConversationProjectStats(conversations),
    usage_attribution: buildAiUsageStats(aiUsages, segments, activities, conversations),
    allocated_by_work_type: allocatedDimension(aiUsages, activities, (a) => a.work_type),
    allocated_by_project: allocatedDimension(aiUsages, activities, (a) => a.project_name),
    allocated_by_project_stage: allocatedDimension(aiUsages, activities, (a) => a.project_stage),
    // 工作类型维度（用户 §13「Work Type 维度」）
    by_work_type: byWorkType.rows.map((r) => ({
      ...r,
      token_share: shareOf(r.total_token, tokenTotal),
      score_share: shareOf(r.total_score, scoreTotal),
    })),
    by_work_type_ambiguous: byWorkType.ambiguous,
    // 项目维度（用户 §13「Project 维度」）
    by_project: byProject.rows.map((r) => ({
      ...r,
      token_share: shareOf(r.total_token, tokenTotal),
      score_share: shareOf(r.total_score, scoreTotal),
    })),
    by_project_ambiguous: byProject.ambiguous,
    // 项目阶段维度（用户 §13「Project Stage 维度」）
    by_project_stage: byStage.rows.map((r) => ({
      ...r,
      token_share: shareOf(r.total_token, tokenTotal),
      score_share: shareOf(r.total_score, scoreTotal),
    })),
    by_project_stage_ambiguous: byStage.ambiguous,
    // V3.6：工作口径（剔除探索沉淀/生活）—— 洞察报告用这一套回答
    // 「项目工作哪个阶段更依赖 AI」。与上面的全量口径**不可相加**，是并排的两张表。
    by_work_type_work: workByWorkType.rows.map((r) => ({
      ...r,
      token_share: shareOf(r.total_token, tokenTotal),
      score_share: shareOf(r.total_score, scoreTotal),
    })),
    by_work_type_work_ambiguous: workByWorkType.ambiguous,
    by_project_work: workByProject.rows.map((r) => ({
      ...r,
      token_share: shareOf(r.total_token, tokenTotal),
      score_share: shareOf(r.total_score, scoreTotal),
    })),
    by_project_work_ambiguous: workByProject.ambiguous,
    by_project_stage_work: workByStage.rows.map((r) => ({
      ...r,
      token_share: shareOf(r.total_token, tokenTotal),
      score_share: shareOf(r.total_score, scoreTotal),
    })),
    by_project_stage_work_ambiguous: workByStage.ambiguous,
    // 项目 × 阶段的歧义（同一会话落进 2 个以上 (项目, 阶段) 格子）
    project_stage_ambiguous: projectStageAmbiguous,
    // 归因覆盖率（诊断用）：说明 Token/Score 为什么「不可获取」。
    // 只做事实陈述 —— 记录里没有 conversation_id 就是没有，不补、不摊派。
    attribution_coverage: {
      activities: (activities || []).length,
      with_conversation: (activities || []).filter((a) => a.conversation_id).length,
      conversations: (conversations || []).length,
    },
    // 项目 × 阶段（用户 §13 重点）
    project_stages: projectStages.sort((a, b) => b.minutes - a.minutes),
    project_stages_work: workStageGrid.rows,
    project_stage_work_ambiguous: workStageGrid.ambiguous,
    attribution_rule: byWorkType.rule,
    notes: [
      'Token 与 Score 是**独立指标**，同时给出、互不换算（用户 §6）。',
      '归因只走记录中已存在的 conversation_id；人工事项与未关联会话的时间照常统计，' +
        '但 Token/Score 记为 null（不可归属，不摊派）。',
      '取不到的值一律 null —— 与「真实观察到 0 消耗」严格区分（用户 §5/§6）。',
    ],
  };
}


/**
 * 构建某一天的指标汇总（**只读** Structured Logs）。
 *
 * @param {string} dir 日志目录
 * @param {string} date YYYY-MM-DD
 */
function buildMetrics(dir, date) {
  const d = CS.assertDate(date);
  return buildFrom(
    {
      conversations: CS.read(dir, 'conversation', d),
      turns: CS.read(dir, 'turn', d),
      skillUsages: CS.read(dir, 'skill_usage', d),
      segments: CS.read(dir, 'work_segment', d),
      activities: CS.read(dir, 'work_activity', d),
      aiUsages: CS.read(dir, 'ai_usage', d),
    },
    { date: d, from: d, to: d, dir }
  );
}

/**
 * 构建日期区间的汇总（7/30 天周期分析，用户 §十二）。
 *
 * 同样只读 Structured Logs —— 不重扫历史对话。
 */
function buildMetricsRange(dir, from, to) {
  const f = CS.assertDate(from);
  const t = CS.assertDate(to);
  return buildFrom(
    {
      conversations: CS.readRange(dir, 'conversation', f, t),
      turns: CS.readRange(dir, 'turn', f, t),
      skillUsages: CS.readRange(dir, 'skill_usage', f, t),
      segments: CS.readRange(dir, 'work_segment', f, t),
      activities: CS.readRange(dir, 'work_activity', f, t),
      aiUsages: CS.readRange(dir, 'ai_usage', f, t),
    },
    { date: `${f}..${t}`, from: f, to: t, dir }
  );
}

/* ------------------------------------------------------------------ *
 * V3.6（用户 2026-09-24）：模型维度归一 + 使用对比
 * ------------------------------------------------------------------ */

/**
 * 归一化模型名 —— 解决「同一个模型在日志里有好几种写法」。
 *
 * 真实观测到的同一模型写法：`deepseek-v4-flash`、`custom-local:deepseek-v4-flash`、
 * `DeepSeek-V4 Flash`、`快速` / `fast-model`。不归一会让「模型使用对比」失去意义。
 *
 * 归一顺序：
 *   ① `config.ai.model_aliases` 显式映射（原样、去前缀后各查一次）
 *   ② 去掉 provider 前缀（`custom-local:` / `local:` / `openai:` 等）
 *   ③ 兜底归并键 = 小写化 + 去掉空格/下划线/连字符
 *
 * @returns {{key: string|null, label: string|null}}
 */
function normalizeModelName(raw, aliases) {
  const name = String(raw == null ? '' : raw).trim();
  if (!name) return { key: null, label: null };
  const map = aliases && typeof aliases === 'object' ? aliases : {};
  if (map[name]) return { key: aliasKey(map[name]), label: String(map[name]) };
  const stripped = name.replace(/^[A-Za-z0-9_.-]+:/, '').trim() || name;
  if (map[stripped]) return { key: aliasKey(map[stripped]), label: String(map[stripped]) };
  return { key: aliasKey(stripped), label: stripped };
}

/** 模型归并键：小写 + 去掉分隔符 */
function aliasKey(v) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

/**
 * 按模型聚合 AI 使用（Conversation 是唯一总账单位）。
 *
 * ⚠️ 口径：一次 Conversation 的 Token/积分整体记给它**记录里的主模型**
 * （`model_name`）。会话若同时用到多个模型（`models[]`），只记 `models_seen`
 * 作为线索，**不按模型拆分会话总量** —— 拆分会变成估算。
 */
function buildModelStats(conversations, aliases) {
  const convById = new Map();
  for (const c of conversations || []) {
    const { key, label } = normalizeModelName(c.model_name, aliases);
    const ukey = key || '（未记录模型）';
    if (!convById.has(ukey)) {
      convById.set(ukey, {
        key: ukey,
        model: label || '（未记录模型）',
        raw_names: new Set(),
        models_seen: new Set(),
        agents: new Set(),
        conversation_count: 0,
        request_count: 0,
        total_token: 0,
        token_known: 0,
        input_token: 0,
        output_token: 0,
        cached_token: 0,
        cached_known: 0,
        reasoning_token: 0,
        score: 0,
        score_known: 0,
        score_not_applicable: 0,
      });
    }
    const row = convById.get(ukey);
    if (c.model_name) row.raw_names.add(String(c.model_name));
    for (const m of Array.isArray(c.models) ? c.models : []) {
      const n = normalizeModelName(m, aliases);
      if (n.label) row.models_seen.add(n.label);
    }
    if (c.agent) row.agents.add(String(c.agent));
    row.conversation_count += 1;
    row.request_count += Number(c.request_count) || 0;
    if (typeof c.total_token === 'number') {
      row.total_token += c.total_token;
      row.token_known += 1;
    }
    if (typeof c.input_token === 'number') row.input_token += c.input_token;
    if (typeof c.output_token === 'number') row.output_token += c.output_token;
    if (typeof c.cached_token === 'number') {
      row.cached_token += c.cached_token;
      row.cached_known += 1;
    }
    if (typeof c.reasoning_token === 'number') row.reasoning_token += c.reasoning_token;
    if (c.score_source === 'not_applicable') row.score_not_applicable += 1;
    // 只有**适用积分**的会话才计入「有积分的会话数」，否则走 API 的会话会被
    // 当成「观察到 0 分」，在报告里显示成 0 而不是留空。
    if (c.score_source !== 'not_applicable' && typeof c.total_score === 'number') {
      row.score += c.total_score;
      row.score_known += 1;
    }
  }

  const rows = [...convById.values()].map((r) => ({
    key: r.key,
    model: r.model,
    // 归一前的原始写法（便于核对，也说明归一做了什么）
    raw_names: [...r.raw_names].sort(),
    models_seen: [...r.models_seen].sort(),
    agents: [...r.agents].sort(),
    conversation_count: r.conversation_count,
    request_count: r.request_count,
    total_token: r.token_known ? r.total_token : U,
    token_known_conversations: r.token_known,
    input_token: r.input_token,
    output_token: r.output_token,
    cached_token: r.cached_known ? r.cached_token : U,
    reasoning_token: r.reasoning_token,
    // 缓存命中率 = 缓存读 Token / 总 Token；取不到就 null（不是 0%）
    cache_hit_rate:
      r.token_known && r.total_token > 0 && r.cached_known
        ? CS.round2((r.cached_token / r.total_token) * 100)
        : U,
    // 平均单请求 Token —— 衡量「这个模型用起来贵不贵」的可比口径
    avg_token_per_request:
      r.token_known && r.request_count > 0 ? Math.round(r.total_token / r.request_count) : U,
    avg_token_per_conversation:
      r.token_known && r.conversation_count > 0
        ? Math.round(r.total_token / r.conversation_count)
        : U,
    total_score: r.score_known ? CS.round2(r.score) : U,
    score_known_conversations: r.score_known,
    score_not_applicable_conversations: r.score_not_applicable,
  }));

  rows.sort((a, b) => {
    const at = typeof a.total_token === 'number' ? a.total_token : -1;
    const bt = typeof b.total_token === 'number' ? b.total_token : -1;
    if (at !== bt) return bt - at;
    return b.conversation_count - a.conversation_count;
  });

  return {
    rows,
    // 原始写法条数 > 归一后条数，说明确实发生了归并（报告里据此提示）
    raw_name_count: new Set((conversations || []).map((c) => String(c.model_name || ''))).size,
    rule:
      '模型名先按 config.ai.model_aliases 显式映射，再去 provider 前缀归并；' +
      '一次会话的 Token/积分整体记给记录里的主模型，不按会话内多模型拆分（那会变成估算）。',
  };
}

/** 汇总核心（供单日与区间共用） */
function buildFrom(read, ctx) {
  const { conversations, turns, skillUsages, segments, activities, aiUsages } = read;
  const d = ctx.date;
  // V3.6：模型名归一需要 config.ai.model_aliases。读不到配置时按通用规则归一。
  let cfg = null;
  try {
    cfg = ctx.dir ? C.readConfig(ctx.dir) : null;
  } catch (e) {
    cfg = null;
  }
  const modelAliases = (cfg && cfg.ai && cfg.ai.model_aliases) || {};

  const notes = [];
  if (
    !conversations.length &&
    !(turns || []).length &&
    !skillUsages.length &&
    !segments.length &&
    !activities.length &&
    !aiUsages.length
  ) {
    notes.push(
      `${d} 的结构化日志中无任何记录。若当天确有对话，通常是「对话结束结算」尚未执行 —— ` +
        '运行 settle-conversation.js 补算，而不是让复盘去翻历史对话。'
    );
  }
  notes.push(
    '本汇总只读 Structured Logs（Conversations / Skill Usage / Work Segments / Work Activities / AI Usage），未重新扫描历史对话。'
  );

  /* ---------------- AI 使用（Conversation 维度） ---------------- */
  const tokenStats = {
    total: CS.sumField(conversations, 'total_token'),
    input: CS.sumField(conversations, 'input_token'),
    output: CS.sumField(conversations, 'output_token'),
    cached: CS.sumField(conversations, 'cached_token'),
    reasoning: CS.sumField(conversations, 'reasoning_token'),
    score: CS.sumField(conversations, 'total_score'),
  };
  const durationStats = CS.sumField(conversations, 'duration_seconds');

  // 积分覆盖率：宿主只为部分请求落 credit → total_score 是下界，必须显式告知。
  // 旧记录可能没有 score_request_count 字段，此时覆盖率**未知**而非 0。
  const scoreRequests = conversations.reduce(
    (a, c) => a + (Number(c.score_request_count) || 0),
    0
  );
  const requestCount = conversations.reduce((a, c) => a + (Number(c.request_count) || 0), 0);
  // `not_applicable` 的会话（走模型 API、本就不计积分）**不参与**下界判断 ——
  // 它们的请求注定没有 credit，算进去会把「覆盖不全」误报成缺口。
  const applicableRequests = conversations
    .filter((c) => c.score_source !== 'not_applicable')
    .reduce((a, c) => a + (Number(c.request_count) || 0), 0);
  const notApplicableCount = conversations.filter(
    (c) => c.score_source === 'not_applicable'
  ).length;
  const hasNumericScore = conversations.some((c) => typeof c.total_score === 'number');
  const coverageKnown = scoreRequests > 0 || !hasNumericScore;

  const agent = {
    conversation_count: conversations.length,
    settled: conversations.filter((c) => c.settlement_status === 'settled').length,
    partial_or_failed: conversations.filter((c) => c.settlement_status !== 'settled').length,
    by_agent: CS.countBy(conversations, 'agent'),
    by_model: CS.countBy(conversations, 'model_name'),
    by_source: CS.countBy(conversations, 'source'),
    by_settlement_status: CS.countBy(conversations, 'settlement_status'),
    total_token: tokenText(tokenStats.total),
    input_token: tokenText(tokenStats.input),
    output_token: tokenText(tokenStats.output),
    cached_token: tokenText(tokenStats.cached),
    reasoning_token: tokenText(tokenStats.reasoning),
    // Score / Credit：与 Token 完全独立的指标（用户 §七）
    // 计分统一保留两位小数（用户 2026-09-21 口径）——
    // 浮点求和会留下 245.61999999999998 这类噪声，且会让同日合计在不同汇总间抖动
    total_score: tokenText(tokenStats.score) === U ? U : CS.round2(tokenStats.score.value),
    score_request_count: scoreRequests,
    request_count: requestCount,
    // 参与了积分统计的请求数（排除「本就不计积分」的通道）
    score_applicable_requests: applicableRequests,
    score_not_applicable_conversations: notApplicableCount,
    score_coverage_known: coverageKnown,
    score_is_lower_bound: coverageKnown ? scoreRequests < applicableRequests : U,
    total_duration_seconds: tokenText(durationStats),
    turn_count: conversations.reduce((a, c) => a + (Number(c.turn_count) || 0), 0),
    models_in_use: [
      ...new Set(conversations.flatMap((c) => (Array.isArray(c.models) ? c.models : []))),
    ],
    conversations: conversations
      .slice()
      .sort((a, b) => String(a.start_time || '').localeCompare(String(b.start_time || '')))
      .map((c) => ({
        conversation_id: c.conversation_id,
        title: c.title,
        agent: c.agent,
        model_name: c.model_name,
        start_time: c.start_time,
        end_time: c.end_time,
        duration_seconds: c.duration_seconds,
        total_token: c.total_token,
        total_score: c.total_score,
        score_source: c.score_source,
        score_request_count: c.score_request_count,
        request_count: c.request_count,
        turn_count: c.turn_count,
        skill_count: c.skill_count,
        skill_invocation_count: c.skill_invocation_count,
        distinct_skill_count: c.distinct_skill_count,
        // 具体调用了哪些 Skill（用户 2026-09-21：明细要显示名称，不要只给个数）
        skill_names: [...new Set(skillUsages.filter((s) => s.conversation_id === c.conversation_id).map((s) => s.skill_id))],
        status: c.status,
        settlement_status: c.settlement_status,
      })),
  };

  const turnRows = turns || [];
  const turnToken = CS.sumField(turnRows, 'total_token');
  const turn = {
    count: turnRows.length,
    token_known: turnToken.known,
    token_unavailable: turnToken.unknown,
    total_token: turnToken.value,
    by_status: CS.countBy(turnRows, 'status'),
    by_source: CS.countBy(turnRows, 'source'),
  };

  // 只读回执视图：事实来自 turns + skill-usage，渲染时可以按 snapshots
  // 输出“截至本条”，最终状态取 final。这里不写回事实日志。
  const receiptRows = SKR.buildTurnReceipts(turnRows, skillUsages);
  const skillReceipts = {
    rule:
      '由 turns.jsonl 与 skill-usage.jsonl 派生；中间回执使用累计事件，最终回执按 skill_id 去重。',
    turns: receiptRows.map((row) => ({
      turn_id: row.turn_id,
      provider_turn_id: row.provider_turn_id,
      final: row.final,
      snapshots: row.snapshots,
    })),
  };

  /* ---------------- Skill 使用 ---------------- */
  // 对话 → 该对话总 Token（用于回答「这个 Skill 涉及的对话一共消耗了多少」）
  const convTokenById = new Map();
  for (const c of conversations) {
    if (c.conversation_id) convTokenById.set(c.conversation_id, Number(c.total_token) || 0);
  }
  const bySkillId = new Map();
  for (const s of skillUsages) {
    const key = `${s.skill_id}@${s.skill_version}`;
    if (!bySkillId.has(key)) {
      bySkillId.set(key, {
        skill_id: s.skill_id,
        skill_version: s.skill_version,
        invocations: 0,
        failed: 0,
        unknown: 0,
        load_chars: 0,
        // 有多少次调用真的提供了载入字符（P2-5）—— 用于区分「载入确实轻」与「没有数据」
        load_chars_known: 0,
        skill_token: 0,
        token_known: 0,
        token_unavailable: 0,
        conversations: new Set(),
        // B 口径：精确但**非独占**，仅供核对，禁止跨 Skill 相加
        call_request_total_token_sum: 0,
        call_request_token_known: 0,
      });
    }
    const a = bySkillId.get(key);
    a.invocations += 1;
    if (s.status === 'failed') a.failed += 1;
    if (s.status === 'unknown') a.unknown += 1;
    if (typeof s.load_chars === 'number') {
      a.load_chars += s.load_chars;
      a.load_chars_known += 1;
    }
    if (typeof s.skill_token === 'number') {
      a.skill_token += s.skill_token;
      a.token_known += 1;
    } else {
      a.token_unavailable += 1;
    }
    if (typeof s.call_request_total_token === 'number') {
      a.call_request_total_token_sum += s.call_request_total_token;
      a.call_request_token_known += 1;
    }
    if (s.conversation_id) a.conversations.add(s.conversation_id);
  }

  const bySkill = [...bySkillId.values()]
    .map((a) => {
      // 该 Skill 涉及的全部对话一共消耗了多少 Token（用户 2026-09-21 要求）。
      //
      // ⚠️ 两个必须留意的点：
      //   ① 对话是**共享**的 —— 同一对话里多个 Skill 会得到同一个数字，
      //      因此**不可跨 Skill 相加**（相加会重复计入）；
      //   ② 对话可能不在本区间内（如跨日期会话），此时它的 Token **未知**。
      //      未知必须记 null，**绝不能用 0 冒充**（曾经把它写成 0，看起来像「没消耗」）。
      let known = 0;
      let total = 0;
      for (const id of a.conversations) {
        const v = convTokenById.get(id);
        if (typeof v === 'number') {
          known += 1;
          total += v;
        }
      }
      return Object.assign({}, a, {
        conversation_count: a.conversations.size,
        conversations: [...a.conversations],
        conversation_token_known: known,
        conversation_token_total: known ? total : U,
        // 全部调用都拿不到 token 时，汇总值本身也必须是 null（不能写 0）
        skill_token: a.token_known ? a.skill_token : U,
        // V3.6：B 口径的**平均单次**用量 —— 回答「这个 Skill 用起来贵不贵」的可比口径。
        // 只按「拿到 B 值的调用次数」求均值；一次都没拿到就是 null。
        call_request_avg_token: a.call_request_token_known
          ? Math.round(a.call_request_total_token_sum / a.call_request_token_known)
          : U,
        // P2-5：A 口径的**平均单次载入字符** —— 回答「这个 Skill 每次要用掉多少上下文」。
        // 用 `load_chars_known` 而非 `invocations` 作分母：只在**有数据的调用**上求均值，
        // 否则 codex 通道（全部缺该字段）会把平均值稀释成一个偏低的假数字。
        avg_load_chars: a.load_chars_known ? Number((a.load_chars / a.load_chars_known).toFixed(1)) : U,
      });
    })
    .sort((x, y) => {
      const xU = x.skill_token === U ? 1 : 0;
      const yU = y.skill_token === U ? 1 : 0;
      if (xU !== yU) return xU - yU;
      if (xU === 0 && y.skill_token !== x.skill_token) return y.skill_token - x.skill_token;
      return y.invocations - x.invocations;
    });

  const skill = {
    invocations: skillUsages.length,
    distinct: bySkillId.size,
    failed: skillUsages.filter((s) => s.status === 'failed').length,
    unknown: skillUsages.filter((s) => s.status === 'unknown').length,
    // A 口径合计（Skill 载入体积）—— 这是可精确归因的部分
    // 载入体积合计：只累加**可归因**的部分；一次都拿不到时为 null
    // （0 表示「真实观察到零载入」，与「不可获取」语义完全不同 ——
    //  早期这里无条件写 0，导致 Codex 侧（完全不暴露载入体积）看起来像「零消耗」）。
    load_token_total: (() => {
      const known = bySkill.filter((s) => typeof s.skill_token === 'number');
      return known.length ? known.reduce((a, s) => a + s.skill_token, 0) : U;
    })(),
    token_unavailable_invocations: skillUsages.filter((s) => s.skill_token === U).length,
    by_skill: bySkill,
    by_conversation: (() => {
      const map = new Map();
      for (const s of skillUsages) {
        if (!map.has(s.conversation_id)) map.set(s.conversation_id, []);
        map.get(s.conversation_id).push(s.skill_id);
      }
      return Object.fromEntries([...map].map(([k, v]) => [k, [...new Set(v)]]));
    })(),
    notes: [
      'Skill token 为 A 口径（Skill 载入体积 = 工具返回字符 × 系数），可精确归因；' +
        '载入失败或口径关闭时为 null，**绝不**用总额摊派补齐。',
      'call_request_total_token 是 B 口径（调用所在请求的用量），含全部历史上下文、' +
        '同请求内多个 Skill 会重复计入，**禁止跨 Skill 相加**。',
    ],
  };
  const skillConversationIds = new Set(
    skillUsages
      .map((s) => (s.conversation_id ? String(s.conversation_id) : null))
      .filter(Boolean)
  );
  skill.conversation_count_with_skill = skillConversationIds.size;
  skill.conversation_count_without_skill = conversations.filter(
    (c) => !skillConversationIds.has(String(c.conversation_id))
  ).length;

  /* ---------------- Work Activity ---------------- */
  const activity = {
    count: activities.length,
    segment_count: segments.length,
    by_source: CS.countBy(activities, 'source'),
    by_project: countByLabeled(activities, 'project_name', '（未识别项目）'),
    by_work_type: countByLabeled(activities, 'work_type', '（未识别类型）'),
    // V3.3（用户 2026-09-22）：分类 / 项目阶段分布 + 成果
    by_category: countByLabeled(activities, 'category', '（未分类）'),
    by_project_stage: countByLabeled(activities, 'project_stage', '（未标注阶段）'),
    by_ai_role: countByLabeled(activities, 'ai_role', '（未标注）'),
    with_segment: activities.filter((a) => a.segment_id).length,
    with_output: activities.filter((a) => a.output).length,
    outputs: activities
      .filter((a) => a.output)
      .map((a) => ({
        activity_id: a.activity_id,
        project_name: a.project_name,
        work_type: a.work_type,
        project_stage: a.project_stage,
        content: a.content,
        output: a.output,
      })),
    by_status: CS.countBy(activities, 'status'),
    agent_count: activities.filter((a) => a.source === 'agent').length,
    manual_count: activities.filter((a) => a.source === 'manual').length,
    // 人工工作允许没有 Conversation（用户 §十）
    without_conversation: activities.filter((a) => !a.conversation_id).length,
    // 无 Conversation 但带 work_item_id → 来自 WorkItem 导出的永久归档
    via_work_item: activities.filter((a) => !a.conversation_id && a.work_item_id).length,
    completed: activities.filter((a) => a.status === 'completed').length,
    unfinished: activities.filter((a) =>
      ['in_progress', 'needs_confirmation'].includes(a.status)
    ).length,
    // 工作时长统计（用户 §十二「工作时长统计」）
    total_duration_minutes: (() => {
      const nums = activities
        .map((a) => a.duration_minutes)
        .filter((v) => typeof v === 'number' && Number.isFinite(v));
      return nums.length ? nums.reduce((a, b) => a + b, 0) : U;
    })(),
    items: activities.map((a) => ({
      activity_id: a.activity_id,
      project_name: a.project_name,
      work_type: a.work_type,
      // V3.3：三个归因维度 + 成果
      category: a.category,
      project_stage: a.project_stage,
      segment_id: a.segment_id || null,
      ai_role: a.ai_role || null,
      output: a.output,
      content: a.content,
      display_content: a.display_content,
      start_time: a.start_time,
      end_time: a.end_time,
      duration_minutes: a.duration_minutes,
      source: a.source,
      conversation_id: a.conversation_id,
      status: a.status,
      confidence: a.confidence,
    })),
  };

  /* ---------------- 关联链（用户 §十二） ---------------- */
  const linkage = buildLinkage(activities, conversations, skillUsages);

  /* ---------------- AI 成本多维聚合（V3.3，用户 §13/§14/§15） ---------------- */
  const cost = buildCostStats({ conversations, skillUsages, segments, activities, aiUsages }, ctx);

  /* ---------------- 模型维度（V3.6，用户 2026-09-24） ---------------- */
  const modelStats = buildModelStats(conversations, modelAliases);
  const modelTotalToken = typeof cost.total_token === 'number' ? cost.total_token : U;
  const models = {
    ...modelStats,
    rows: modelStats.rows.map((r) => ({
      ...r,
      token_share: shareOf(r.total_token, modelTotalToken),
      score_share: shareOf(r.total_score, cost.total_score),
    })),
  };

  return {
    date: d,
    from: ctx.from,
    to: ctx.to,
    source_of_truth: 'structured_logs_only',
    no_rescan: true,
    generated_at: C.nowIso(),
    agent,
    models,
    turn,
    skill_receipts: skillReceipts,
    skill,
    activity,
    linkage,
    cost,
    notes: notes.concat(skill.notes),
  };
}

/**
 * 构建「项目 → 工作事项 → Conversation → Skill → Token/Score」关联链。
 *
 * 铁律：**没有显式关联就不生成**。归属有歧义时（一个对话被多个项目引用）
 * 归入 `ambiguous`，不硬算给任何一方。
 */
function buildLinkage(activities, conversations, skillUsages) {
  const convById = new Map(conversations.map((c) => [String(c.conversation_id), c]));
  const skillsByConv = new Map();
  for (const s of skillUsages) {
    if (!skillsByConv.has(String(s.conversation_id))) skillsByConv.set(String(s.conversation_id), []);
    skillsByConv.get(String(s.conversation_id)).push(s);
  }

  // 只对有 conversation_id 的事项建立关联（agent 来源才有；manual 天然为空）
  const linked = activities.filter(
    (a) => a.conversation_id && convById.has(String(a.conversation_id))
  );

  const byProject = new Map();
  for (const a of linked) {
    const proj = a.project_name || '（未识别项目）';
    if (!byProject.has(proj)) byProject.set(proj, []);
    byProject.get(proj).push(a);
  }

  const convProjects = new Map();
  for (const [, items] of byProject) {
    for (const a of items) {
      const k = String(a.conversation_id);
      if (!convProjects.has(k)) convProjects.set(k, new Set());
      convProjects.get(k).add(a.project_name || '（未识别项目）');
    }
  }

  const groups = [];
  const ambiguous = [];
  for (const [proj, items] of byProject) {
    const convIds = [...new Set(items.map((a) => String(a.conversation_id)))];
    const mine = [];
    const shared = [];
    for (const cid of convIds) {
      if ((convProjects.get(cid) || new Set()).size > 1) shared.push(cid);
      else mine.push(cid);
    }
    if (shared.length) {
      ambiguous.push({
        project: proj,
        conversation_ids: shared,
        reason:
          '这些对话同时关联多个项目的工作事项，Token/Score 无法归属到单一项目，' +
          '因此不计入任何项目的合计（不推断）。',
      });
    }
    const rows = mine.map((cid) => {
      const c = convById.get(cid);
      return {
        conversation_id: cid,
        title: c.title,
        agent: c.agent,
        model_name: c.model_name,
        total_token: c.total_token,
        total_score: c.total_score,
        skills: (skillsByConv.get(cid) || []).map((s) => ({
          skill_id: s.skill_id,
          skill_version: s.skill_version,
          skill_token: s.skill_token,
          token_source: s.token_source,
        })),
      };
    });
    groups.push({
      project: proj,
      activities: items.map((a) => ({
        activity_id: a.activity_id,
        display_content: a.display_content,
        start_time: a.start_time,
      })),
      conversations: rows,
      // 合计只在「无歧义」的对话上求和，且每个对话只计一次
      total_token: rows.length
        ? rows.reduce((n, r) => (typeof r.total_token === 'number' ? n + r.total_token : n), 0)
        : U,
      total_score: (() => {
        const nums = rows.map((r) => r.total_score).filter((v) => typeof v === 'number');
        return nums.length ? CS.round2(nums.reduce((a, b) => a + b, 0)) : U;
      })(),
    });
  }

  return {
    available: groups.length > 0,
    groups,
    ambiguous,
    rule: '仅使用记录中已存在的 conversation_id 关联，未做任何推断。',
    unattributed_conversations: conversations
      .filter((c) => !linked.some((a) => String(a.conversation_id) === String(c.conversation_id)))
      .map((c) => c.conversation_id),
  };
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/** 不可获取统一显示为「不可获取」，而不是裸 null 或 0 */
const NA_TEXT = '不可获取';
const dash = (v) => (v === U || v === null || v === undefined ? NA_TEXT : v);
const num = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : NA_TEXT);

/**
 * 渲染「AI 使用 / Skill 使用 / 工作事项 / 关联链」四块文本。
 *
 * 由 `daily-summary.js` 与 `aggregate-logs.js` 直接使用，供人读也供 LLM 引用。
 */
function renderMetrics(m) {
  const L = [];
  if (!m) return L;
  const a = m.agent;
  const s = m.skill;
  const w = m.activity;

  L.push('十一、AI 使用汇总（Conversation / Model / Token / Score）');
  if (!a.conversation_count) {
    L.push(`  本区间无已结算的 Conversation（${m.date}）。`);
  } else {
    L.push(
      `  Conversation ${a.conversation_count} 次（结算完成 ${a.settled} 次` +
        `${a.partial_or_failed ? `，数据不全 ${a.partial_or_failed} 次` : ''}）` +
        `　Turn ${a.turn_count} 轮　请求 ${a.request_count} 次`
    );
    L.push(`  Token 合计 ${num(a.total_token)}（输入 ${num(a.input_token)} / 输出 ${num(a.output_token)}）`);
    L.push(`  缓存命中 ${num(a.cached_token)}　推理 ${num(a.reasoning_token)}`);
    L.push(
      `  Score / Credit 合计 ${dash(a.total_score)}` +
        (a.score_is_lower_bound
          ? `　⚠ 仅为下界：${a.score_request_count}/${a.score_applicable_requests} 次计分请求有积分记录`
          : a.score_is_lower_bound === null && a.score_coverage_known
            ? ''
            : '　（积分覆盖率未知：该批结算记录未记录覆盖度）') +
        (a.score_not_applicable_conversations
          ? `\n  （另有 ${a.score_not_applicable_conversations} 次对话走模型 API，不消耗积分，记 0 而非「不可获取」）`
          : '')
    );
    L.push(`  Agent 分布：${fmtCounts(a.by_agent)}`);
    L.push(`  Model 分布：${fmtCounts(a.by_model)}`);
    if (a.models_in_use.length) L.push(`  本区间涉及模型：${a.models_in_use.join('、')}`);
    L.push('  明细：');
    a.conversations.forEach((c) => {
      // 用户 2026-09-21：
      //   · Skill 列要显示**具体名称**，不是个数
      //   · 不要「结算状态」列
      //   · `not_applicable`（走模型 API）的积分是确定值 0，不写「不可获取」
      const na = c.score_source === 'not_applicable';
      const scoreText = na
        ? `${dash(c.total_score)}（模型 API，不计积分）`
        : dash(c.total_score);
      const skills = (c.skill_names || []).length ? c.skill_names.join('/') : '—';
      L.push(
        `    - [${spanText(c.start_time, c.end_time)}] ${c.title || '（无标题）'}` +
          `　${c.agent}/${c.model_name}` +
          `　${num(c.total_token)} token　积分 ${scoreText}` +
          `　Turn ${c.turn_count === null ? NA_TEXT : c.turn_count}` +
          `　不同 Skill ${c.distinct_skill_count === null ? NA_TEXT : c.distinct_skill_count}` +
          `　Skill ${skills}`
      );
    });
  }

  L.push('');
  L.push('十二、Skill 使用汇总');
  if (!s.invocations) {
    L.push('  本区间未从已结算对话中识别到 Skill 调用。');
  } else {
    L.push(
      `  调用 ${s.invocations} 次　涉及 ${s.distinct} 个 Skill` +
        `${s.failed ? `　失败 ${s.failed} 次` : ''}` +
        `${s.unknown ? `　结果未知 ${s.unknown} 次` : ''}`
    );
    L.push(`  Skill Token 合计 ${num(s.load_token_total)}（A 口径：载入体积，可精确归因）`);
    if (s.token_unavailable_invocations) {
      L.push(
        `  其中 ${s.token_unavailable_invocations} 次调用 Token ${NA_TEXT}（记 null，未做任何摊派）`
      );
    }
    L.push('  按 Skill 统计（**载入体积**，即该 Skill 的定义被注入上下文的成本）：');
    // ⚠️ 口径提醒：A 口径衡量的是「Skill 定义多大」，**不是**「这次工作花了多少」。
    //    改造 work-time-tracking 的真实开销（读写文件、跑测试、多轮对话）
    //    根本不经过任何 Skill，因此不会出现在这张表里。
    //    不做这个提醒，17,256 很容易被误读成「改造它花了 17,256 Token」。
    s.by_skill.forEach((x) => {
      const tokenText2 =
        x.skill_token === null
          ? `${NA_TEXT}（${x.token_unavailable} 次不可获取）`
          : `${x.skill_token.toLocaleString('en-US')}（${x.token_known} 次可归因）`;
      L.push(
        `    - ${x.skill_id}@${x.skill_version}　调用次数 ${x.invocations}` +
          `${x.failed ? `（失败 ${x.failed}）` : ''}`
      );
      L.push(
        `        载入 Token：${tokenText2}　载入字符：${x.load_chars.toLocaleString('en-US')}` +
          // P2-5：补「单次平均载入字符」。括号里标注数据覆盖情况 ——
          // 若只有部分调用有该字段，平均值只按有数据的调用求，必须让人看见分母。
          `　单次平均载入字符：${
            x.avg_load_chars === U ? NA_TEXT : x.avg_load_chars.toLocaleString('en-US')
          }（${x.load_chars_known}/${x.invocations} 次有数据）`
      );
      const convTokenText =
        x.conversation_token_total === U
          ? `${NA_TEXT}（${x.conversation_count} 个对话均不在本区间内）`
          : `${num(x.conversation_token_total)}` +
            `（${x.conversation_count} 个对话${
              x.conversation_token_known < x.conversation_count
                ? `，其中 ${x.conversation_token_known} 个可查`
                : ''
            }；对话为多 Skill 共享，**不可跨 Skill 相加**）`;
      L.push(`        涉及对话总 Token：${convTokenText}`);
      // B 口径只作为参考单独标注，绝不与 A 口径相加
      if (x.call_request_total_token_sum) {
        L.push(
          `        参考（B 口径，调用所在请求用量，**不可跨 Skill 相加**）：` +
            `${x.call_request_total_token_sum.toLocaleString('en-US')}`
        );
      }
    });
    if (s.conversation_count_without_skill) {
      L.push(`    - （未记录 Skill）　${s.conversation_count_without_skill} 个 Conversation`);
    }
    // 把「载入体积」与「会话总消耗」并列，避免把前者误当成后者
    const convToken = m.agent && typeof m.agent.total_token === 'number' ? m.agent.total_token : null;
    if (convToken) {
      // 载入体积全不可归因时（如 Codex 侧）没有占比可言 —— 不写 0%，避免被读成「零消耗」
      const pct =
        typeof s.load_token_total === 'number'
          ? `${((s.load_token_total / convToken) * 100).toFixed(1)}%`
          : null;
      L.push(
        `  ⚠ **载入体积 ≠ 实际消耗**：Skill 载入合计 ${num(s.load_token_total)}` +
          (pct ? `，仅占会话总 Token ${num(convToken)} 的 **${pct}**。` : '（占比不可获取）。')
      );
      L.push(
        '      其余部分是读写文件、执行命令、多轮对话等 —— **不经过任何 Skill**，' +
          '因此不会归因到任何 Skill 名下。'
      );
    }
    L.push(`  ${s.notes[0]}`);
    L.push(`  ${s.notes[1]}`);
    if (m.turn && m.turn.count) {
      const receiptRows = (m.skill_receipts && m.skill_receipts.turns) || [];
      const visible = receiptRows
        .filter((row) => row.final && row.final.skills && row.final.skills.length)
        .slice(0, 10);
      L.push(`  Turn 回执：共 ${m.turn.count} 轮，显示 ${visible.length} 条有 Skill 的最终回执`);
      visible.forEach((row) => {
        L.push(
          `    - ${row.turn_id}　${row.final.skills
            .map((x) => x.skill_id)
            .join('、')}（去重 ${row.final.distinct_skill_count} 个）`
        );
      });
    }
  }

  if (w.count) {
    L.push('');
    L.push('十三、工作事项（Work Activity）汇总');
    L.push(
      `  共 ${w.count} 项：Agent 工作 ${w.agent_count} 项，人工工作 ${w.manual_count} 项` +
        `　工作时长合计 ${w.total_duration_minutes === null ? NA_TEXT : w.total_duration_minutes + ' 分钟'}`
    );
    if (w.segment_count) {
      L.push(`  Work Segment ${w.segment_count} 段，其中 ${w.with_segment} 项事项已关联 Segment`);
    }
    if (w.without_conversation) {
      // 措辞要区分「为什么没有 Conversation」—— 两者含义不同：
      //   · 有 work_item_id → 从 WorkItem 导出的永久归档（自动采集，本就无对话关联）
      //   · 无 work_item_id 且 source=manual → 人工补录
      // 原先一律写成「人工记录」是错的（导出的自动事项被误称为人工）。
      const viaItem = w.via_work_item || 0;
      const manual = Math.max(0, w.without_conversation - viaItem);
      const parts = [];
      if (viaItem) parts.push(`${viaItem} 项由 WorkItem 导出（经 work_item_id 关联）`);
      if (manual) parts.push(`${manual} 项为人工记录`);
      L.push(`  其中 ${w.without_conversation} 项不含 Conversation：${parts.join('；')}`);
    }
    L.push(`  已完成 ${w.completed} 项，未完成/待确认 ${w.unfinished} 项`);
    L.push(`  项目分布：${fmtCounts(w.by_project)}`);
    L.push(`  工作类型分布：${fmtCounts(w.by_work_type)}`);
    if (Object.keys(w.by_ai_role || {}).length) {
      L.push(`  AI 角色分布：${fmtCounts(w.by_ai_role)}`);
    }
  }

  if (m.linkage && m.linkage.available) {
    L.push('');
    L.push('十四、AI 使用与工作事项的关联');
    m.linkage.groups.forEach((g) => {
      L.push(`  【${g.project}】`);
      g.activities.forEach((x) =>
        L.push(`    ├── ${x.display_content}${x.start_time ? `（${x.start_time}）` : ''}`)
      );
      g.conversations.forEach((c) => {
        L.push(`    │   └── Conversation ${c.conversation_id}（${c.agent}/${c.model_name}）`);
        if (c.skills.length) {
          c.skills.forEach((sk) =>
            L.push(
              `    │        └── ${sk.skill_id}@${sk.skill_version}　` +
                `Token：${sk.skill_token === null ? NA_TEXT : sk.skill_token}`
            )
          );
        }
      });
      L.push(
        `    └── 合计 ${num(g.total_token)} token　Score ${dash(g.total_score)}`
      );
    });
    if (m.linkage.ambiguous.length) {
      L.push('  ⚠ 归属有歧义（未计入任何项目合计）：');
      m.linkage.ambiguous.forEach((x) =>
        L.push(`    - 【${x.project}】${x.conversation_ids.join('、')}：${x.reason}`)
      );
    }
    L.push(`  关联规则：${m.linkage.rule}`);
  }

  /* ---------------- V3.3：AI 成本多维聚合（用户 §13/§14/§15） ---------------- */
  if (m.cost) {
    const c = m.cost;
    const pct = (v) => (typeof v === 'number' ? `${v}%` : NA_TEXT);

    L.push('');
    L.push('十五、AI 成本 · Skill 维度（调用次数 / Token / 积分）');
    L.push(
      `  合计：调用 ${c.skill.invocations} 次　Token ${num(c.skill.total_token)}` +
        `（占会话总 Token ${pct(c.skill.token_share_of_conversations)}）` +
        `　积分 ${NA_TEXT}（宿主不提供 Skill 级积分，禁止摊派）`
    );
    c.skill.by_skill.forEach((s) => {
      L.push(
        `    - ${s.skill_id}@${s.skill_version}　调用 ${s.invocations} 次` +
          `${s.failed ? `（失败 ${s.failed}）` : ''}` +
          `　关联事项 ${s.activity_count} 项`
      );
      L.push(
        `        累计 Token ${num(s.total_token)}　平均 ${num(s.avg_token)}` +
          `　最大 ${num(s.max_token)}　最小 ${num(s.min_token)}　最近一次 ${num(s.last_token)}`
      );
      // P2-5：载入字符的「累计」与「单次平均」分别呈现。
      // 只看累计看不出「低频但单次极重」的 Skill —— 那需要平均值。
      L.push(
        `        累计载入字符 ${num(s.load_chars)}　单次平均载入字符 ${num(s.avg_load_chars)}` +
          `${s.load_chars_known ? `（${s.load_chars_known}/${s.invocations} 次有数据）` : ''}`
      );
      L.push(
        `        累计积分 ${NA_TEXT}　平均积分 ${NA_TEXT}` +
          (s.token_unavailable
            ? `（${s.token_unavailable} 次调用 Token 不可获取，记 null）`
            : '')
      );
    });
    if (c.skill.version_comparison.length) {
      L.push('  Skill 版本成本对比（平均单次 Token）：');
      c.skill.version_comparison.forEach((v) => {
        const parts = v.versions.map(
          (x) => `${x.skill_version || '（无版本）'} ${num(x.avg_token)}（${x.invocations} 次）`
        );
        L.push(`    - ${v.skill_id}：${parts.join('　→　')}`);
      });
    }
    c.skill.notes.forEach((n) => L.push(`  · ${n}`));

    if (c.conversation_projects && c.conversation_projects.length) {
      L.push('');
      L.push('AI 使用 · Conversation 项目分布（范围口径）');
      c.conversation_projects.forEach((r) => {
        const tokenTail = r.token_unknown ? '（下界）' : '';
        const credit =
          r.score_status === 'not_applicable' || !r.score_known
            ? ''
            : `${r.score_status === 'lower_bound' ? '下界 ' : ''}${r.total_score}`;
        L.push(
          `    - ${r.key}　Conversation ${r.conversations}　请求 ${r.request_count}` +
            `　Token ${num(r.total_token)}${tokenTail}　积分 ${credit}`
        );
      });
    }

    const usage = c.usage_attribution;
    if (usage && usage.records) {
      L.push('');
      L.push('AI Usage 归属');
      L.push(
        `  已精确归属 Token ${num(usage.allocated_token)}` +
          `（占会话总 Token ${pct(usage.allocated_token_share)}）` +
          `　未归属 Token ${num(usage.unallocated_token)}`
      );
      L.push(
        `  已精确归属 Credit ${dash(usage.allocated_credit)}` +
          `　未归属 Credit ${dash(usage.unallocated_credit)}`
      );
      L.push(
        `  记录：exact ${usage.by_status.exact}　partial ${usage.by_status.partial}` +
          `　unallocated ${usage.by_status.unallocated}`
      );
      L.push(
        `  覆盖：${usage.coverage.activities_with_usage}/${usage.coverage.activities} 项 Work Activity ` +
          `有精确 AI Usage；Conversation ${usage.coverage.conversations_with_allocated_usage}/` +
          `${usage.coverage.conversations} 个已有归属记录`
      );
      if (usage.over_allocated) {
        L.push('  ⚠ 精确归属合计大于 Conversation 总账，请核对 AI Usage 记录。');
      }
      usage.notes.forEach((n) => L.push(`  · ${n}`));
    }

    const dimBlock = (title, rows, ambiguous, hint) => {
      L.push('');
      L.push(title);
      if (!rows.length) {
        L.push('  （本区间无可用记录）');
        return;
      }
      // 占比不可获取时不写括号 —— 否则出现「Token 不可获取（不可获取）」这类零信息量输出
      const shareTail = (v) => (typeof v === 'number' ? `（${pct(v)}）` : '');
      rows.forEach((r) => {
        const credit =
          typeof r.total_score === 'number' && r.score_known > 0 ? r.total_score : '';
        L.push(
          `    - ${r.key}　事项 ${r.activities} 项 / ${r.minutes} 分钟` +
            `　Token ${num(r.total_token)}${shareTail(r.token_share)}` +
            `　积分 ${credit}${shareTail(r.score_share)}`
        );
        const tail = [];
        if (r.without_conversation) tail.push(`${r.without_conversation} 项无会话关联（Token 不可归属）`);
        if (r.ambiguous_conversation_count) tail.push(`${r.ambiguous_conversation_count} 个对话归属有歧义`);
        if (r.outputs.length) tail.push(`成果：${r.outputs.map((o) => String(o).slice(0, 40)).join('；')}`);
        if (tail.length) L.push(`        ${tail.join('　')}`);
      });
      if (ambiguous && ambiguous.length) {
        L.push(`    ⚠ 归属有歧义（未计入任何一方）：${ambiguous.length} 个对话 — ${hint}`);
      }
    };

    dimBlock('十六、AI 成本 · 工作类型维度', c.by_work_type, c.by_work_type_ambiguous, '同一对话服务多个工作类型');
    dimBlock('十七、AI 成本 · 项目维度', c.by_project, c.by_project_ambiguous, '同一对话服务多个项目');
    dimBlock('十八、AI 成本 · 项目阶段维度', c.by_project_stage, c.by_project_stage_ambiguous, '同一对话跨多个阶段');

    const allocatedDimBlock = (title, rows) => {
      if (!rows || !rows.length) return;
      L.push('');
      L.push(title);
      rows.forEach((r) => {
        L.push(
          `    - ${r.key}　事项 ${r.activities} 项 / 记录 ${r.records} 条` +
            `　Token ${num(r.total_token)}　Credit ${dash(r.total_credit)}`
        );
      });
    };
    allocatedDimBlock('AI Usage · 工作类型精确归属', c.allocated_by_work_type);
    allocatedDimBlock('AI Usage · 项目精确归属', c.allocated_by_project);
    allocatedDimBlock('AI Usage · 项目阶段精确归属', c.allocated_by_project_stage);

    if (c.project_stages.length) {
      L.push('');
      L.push('十九、项目 × 阶段（时间 / Token / 积分）');
      c.project_stages.forEach((p) => {
        L.push(
          `  【${p.project}】${p.minutes} 分钟　Token ${num(p.total_token)}　积分 ${dash(p.total_score)}`
        );
        p.stages.forEach((s) => {
          L.push(
            `    ├── ${s.stage}　${s.activities} 项 / ${s.minutes} 分钟` +
              `　Token ${num(s.total_token)}　积分 ${dash(s.total_score)}`
          );
        });
      });
      if (c.project_stage_ambiguous && c.project_stage_ambiguous.length) {
        L.push(
          `    ⚠ 归属有歧义（同一会话落在多个 (项目, 阶段) 格子，未计入任何一方）：` +
            `${c.project_stage_ambiguous.length} 个对话`
        );
      }
    }
    L.push('');
    L.push(
      `  归因覆盖率：${c.attribution_coverage.activities} 条事项中 ` +
        `${c.attribution_coverage.with_conversation} 条带 conversation_id` +
        `（区间内会话 ${c.attribution_coverage.conversations} 个）` +
        '　—— 未关联的 Token/积分记 null，不摊派、不估算。'
    );
    L.push(`  归因规则：${c.attribution_rule}`);
    c.notes.forEach((n) => L.push(`  · ${n}`));
  }

  return L;
}

function fmtCounts(obj) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return '（无）';
  return keys
    .sort((a, b) => obj[b] - obj[a])
    .map((k) => `${k} ×${obj[k]}`)
    .join('　');
}

/** 时间段展示：10:24-19:00 / 10:24- / （未记录） */
function spanText(start, end) {
  const hhmm = (iso) => {
    if (!iso) return null;
    const m = /T(\d{2}:\d{2})/.exec(String(iso));
    return m ? m[1] : null;
  };
  const s = hhmm(start);
  const e = hhmm(end);
  if (s && e) return `${s}-${e}`;
  if (s) return `${s}-`;
  return '（未记录）';
}

module.exports = {
  NA_TEXT,
  buildMetrics,
  buildMetricsRange,
  buildFrom,
  buildLinkage,
  // V3.3：AI 成本多维聚合
  buildCostStats,
  buildSkillCost,
  attributeDimension,
  allocatedDimension,
  buildAiUsageStats,
  shareOf,
  renderMetrics,
  spanText,
  fmtCounts,
  toMinutes,
};
