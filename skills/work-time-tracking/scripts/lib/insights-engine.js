'use strict';
/**
 * insights-engine.js —— 「AI 使用洞察」报告（V3.6，用户 2026-09-24）。
 *
 * 用户原话（2026-09-24）：
 *   「我想要知道我的 skill 使用情况、各个模型的使用情况，我在各个 skill、
 *     各项工作阶段或者各个项目上的 token/积分的使用分布，这样我才能总结出
 *     哪个 skill 是我高频 skill，哪个 skill 比较好用，哪个我压根用不上，
 *     或者哪个对我消耗有点高；哪个 ai 模型比较有用；项目工作中哪个阶段
 *     比较侧重在 AI 上。」
 *
 * 设计原则：
 *   1. **只读 Structured Logs + 本地清单** —— 不重扫历史对话、零 Token、零出网；
 *   2. **数字全部规则驱动** —— 「高频 / 用不上 / 消耗偏高」都有可复核的判据，
 *      不产出主观评分（那是撰写环节的解读，不是脚本的职责）；
 *   3. **守住成本铁律** —— 不把会话 Token 摊派给 Skill；
 *      Skill 级积分为 null；Token 与积分互不换算；取不到就是 null 而不是 0。
 */

const C = require('./log-core');
const INS = require('./skill-inventory');

const U = null;

const num = (v) => (typeof v === 'number' ? v : U);
const fmt = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : '不可获取');
const pct = (v) => (typeof v === 'number' ? `${v}%` : U);
const textOf = (v) => (v === U || v === null || v === undefined ? '不可获取' : v);

/**
 * 汇总 Skill 使用情况（含「高频 / 低频 / 装了没用」三类判据）。
 *
 * 「消耗偏高」的判据（三项同时成立才算，避免误伤）：
 *   ① 载入体积（A 口径）高于同批中位数
 *   ② 平均单次调用所在请求用量（B 口径）高于同批中位数
 *   ③ 调用次数达到高频阈值
 *
 * ⚠️ A/B 口径都**不是真实消耗**（真实消耗不可精确归属），报告里必须标注。
 */
function buildSkillInsights(metrics, inventory, insCfg) {
  const top = (metrics && metrics.skill) || {};
  const costSkill = (metrics && metrics.cost && metrics.cost.skill) || {};
  // 两处聚合互补，必须合并成一行再看：
  //   cost.skill.by_skill → A 口径（total_token / avg_token / last_at / load_chars）
  //   metrics.skill.by_skill → B 口径（call_request_avg_token）与涉及会话数
  // 注意两边的「载入 Token」字段名不同（`total_token` vs `skill_token`），
  // 早期版本在这里取错了字段，导致载入体积恒显示「不可获取」。
  const bRows = new Map(
    (Array.isArray(top.by_skill) ? top.by_skill : []).map((r) => [
      `${r.skill_id}@${r.skill_version}`,
      r,
    ])
  );
  const rows = (Array.isArray(costSkill.by_skill) ? costSkill.by_skill : []).map((r) => {
    const b = bRows.get(`${r.skill_id}@${r.skill_version}`) || {};
    return {
      ...r,
      last_at: r.last_at ?? U,
      // P2-5：载入字符的「总量」与「单次平均」。
      // 总量跟着 `...r` 进来（cost.skill 有 load_chars）；
      // 平均值显式兜底，缺失就是 U（不可获取），**不填 0**。
      load_chars: typeof r.load_chars === 'number' ? r.load_chars : U,
      avg_load_chars: typeof r.avg_load_chars === 'number' ? r.avg_load_chars : U,
      call_request_avg_token: b.call_request_avg_token ?? U,
      conversation_count:
        typeof r.conversation_count === 'number'
          ? r.conversation_count
          : typeof b.conversation_count === 'number'
            ? b.conversation_count
            : U,
    };
  });
  const topN = insCfg.top_n;

  const invocationsOf = (r) => Number(r.invocations) || 0;
  // 排序必须**确定**（同次数时再看载入体积、最后看名字），
  // 否则同一份数据两次运行可能给出不同的「高频榜」。
  const loadOf = (r) => (typeof r.total_token === 'number' ? r.total_token : -1);
  // P2-5：单次平均载入字符。仅用于展示，不参与排序 ——
  // 混进排序会把「高频」和「单次重」两种不同口径的榜混为一谈。
  const avgLoadOf = (r) => (typeof r.avg_load_chars === 'number' ? r.avg_load_chars : -1);
  const byInvocations = rows
    .slice()
    .sort(
      (a, b) =>
        invocationsOf(b) - invocationsOf(a) ||
        loadOf(b) - loadOf(a) ||
        String(a.skill_id).localeCompare(String(b.skill_id))
    );
  const used = byInvocations.filter((r) => invocationsOf(r) > 0);

  const median = (arr) => {
    const v = arr.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
    if (!v.length) return U;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };
  const loadValues = used.map((r) => num(r.total_token));
  // B 口径（调用所在请求用量）才是「单次贵不贵」的可比口径；
  // 拿不到 B 值的（如 Codex 侧不暴露载入体积与请求用量）不参与中位数，也不硬套 A 口径。
  const callValues = used.map((r) => num(r.call_request_avg_token));
  const loadMedian = median(loadValues);
  const callMedian = median(callValues);

  const high_frequency = used.slice(0, topN);
  const low_frequency = used.filter((r) => invocationsOf(r) <= 1);

  // 「消耗偏高」候选：三项判据同时成立（调用够多 + 载入体积高于中位数 + 平均单次请求用量高于中位数）。
  // B 口径整体不可用时（例如宿主不暴露请求用量）退化为「载入体积高于中位数」单判据，
  // 并在报告里标明口径降级 —— 不假装有 B 数据。
  const bUsable = callMedian !== U;
  const expensive = used.filter((r) => {
    const load = num(r.total_token);
    const enough = invocationsOf(r) >= 3;
    if (!enough || load === U || loadMedian === U || load <= loadMedian) return false;
    if (!bUsable) return true;
    const call = num(r.call_request_avg_token);
    return call !== U && call > callMedian;
  });
  const expensiveBasis = bUsable ? 'load_and_call' : 'load_only';

  const inv = inventory || null;
  return {
    // 区间内调用总数与会话覆盖
    invocation_total: used.reduce((s, r) => s + invocationsOf(r), 0),
    skill_count: used.length,
    conversation_count_with_skill: top.conversation_count_with_skill ?? U,
    conversation_count_without_skill: top.conversation_count_without_skill ?? U,
    by_skill: byInvocations,
    high_frequency,
    low_frequency,
    expensive,
    expensive_basis: expensiveBasis,
    load_token_total:
      typeof top.load_token_total === 'number'
        ? top.load_token_total
        : typeof costSkill.total_token === 'number'
          ? costSkill.total_token
          : U,
    // 本机清单对账
    inventory_summary: inv
      ? {
          roots: inv.roots,
          installed_count: inv.installed_count,
          deployed_count: inv.deployed_count,
          used_count: inv.used_count,
          stale_days: inv.stale_days,
        }
      : U,
    never_used: inv ? inv.never_used : U,
    stale: inv ? inv.stale : U,
    used_not_installed: inv ? inv.used_not_installed : U,
    thresholds: {
      top_n: topN,
      stale_days: inv ? inv.stale_days : insCfg.stale_days,
      load_median: loadMedian,
      call_median: callMedian,
    },
  };
}

/**
 * 组装完整洞察视图（供渲染与 AI 解读共用）。
 *
 * @param {object} metrics buildMetrics / buildMetricsRange 的结果
 * @param {object} opts { config, inventory, now }
 */
function buildInsights(metrics, opts) {
  const o = opts || {};
  const m = metrics || {};
  const cfg = o.config || {};
  const insCfg = Object.assign(
    { enabled: true, stale_days: 30, top_n: 5 },
    (cfg.summary && cfg.summary.insights) || {}
  );
  const cost = m.cost || {};
  const agent = m.agent || {};
  const models = m.models || { rows: [], rule: null, raw_name_count: 0 };

  const skills = buildSkillInsights(m, o.inventory || null, insCfg);

  // 未归属 Token / 积分（会话总量 − 已精确归属）——由成本口径给出，不在这里重算
  const usage = cost.usage_attribution || {};
  return {
    kind: 'ai_insights',
    scope: { date: m.date || null, from: m.from || null, to: m.to || null },
    generated_at: C.nowIso(),
    source_of_truth: 'structured_logs_only',
    overview: {
      conversation_count: agent.conversation_count || 0,
      settled: agent.settled || 0,
      partial_or_failed: agent.partial_or_failed || 0,
      request_count: agent.request_count || 0,
      by_agent: agent.by_agent || {},
      by_source: agent.by_source || {},
      total_token: num(agent.total_token),
      input_token: num(agent.input_token),
      output_token: num(agent.output_token),
      cached_token: num(agent.cached_token),
      reasoning_token: num(agent.reasoning_token),
      total_score: num(agent.total_score),
      score_request_count: agent.score_request_count || 0,
      score_applicable_requests: agent.score_applicable_requests || 0,
      score_not_applicable_conversations: agent.score_not_applicable_conversations || 0,
      score_is_lower_bound: agent.score_is_lower_bound ?? U,
    },
    skills,
    models: {
      rows: models.rows || [],
      rule: models.rule || null,
      raw_name_count: models.raw_name_count || 0,
      normalized_count: (models.rows || []).length,
    },
    cost_distribution: {
      // 工作口径（剔除探索沉淀/生活）：主视图，回答「项目工作哪个阶段更依赖 AI」
      by_project: cost.by_project_work || [],
      by_project_ambiguous: cost.by_project_work_ambiguous || [],
      by_project_stage: cost.by_project_stage_work || [],
      by_project_stage_ambiguous: cost.by_project_stage_work_ambiguous || [],
      by_work_type: cost.by_work_type_work || [],
      by_work_type_ambiguous: cost.by_work_type_work_ambiguous || [],
      // 全量口径（含探索沉淀/生活）：并排的第二张表，与上面**不可相加**
      by_project_all: cost.by_project || [],
      by_project_stage_all: cost.by_project_stage || [],
      by_work_type_all: cost.by_work_type || [],
      conversation_projects: cost.conversation_projects || [],
      // 事项级精确归属（AI Usage Record）
      allocated_by_project: cost.allocated_by_project || [],
      allocated_by_project_stage: cost.allocated_by_project_stage || [],
      allocated_by_work_type: cost.allocated_by_work_type || [],
      allocation: usage.allocated || U,
      unallocated: usage.unallocated || U,
    },
    // 工作口径优先（回答「项目工作哪个阶段更依赖 AI」），全量口径作为补充
    project_stage_focus: cost.project_stages_work || [],
    project_stage_focus_all: cost.project_stages || [],
    coverage: cost.attribution_coverage || {},
    attribution_rule: cost.attribution_rule || null,
    notes: [
      'Skill 的 Token 是 **A 口径「载入体积」**（Skill 定义被注入上下文的成本），' +
        '可精确归因，但**不是真实消耗**；真实消耗无法精确归属到 Skill，禁止按比例摊派。',
      'Skill 级积分**不存在**（宿主只提供会话级 credit）→ 一律 null。',
      'Token 与积分是两个独立指标，同时给出、互不换算。',
      '「按项目 / 项目阶段 / 工作类型」的 Token 是**会话级范围口径**：' +
        '一个会话在同一维度被多个取值引用时，该会话不计入任何一方。',
      '取不到的值一律 null（不可获取），与「真实观察到 0 消耗」严格区分。',
    ],
  };
}

/** 渲染「Skill 盘点」块 */
function renderSkillSection(skills, L) {
  L.push('## 二、Skill 盘点');
  L.push('');
  L.push(
    `  本区间调用 ${skills.invocation_total} 次，涉及 ${skills.skill_count} 个 Skill` +
      (skills.conversation_count_with_skill !== U
        ? `；有 Skill 的会话 ${textOf(skills.conversation_count_with_skill)} 个，` +
          `未记录 Skill 的会话 ${textOf(skills.conversation_count_without_skill)} 个`
        : '')
  );
  L.push(`  Skill 载入体积合计 ${fmt(skills.load_token_total)}（A 口径：载入体积，非真实消耗）`);
  L.push('');

  if (!skills.by_skill.length) {
    L.push('  （本区间无 Skill 调用记录）');
    L.push('');
  } else {
    L.push('  · 高频 Skill（按调用次数）');
    skills.high_frequency.forEach((r) => {
      L.push(
        `      ${r.skill_id}@${r.skill_version ?? '（无版本）'}　调用 ${r.invocations} 次` +
          `　载入 ${fmt(num(r.total_token))}　单次平均载入 ${fmt(num(r.avg_load_chars))} 字符` +
          `　涉及会话 ${fmt(num(r.conversation_count))}`
      );
    });
    L.push('');
    if (skills.expensive.length) {
      L.push(
        '  · 消耗偏高候选（' +
          (skills.expensive_basis === 'load_and_call'
            ? '载入体积与平均单次请求用量同时高于同批中位数，且调用 ≥3 次'
            : '载入体积高于同批中位数，且调用 ≥3 次（B 口径不可用，已降级为单判据）') +
          '）'
      );
      skills.expensive.forEach((r) => {
        L.push(
          `      ${r.skill_id}　调用 ${r.invocations} 次　载入 ${fmt(num(r.total_token))}` +
            `　单次平均载入 ${fmt(num(r.avg_load_chars))} 字符` +
            `　平均单次请求用量 ${fmt(num(r.call_request_avg_token))}`
        );
      });
      L.push('      以上均为 A/B 口径参考值，**不是**真实消耗，不要据此下「贵」的结论。');
      L.push('');
    }
    L.push('  · 全部 Skill 调用明细');
    skills.by_skill.forEach((r) => {
      L.push(
        `      ${r.skill_id}@${r.skill_version ?? '（无版本）'}　${r.invocations} 次` +
          `　载入 ${fmt(num(r.total_token))}　单次平均载入 ${fmt(num(r.avg_load_chars))} 字符` +
          `　最近 ${r.last_at ?? '不可获取'}`
      );
    });
    L.push('');
    // P2-5：口径提示。单次平均载入字符只在**有该字段的调用**上求均值，
    // codex 通道全部缺该字段，故横向比较必须知道样本覆盖情况。
    L.push('      注：「单次平均载入」按**有载入字符数据的调用**求均值；缺失该数据的调用不计入分母，');
    L.push('          故它反映的是「有数据时的单次成本」，样本覆盖率见各 Skill 明细。');
    L.push('');
  }

  const inv = skills.inventory_summary;
  if (inv) {
    L.push(
      `  · 本机清单：已安装 ${inv.installed_count} 个，已部署 ${inv.deployed_count} 个，` +
        `本区间使用 ${inv.used_count} 个`
    );
    const scanRoots = (inv.roots || [])
      .map((r) => `${r.label}${r.exists ? `×${r.skill_count}` : '（目录不存在）'}`)
      .join('　');
    if (scanRoots) L.push(`      扫描范围：${scanRoots}`);
  }
  if (Array.isArray(skills.never_used) && skills.never_used.length) {
    L.push(`  · 装了但本区间没用过（${skills.never_used.length} 个，最多列 20）`);
    skills.never_used.slice(0, 20).forEach((r) => {
      L.push(`      ${r.skill_id}　部署于 ${r.deployed_in.join('/') || '（仅中央库）'}`);
    });
    if (skills.never_used.length > 20) {
      L.push(`      ……另有 ${skills.never_used.length - 20} 个未列出`);
    }
  }
  if (Array.isArray(skills.stale) && skills.stale.length) {
    L.push(`  · 曾经用过、但已超过 ${skills.thresholds.stale_days} 天未调用`);
    skills.stale.forEach((r) => {
      L.push(`      ${r.skill_id}　最后使用 ${r.last_used_at}　已 ${r.days_since_last_use} 天`);
    });
  }
  if (Array.isArray(skills.used_not_installed) && skills.used_not_installed.length) {
    L.push(
      `  · 日志里用过但清单里找不到（${skills.used_not_installed.length} 个，可能是改名或已卸载）：` +
        skills.used_not_installed.join('、')
    );
  }
  L.push('');
}

/** 渲染「模型使用对比」块 */
function renderModelSection(models, L) {
  L.push('## 三、模型使用对比');
  L.push('');
  if (!models.rows.length) {
    L.push('  （本区间无 Conversation 记录）');
    L.push('');
    return;
  }
  if (models.raw_name_count > models.normalized_count) {
    L.push(
      `  归一提示：日志里出现 ${models.raw_name_count} 种模型写法，` +
        `归一为 ${models.normalized_count} 个模型（原文列在 JSON 的 raw_names）。`
    );
    L.push('');
  }
  L.push('  | 模型 | 会话 | 请求 | Token | 占比 | 缓存命中率 | 平均单请求 | 积分 |');
  L.push('  |---|---|---|---|---|---|---|---|');
  models.rows.forEach((r) => {
    // 走模型 API 的会话本就不产生积分 → 这里**留空**，不写 0
    // （0 表示「真实观察到零消耗」，与「本就不适用」语义不同）
    const credit =
      r.score_known_conversations === 0 && r.score_not_applicable_conversations > 0
        ? ''
        : textOf(r.total_score);
    L.push(
      `  | ${r.model} | ${r.conversation_count} | ${r.request_count} | ${fmt(r.total_token)} | ` +
        `${textOf(pct(r.token_share))} | ${textOf(pct(r.cache_hit_rate))} | ` +
        `${fmt(r.avg_token_per_request)} | ${credit} |`
    );
  });
  L.push('');
  L.push('  说明：一次会话的 Token 整体记给**记录里的主模型**，不按会话内多模型拆分（拆分会变成估算）。');
  L.push('  缓存命中率 = 缓存读 Token ÷ 总 Token；积分只在计分类 Agent 上存在，其余留空。');
  L.push('');
}

/** 渲染「成本分布」块 */
function renderCostDistribution(cd, L) {
  L.push('## 四、成本分布（按维度）');
  L.push('');
  const dimRow = (r, keyName) =>
    `      ${r.key}　会话 ${fmt(num(r.conversation_count))}　Token ${fmt(r.total_token)}` +
    `　占比 ${textOf(pct(r.token_share))}　积分 ${textOf(r.total_score)}` +
    (r.ambiguous_conversation_count
      ? `　（${r.ambiguous_conversation_count} 个会话归属有歧义，未计入）`
      : '') +
    (r.without_conversation ? `　（${r.without_conversation} 条事项无会话证据）` : '');

  const block = (title, rows, keyName) => {
    L.push(`  · ${title}`);
    if (!rows || !rows.length) {
      L.push('      （本区间无可用记录）');
      L.push('');
      return;
    }
    rows.forEach((r) => L.push(dimRow(r, keyName)));
    L.push('');
  };

  L.push('  （下面三张表是**工作口径**：剔除探索沉淀与生活类事项，' +
    '回答「项目工作哪个阶段更依赖 AI」；与末尾的全量口径不可相加。）');
  L.push('');
  block('按项目（工作口径 · 会话级范围）', cd.by_project);
  block('按项目阶段（工作口径 · 会话级范围）', cd.by_project_stage);
  block('按工作类型（工作口径 · 会话级范围）', cd.by_work_type);

  const allHasData = (cd.by_project_all || []).length;
  if (allHasData) {
    block('按项目（全量口径，含探索沉淀/生活；与上表不可相加）', cd.by_project_all);
  }

  L.push('  · 会话级范围口径的项目分布（不看事项，直接按 Conversation 的 project）');
  if (!cd.conversation_projects.length) {
    L.push('      （本区间无可用记录）');
  } else {
    cd.conversation_projects.forEach((r) => {
      // Conversation 项目分布的字段名是 `conversations`（会话数），不是 conversation_count
      const convN = r.conversations ?? r.conversation_count;
      L.push(
        `      ${r.key ?? r.project ?? '（未归属项目）'}　会话 ${fmt(num(convN))}` +
          `　请求 ${fmt(num(r.request_count))}　Token ${fmt(r.total_token)}　积分 ${textOf(r.total_score)}`
      );
    });
  }
  L.push('');

  const alloc = cd.allocation;
  L.push('  · 事项级精确归属（AI Usage Record，与上面的范围口径**不可相加**）');
  if (alloc && (typeof alloc.total_token === 'number' || typeof alloc.total_credit === 'number')) {
    L.push(
      `      已归属 Token ${fmt(alloc.total_token)}　已归属积分 ${textOf(alloc.total_credit)}` +
        `　记录 ${fmt(num(alloc.record_count))} 条`
    );
  } else {
    L.push('      （本区间无 AI Usage 精确归属记录；补齐方式见「口径与限制」）');
  }
  block('按项目（精确归属）', cd.allocated_by_project);
  block('按项目阶段（精确归属）', cd.allocated_by_project_stage);
  block('按工作类型（精确归属）', cd.allocated_by_work_type);
}

/** 渲染「项目阶段侧重」块 */
function renderStageFocus(projectStages, L) {
  L.push('## 五、项目阶段侧重（哪个阶段最依赖 AI）');
  L.push('');
  L.push('  口径：工作事项（剔除探索沉淀 / 生活），按 项目 → 阶段 拆分会话级 Token。');
  L.push('');
  if (!projectStages.length) {
    L.push('  （本区间无带项目阶段的活动记录；需先有带 conversation_id 的 Work Activity）');
    L.push('');
    return;
  }
  projectStages.forEach((p) => {
    L.push(
      `  · ${p.project}　事项 ${p.stages.reduce((s, x) => s + (Number(x.activities) || 0), 0)} 项` +
        ` / ${p.minutes} 分钟　Token ${fmt(p.total_token)}`
    );
    p.stages.forEach((s) => {
      L.push(
        `      ${s.stage}　${s.activities} 项 / ${s.minutes} 分钟` +
          `　会话 ${fmt(num(s.conversation_count))}　Token ${fmt(s.total_token)}`
      );
    });
  });
  L.push('');
  L.push('  注意：阶段维度的 Token 只统计「会话在该维度唯一归属」的部分，' +
    '同一会话横跨多个阶段时会因歧义而不计入任何阶段。');
  L.push('');
}

/** 渲染「口径与限制」块 */
function renderNotation(insights, L) {
  L.push('## 七、口径与限制');
  L.push('');
  insights.notes.forEach((n) => L.push(`  · ${n}`));
  const cov = insights.coverage || {};
  if (Object.keys(cov).length) {
    L.push(
      `  · 归因覆盖率：${fmt(num(cov.activities))} 条事项中 ` +
        `${fmt(num(cov.with_conversation))} 条带 conversation_id（区间内会话 ` +
        `${fmt(num(cov.conversations))} 个）`
    );
  }
  if (!insights.cost_distribution.allocation) {
    L.push(
      '  · 事项级精确归属为空的原因：结算时未传 `--ai-usage-file`。' +
        '需要「按项目/阶段的花费」时，在结算里带上 AI Usage 记录即可，脚本不会替它估算。'
    );
  }
  L.push('');
}

/**
 * 渲染完整洞察报告（供脚本输出与 `save` 落盘）。
 */
function renderInsights(insights) {
  const s = insights.scope || {};
  const span = s.from && s.to ? (s.from === s.to ? s.from : `${s.from}..${s.to}`) : s.date || '';
  const L = [];
  L.push(`# AI 使用洞察（${span}）`);
  L.push('');
  L.push('> 只读 Structured Logs 与本地 Skill 清单；未重扫历史对话、零 Token、零出网。');
  L.push('');

  /* 一、总览 */
  const o = insights.overview;
  L.push('## 一、AI 使用总览');
  L.push('');
  L.push(`  Conversation ${o.conversation_count} 次（结算完成 ${o.settled}）　请求 ${o.request_count} 次`);
  L.push(
    `  Token ${fmt(o.total_token)}（输入 ${fmt(o.input_token)} / 输出 ${fmt(o.output_token)}）` +
      `　缓存命中 ${fmt(o.cached_token)}　推理 ${fmt(o.reasoning_token)}`
  );
  L.push(
    `  积分 ${fmt(o.total_score)}` +
      (o.score_not_applicable_conversations
        ? `（其中 ${o.score_not_applicable_conversations} 次走模型 API，本就不计积分）`
        : '') +
      (o.score_is_lower_bound === true ? '　⚠ 覆盖不全，为下界' : '')
  );
  const counts = (obj) =>
    Object.entries(obj || {})
      .map(([k, v]) => `${k} ×${v}`)
      .join('　');
  if (counts(o.by_agent)) L.push(`  Agent 分布：${counts(o.by_agent)}`);
  if (counts(o.by_source)) L.push(`  来源分布：${counts(o.by_source)}`);
  L.push('');

  renderSkillSection(insights.skills, L);
  renderModelSection(insights.models, L);
  renderCostDistribution(insights.cost_distribution, L);
  renderStageFocus(insights.project_stage_focus, L);

  /* 六、解读提示（留给撰写环节） */
  L.push('## 六、解读提示（撰写时按此组织，不要编造数字）');
  L.push('');
  L.push('  · 高频：看「二、Skill 盘点」的调用次数排序。');
  L.push('  · 用不上：看「装了但本区间没用过」与「超过 N 天未调用」。');
  L.push('  · 消耗偏高：看「消耗偏高候选」，并**必须**说明它是 A/B 口径参考值而非真实消耗。');
  L.push('  · 模型：看「三、模型使用对比」的会话数、Token 占比、缓存命中率、平均单请求。');
  L.push('  · 项目阶段侧重：看「五、项目阶段侧重」，并如实说明歧义与空数据原因。');
  L.push('');

  renderNotation(insights, L);
  while (L.length && L[L.length - 1] === '') L.pop();
  return L;
}

module.exports = {
  buildSkillInsights,
  buildInsights,
  renderInsights,
};
