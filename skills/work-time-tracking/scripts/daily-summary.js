#!/usr/bin/env node
'use strict';
/**
 * daily-summary.js — 今日记录视图与每日总结（§24/§25/§26/§38）。
 *
 * §38：每日总结由**宿主定时任务**触发 /summary，或由用户手动执行；
 * 本脚本不创建任何定时器（§43）。自动总结最多每日一次（§18）。
 *
 * §25：必须保留 Raw Activity → WorkItem → DailySummary 链条，
 * AI 总结不得覆盖原始记录。
 *
 * §26：总结**不应机械复制 Activity** ——
 * 「过滤无关对话 + 合并相关事项」由 `lib/summary-engine.js` 在**总结层**完成，
 * 采集层（current.json.records）保持完整不受影响。
 *
 * 用法：
 *   daily-summary.js today [--json]       今日记录（原始记录，不做过滤）
 *   daily-summary.js material [--json]    总结素材（经过滤与合并）
 *   daily-summary.js draft [--json]       §24 九项确定性草稿（经过滤与合并）
 *   daily-summary.js save --text "..." [--trigger manual|auto_scheduled] [--no-ai]
 */

const fs = require('fs');
const path = require('path');

const C = require('./lib/log-core');
const SE = require('./lib/summary-engine');
const SP = require('./lib/space-projects');
const RP = require('./lib/role-profile');
const CS = require('./lib/conversation-store');
const ME = require('./lib/metrics-engine');
// V3.6：AI 使用洞察（Skill 盘点 / 模型对比 / 成本分布 / 项目阶段侧重）
const IE = require('./lib/insights-engine');
const SI = require('./lib/skill-inventory');

const USAGE = `daily-summary.js — 今日记录视图与自定义周期总结

  数据源：
    · 当日记录     → 日志目录下的 current.json（当天日志），不读 pending/
    · 历史区间记录 → logs/<date>/work-activities.jsonl（永久，WorkItem 每日导出）
    · AI 成本      → logs/<date>/{conversations,skill-usage}.jsonl（只读汇总，
                     不重新扫描历史对话、不重算 Token 与 Score）

  today [--json]        今日工作 / 进行中 / 待确认（直接读 current.json）
  material [--json]     总结素材：WorkItem 与统计 + AI 使用与成本汇总
  draft [--json]        每日总结草稿（用户 2026-09-22 的七段结构）
                        [--verbose] 追加明细章节（项目维度 / 时间线 / 异常时间段…）
  metrics [--json]      只输出 AI 使用与成本汇总
  insights [day|week|month|project] [--json] [--save] [--recheck]
                        AI 使用洞察报告（V3.6）：高频 Skill / 装了没用过 /
                        消耗偏高 / 模型对比 / 项目与项目阶段成本分布
                        默认今天；--days N / --from --to / --project <名>
                        --save 落盘 summaries/<key>-insights.md
  week [--json]         周总结草稿（默认本周一~今天；可用 --days N / --from --to）
  month [--json]        月总结草稿（默认本月 1 日~今天；可用 --month YYYY-MM）
  project --project <名称> [--json]
                        项目总结草稿（默认该项目全部已记录日期；可用 --from --to）
  save --text "..."     保存总结（同时写出 summaries/<file>.md）
                        --kind daily|week|month|project（默认 daily）
                        --key <YYYY-Www|YYYY-MM|项目名>（week/month/project 用）
                        --trigger manual（默认，不受安全熔断限制）
                        --trigger auto_scheduled（宿主定时任务，受 §35 限制且每日一次）
                        --no-ai 表示草稿直出、未用 AI
  --dir <路径> --actor <标识>
  --date <YYYY-MM-DD>   仅作校验：必须与 current.json 的日期一致（历史日期不支持日总结）
  --no-stale            关闭「已落盘日报过期检测」（V3.27；默认开启）

  纪律：分类（工作/探索沉淀/生活/…）决定是否套用产品经理视角；
        探索沉淀（AI 工具/Skill/MCP 建设）**不计**职业产出，更不得混进「工作」；
        非工作事项**不得**被解释成职业产出；成果只写记录里真实存在的 output。
`;

/**
 * §24 + V3.6（用户 2026-09-24）：每日总结必须覆盖的章节。
 *
 * 七段固定结构 —— 关键变化：**工作与探索沉淀彻底分家**。
 *
 * 用户原话：
 *   「我希望在总结中区别工作上、探索沉淀或者生活上……现在的总结都是
 *     我解决了什么问题，这个是我在 ai 方面对自己的探索沉淀，
 *     但在工作上面，没有很体现我的实际工作内容。」
 */
const REQUIRED_SECTIONS = [
  '1. 今日概览（工作 / 探索沉淀 / 生活 三线并出，含计数与时长）',
  '2. 工作（按 产品线/项目 → 项目阶段 → 交付物 组织；只含 category = 工作，不得出现探索沉淀与生活事项）',
  '3. 探索沉淀（优先写 Skill / 工具的用户可感知能力变化；纯修复与稳定性维护折叠为计数，不占主位）',
  '4. 今日成果（只列记录中真实存在的 output，不得虚构）',
  '5. 生活与个人事项（生活 / 个人成长 / 健康运动 / 休闲娱乐，简要总结，不过度分析）',
  '6. 时间结构（工作 / 探索沉淀 / 生活 / 个人成长 / 健康运动 / 休闲娱乐 / 其他）',
  '7. AI 使用情况（会话 / Token / 积分 + 按 Skill、模型、工作类型、项目、项目阶段展示分布）',
];

/** 周期总结（周 / 月 / 项目）必须覆盖的要点（用户 §17/§18/§19） */
const PERIOD_SECTIONS = {
  week: [
    '时间投入',
    '项目投入',
    '产品经理工作类型分布',
    '主要工作成果',
    '项目阶段进展',
    '生活 / 运动 / 个人成长',
    'AI Token',
    'AI Score / 积分',
    'Skill 消耗',
  ],
  month: [
    '主要项目',
    '各项目时间投入',
    '各项目 AI Token / 积分',
    '工作类型分布',
    '项目阶段分布',
    '主要产品成果',
    '个人成长',
    '生活 / 运动',
    'AI 使用趋势',
  ],
  project: [
    '总投入时间',
    '总 AI Token',
    '总 AI Score',
    '各阶段（需求 / 设计 / 开发 / 测试 / 上线 / 运营迭代）的时间 / Token / 积分',
    '主要工作成果',
  ],
};

/**
 * 撰写纪律（§24 + 2026-09-21 教训）。
 *
 * ```text
 * ✗ 只依据 records 下结论。
 *   records 只是「已归类」的部分；采集到但未归类的事件都在 pending_items 里。
 *   2026-09-21 曾因此把 22 条真实产品工作（气象数据 17 + 云浮门户 5）漏掉，
 *   并错误断言「今日无产品交付物产出」。
 *
 * ✓ 断言前必须先看待判断事项：
 *   · pending 非空时，禁止出现「无 X 产出」「全部是 Y」这类**排他性结论**；
 *   · 「待确认事项」章节必须列出内容与按项目分布；
 *   · 数量必须与 material 输出一致（不要把 50 写成 45）。
 * ```
 */
const SUMMARY_DISCIPLINE = [
  '待判断事项非空时，**不得**对当日产出下排他性结论（如「无产品交付物产出」「全部为工具建设」）。',
  '「待确认事项」必须列出内容与按项目分布，不能只报条数。',
  '引用计数前先与 material 输出的数字核对。',
  '探索沉淀优先描述新增 / 调整 / 移除的用户可感知能力；不要写文件名、函数名、报错堆栈。',
  '查看日志、环境恢复、任务重跑与自动化结果属于过程 / 维护活动；除非形成明确 output，否则不进主总结。',
];

/**
 * 展示用文本（§28 + 用户指定的输出格式）。
 *
 * 项目工作统一用 `【项目名称】【功能/模块名称】事项内容`；
 * 既无项目也识别不出模块的（如生活事项）沿用原显示，避免套上「【其他工作】【未分类】」。
 */
const showOf = (rec) => {
  const t = SE.buildItemTitle(rec);
  // 能识别模块，或有「项目 + 工作类型」→ 用【项目】【模块】格式
  // 否则（生活事项、既无模块也无类型）沿用原显示，避免出现「【运动计划】【未分类】散步」
  if (rec.project_name || t.module) return t.title;
  return rec.display_content || C.buildDisplayContent(rec);
};

/**
 * 合并项的来源标题列表（§26 归类合并的透明度要求）。
 *
 * 合并会只保留一条主标题，若不列出被并进来的条目，读者无法知道合并了什么。
 * 只取 content（不含项目/类型前缀），避免整行过长。
 */
const mergedTitles = (rec) => {
  const src = rec.merged_titles || rec.merged_from_titles || [];
  if (Array.isArray(src) && src.length) {
    return src
      .filter((t) => t && t !== rec.content)
      .map((t) => (t.length > 24 ? `${t.slice(0, 24)}…` : t))
      .join('、');
  }
  return '（详见原始记录）';
};

/**
 * 读取**唯一**的总结数据源：日志目录下的 current.json（当天日志）。
 *
 * 明确的边界（用户约定）：总结只针对 current.json。
 * 本脚本**不读** `archive/`、不读 `pending/` —— 那两处是跨日归档与待同步暂存，
 * 不属于「今日总结」的输入。历史日期不做总结（本机只保留当天日志）。
 */
function loadLog(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const log = C.readJSON(C.currentPath(dir), null);
  if (!log) throw new C.LogError('未找到 current.json，请先运行 init-log.js init。', C.EXIT.BAD_DIR);
  // 显式拒绝历史日期：current.json 只承载当天日志（跨日由 rollover 处理）。
  // 防止「用 --date 指向过去」而实际读到的是今天的日志，产出错位的总结。
  const wantDate = C.flagStr(flags, 'date');
  if (wantDate && log.date && wantDate !== log.date) {
    throw new C.LogError(
      `--date ${wantDate} 与 current.json 的日期 ${log.date} 不一致。\n` +
        '本技能只保留当天日志（current.json），历史日期不做总结 —— ' +
        '历史数据请通过同步链路（ticktick-work-review）获取。',
      C.EXIT.BAD_DIR
    );
  }
  return { dir, log };
}

/**
 * 总结前的项目对齐（§4.1 C）。
 *
 * 采集阶段只用**本地映射**确认项目名；到总结阶段，才对**带 project_id 的条目**
 * 调用线上接口取权威名称，更新日志记录后再产出总结。
 *
 * 规则：
 *   - 仅作用于带 project_id 的条目（无归属线索的不请求、不猜测）
 *   - 失败不阻断总结，只提示
 *   - `--no-online` 可跳过（离线场景）
 *
 * @returns {{dir:string, log:object, project_sync:object|null}}
 */
function loadLogForSummary(flags) {
  const { dir, log: initial } = loadLog(flags);
  if (C.flagBool(flags, 'no-online')) return { dir, log: initial, project_sync: { skipped: true, reason: '--no-online' } };
  let sync = null;
  try {
    sync = SP.syncUnresolvedProjects(dir, { config: C.readConfig(dir), log: initial });
  } catch (e) {
    sync = { ok: false, error: String((e && e.message) || e) };
  }
  // 重新读取，让总结看到更新后的记录
  const log = C.readJSON(C.currentPath(dir), null) || initial;
  return { dir, log, project_sync: sync };
}

/** 把项目对齐结果作为一行提示输出（成功静默，异常/补全才提示） */
function projectSyncNote(sync) {
  if (!sync || sync.skipped) return null;
  if (!sync.ok) return `⚠ 空间项目名称未能从线上对齐：${sync.error}（沿用本地映射）`;
  const parts = [];
  if (sync.resolved) parts.push(`补全 ${sync.resolved} 条`);
  if (sync.renamed) parts.push(`校正 ${sync.renamed} 条`);
  if (!parts.length) return null;
  return `已按线上权威名称更新日志记录：${parts.join('，')}（覆盖 ${sync.projects} 个空间项目）`;
}

/**
 * AI 使用汇总的读取入口（V3.0 §17-§19）。
 *
 * **只读结构化日志**，不碰历史对话、不重算 Token/Score：
 *
 * ```text
 * structured/conversations/<date>.jsonl
 * structured/skill-usage/<date>.jsonl
 * structured/work-activities/<date>.jsonl
 * ```
 *
 * 结构化日志缺失或损坏时**静默降级**为 null —— 每日复盘的主体（工作事项）不应
 * 因为 AI 汇总拿不到而整体失败。
 */
function metricsFor(dir, log) {
  try {
    return ME.buildMetrics(dir, log.date);
  } catch (e) {
    return { error: String((e && e.message) || e), date: log.date };
  }
}

function doToday(flags) {
  const { log, dir } = loadLog(flags);
  const stats = C.buildStats(log);
  // V3.27：日报过期检测。只报不改 —— 不触发重新生成、不写文件。
  const stale = flags['no-stale']
    ? null
    : detectSummaryStaleness(dir, log.date, { threshold: staleThresholdOf(dir) });
  if (C.flagBool(flags, 'json')) {
    C.emit({
      log_directory: dir,
      daily_log: log,
      stats,
      status: C.computeStatus(dir),
      summary_staleness: stale,
    });
    return C.EXIT.OK;
  }
  const L = ['今日工作：', ''];
  if (stale && stale.stale) L.push(stale.message, '');
  const records = (log.records || []).slice().sort((a, b) => {
    const av = C.toMinutes(a.start_time);
    const bv = C.toMinutes(b.start_time);
    return (av === null ? 1e9 : av) - (bv === null ? 1e9 : bv);
  });
  if (!records.length) L.push('（暂无记录）');
  records.forEach((r) => L.push(`${C.recordSpan(r)}  ${showOf(r)}  ·  ${C.SOURCE_LABEL[r.source] || r.source}`));
  const active = records.filter((r) => r.status === 'in_progress');
  if (active.length) {
    L.push('');
    L.push('当前进行中：');
    active.forEach((r) => L.push(r.content));
  }
  const needsConfirm = records.filter((r) => r.status === 'needs_confirmation');
  const pending = log.pending_items || [];
  if (needsConfirm.length || pending.length) {
    L.push('');
    L.push('待确认：');
    needsConfirm.forEach((r) => L.push(`${r.start_time || '--:--'}  ${r.content}`));
    pending.forEach((p) => L.push(`${p.time || p.timestamp || '--:--'}  ${p.content}`));
  }
  L.push('');
  L.push(
    `事项累计 ${stats.work_item_total_minutes} 分钟　实际占用 ${stats.wall_clock_minutes} 分钟　` +
      `同步 ${(log.sync || {}).status}　版本 ${log.version}`
  );
  C.emitText(L.join('\n'));
  return C.EXIT.OK;
}

/**
 * 总结素材（§26 生成原则 / §34 Token 优化）。
 *
 * **只读**：只读取 WorkItem，不读完整 Activity；
 * 并按 §26 先做「过滤无关对话 + 合并相关事项」再交给总结撰写。
 */
function material(log, role, section) {
  const view = SE.buildSummaryView(log);
  // §24 扩展：角色视角一并交给总结撰写环节，让 AI 按同一套画像组织文本
  const roleView = RP.buildRoleView(view.items, role, section);
  const workBoard = RP.groupWorkBoard(view.items, role, section);
  workBoard.operational_count += view.operational_count || 0;
  const explorationUpdates = RP.buildExplorationView(view.items, section);
  return {
    date: log.date,
    version: log.version,
    read_only_note: '本材料只读；总结不得覆盖原始记录（§25）。',
    // §26-1/2：合并后的工作事项（同一工作合并为一条）
    work_items: view.items.map((r) => ({
      id: r.id,
      merged_from: r.merged_from || [r.id],
      merged_titles: r.merged_titles || [],
      merge_evidence: r.merge_evidence || [],
      merged_count: r.merged_count || 1,
      // §31：TickTick 同步标题优先使用 display_content
      display_content: r.display_content || C.buildDisplayContent(r),
      project_name: r.project_name || null,
      work_type: r.work_type || null,
      category: RP.categoryOf(r, section),
      category_source:
        typeof r.category === 'string' && r.category.trim() ? 'record' : 'derived',
      project_stage: r.project_stage || null,
      classification_status: r.classification_status || 'pending_review',
      confirmed_by: r.confirmed_by || null,
      ai_role: r.ai_role || null,
      detail: r.detail || null,
      skills: Array.isArray(r.skills) ? r.skills : [],
      models: Array.isArray(r.models) ? r.models : [],
      content: r.content,
      start_time: r.start_time,
      end_time: r.end_time,
      time_segments: r.time_segments,
      actual_duration: r.actual_duration,
      estimated_duration: r.estimated_duration,
      status: r.status,
      source: r.source,
      confidence: r.confidence,
      output: r.output || null,
      notes: r.notes,
    })),
    // 被过滤的无关对话：只给数量与原因，不回传内容（避免再次进入 AI 上下文）
    excluded_conversation: {
      count: view.excluded_count + (view.pending_excluded || []).length,
      from_records: view.excluded_count,
      from_pending_items: (view.pending_excluded || []).length,
      reasons: [
        ...new Set(
          [...view.excluded, ...(view.pending_excluded || [])].map((e) => e.reason)
        ),
      ],
    },
    merge_log: view.merge_log,
    project_groups: view.groups,
    work_board: workBoard,
    exploration_updates: explorationUpdates,
    operational_count: view.operational_count || 0,
    stats: view.stats,
    summary_pipeline: view.notes,
    pending_item_count: (view.pending_items || []).length,
    existing_summary: log.summary,
    required_sections: REQUIRED_SECTIONS,
    // 角色维度汇总（按 config.role 画像；无角色相关事项时为 null）
    role_view: roleView,
  };
}

/**
 * 渲染「待判断事项」—— material 与 draft **必须共用**同一实现。
 *
 * ⚠️ 为什么把它抽出来（2026-09-21 的真实教训）：
 *
 * ```text
 * 曾经：只有 draft 展开待判断事项的内容，material 只输出一行「待判断事项 N 条」
 * 而 /summary 的官方流程是 material → 撰写 → save
 * 结果：撰写环节看不到这些内容 → 把 22 条真实产品工作
 *      （气象数据 17 条 + 云浮门户 5 条）整块漏掉，
 *      还据此断言「今日无产品交付物产出」
 * ```
 *
 * **素材入口不得隐藏素材。** 待判断事项大多是「本地规则匹配不到、等待 AI 归类」的
 * 真实工作，它们恰恰是最需要被看见的部分。
 */
function renderPendingItems(pending, pendingModules, indent) {
  const pad = indent || '  ';
  const L = [];
  if (!pending.length) return L;
  L.push(
    `${pad}待判断事项（按项目与功能模块归并，共 ${pending.length} 条 → ${pendingModules.length} 项）：`
  );
  for (const g of pendingModules) {
    // 与「工作事项」统一格式：【项目名称】【功能/模块名称】事项内容
    const rep = Object.assign({}, g.items[0] || {}, { project_name: g.project_name });
    const head = `${pad}  - ${SE.buildItemTitle(rep).title}`;
    if (g.count > 1) {
      L.push(`${head}　（共 ${g.count} 条，最早 ${g.earliest_time || '--:--'}）`);
      g.items
        .slice(1)
        .forEach((p) => L.push(`${pad}      · [${p.time || '--:--'}] ${String(p.content).slice(0, 70)}`));
    } else {
      L.push(`${head}　[${g.earliest_time || '--:--'}]`);
    }
  }
  return L;
}

/** 渲染工作看板：产品线/项目 → 阶段 → 交付物（与日报草稿同一口径）。 */
function renderMaterialWorkBoard(board) {
  const L = [];
  if (!board || !board.projects.length) {
    const out = ['work_board（工作）:', '  （今日无工作分类事项）'];
    if (board && board.operational_count) {
      out.push(`  - 另有过程 / 维护 ${board.operational_count} 项（不计入成果）`);
    }
    return out;
  }
  L.push('work_board（工作：产品线/项目 → 项目阶段 → 交付物）:');
  board.projects.forEach((p) => {
    const stages = p.stages.map((s) => `${s.stage}×${s.count}`).join('、') || '（未标注）';
    const deliverables = p.deliverables.length
      ? p.deliverables.map((d) => `${d.deliverable}×${d.count}`).join('、')
      : '（未识别到明确交付物）';
    L.push(`  - 【${p.product_line}】${p.count} 项 / ${p.minutes} 分钟`);
    L.push(`      阶段：${stages}`);
    L.push(`      交付物：${deliverables}`);
  });
  if (board.operational_count) {
    L.push(
      `  - 另有过程 / 维护 ${board.operational_count} 项（不计入工作看板与成果）`
    );
  }
  return L;
}

/** 渲染探索沉淀变化：能力变化展开，稳定性维护只计数。 */
function renderMaterialExploration(view) {
  const L = ['exploration_updates（Skill / 工具能力变化）:'];
  if (!view || !view.total) return L.concat(['  （今日无探索沉淀）']);
  if (view.main.length) {
    view.main.forEach((x) => {
      const result = x.output || x.content;
      const proj = x.project_name ? `【${x.project_name}】` : '';
      L.push(`  - ${x.change_type}　${proj}${result}`);
    });
  } else {
    L.push('  （无用户可感知的能力变化）');
  }
  if (view.maintenance_count) {
    L.push(
      `  - 稳定性维护 ${view.maintenance_count} 项（默认折叠，不占成果主位）`
    );
  }
  return L;
}

function doMaterial(flags) {
  const { dir, log, project_sync } = loadLogForSummary(flags);
  const dirCfg = C.readConfig(dir);
  const m = material(log, dirCfg.role, dirCfg.work);
  // V3.0：AI 使用与 Skill 使用汇总 —— 只读结构化日志（不重新扫描历史对话）
  m.ai_metrics = metricsFor(dir, log);
  // 撰写纪律随素材一起下发，避免撰写环节「凭 records 下排他性结论」
  m.summary_discipline = SUMMARY_DISCIPLINE;
  m.pending_items = (SE.buildSummaryView(log).pending_items || []).map((p) => ({
    hash: p.hash,
    time: p.time,
    project_name: p.project_name || null,
    content: String(p.content).slice(0, 200),
    local_reason: p.local_reason,
  }));
  m.metrics_source = {
    kind: 'structured_logs_only',
    paths: [
      CS.logPath(dir, 'conversation', log.date),
      CS.logPath(dir, 'skill_usage', log.date),
      CS.logPath(dir, 'work_activity', log.date),
    ],
    no_rescan_note:
      'Token / Score / Skill 已在对话结束时由 settle-conversation.js 结算落盘；' +
      '此处只做读取与汇总，**不得**重新解析历史对话、**不得**重算 Token 或 Score（§17-§19）。',
  };
  if (C.flagBool(flags, 'json')) {
    C.emit(m);
    return C.EXIT.OK;
  }
  const L = [`${m.date} 总结素材（已经过滤与合并）`, ''];
  const syncNote = projectSyncNote(project_sync);
  if (syncNote) L.push(`  ${syncNote}`, '');
  m.summary_pipeline.forEach((n) => L.push(`  ${n}`));
  L.push('');
  L.push('work_items（合并后）:');
  if (!m.work_items.length) L.push('  （无）');
  m.work_items.forEach((r) => {
    const tag = r.merged_count > 1 ? `  ← 合并 ${r.merged_count} 条` : '';
    L.push(
      `  - ${r.display_content}　${C.recordSpan(r)}　${
        r.actual_duration === null ? '时长未记录' : `${r.actual_duration} 分钟`
      }　[${C.STATUS_LABEL[r.status] || r.status}]${tag}`
    );
    if (r.merged_count > 1 && r.merged_titles.length) {
      L.push(`      归并来源：${r.merged_titles.map((x) => String(x).slice(0, 70)).join('；')}`);
    }
  });
  if (m.merge_log.length) {
    L.push('');
    L.push('合并明细:');
    m.merge_log.forEach((x) => L.push(`  - ${x.added} 并入 ${x.into}：${x.reason}`));
  }
  if (m.excluded_conversation.count) {
    L.push('');
    L.push(`已过滤无关对话 ${m.excluded_conversation.count} 条（内容不进入总结上下文）:`);
    m.excluded_conversation.reasons.forEach((r) => L.push(`  - ${r}`));
  }
  L.push('');
  L.push(
    `事项累计 ${m.stats.work_item_total_minutes} 分钟　实际占用 ${m.stats.wall_clock_minutes} 分钟`
  );
  L.push(`待判断事项 ${m.pending_item_count} 条`);
  // V3.24：正式总结与日报草稿共用「工作看板 + 探索沉淀变化」，
  // 不再使用旧的 classifyRecord 紧凑汇总，避免显式分类被旧规则覆盖。
  L.push('');
  L.push(...renderMaterialWorkBoard(m.work_board));
  L.push('');
  L.push(...renderMaterialExploration(m.exploration_updates));
  // ⚠️ 素材必须包含待判断事项的**内容**，不能只给计数 ——
  //    否则撰写环节会以为今天只有 work_items 里那几条，把真实工作整块漏掉。
  const pendingView = SE.buildSummaryView(log);
  const pRows = renderPendingItems(
    pendingView.pending_items || [],
    pendingView.pending_modules || [],
    '  '
  );
  if (pRows.length) {
    L.push('');
    L.push('待判断事项明细（**尚未确认为工作事项，但很可能是真实工作**）：');
    L.push(...pRows);
    L.push('');
    L.push(
      `  ⚠ 上述 ${(pendingView.pending_items || []).length} 条尚未经 AI 归类。撰写总结时**必须**把它们计入考虑：`
    );
    L.push('    · 存在未归类的产品工作时，**不得**声称「今日无产品产出」之类的结论；');
    L.push('    · 应在「待确认事项」章节列出其内容与按项目/工作类型的分布；');
    L.push('    · 若确认属于真实工作，先归类再重新生成总结：');
    L.push('      `collect-activity.js analyze` → `collect-activity.js apply --hash <h> --new --project <名> --work-type <类型>`');
  } else {
    L.push('待判断事项：无（所有采集到的事件均已归类）');
  }
  // §24 扩展：角色维度（供撰写环节按同一画像组织）
  const roleLines = RP.renderRoleView(m.role_view);
  if (roleLines.length) {
    L.push('');
    L.push(...roleLines);
  }
  // V3.0：AI 使用 / Skill 使用 / 关联链（只读结构化日志）
  if (m.ai_metrics && !m.ai_metrics.error) {
    const mLines = ME.renderMetrics(m.ai_metrics);
    if (mLines.length) {
      L.push('');
      L.push(...mLines);
    }
    if (m.ai_metrics.notes && m.ai_metrics.notes.length) {
      L.push('');
      m.ai_metrics.notes.forEach((n) => L.push(`  · ${n}`));
    }
  } else if (m.ai_metrics && m.ai_metrics.error) {
    L.push('');
    L.push(`  ⚠ AI 使用汇总不可用：${m.ai_metrics.error}`);
  }
  L.push('');
  L.push('需要覆盖的章节（§24 + V3.0）：');
  m.required_sections.forEach((s) => L.push(`  ${s}`));
  C.emitText(L.join('\n'));
  return C.EXIT.OK;
}

function doDraft(flags) {
  const { dir, log, project_sync } = loadLogForSummary(flags);
  // §26：先过滤无关对话、再合并相关事项，然后才生成总结
  const view = SE.buildSummaryView(log);
  const stats = view.stats;
  const nowMin = C.nowMinutes();
  const records = view.items; // 合并后的工作事项
  const durText = (v) => (v === null ? '时长未记录' : `${v} 分钟`);

  const completed = records.filter((r) => r.status === 'completed');
  const inProgress = records.filter((r) => r.status === 'in_progress');
  const needsConfirm = records.filter((r) => r.status === 'needs_confirmation');
  const unfinished = records.filter((r) =>
    ['in_progress', 'paused', 'not_started', 'needs_confirmation'].includes(r.status)
  );
  const byDuration = records.slice().sort((a, b) => (b.actual_duration || 0) - (a.actual_duration || 0));
  const overlaps = C.overlapsOf(records, nowMin);
  const groups = view.groups;
  // §26：标记无法确认项目的事项
  const projectUnknown = records.filter((r) => !r.project_name);
  const workTypeUnknown = records.filter((r) => !r.work_type);

  const L = [`${log.date} 工作总结`, ''];
  const syncNote = typeof projectSyncNote === 'function' ? projectSyncNote(project_sync) : null;
  if (syncNote) L.push(syncNote, '');
  L.push('一、今日工作概览');
  L.push(view.notes[0]);
  L.push(
    `共 ${stats.work_item_count} 个工作事项，来自 ${
      Object.keys(stats.by_source).map((s) => C.SOURCE_LABEL[s] || s).join(' / ') || '（无来源）'
    }；涉及 ${groups.filter((g) => !g.unassigned).length} 个项目。`
  );
  L.push(`已完成 ${completed.length} 项，进行中 ${inProgress.length} 项，待确认 ${needsConfirm.length} 项。`);

  L.push('');
  L.push('二、工作事项');
  L.push(
    ...(records.length
      ? byDuration.map((r) => {
          const tag = r.merged_count > 1 ? `　← 合并 ${r.merged_count} 条：${mergedTitles(r)}` : '';
          return `  - ${showOf(r)}（${durText(r.actual_duration)}）${tag}`;
        })
      : ['  （无）'])
  );

  L.push('');
  L.push('三、时间线');
  // §26：时间线必须与「工作事项」同口径 —— 传合并后的事项，避免
  //   「工作事项 3 条 / 时间线 4 行」的计数错位。
  const tl = C.timeline(log, showOf, records);
  L.push(...(tl.length ? tl.map((l) => `  ${l}`) : ['  （无记录）']));

  L.push('');
  L.push('四、项目维度汇总');
  if (groups.length) {
    groups.forEach((g) => {
      L.push(`  ${g.project_name}${g.unassigned ? '（未识别项目）' : ''}　${g.items} 项 / ${g.minutes} 分钟`);
      g.types.forEach((t) => {
        L.push(`    ├── ${t.work_type}　${t.items.length} 项 / ${t.minutes} 分钟`);
        // 分组内的条目未必带 project_name，用所在分组的项目名补齐后再格式化
        t.items.forEach((it) =>
          L.push(`    │     └── ${showOf(Object.assign({}, it, { project_name: g.unassigned ? null : g.project_name }))}`)
        );
      });
    });
  } else {
    L.push('  （无）');
  }

  L.push('');
  L.push('五、项目统计');
  if (groups.length) {
    L.push('  项目　　　　　　　　事项数　事项累计时间');
    groups.forEach((g) =>
      L.push(`  ${g.project_name}　　${g.items} 项　${g.minutes} 分钟`)
    );
    L.push(
      `  合计：事项累计 ${stats.work_item_total_minutes} 分钟　实际占用 ${
        stats.wall_clock_minutes
      } 分钟（求并集）`
    );
    if (stats.wall_clock_minutes !== stats.work_item_total_minutes) {
      L.push('  注意：并行事项情况下，事项累计时间可能大于实际工作时长（§25）。');
    }
  } else {
    L.push('  （无）');
  }
  if (overlaps.length) {
    L.push('  并行时段：');
    overlaps.forEach((o) => L.push(`    · ${o}`));
  }

  L.push('');
  L.push('六、已完成事项');
  L.push(...(completed.length ? completed.map((r) => `  - ${showOf(r)}`) : ['  （无）']));

  L.push('');
  L.push('七、未完成事项');
  L.push(...(unfinished.length ? unfinished.map((r) => `  - ${showOf(r)}`) : ['  （无）']));

  L.push('');
  L.push('八、待确认事项');
  L.push(
    ...(needsConfirm.length
      ? needsConfirm.map(
          (r) => `  - ${showOf(r)}（${r.start_time ? '缺少结束时间' : '缺少开始时间'}）`
        )
      : ['  （无）'])
  );
  if (projectUnknown.length) {
    L.push('  无法确认项目（§11 保持为空，不猜测）：');
    projectUnknown.forEach((r) => L.push(`  - ${r.content}`));
  }
  if (workTypeUnknown.length) {
    L.push('  无法确认工作类型：');
    workTypeUnknown.forEach((r) => L.push(`  - ${r.content}`));
  }
  const pending = view.pending_items || [];
  const pendingModules = view.pending_modules || [];
  // 与 material 共用同一实现（见 renderPendingItems 的注释：两者不一致曾导致漏报）
  L.push(...renderPendingItems(pending, pendingModules, '  '));

  L.push('');
  L.push('九、异常时间段');
  const anomalies = [...overlaps.map((o) => `并行时段 ${o}`)];
  stats.anomalies.forEach((a) => {
    const rec = records.find((r) => r.id === a.id);
    anomalies.push(`${rec ? showOf(rec) : a.content}：${a.reason}`);
  });
  L.push(...(anomalies.length ? anomalies.map((a) => `  - ${a}`) : ['  （无）']));

  // §26：透明记录被排除的内容（只给数量与原因，不回显对话内容）
  const excludedTotal = view.excluded_count + (view.pending_excluded || []).length;
  if (excludedTotal) {
    L.push('');
    L.push('附：本次总结已排除的内容');
    L.push(`  已过滤与工作事项无关的对话 ${excludedTotal} 条，原因为：`);
    const reasons = [
      ...new Set(
        [...view.excluded, ...(view.pending_excluded || [])].map((e) => e.reason)
      ),
    ];
    reasons.forEach((r) => L.push(`  - ${r}`));
    L.push('  这些对话不在每日总结中体现，但仍原始保留在日志里可供追溯。');
  }

  // §24 扩展：角色维度（按 config.role 画像组织 —— 需求阶段分布 / 按产品线汇总 / 交付物产出）
  // 画像只作用于「角色相关」事项；探索、学习、生活类单列，避免把个人学习当成职业产出
  const dirCfg = C.readConfig(dir);
  const roleView = RP.buildRoleView(records, dirCfg.role, dirCfg.work);
  const roleLines = RP.renderRoleView(roleView);
  if (roleLines.length) {
    L.push('');
    L.push(...roleLines);
  }

  // V3.0：AI 使用 / Skill 使用 / 关联链 —— 只读结构化日志，不重新扫描历史对话（§17-§19）
  const aiMetrics = metricsFor(dir, log);
  if (aiMetrics && !aiMetrics.error) {
    const mLines = ME.renderMetrics(aiMetrics);
    if (mLines.length) {
      L.push('');
      L.push(...mLines);
    }
  } else if (aiMetrics && aiMetrics.error) {
    L.push('');
    L.push(`  ⚠ AI 使用汇总不可用：${aiMetrics.error}（不影响上方工作事项部分）`);
  }
  L.push('');
  L.push(`附：token 与积分在对话结束时已结算并落盘（${CS.logPath(dir, 'conversation', log.date)}）；`);
  L.push('    本节只读取结构化日志汇总，未重新解析历史对话、未重算 Token 或 Score（§17-§19）。');

  L.push('');
  L.push('注：本文件由脚本按事实生成，不含推测；不可靠的时长与项目一律留空（§11/§13）。');
  if (roleView) {
    L.push(
      `注：角色维度按 config.role（${roleView.role_title || '未命名角色'}）的画像组织，` +
        '仅覆盖角色相关工作；阶段与交付物识别不出时留空，不硬套。'
    );
  }

  const text = L.join('\n');
  if (C.flagBool(flags, 'json')) {
    C.emit({
      date: log.date,
      draft: text,
      stats,
      project_groups: groups,
      merge_log: view.merge_log,
      excluded: view.excluded,
      summary_pipeline: view.notes,
      role_view: roleView,
      ai_metrics: aiMetrics && !aiMetrics.error ? aiMetrics : null,
    });
    return C.EXIT.OK;
  }
  C.emitText(text);
  return C.EXIT.OK;
}

/**
 * 只输出 AI 使用汇总（V3.0）。
 *
 * 这是「每日复盘只读结构化日志」的最小验收口径：本命令**不读** current.json 的
 * records，也**不读**任何 historical conversation，只读结构化日志。
 */
function doMetrics(flags) {
  const { dir, log } = loadLog(flags);
  const m = metricsFor(dir, log);
  if (C.flagBool(flags, 'json')) {
    C.emit({ date: log.date, metrics: m });
    return C.EXIT.OK;
  }
  const lines = ['AI 使用汇总（只读结构化日志）', ''];
  if (m && m.error) {
    lines.push(`⚠ 汇总不可用：${m.error}`);
  } else {
    lines.push(...ME.renderMetrics(m));
    if (m.notes && m.notes.length) {
      lines.push('');
      m.notes.forEach((n) => lines.push(`· ${n}`));
    }
  }
  C.emitText(lines.join('\n'));
  return C.EXIT.OK;
}

function doSave(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  C.ensureWritable(dir);
  const text = C.flagStr(flags, 'text');
  if (!text) throw new C.LogError('save 需要 --text "<总结文本>"。');
  const triggerRaw = C.flagStr(flags, 'trigger');
  const trigger = triggerRaw === 'auto_scheduled' ? 'auto_scheduled' : 'manual';
  const useAi = !C.flagBool(flags, 'no-ai');

  // §18：每日自动总结最多执行一次
  if (trigger === 'auto_scheduled') {
    const state = C.readState(dir);
    if (state.last_automatic_summary_date === C.today()) {
      C.emit({
        action: 'skipped',
        reason: 'already_summarized_today',
        last_automatic_summary_date: state.last_automatic_summary_date,
        message: '每日自动总结最多执行一次（§18）；如需重跑请使用 --trigger manual。',
      });
      return C.EXIT.OK;
    }
  }

  // §35：手动 /summary 不受安全熔断限制；宿主定时任务触发的自动总结受限制
  let ai = null;
  let aiBlocked = null;
  if (useAi) {
    const consumed = C.consumeAiCall(
      dir,
      `summary:${trigger}`,
      trigger === 'auto_scheduled' ? 'auto_analysis' : 'manual'
    );
    ai = consumed.usage;
    if (!consumed.allowed) {
      aiBlocked = consumed.usage.block_reason;
      if (trigger === 'auto_scheduled') {
        C.emit({
          action: 'blocked',
          reason: aiBlocked,
          message: '自动总结未能获得 AI 额度，未写入；本地记录不受影响（§35/§40）。',
          ai,
        });
        return C.EXIT.OK;
      }
    }
  }

  const summary = {
    generated_at: C.nowIso(),
    generated_by: C.flagStr(flags, 'actor') || 'workbuddy',
    trigger,
    ai_assisted: useAi,
    ai_blocked_reason: aiBlocked,
    text,
  };
  const result = C.runMutation(dir, summary.generated_by, [{ kind: 'summary', summary }], {});

  // V3.0：同时把总结落成可带走的 Markdown（summaries/<date>.md），
  // 便于随日志目录一起归档；current.json.summary 仍是权威副本（§25 原始记录不受影响）。
  let mdFile = null;
  let mdError = null;
  try {
    mdFile = writeSummaryMarkdown(dir, summary, result.log.date);
  } catch (e) {
    mdError = String((e && e.message) || e);
  }

  // 保存总结时顺手把已归类的 WorkItem 导出到 logs/<date>/work-activities.jsonl。
  //
  // 为什么放在这里：写总结 = 当天工作的「收口时刻」，此刻导出能保证
  // 总结第 13 章（Work Activity 汇总）与实际事项一致，而不是显示 0 条。
  // 幂等，重复保存不会产生新记录；失败不影响总结本身（本地记录仍在 current.json）。
  let activityExport = null;
  let activityExportError = null;
  try {
    const exp = require('./export-work-activities');
    if (typeof exp.exportForDate === 'function') {
      activityExport = exp.exportForDate(dir, result.log.date);
    }
  } catch (e) {
    activityExportError = String((e && e.message) || e);
  }

  C.emit({
    action: 'summary_saved',
    version: result.log.version,
    date: result.log.date,
    trigger,
    summary,
    summary_markdown: mdFile,
    summary_markdown_error: mdError,
    work_activity_export: activityExport,
    work_activity_export_error: activityExportError,
    ai,
    note: '总结只写入 summary 字段，原始记录未被修改（§25）；且只读取 WorkItem（§36）。',
  });
  return C.EXIT.OK;
}

/**
 * ISO 时间 → 本地可读形式 `YYYY-MM-DD HH:mm:ss`。
 *
 * 只做格式转换，**不做时区换算** —— 日志里的时间本来就是本地时区（+08:00），
 * 用 `new Date()` 再 `toLocaleString()` 会因运行环境时区不同而漂移。
 */
function readableTime(iso) {
  if (!iso) return '（未记录）';
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(String(iso));
  return m ? `${m[1]} ${m[2]}` : String(iso);
}

/** 本地可读时间 → 毫秒；只认 `YYYY-MM-DD HH:mm:ss` 与同前缀的 ISO，解析失败返回 null。 */
function parseLocalTime(value) {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(String(value));
  if (!m) return null;
  const ms = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6])
  ).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 从 `summaries/<date>.md` 的快照头部读出生成时间（P1-3，2026-09-29）。
 *
 * 为什么要它：`current.json.summary` 只是**当天的**权威副本，跨日后会被滚动清空。
 * 过期检测原先只认它，于是**历史日期的日报永远被判成「无日报」**——
 * 哪怕 md 文件好好地躺在磁盘上。结果是「已落盘日报必须先看过期结论」这条约束
 * 对非当日日期完全失效（实测 2026-09-28 有 13 次 Skill 调用未纳入日报，却报 stale:false）。
 *
 * 只读、不抛异常：文件缺失 / 无头部 / 时间不可解析一律返回 null，
 * 由调用方继续按 `no_summary` 处理（宁可漏报，不可误报）。
 *
 * @returns {{generated_at:string, generated_at_ms:number}|null}
 */
function readSummarySnapshot(dir, date) {
  if (!dir || !date) return null;
  let text = '';
  try {
    const file = path.join(CS.summariesDir(dir), `${date}.md`);
    if (!fs.existsSync(file)) return null;
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return null;
  }
  // 头部格式（由 writeSummaryMarkdown 写入，字段间用全角空格分隔）：
  //   > **2026-09-28 工作总结**　生成时间：2026-09-28 18:37:21　数据截止：...　触发方式：...
  const m = /生成时间：\s*(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})/.exec(text);
  if (!m) return null;
  const ms = parseLocalTime(m[1]);
  if (ms === null) return null;
  return { generated_at: m[1], generated_at_ms: ms };
}

/**
 * 日报过期检测（V3.27）。
 *
 * 为什么需要：日报只读取**已结算**的结构化日志，这是硬约束（正确）；
 * 但总结一旦落盘就成了静态文件，此后新增的会话不会自动进入它。
 * 实测（2026-09-28）出现 `summaries/2026-09-28.md` 停在 14:36、
 * 而当天会话数从 10 涨到 25 的情况 —— 文件本身没有任何过期标记，
 * 人和 AI 都可能直接把旧日报当成当日全貌。
 *
 * 判定口径（三条同时成立才算过期）：
 *   1. `summaries/<date>.md` 与 `current.json.summary` 已存在；
 *   2. 日报生成时间（`generated_at`）早于**最后结算时间**（当日会话 `settled_at` 最大值）；
 *   3. 生成时间之后新增的 Conversation 数 >= 阈值（默认 3，可用 `summary.stale_conversation_threshold` 覆盖）。
 *
 * **只报不改**：本函数不触发重新生成、不写任何文件，只返回可展示的结论。
 * 缺时间戳、文件缺失、读取失败一律返回 `{stale:false}` —— 宁可漏报，不可误报。
 *
 * @returns {{stale:boolean, generated_at:string|null, generated_at_ms:number|null,
 *            last_settled_at:string|null, new_conversations:number, threshold:number,
 *            message:string|null, reason:string|null}}
 */
function detectSummaryStaleness(dir, date, opts) {
  const options = opts || {};
  const thresholdRaw = options.threshold;
  const threshold =
    Number.isFinite(thresholdRaw) && thresholdRaw >= 1 ? Math.floor(thresholdRaw) : 3;
  const notStale = (reason, extra) =>
    Object.assign(
      {
        stale: false,
        generated_at: null,
        generated_at_ms: null,
        last_settled_at: null,
        new_conversations: 0,
        threshold,
        message: null,
        reason: reason || null,
      },
      extra || {}
    );

  // ① 权威副本：current.json.summary（§25）；markdown 只是可带走的快照。
  const log = C.readJSON(C.currentPath(dir), null);
  const summary = log && log.summary;
  let generatedAt = (summary && summary.generated_at) || null;
  let generatedMs = generatedAt ? parseLocalTime(generatedAt) : null;

  // ② P1-3 回落（2026-09-29）：current.json 答不了这个日期时，改读快照 md 的头部。
  //    为什么必须回落：current.json 是**当天滚动文件**，跨日后 summary 被清空，
  //    历史日期的日报于是永远被判成「无日报」—— 哪怕 md 文件就在磁盘上。
  //    触发：无生成时间 / 时间不可解析 / 日期不匹配。
  const snapshot = readSummarySnapshot(dir, date);
  const dateMismatch = !!(log && log.date && date && log.date !== date);
  if (snapshot && (!generatedAt || generatedMs === null || dateMismatch)) {
    generatedAt = snapshot.generated_at;
    generatedMs = snapshot.generated_at_ms;
  } else if (dateMismatch && !snapshot) {
    return notStale('date_mismatch');
  }

  if (!generatedAt) return notStale('no_summary');
  if (generatedMs === null) return notStale('unparsable_generated_at');

  let convs = [];
  try {
    // 注意 KINDS 的键是**单数** `conversation`（对应 conversations.jsonl）。
    convs = CS.read(dir, 'conversation', date) || [];
  } catch (e) {
    return notStale('conversations_unavailable');
  }

  let lastSettledMs = null;
  let lastSettledAt = null;
  let newConversations = 0;
  for (const c of convs) {
    const settledMs = parseLocalTime(c.settled_at || c.end_time);
    if (settledMs === null) continue;
    if (lastSettledMs === null || settledMs > lastSettledMs) {
      lastSettledMs = settledMs;
      lastSettledAt = c.settled_at || c.end_time;
    }
    // 只统计「结算时间晚于日报生成时间」的会话 —— 它们不可能进入这份日报。
    if (settledMs > generatedMs) newConversations += 1;
  }

  if (lastSettledMs === null || lastSettledMs <= generatedMs) {
    return Object.assign(notStale('up_to_date'), {
      generated_at: generatedAt,
      generated_at_ms: generatedMs,
      last_settled_at: lastSettledAt,
      new_conversations: 0,
    });
  }

  if (newConversations < threshold) {
    return Object.assign(notStale('below_threshold'), {
      generated_at: generatedAt,
      generated_at_ms: generatedMs,
      last_settled_at: lastSettledAt,
      new_conversations: newConversations,
    });
  }

  return {
    stale: true,
    generated_at: generatedAt,
    generated_at_ms: generatedMs,
    last_settled_at: lastSettledAt,
    new_conversations: newConversations,
    threshold,
    message:
      `⚠️ 本日报数据截止于 ${readableTime(generatedAt)}，` +
      `此后新增 ${newConversations} 个会话（最后结算 ${readableTime(lastSettledAt)}），` +
      '建议重新生成。',
    reason: 'stale',
  };
}

/** 从配置读过期阈值；缺失或非法时回退默认值（fail-safe，不阻断总结）。 */
function staleThresholdOf(dir) {
  try {
    const cfg = C.readConfig(dir);
    const v = cfg && cfg.summary && cfg.summary.stale_conversation_threshold;
    return Number.isFinite(v) && v >= 1 ? Math.floor(v) : 3;
  } catch (e) {
    return 3;
  }
}
/**
 * 写 `summaries/<date>.md`（原子写入）。
 *
 * ⚠️ 头部**不使用 `#` 标题**（2026-09-21 修正）：
 * 曾经这里是 `# <date> 工作总结`，而正文由 AI 撰写时常自带
 * `# <date> 工作日报` —— 一个文件出现两个 H1，结构与目录都乱。
 * 现在元信息用引用块，正文的 H1 就是全文唯一的一级标题。
 *
 * 生成时间也改为**本地可读格式**（`2026-09-21 19:29:05`）而不是 ISO
 * `2026-09-21T19:29:05+08:00` —— 给人看的文件不该要求读者解析 `T` 与时区偏移；
 * 精确的 ISO 值仍保留在 `current.json.summary.generated_at` 里供机器读取。
 */
function writeSummaryMarkdown(dir, summary, date) {
  const file = path.join(CS.summariesDir(dir), `${date}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // V3.27：把「这份日报覆盖到哪个时间点」写进头部。
  // 头部只写**数据截止**（= 生成时刻），不写「是否过期」—— 过期是随时间变化的动态结论，
  // 一旦写进静态文件就会立刻开始说谎；过期判定留给 detectSummaryStaleness 在读取时现算。
  const lines = [
    `> **${date} 工作总结**　生成时间：${readableTime(summary.generated_at)}` +
      `　数据截止：${readableTime(summary.generated_at)}` +
      `　触发方式：${summary.trigger}　AI 参与：${summary.ai_assisted ? '是' : '否（草稿直出）'}` +
      `${summary.ai_blocked_reason ? `　AI 受限：${summary.ai_blocked_reason}` : ''}`,
    '',
    summary.text,
    '',
  ].filter((x) => x !== null);
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, lines.join('\n'), 'utf8');
  fs.renameSync(tmp, file);
  return file;
}

/* ------------------------------------------------------------------ *
 * V3.3（用户 2026-09-22）：日 / 周 / 月 / 项目总结
 *
 * 分工不变：**脚本算数，AI 组织语言**。
 * 本区块只做确定性汇总（分类、分组、时间、Token、积分），不写任何推测性结论。
 * ------------------------------------------------------------------ */

const pad2 = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseDate = (s) => new Date(`${s}T00:00:00`);

function shiftDate(date, deltaDays) {
  const d = parseDate(date);
  d.setDate(d.getDate() + deltaDays);
  return fmtDate(d);
}

/** 本周一（ISO 周起点） */
function weekStartOf(date) {
  const d = parseDate(date);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return fmtDate(d);
}

/** 本月 1 日 */
function monthStartOf(date) {
  const d = parseDate(date);
  d.setDate(1);
  return fmtDate(d);
}

/** ISO 周号（YYYY-Www），用于周总结的文件名与 key */
function isoWeekKey(date) {
  const d = parseDate(date);
  const target = new Date(d);
  target.setDate(target.getDate() + 3 - ((target.getDay() + 6) % 7)); // 该周周四
  const firstThursday = new Date(target.getFullYear(), 0, 4);
  firstThursday.setDate(
    firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7)
  );
  const week = 1 + Math.round((target - firstThursday) / (7 * 24 * 3600 * 1000));
  return `${target.getFullYear()}-W${pad2(week)}`;
}

/** 读取区间内的永久结构化日志（历史区间唯一合法来源） */
function loadRange(dir, from, to) {
  return {
    from,
    to,
    activities: CS.readRange(dir, 'work_activity', from, to),
    conversations: CS.readRange(dir, 'conversation', from, to),
    skillUsages: CS.readRange(dir, 'skill_usage', from, to),
  };
}

/**
 * 把区间总结的「工作事项」压缩成分析输入。
 *
 * ⚠️ 历史区间**没有** current.json（只保留当天），因此事项来自
 * `logs/<date>/work-activities.jsonl` —— 由 `export-work-activities.js` 每日导出，
 * 永久保留。这是「周/月/项目总结」能算出来的前提。
 */
function rangeItems(read) {
  return read.activities.map((a) => ({
    content: a.content,
    project_name: a.project_name || null,
    work_type: a.work_type || null,
    category: a.category || null,
    project_stage: a.project_stage || null,
    output: a.output || null,
    start_time: a.start_time || null,
    end_time: a.end_time || null,
    date: a.date,
    // role-profile 的统计口径读 actual_duration，WorkActivity 用 duration_minutes
    actual_duration: typeof a.duration_minutes === 'number' ? a.duration_minutes : null,
    status: a.status || null,
  }));
}

/**
 * 极简 AI 成本块（供各总结的「AI 使用情况」章节使用；完整洞察走 `insights`）。
 *
 * V3.6：新增**模型维度**（用户 2026-09-24）—— 回答「我用了哪些模型、各花了多少」。
 */
function renderCostBrief(cost, label, models) {
  const L = [];
  if (!cost) {
    L.push('  （无 AI 成本数据）');
    return L;
  }
  const na = ME.NA_TEXT;
  const n = (v) => (typeof v === 'number' ? v.toLocaleString('en-US') : na);
  const p = (v) => (typeof v === 'number' ? `${v}%` : na);
  L.push(
    `  调用 ${cost.skill.invocations} 次　Token ${n(cost.total_token)}　` +
      `积分 ${typeof cost.total_score === 'number' ? cost.total_score : ''}`
  );
  L.push('  按 Skill：');
  if (!cost.skill.by_skill.length) L.push('    （无）');
  else {
    L.push(
      '    （口径 A：Skill 载入体积 = load_chars × token_per_char，' +
        '可精确归因、可跨 Skill 相加；不含历史上下文，勿与上方会话级 Token 相加）'
    );
  }
  cost.skill.by_skill.slice(0, 12).forEach((s) => {
    const avg = typeof s.avg_token === 'number' ? `（平均 ${n(s.avg_token)}）` : '';
    L.push(
      `    - ${s.skill_id}@${s.skill_version}　${s.invocations} 次` +
        `　Token ${n(s.total_token)}${avg}　积分 `
    );
  });
  if (
    typeof cost.skill.conversation_count_without_skill === 'number' &&
    cost.skill.conversation_count_without_skill > 0
  ) {
    L.push(
      `    - （未记录 Skill）　${cost.skill.conversation_count_without_skill} 个 Conversation`
    );
  }
  if (Array.isArray(cost.conversation_projects) && cost.conversation_projects.length) {
    L.push('  按 Conversation 项目（范围口径，不等同于 WorkItem 精确归属）：');
    cost.conversation_projects.slice(0, 12).forEach((r) => {
      const tokenTail = r.token_unknown ? '（下界）' : '';
      const credit =
        r.score_status === 'not_applicable' || !r.score_known
          ? ''
          : `${r.total_score}${r.score_status === 'lower_bound' ? '（下界）' : ''}`;
      L.push(
        `    - ${r.key}　Conversation ${r.conversations}　请求 ${r.request_count}` +
          `　Token ${n(r.total_token)}${tokenTail}　积分 ${credit}`
      );
    });
  }
  const dim = (name, rows, keyName) => {
    L.push(`  按${name}：`);
    if (!rows.length) {
      L.push('    （无）');
      return;
    }
    rows.slice(0, 12).forEach((r) => {
      // 括号里只放**真的可获取**的信息：占比不可获取时不写「（不可获取）」，
      // 否则会出现「Token 不可获取（不可获取）」这种无信息量的重复。
      const tTail = typeof r.token_share === 'number' ? `（占 ${p(r.token_share)}）` : '';
      const sTail = typeof r.score_share === 'number' ? `（占 ${p(r.score_share)}）` : '';
      const credit =
        typeof r.total_score === 'number' && r.score_known > 0 ? r.total_score : '';
      L.push(
        `    - ${r[keyName] !== undefined ? r[keyName] : r.key}　${r.activities} 项` +
          `　Token ${n(r.total_token)}${tTail}` +
          `　积分 ${credit}${sTail}`
      );
    });
  };
  dim('工作类型', cost.by_work_type, 'key');
  dim('项目', cost.by_project, 'key');
  if (cost.by_project_stage.length) dim('项目阶段', cost.by_project_stage, 'key');
  // ── 模型维度（V3.6，用户 2026-09-24）──
  if (models && Array.isArray(models.rows) && models.rows.length) {
    L.push('  按模型：');
    if (models.raw_name_count > models.rows.length) {
      L.push(
        `    （模型名已归一：日志里 ${models.raw_name_count} 种写法 → ${models.rows.length} 个模型）`
      );
    }
    models.rows.slice(0, 12).forEach((r) => {
      const share = typeof r.token_share === 'number' ? `（占 ${p(r.token_share)}）` : '';
      const hit = typeof r.cache_hit_rate === 'number' ? `　缓存命中 ${p(r.cache_hit_rate)}` : '';
      const per = typeof r.avg_token_per_request === 'number' ? `　平均单请求 ${n(r.avg_token_per_request)}` : '';
      const credit = typeof r.total_score === 'number' ? `　积分 ${r.total_score}` : '';
      L.push(
        `    - ${r.model}　会话 ${r.conversation_count}　请求 ${r.request_count}` +
          `　Token ${n(r.total_token)}${share}${hit}${per}${credit}`
      );
    });
    L.push(
      '    口径：一次会话的 Token 整体记给记录里的**主模型**，不按会话内多模型拆分（拆分会变成估算）。'
    );
  }
  const usage = cost.usage_attribution;
  if (usage && usage.records) {
    L.push('  Work Activity 精确归属：');
    L.push(
      `    已归属 Token ${n(usage.allocated_token)}　未归属 Token ${n(usage.unallocated_token)}` +
        `　已归属 Credit ${typeof usage.allocated_credit === 'number' ? usage.allocated_credit : na}` +
        `　未归属 Credit ${typeof usage.unallocated_credit === 'number' ? usage.unallocated_credit : na}`
    );
    L.push(
      `    exact ${usage.by_status.exact} 条　partial ${usage.by_status.partial} 条` +
        `　unallocated ${usage.by_status.unallocated} 条`
    );
  }
  // 归因覆盖率诊断：说明「不可获取」的真实原因（记录缺 conversation_id），
  // 避免读者误以为统计出错，也避免有人「帮忙」补一个估算值。
  const cov = cost.attribution_coverage;
  if (cov && cov.with_conversation < cov.activities) {
    L.push(
      `  ⚠ 归因覆盖：${cov.activities} 条事项中 ${cov.with_conversation} 条带 conversation_id` +
        `（区间内会话 ${cov.conversations} 个）—— 未关联的 Token/积分记 null，不摊派、不估算。`
    );
  }
  L.push(
    '  ⚠ 积分口径：Token 与积分是独立指标，不做换算；' +
      'Skill 级积分宿主不提供，记 null（禁止按比例摊派）。'
  );
  // 说明行：以 ⚠ 开头的口径提示单独成行（内容较长，套括号反而看不清）
  if (label) L.push(label.startsWith('⚠') ? `  ${label}` : `  （${label}）`);
  return L;
}

/**
 * 七段结构（V3.6）。
 *
 * ```text
 * 1 今日概览    工作 / 探索沉淀 / 生活 三线并出
 * 2 工作        产品线/项目 → 项目阶段 → 交付物（**交付物为主轴**）
 * 3 探索沉淀    AI 能力建设，单列且不计职业产出
 * 4 今日成果    只列真实 output
 * 5 生活与个人  生活/成长/健康/休闲，不做职业化解读
 * 6 时间结构    各分类时长
 * 7 AI 使用情况 会话/Token/积分 + Skill/模型/工作类型/项目/项目阶段
 * ```
 *
 * 「项目进展」并入第 2 段 —— 按产品线/项目组织即已包含阶段分布，
 * 单列一段只会让同一批事项出现两次。
 */
function renderDailySections(opts) {
  const { items, config, cost, models, pending, extraNotes, operationalCount } = opts;
  const section = (config && config.work) || null;
  const cats = (section && section.categories) || null;
  const cb = RP.categoryBreakdown(items, cats, section);
  const board = RP.groupWorkBoard(items, config.role, section);
  const explorationView = RP.buildExplorationView(items, section);
  const L = [];
  const bucketOf = (name) => cb.buckets.find((b) => b.category === name) || null;
  const line = (b) => (b ? `${b.count} 项${b.minutes ? ` / ${b.minutes} 分钟` : ''}` : '0 项');
  const workBucket = bucketOf('工作');
  const exploreBucket = bucketOf(RP.EXPLORATION_CATEGORY);
  const lifeBuckets = cb.buckets.filter(
    (b) => b.category !== '工作' && b.category !== RP.EXPLORATION_CATEGORY
  );

  // ── 1. 今日概览（工作 / 探索沉淀 / 生活 三线） ──
  L.push('## 1. 今日概览');
  L.push('');
  L.push(`总事项：${items.length}`);
  L.push(`- 工作：${line(workBucket)}`);
  L.push(`- 探索沉淀：${line(exploreBucket)}`);
  const lifeCount = lifeBuckets.reduce((s, b) => s + b.count, 0);
  const lifeMinutes = lifeBuckets.reduce((s, b) => s + b.minutes, 0);
  L.push(`- 生活：${lifeCount} 项${lifeMinutes ? ` / ${lifeMinutes} 分钟` : ''}`);
  if (!cb.buckets.length) L.push('（无记录）');
  else if (lifeBuckets.length) {
    L.push(`  （生活明细：${lifeBuckets.map((b) => `${b.category} ${b.count}`).join('、')}）`);
  }

  // ── 2. 工作（产品线/项目 → 项目阶段 → 交付物） ──
  L.push('');
  L.push('## 2. 工作');
  L.push('');
  L.push('（口径：产品线/项目 → 项目阶段 → 交付物；只含「工作」分类）');
  const maintenanceCount = board.operational_count || operationalCount || 0;
  if (!board.item_count) {
    L.push('');
    L.push('（今日无「工作」分类的事项）');
  } else {
    L.push('');
    board.projects.forEach((p) => {
      const stages = p.stages.map((s) => `${s.stage}×${s.count}`).join('、');
      L.push(`### 【${p.product_line}】${p.count} 项 / ${p.minutes} 分钟`);
      L.push(`- 项目阶段：${stages}`);
      L.push(
        `- 交付物：${
          p.deliverables.length
            ? p.deliverables.map((d) => `${d.deliverable}×${d.count}`).join('、')
            : '（未识别到明确交付物 —— 不虚构）'
        }`
      );
      p.items.slice(0, 12).forEach((it) => {
        const time =
          it.start_time && it.end_time
            ? `${it.start_time}-${it.end_time}`
            : it.start_time
              ? `${it.start_time}-`
              : '（未记录）';
        const type = it.work_type ? `　${it.work_type}` : '';
        const out = it.output ? `　产出：${it.output}` : '';
        L.push(`    · ${time}　${it.content}${type}　（阶段：${it.stage}）${out}`);
      });
      L.push('');
    });
    L.push('  今日交付物合计：');
    if (!board.deliverables.length) L.push('    （本日工作未识别到明确交付物）');
    board.deliverables.forEach((d) => L.push(`    - ${d.deliverable}　×${d.count}`));
  }
  if (maintenanceCount) {
    L.push('');
    L.push(
      `  过程 / 维护 ${maintenanceCount} 项（查看日志、环境恢复、任务重跑等；不计入成果）`
    );
  }

  // ── 3. 探索沉淀 ──
  L.push('');
  L.push('## 3. 探索沉淀');
  L.push('');
  L.push('（AI 工具 / Skill / MCP / 提示词与自动化建设 —— 属个人方向，**不计职业产出**）');
  if (!explorationView.total) {
    L.push('');
    L.push('（今日无探索沉淀）');
  } else {
    L.push('');
    L.push(
      `合计 ${explorationView.total} 项` +
        (explorationView.minutes ? ` / ${explorationView.minutes} 分钟` : '')
    );
    L.push('能力变化：');
    if (!explorationView.main.length) {
      L.push('  （无用户可感知的能力变化）');
    } else {
      explorationView.main.slice(0, 15).forEach((x) => {
        const proj = x.project_name ? `【${x.project_name}】` : '';
        const result = x.output || x.content;
        L.push(`- ${x.change_type}：${proj}${result}`);
      });
      if (explorationView.main.length > 15) {
        L.push(`（另有 ${explorationView.main.length - 15} 项能力变化未展开）`);
      }
    }
    if (explorationView.maintenance_count) {
      L.push(
        `稳定性维护：${explorationView.maintenance_count} 项（默认折叠，不占成果主位）`
      );
    }
  }

  // ── 4. 今日成果 ──
  L.push('');
  L.push('## 4. 今日成果');
  L.push('');
  const outputs = items.filter((i) => i.output);
  if (!outputs.length) {
    L.push('（记录中未填写 output —— 不虚构成果）');
  } else {
    outputs.forEach((i) =>
      L.push(
        `- ${i.output}${i.project_name ? `（${i.project_name}）` : ''}` +
          `（分类：${RP.categoryOf(i, section)}）`
      )
    );
  }

  // ── 5. 生活与个人事项 ──
  L.push('');
  L.push('## 5. 生活与个人事项');
  L.push('');
  if (!lifeBuckets.length) {
    L.push('（无）');
  } else {
    lifeBuckets.forEach((b) => {
      L.push(`- ${b.category}：${b.count} 项${b.minutes ? ` / ${b.minutes} 分钟` : ''}`);
      b.titles.slice(0, 6).forEach((t) => L.push(`    · ${t}`));
    });
    L.push('');
    L.push('（生活、运动、休闲与个人成长均为事实陈述，不做职业化解读）');
  }

  // ── 6. 时间结构 ──
  L.push('');
  L.push('## 6. 时间结构');
  L.push('');
  if (!cb.buckets.length) L.push('（无记录）');
  cb.buckets.forEach((b) => {
    // V3.25：AI 生成记录不产出时长（actual_duration 为 null、不计入 minutes），
    // 未记结束时间的条目同样不计入 —— 因此这里的合计是**下界**，不再是上界。
    // 旧文案「时长为上界」来自「开放段按 now 兜底计价」的老口径，已失效。
    const tail = b.open_ended ? `（另有 ${b.open_ended} 条未记结束时间，未计入时长）` : '';
    L.push(`- ${b.category}：${b.minutes} 分钟${tail}`);
  });
  L.push('');
  L.push(
    `合计：${cb.total_minutes} 分钟　其中工作 ${cb.work_minutes} 分钟，` +
      `探索沉淀 ${cb.exploration_minutes} 分钟，非工作合计 ${cb.life_minutes} 分钟`
  );
  L.push(
    '（口径 V3.25：**只累计人工明确记录的闭合时段**，故该合计为**下界**；' +
      'AI 会话推导的事项不产出时长，未记结束时间的时段也不计入。）'
  );

  // ── 7. AI 使用情况 ──
  L.push('');
  L.push('## 7. AI 使用情况');
  L.push('');
  L.push(
    ...renderCostBrief(cost, '只读结构化日志，未重算 Token / Score；完整洞察见 /insights', models)
  );

  if (extraNotes && extraNotes.length) {
    L.push('');
    L.push('---');
    extraNotes.forEach((n) => L.push(`- ${n}`));
  }
  return L;
}

/** 日总结（V3.3 七段结构） */
function doDailyDraft(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const { log } = loadLogForSummary(flags);
  const config = C.readConfig(dir);
  const view = SE.buildSummaryView(log);
  const items = view.items || [];
  const m = metricsFor(dir, log);
  const cost = m && !m.error ? m.cost : null;
  const models = m && !m.error ? m.models : null;

  // V3.27：已落盘日报的过期检测。只报不改；--no-stale 可关闭。
  const staleDraft = flags['no-stale']
    ? null
    : detectSummaryStaleness(dir, log.date, { threshold: staleThresholdOf(dir) });

  if (C.flagBool(flags, 'json')) {
    C.emit({
      kind: 'daily',
      date: log.date,
      sections: REQUIRED_SECTIONS,
      category_breakdown: RP.categoryBreakdown(items, config.work.categories, config.work),
      // V3.6：工作块以「产品线/项目 → 阶段 → 交付物」为主轴
      work_board: RP.groupWorkBoard(items, config.role, config.work),
      exploration: RP.buildExplorationView(items, config.work),
      // 保留旧字段但不删除：pm_work / projects 仍是「按工作类型 / 按项目」的另一视角
      pm_work: RP.groupPmWork(items, config.work),
      projects: RP.groupByProjectWithStage(items.filter((i) => RP.isWorkCategory(i, config.work))),
      outputs: items.filter((i) => i.output).map((i) => ({
        content: i.content,
        output: i.output,
        category: RP.categoryOf(i, config.work),
      })),
      pending_item_count: (view.pending_items || []).length,
      summary_staleness: staleDraft,
      cost,
      models,
      draft: null,
    });
    return C.EXIT.OK;
  }

  const pendingN = (view.pending_items || []).length;
  const notes = [view.notes[0], '本文件由脚本按事实生成，不含推测；缺失项一律留空（§11/§13）。'];
  // V3.27：过期提示置顶 —— 它决定读者该如何解读全文。
  if (staleDraft && staleDraft.stale) {
    notes.unshift(staleDraft.message);
  }
  // V3.6：归属二次确认。只列「待复核」，已确认的默认不再重复验证
  // （用户 2026-09-24：「已总结过的 message 若无明确要求无需重复验证」）。
  const recheck = C.flagBool(flags, 'recheck');
  const unconfirmed = items.filter((i) => (i.classification_status || 'pending_review') !== 'confirmed');
  const confirmedN = items.length - unconfirmed.length;
  if (recheck) {
    notes.push(
      `⚠ --recheck：本次对全部 ${items.length} 条事项（含已确认的 ${confirmedN} 条）重新复核归属。`
    );
  } else if (unconfirmed.length) {
    notes.push(
      `待复核归属 ${unconfirmed.length} 条（已确认 ${confirmedN} 条默认跳过，不重复验证）；` +
        '复核后请用 collect-activity.js apply 写回分类，写回即标为已确认。'
    );
  }
  if (pendingN) {
    notes.push(
      `⚠ 另有 ${pendingN} 条待判断事项未归类 —— 存在未归类事项时，**不得**对当日产出下排他性结论。`
    );
    notes.push(
      '先归类再重新生成：collect-activity.js analyze → apply --hash <h> --new ' +
        '--project <名> --work-type <类型> [--category <分类>] [--project-stage <阶段>] [--output <成果>]'
    );
  }
  const L = [
    `# ${log.date} 每日总结`,
    '',
    ...renderDailySections({
      items,
      config,
      cost,
      models,
      pending: view.pending_items,
      operationalCount: view.operational_count || 0,
      extraNotes: notes,
    }),
  ];
  C.emitText(L.join('\n'));
  return C.EXIT.OK;
}

/** 周 / 月 / 项目总结（周期结构，用户 §17/§18/§19） */
function doPeriod(flags, kind) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const config = C.readConfig(dir);
  const today = C.today();
  const fromFlag = C.flagStr(flags, 'from');
  const toFlag = C.flagStr(flags, 'to');
  const days = C.flagNum(flags, 'days');
  const monthFlag = C.flagStr(flags, 'month');
  const project = C.flagStr(flags, 'project');

  let from;
  let to = toFlag ? CS.assertDate(toFlag) : today;
  let key;

  if (kind === 'project') {
    if (!project) throw new C.LogError('project 子命令需要 --project <名称>。');
    const dates = CS.listLoggedDates(dir);
    if (!dates.length) throw new C.LogError('尚无结构化日志（logs/<date>/），无法生成项目总结。');
    from = fromFlag ? CS.assertDate(fromFlag) : dates[dates.length - 1];
    to = toFlag ? CS.assertDate(toFlag) : dates[0];
    key = project;
  } else if (kind === 'month') {
    from = fromFlag ? CS.assertDate(fromFlag) : monthStartOf(monthFlag && /^\d{4}-\d{2}$/.test(monthFlag) ? `${monthFlag}-01` : today);
    if (monthFlag && /^\d{4}-\d{2}$/.test(monthFlag)) {
      const mEnd = new Date(parseDate(`${monthFlag}-01`));
      mEnd.setMonth(mEnd.getMonth() + 1);
      mEnd.setDate(0);
      to = toFlag ? CS.assertDate(toFlag) : fmtDate(mEnd);
    }
    key = from.slice(0, 7);
  } else {
    // week：默认本周一 ~ 今天
    if (days !== null && days !== undefined) {
      if (!(days >= 1)) throw new C.LogError('--days 必须 ≥ 1。');
      from = shiftDate(today, -(Math.floor(days) - 1));
    } else {
      from = fromFlag ? CS.assertDate(fromFlag) : weekStartOf(today);
    }
    key = isoWeekKey(from);
  }
  if (from > to) throw new C.LogError(`起始日期 ${from} 晚于结束日期 ${to}。`);

  const read = loadRange(dir, from, to);
  const items = rangeItems(read);
  const scoped = kind === 'project' ? items.filter((i) => (i.project_name || '') === project) : items;
  const metrics = ME.buildMetricsRange(dir, from, to);
  const cost = metrics.cost;
  // V3.6：模型维度同样适用于区间 —— buildMetricsRange 走的是同一个 buildFrom，
  // 返回体里就有 models；此前漏取，导致 week/month/project 一律抛
  // `ReferenceError: models is not defined`（2026-09-28 修复）。
  const models = metrics.models || null;

  if (C.flagBool(flags, 'json')) {
    C.emit({
      kind,
      key,
      from,
      to,
      sections: PERIOD_SECTIONS[kind],
      item_count: scoped.length,
      category_breakdown: RP.categoryBreakdown(scoped, config.work.categories, config.work),
      work_board: RP.groupWorkBoard(scoped, config.role, config.work),
      pm_work: RP.groupPmWork(scoped, config.work),
      projects: RP.groupByProjectWithStage(
        scoped.filter((i) => RP.isWorkCategory(i, config.work))
      ),
      outputs: scoped.filter((i) => i.output).map((i) => ({ content: i.content, output: i.output, date: i.date })),
      cost,
      // cost 始终是**区间会话级**口径；项目总结里它不是「仅本项目」的消耗。
      // 显式声明，避免下游（AI / 人）误读。
      cost_scope: 'range',
      cost_scoped_to_key: false,
      metrics_date: metrics.date,
    });
    return C.EXIT.OK;
  }

  const cb = RP.categoryBreakdown(scoped, config.work.categories, config.work);
  const workBoard = RP.groupWorkBoard(scoped, config.role, config.work);
  const pm = RP.groupPmWork(scoped, config.work);
  const projects = RP.groupByProjectWithStage(
    scoped.filter((i) => RP.isWorkCategory(i, config.work))
  );
  const outputs = scoped.filter((i) => i.output);
  const title =
    kind === 'week' ? `周总结（${from} ~ ${to}，${key}）`
      : kind === 'month' ? `月总结（${from} ~ ${to}）`
        : `项目总结：${project}（${from} ~ ${to}）`;

  const L = [`# ${title}`, ''];

  // 顶部时间投入（各种周期总结共有）
  L.push('## 时间投入');
  L.push('');
  cb.buckets.forEach((b) => L.push(`- ${b.category}：${b.count} 项 / ${b.minutes} 分钟`));
  L.push(`- 合计：${scoped.length} 项 / ${cb.total_minutes} 分钟（工作 ${cb.work_minutes}，非工作 ${cb.life_minutes}）`);

  if (kind !== 'project') {
    L.push('');
    L.push('## 项目投入');
    L.push('');
    if (!projects.length) L.push('（无可归属项目的事项）');
    projects.forEach((p) =>
      L.push(`- 【${p.project_name}】${p.count} 项 / ${p.minutes} 分钟　阶段：${Object.entries(p.stages).map(([k, v]) => `${k}×${v}`).join('、')}`)
    );
  }

  // V3.6：工作以「交付物视角」组织 —— 与每日总结第 2 段同一口径，
  // 让周/月/项目总结也回答「我产出了什么」，而不只是「我做了什么类型的事」。
  L.push('');
  L.push('## 工作（产品线 / 阶段 / 交付物）');
  L.push('');
  if (!workBoard.item_count) {
    L.push('（区间内无「工作」分类事项）');
  } else {
    workBoard.projects.slice(0, 12).forEach((p) => {
      L.push(
        `- 【${p.product_line}】${p.count} 项 / ${p.minutes} 分钟　阶段：` +
          p.stages.map((s) => `${s.stage}×${s.count}`).join('、')
      );
      L.push(
        `    交付物：${
          p.deliverables.length
            ? p.deliverables.map((d) => `${d.deliverable}×${d.count}`).join('、')
            : '（未识别到明确交付物 —— 不虚构）'
        }`
      );
    });
    L.push('');
    L.push('  交付物合计：');
    if (!workBoard.deliverables.length) L.push('    （区间内未识别到明确交付物）');
    workBoard.deliverables.forEach((d) => L.push(`    - ${d.deliverable}　×${d.count}`));
  }

  L.push('');
  L.push('## 产品经理工作类型分布');
  L.push('');
  if (!pm.groups.length) L.push('（无「工作」分类事项）');
  pm.groups.forEach((g) => {
    L.push(`### ${g.group}（${g.count} 项 / ${g.minutes} 分钟）`);
    g.titles.slice(0, 12).forEach((t) => L.push(`- ${t}`));
    L.push('');
  });

  if (kind === 'project') {
    L.push('## 项目阶段');
    L.push('');
    const ps = cost.project_stages.find((p) => p.project === project);
    if (!ps) {
      L.push('（该项目无带阶段的记录）');
    } else {
      ps.stages.forEach((s) =>
        L.push(
          `- ${s.stage}：${s.activities} 项 / ${s.minutes} 分钟` +
            `　Token ${typeof s.total_token === 'number' ? s.total_token : ME.NA_TEXT}` +
            `　积分 ${typeof s.total_score === 'number' ? s.total_score : ME.NA_TEXT}`
        )
      );
      L.push(
        `- 合计：${ps.minutes} 分钟　Token ${typeof ps.total_token === 'number' ? ps.total_token : ME.NA_TEXT}` +
          `　积分 ${typeof ps.total_score === 'number' ? ps.total_score : ME.NA_TEXT}`
      );
    }
    const allocated = (cost.allocated_by_project || []).find((p) => p.key === project);
    L.push('');
    L.push('## 项目 AI 成本精确归属');
    L.push('');
    L.push(
      allocated
        ? `- 已精确归属：${allocated.activities} 项 / ${allocated.records} 条记录` +
          `　Token ${typeof allocated.total_token === 'number' ? allocated.total_token : ME.NA_TEXT}` +
          `　Credit ${typeof allocated.total_credit === 'number' ? allocated.total_credit : ME.NA_TEXT}`
        : '- 本项目没有已精确归属的 AI Usage Record。'
    );
    L.push('- 未归属或仅会话级的成本仍按区间口径呈现，不拆分给本项目。');
  }

  L.push('');
  L.push('## 主要工作成果');
  L.push('');
  if (!outputs.length) L.push('（记录中未填写 output —— 不虚构成果）');
  outputs.slice(0, 30).forEach((o) => L.push(`- [${o.date}] ${o.output}${o.project_name ? `（${o.project_name}）` : ''}`));

  L.push('');
  L.push('## 生活 / 运动 / 个人成长');
  L.push('');
  const life = cb.buckets.filter(
    (b) => b.category !== '工作' && b.category !== RP.EXPLORATION_CATEGORY
  );
  if (!life.length) L.push('（无）');
  life.forEach((b) => L.push(`- ${b.category}：${b.count} 项 / ${b.minutes} 分钟`));

  // 探索沉淀单列：只展开能力变化，稳定性维护折叠计数。
  const explorationView = RP.buildExplorationView(scoped, config.work);
  if (explorationView.total) {
    L.push('');
    L.push('## 探索沉淀（个人方向，不计职业产出）');
    L.push('');
    L.push(`- ${explorationView.total} 项 / ${explorationView.minutes} 分钟`);
    explorationView.main.slice(0, 20).forEach((x) => {
      const result = x.output || x.content;
      L.push(`    · ${x.change_type}：${x.project_name ? `【${x.project_name}】` : ''}${result}`);
    });
    if (explorationView.maintenance_count) {
      L.push(`    · 稳定性维护 ${explorationView.maintenance_count} 项（折叠）`);
    }
  }

  L.push('');
  L.push('## AI 使用与成本');
  L.push('');
  L.push(
    ...renderCostBrief(
      cost,
      kind === 'project'
        // Token/积分只有在会话级才有；项目总结的时间是项目口径，成本不是。
        // 明确写出来，避免把整个区间的成本误读成「这个项目花的」。
        ? `⚠ 口径为区间 ${from} ~ ${to} 的**会话级**消耗，不是「仅本项目」的消耗；` +
            '仅当事项带 conversation_id 时才能归属到项目，本报告不摊派。'
        : `区间 ${from} ~ ${to}`
    , models)
  );

  L.push('');
  L.push('---');
  L.push(`需覆盖要点：${PERIOD_SECTIONS[kind].join('、')}`);
  L.push('说明：脚本只做确定性汇总（分类 / 分组 / 时间 / Token / 积分）；语言组织由 AI 完成。');
  L.push(
    '时长口径（V3.25）：只累计人工明确记录的闭合时段，**合计为下界**；' +
      'AI 会话推导的事项不产出时长，未记结束时间的时段也不计入。'
  );
  L.push('数据来源：logs/<date>/{work-activities,conversations,skill-usage}.jsonl（未重新扫描历史对话）。');
  C.emitText(L.join('\n'));
  return C.EXIT.OK;
}

/**
 * AI 使用洞察报告（V3.6，用户 2026-09-24）。
 *
 * ```bash
 * node scripts/daily-summary.js insights            # 今天
 * node scripts/daily-summary.js insights --date 2026-09-23
 * node scripts/daily-summary.js insights week|month|project [--days N] [--from --to] [--project 名]
 * node scripts/daily-summary.js insights --save     # 落盘 summaries/<key>-insights.md
 * ```
 *
 * 回答四件事：高频 Skill / 装了没用过的 Skill / 消耗偏高的 Skill / 模型对比 /
 * 项目与项目阶段的成本分布。数字全部来自 Structured Logs，不重扫历史对话。
 */
function doInsights(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const config = C.readConfig(dir);
  const insCfg = (config.summary && config.summary.insights) || { enabled: true };
  if (insCfg.enabled === false) {
    C.emitText('AI 使用洞察已在 config.summary.insights.enabled = false 下关闭。');
    return C.EXIT.OK;
  }

  const kind = (C.flagStr(flags, 'scope') || 'day').toLowerCase();
  const today = C.today();
  const daysFlag = C.flagNum(flags, 'days');
  let from;
  let to;
  let key;

  if (kind === 'day') {
    const d = C.flagStr(flags, 'date') || today;
    from = CS.assertDate(d);
    to = from;
    key = from;
  } else if (kind === 'month') {
    const monthFlag = C.flagStr(flags, 'month');
    if (monthFlag && /^\d{4}-\d{2}$/.test(monthFlag)) {
      from = `${monthFlag}-01`;
      const mEnd = new Date(Date.UTC(Number(monthFlag.slice(0, 4)), Number(monthFlag.slice(5, 7)), 0));
      to = fmtDate(mEnd);
      key = monthFlag;
    } else {
      from = C.flagStr(flags, 'from') || `${today.slice(0, 7)}-01`;
      to = C.flagStr(flags, 'to') || today;
      key = from.slice(0, 7);
    }
  } else {
    // week / project：默认本周一 ~ 今天
    if (typeof daysFlag === 'number' && daysFlag >= 1) {
      from = shiftDate(today, -(Math.floor(daysFlag) - 1));
    } else {
      from = C.flagStr(flags, 'from') || weekStartOf(today);
    }
    to = C.flagStr(flags, 'to') || today;
    key = isoWeekKey(from);
  }
  if (from > to) throw new C.LogError(`起始日期 ${from} 晚于结束日期 ${to}。`);

  const metrics = ME.buildMetricsRange(dir, from, to);

  // 「装了但没用过」需要与本地清单对账；读不到清单不影响其余部分（如实降级）。
  let inventory = null;
  let inventoryError = null;
  const usedIds = new Set(
    (metrics.skill && Array.isArray(metrics.skill.by_skill) ? metrics.skill.by_skill : []).map(
      (r) => String(r.skill_id)
    )
  );
  const lastUsedAt = new Map();
  for (const r of (metrics.skill && metrics.skill.by_skill) || []) {
    if (r.last_at) lastUsedAt.set(String(r.skill_id), String(r.last_at));
  }
  try {
    inventory = SI.load(
      {
        summary: { insights: insCfg },
      },
      { usedSkillIds: usedIds, lastUsedAt, staleDays: insCfg.stale_days }
    );
  } catch (e) {
    inventoryError = String((e && e.message) || e);
  }

  const insights = IE.buildInsights(metrics, { config, inventory });
  insights.scope = { date: kind === 'day' ? from : `${from}..${to}`, from, to, kind, key };
  if (inventoryError) insights.inventory_error = inventoryError;

  if (C.flagBool(flags, 'json')) {
    C.emit(insights);
    return C.EXIT.OK;
  }

  const lines = IE.renderInsights(insights);
  if (inventoryError) {
    lines.push('');
    lines.push(`⚠ 本地 Skill 清单未读到（${inventoryError}）—— 「装了没用过」部分留空。`);
  }
  const text = lines.join('\n');

  if (C.flagBool(flags, 'save')) {
    C.ensureWritable(dir);
    const target = path.join(CS.summariesDir(dir), `${key}-insights.md`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${text}\n`, 'utf8');
    C.emitText(`已写入 ${target}\n\n${text}`);
    return C.EXIT.OK;
  }
  C.emitText(text);
  return C.EXIT.OK;
}

C.runMain(() => {
  const { pos, flags } = C.parseArgs(process.argv.slice(2));
  const cmd = pos[0] || 'today';  switch (cmd) {
    case 'today':
      return doToday(flags);
    case 'material':
      return doMaterial(flags);
    // V3.3：`draft` 默认输出七段结构；`--verbose` 保留原有明细草稿（不删除既有能力）
    case 'draft':
      return C.flagBool(flags, 'verbose') ? doDraft(flags) : doDailyDraft(flags);
    case 'metrics':
      return doMetrics(flags);
    // V3.6：AI 使用洞察（高频 / 用不上 / 消耗高 / 模型对比 / 项目阶段侧重）
    case 'insights':
    case '洞察':
      if (pos[1] && !flags.scope) flags.scope = pos[1];
      return doInsights(flags);
    case 'week':
      return doPeriod(flags, 'week');
    case 'month':
      return doPeriod(flags, 'month');
    case 'project':
      return doPeriod(flags, 'project');
    case 'save':
      return doSave(flags);
    case 'help':
      C.emitText(USAGE);
      return C.EXIT.OK;
    default:
      C.emitText(USAGE);
      throw new C.LogError(`未知子命令：${cmd}`);
  }
}, module);

// V3.27：为进程内测试导出纯函数。
// 沙箱环境常禁止 node→node 派生（EBUSY），子进程式测试会整片假失败；
// 过期检测是纯计算，用进程内调用更可靠，也不依赖退出码。
module.exports = {
  detectSummaryStaleness,
  readSummarySnapshot,
  staleThresholdOf,
  parseLocalTime,
  readableTime,
  writeSummaryMarkdown,
  doToday,
  doDailyDraft,
};
