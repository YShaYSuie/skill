'use strict';
/**
 * role-profile.js —— 角色画像：按用户职业视角组织工作总结（§24 扩展）。
 *
 * 背景（用户明确要求，2026-09-21）：
 *   同一份工作记录，不同角色关心的维度不同。
 *   产品经理关心「需求阶段分布 / 按产品线汇总 / 交付物产出」，
 *   而工程师关心「改了哪些模块 / 缺陷修复 / 技术债」。
 *   记录的**事实层不变**（content / 时间 / 项目），只是**总结的组织方式**要贴合角色。
 *
 * 设计原则：
 *   1. **纯本地规则，零 Token** —— 与 summary-engine 一致，不调 AI。
 *   2. **画像可配置、可手改** —— 落在 config.role，用户随时能改自己的角色描述、
 *      阶段词表、交付物词表，不需要改代码。
 *   3. **不猜、不编造** —— 识别不出阶段/交付物就留空，不硬套（§11/§13 精神）。
 *   4. **角色只作用于「角色相关」事项** —— 探索、学习、生活类事项不被塞进职业维度，
 *      单列一块，避免把「学了一个新工具」硬说成某个需求阶段的产出。
 *
 * 配置示例（config.json 的 role 段，用户可自行修改）：
 *   "role": {
 *     "title": "产品经理",
 *     "enabled": true,
 *     "stages": ["需求分析", "方案设计", "评审对齐", "跟进落地"],
 *     "deliverables": ["需求文档", "原型", "评审结论", "排期表", "竞品分析"],
 *     "product_lines": [],
 *     "focus": ["需求阶段分布", "按产品线汇总", "交付物产出"]
 *   }
 */

const C = require('./log-core');

/* ------------------------------------------------------------------ *
 * 默认画像：产品经理（用户当前角色）
 * ------------------------------------------------------------------ */

/**
 * 默认角色画像。
 *
 * 用户可整体替换；`enabled: false` 时不输出任何角色块，退化为通用总结。
 */
const DEFAULT_ROLE = {
  title: '产品经理',
  enabled: true,
  // 需求阶段：一条工作事项落在产品生命周期的哪一段
  stages: ['需求分析', '方案设计', '评审对齐', '跟进落地'],
  // 交付物：今天实际产出了什么（PM 最容易被低估的部分）
  deliverables: [
    '需求文档',
    '需求规格说明书',
    '原型',
    '评审结论',
    '竞品分析',
    '排期表',
    '流程设计',
    '数据口径',
  ],
  // 产品线：留空则直接用工作记录里的 project_name
  product_lines: [],
  // 用户最看重的维度（决定总结里哪些块置顶）
  focus: ['需求阶段分布', '按产品线汇总', '交付物产出'],
};

/**
 * 阶段识别规则：按「阶段名 → 关键词正则」匹配。
 *
 * **顺序敏感**：先匹配到的阶段胜出。
 *
 * ⚠️ 词表划分原则：把「产出物制作」与「人际对齐」分开。
 * 「需求评审」这类词同时含「需求」（指向需求分析）与「评审」（指向评审对齐），
 * 归属哪一阶段取决于**动作主体**：自己写文档 → 需求分析；
 * 参加评审会/对齐口径 → 评审对齐。
 * 因此 `需求分析` 的规则里**不含** `评审`，`评审对齐` 放在它后面专门承接这类事项。
 * （真实踩到：「参加需求评审会并对齐口径」被误判为需求分析）
 */
const STAGE_RULES = {
  需求分析: /需求(分析|梳理|调研|澄清|拆解)|原始需求|业务诉求|用户访谈|竞品|市场分析|需求文档|需求规格|需求说明|PRD/,
  方案设计: /(方案|原型|交互|流程|结构|页面|功能)设计|设计(方案|稿|页面)|原型|线框|交互稿|信息架构|功能规划|模块划分/,
  评审对齐: /评审|对齐|汇报|宣讲|沟通|协调|例会|会议|干系人|答疑|确认口径|同步(进度|结论)|拉通/,
  跟进落地: /跟进|推动|落地|验收|测试|上线|发布|排期|进度|里程碑|问题排查|缺陷|回归|交付/,
};

/**
 * 交付物识别：按「交付物名 → 关键词正则」。
 *
 * ⚠️ 关键防误判：`原型` 必须限定为**产出物**语境。
 * 「创建原型版本发布 skill」「原型项目部署」里的「原型」是**项目/工具名**，
 * 不是设计交付物 —— 早期版本用裸 `/原型/` 会把它们误判成产出了原型。
 * 因此要求「原型」后面紧跟产出性词（设计/稿/图/评审/方案/交付），
 * 或前面有「画/做/出/更新/输出」这类动词。
 */
const DELIVERABLE_RULES = {
  // 「原型」与「skill/版本/工程」共现时不算交付物
  需求文档: /需求文档|需求规格|需求说明|PRD|需求清单|需求池/,
  需求规格说明书: /需求规格说明书|规格说明书/,
  原型: /原型(设计|稿|图|评审|方案|交付|说明|文档)|(画|做|出|更新|输出|产出|完成)了?原型|高保真|线框|交互稿/,
  评审结论: /评审(结论|意见|纪要)|评审通过|会议纪要/,
  竞品分析: /竞品|友商|对标|市场调研/,
  排期表: /排期|计划表|里程碑|进度表|甘特/,
  流程设计: /流程(图|设计)|业务流|状态机|时序/,
  数据口径: /数据口径|指标定义|埋点|统计口径|报表定义/,
};

/** 角色相关性的常见否定信号：探索 / 学习 / 生活类不计入职业维度 */
const NON_ROLE_HINT =
  /学习|研究一下|了解一下|探索|试了?试|随便看看|自学|教程|读书|文档阅读|散步|运动|休息|吃饭|买|健身|瑜伽|遛狗|就医|家里/;

/**
 * 「工具建设」信号：为记录工具本身做的开发/配置工作。
 *
 * 这类事项在事实层是真实工作，但**不是产品经理的本职产出** ——
 * 把它算进「需求阶段 / 交付物」会虚增 PM 工作量（真实踩到：
 * 「创建原型版本发布 skill」因含「原型」被误判成产出了原型交付物）。
 *
 * 命中时仍计入角色相关（是工作），但**不参与阶段与交付物识别**，
 * 并在渲染时标注，避免与产品工作混淆。
 */
const TOOLING_HINT =
  /skill|技能|hook|工作流|自动化|agent|适配器|adapter|cli|mcp|插件|工具链|本技能|记录工具/i;

/**
 * 「探索学习」信号（2026-09-21 新增）。
 *
 * 用户明确：**「skill 对我来说不是开发，而是一种探索学习」** ——
 * 对产品经理而言，搭建/改造工具、调研新能力属于**个人方向的探索学习**，
 * 而不是本职的「开发」工作。此前一律按 `开发 / 开发验证` 归类，
 * 既不贴合角色，也让总结读起来像一份工程日报。
 */
const EXPLORE_HINT = /学习|研究|调研|探索|了解|试用|摸索|自学|教程|原理|可行性|方案对比|技术选型/;

/**
 * 「日常活动」信号（2026-09-21 新增）。
 *
 * 用户不仅记录工作，也会记录运动等日常活动（散步 / 瑜伽 / 拉伸 …）。
 * 这类事项**不是工作**，必须与工作分开统计 ——
 * 混进「事项累计时长」会让工作时长虚高，也不符合总结的用途。
 *
 * 注意不要用「买」这类过宽的单字（会误伤「购买服务器」）。
 */
const DAILY_HINT =
  /散步|跑步|运动|健身|瑜伽|拉伸|锻炼|游泳|骑行|爬山|打球|徒步|午休|小憩|休息|早操|通勤|接送|购物|买菜|逛街|理发|就医|看病|家务|打扫|做饭|早餐|午餐|晚餐|吃饭|遛狗|睡觉|陪家人|生活/;

/**
 * 「过程 / 维护活动」信号（V3.24）。
 *
 * 这些内容可以保留在原始记录中，但不属于用户完成的成果：
 *   · 查看日志、读取运行状态
 *   · 修复网络、重启服务、刷新缓存、重跑任务
 *   · 自动化 / 定时 / 后台任务的执行结果
 *
 * 只有显式填写 `output` 时才保留在主总结中 —— 能填出成果，说明它确实
 * 形成了用户可感知结果，而不是纯粹的运行过程。
 */
const OPERATIONAL_PATTERNS = [
  /^(?:查看|看一下|检查|读取|分析)\s*(?:一下)?\s*(?:运行|系统|后台|自动化)?日志(?:$|[，,。；;\s])/,
  /^(?:修复|恢复|重启|刷新|重跑|重连).{0,12}(?:网络|连接|服务|缓存|任务|进程|端口|环境)(?:问题)?[。.!！]*$/,
  /^(?:自动化|定时|后台)任务(?:结果|完成|失败|执行结果|状态)/,
];

/**
 * 是否为「过程 / 维护活动」。
 *
 * 仅作用于自动采集事项；用户手动记录的内容一律保留。
 * 已填写 `output` 或项目阶段时不算维护活动 —— 它们已有明确的成果/交付语义。
 */
function isOperationalSupport(rec) {
  if (!rec || rec.source === 'manual') return false;
  if (rec.output || rec.project_stage) return false;
  const text = [rec.content, rec.detail, rec.notes, rec.log].filter(Boolean).join(' ').trim();
  if (!text) return false;
  return OPERATIONAL_PATTERNS.some((re) => re.test(text));
}

/** 事项分类 */
const CLASSES = {
  product: '产品工作',
  // V3.6（用户 2026-09-24）：从「探索学习」改称「探索沉淀」——
  // 用户对 AI 工具/Skill/MCP 的建设属于**个人方向的沉淀**，不是职业产出。
  exploration: '探索沉淀',
  daily: '日常活动',
  unclassified: '其他工作',
};

/* ------------------------------------------------------------------ *
 * V3.3（用户 2026-09-22）：六分类（category）与产品经理工作类型分组
 * ------------------------------------------------------------------ */

/**
 * 事项分类（`category`）—— 「这是工作还是生活」。
 *
 * 与 CLASSES（四分类）的关系：
 *   CLASSES    是**内部推导桶**（为角色视角服务）
 *   category   是**对外可写入的正式字段**（config.work.categories 可扩展）
 *
 * 顺序即优先级；生活/运动类必须优先于工作类，
 * 否则「运动计划评审」这类措辞会被工作关键词抢走。
 */
const DEFAULT_CATEGORIES = [
  '工作',
  // V3.6：与「工作」并列的独立分类。AI 工具 / Skill / MCP / 提示词建设
  // 一律落这里，不再混进「工作」，也不占产品经理的交付物口径。
  '探索沉淀',
  '生活',
  '个人成长',
  '健康运动',
  '休闲娱乐',
  '其他',
];

/** 「探索沉淀」的正式分类名（对外只此一处定义） */
const EXPLORATION_CATEGORY = '探索沉淀';

/** 探索沉淀的变化类型（V3.24）：主总结优先写用户可感知的能力变化。 */
const EXPLORATION_CHANGE_RULES = [
  { type: '新增能力', re: /新增|增加|支持|上线|发布|开放|实现/ },
  { type: '行为调整', re: /调整|优化|完善|改为|统一|升级|修正/ },
  { type: '能力移除', re: /删除|移除|下线|停用/ },
  { type: '稳定性维护', re: /修复|恢复|稳定|超时|报错|异常|失败|兼容|重试|降级/ },
];

function detectExplorationChange(rec) {
  const text = [rec && rec.output, rec && rec.content, rec && rec.detail]
    .filter(Boolean)
    .join(' ');
  if (!text) return '更新记录';
  for (const rule of EXPLORATION_CHANGE_RULES) {
    if (rule.re.test(text)) return rule.type;
  }
  return '更新记录';
}

/**
 * 探索沉淀的默认关键词（`config.work.exploration_keywords` 可覆盖）。
 *
 * ⚠️ 只放**AI/工具向**的词，不放「学习 / 研究 / 探索」这类泛词 ——
 * 泛词属于「个人成长」（读书、考证），混在一起会把生活向成长也算成 AI 沉淀。
 */
const DEFAULT_EXPLORATION_KEYWORDS = [
  'skill',
  'skills',
  'hook',
  'mcp',
  '提示词',
  'prompt',
  '自动化',
  'agent',
  '子代理',
  '适配器',
  'adapter',
  '插件',
  '工具链',
  '工作流',
  '能力建设',
  'AI 探索',
  'AI探索',
  '记录工具',
  '本技能',
];

/**
 * 生活类强信号（**永远优先**）。
 *
 * 顺序即优先级；生活/运动类必须优先于项目与工作类，
 * 否则「运动计划评审」这类措辞会被工作关键词抢走。
 */
const LIFE_CATEGORY_RULES = [
  {
    category: '健康运动',
    re: /散步|跑步|运动|健身|瑜伽|拉伸|锻炼|游泳|骑行|爬山|打球|徒步|普拉提|pilates|八段锦|跳操/i,
  },
  { category: '休闲娱乐', re: /看电影|追剧|游戏|旅游|旅行|逛街|音乐会|展览|看书|闲聊|放松|郊游/ },
  {
    category: '生活',
    re: /吃饭|早餐|午餐|晚餐|做饭|家务|打扫|购物|买菜|理发|就医|看病|接送|通勤|陪家人|睡觉|午休|生活/,
  },
];

/** 个人成长信号（无项目时的次级判据） */
const GROWTH_RULE =
  /学习|研究|调研|探索|了解|试用|摸索|自学|教程|课程|考试|读书|技能|方法论|复盘自己/;

/** 工作信号（无项目时的兜底判据） */
const WORK_RULE =
  /需求|方案|设计|评审|开发|研发|联调|接口|测试|验收|缺陷|bug|上线|发布|项目|会议|排期|进度|文档|原型|数据|指标|运营|复盘|对接|沟通|汇报|协调/i;

/**
 * 完整分类规则表（生活类 → 成长 → 工作）。
 *
 * 保留导出是因为历史调用点与自检引用它；**新代码请用 `categoryOf()`** ——
 * 它额外实现了「显式 category > 项目归属 > 内容关键词」的完整优先级。
 */
const CATEGORY_RULES = [
  ...LIFE_CATEGORY_RULES,
  { category: '个人成长', re: GROWTH_RULE },
  { category: '工作', re: WORK_RULE },
];

/**
 * 归一化「工作分类区块」配置。
 *
 * 同时接受 `config.work` 整块，或只含两个探索字段的小对象；
 * 两个字段都缺省时使用内置默认（关键词有默认、项目白名单为空）。
 */
function normalizeSection(section) {
  const s = section && typeof section === 'object' && !Array.isArray(section) ? section : {};
  const strList = (v, fallback) => {
    if (!Array.isArray(v)) return fallback.slice();
    const out = v.map((x) => String(x).trim()).filter(Boolean);
    return out.length ? out : fallback.slice();
  };
  return {
    // 项目白名单**留空是有意义的**（表示只用内置工具项目规则），不回落成默认非空表
    projects: Array.isArray(s.exploration_projects)
      ? s.exploration_projects.map((x) => String(x).trim()).filter(Boolean)
      : [],
    keywords: strList(s.exploration_keywords, DEFAULT_EXPLORATION_KEYWORDS),
  };
}

/**
 * 项目名是否属于「探索沉淀」项目。
 *
 * 判据（任一命中即可）：
 *   ① 命中 `config.work.exploration_projects` 白名单（双向包含，容忍简写）
 *   ② 项目名本身命中工具词表（如「AI Skill 探索」「每日工作记录 skill」）
 */
function isExplorationProject(projectName, section) {
  const p = String(projectName || '').trim();
  if (!p) return false;
  const { projects } = normalizeSection(section);
  if (projects.some((x) => p === x || p.includes(x) || x.includes(p))) return true;
  return TOOLING_HINT.test(p);
}

/** 文本是否命中探索沉淀关键词 */
function matchesExplorationText(text, section) {
  const t = String(text || '');
  if (!t) return false;
  const { keywords } = normalizeSection(section);
  const lower = t.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

/**
 * 只按**项目名**判定分类（结算期用）。
 *
 * 结算时还不知道事项内容属于哪一类，只知道它挂在哪个项目下；
 * 因此只在「命中探索类项目」时给出 `探索沉淀`，其余返回 null
 * —— 剩下的交给总结层用上下文二次确认，不在这里猜。
 *
 * @returns {string|null} `探索沉淀` 或 null
 */
function categoryForProject(projectName, section) {
  return isExplorationProject(projectName, section) ? EXPLORATION_CATEGORY : null;
}

/**
 * 产品经理工作类型分组（用户 §11 / §16.2）。
 *
 * 日总结的「产品工作」章节按此分组组织，**只覆盖 category = 工作 的事项**；
 * 生活/运动/个人成长不进入本分组（用户明确要求）。
 * 只输出实际存在的分组。
 */
const PM_WORK_GROUPS = ['需求', '产品设计', '项目推进', '研发协作', '项目管理', '数据分析', '其他'];

/** 工作类型 → 分组（键为 config.work.work_types 中的取值；未列出的进「其他」） */
const PM_GROUP_OF_TYPE = {
  // —— config.work.work_types 默认口径（18 项）——
  '产品规划': '产品设计',
  '需求分析': '需求',
  '需求沟通': '需求',
  '需求文档': '需求',
  '竞品/行业研究': '需求',
  '产品设计': '产品设计',
  '原型设计': '产品设计',
  '交互设计': '产品设计',
  '数据分析': '数据分析',
  '项目管理': '项目管理',
  '研发协作': '研发协作',
  '测试验收': '研发协作',
  '上线发布': '项目推进',
  '问题处理': '研发协作',
  '产品运营': '项目推进',
  '产品复盘': '项目推进',
  '会议': '项目推进',
  '其他工作': '其他',
  // —— 旧口径 / 用户自定义别名，保留向后兼容 ——
  '需求梳理': '需求',
  '需求澄清': '需求',
  'UI设计': '产品设计',
  '项目跟进': '项目推进',
  '项目推进': '项目推进',
  '版本发布': '项目推进',
  '沟通协调': '项目推进',
  '项目会议': '项目推进',
  '技术方案': '研发协作',
  '开发': '研发协作',
  '开发验证': '研发协作',
  '问题排查': '研发协作',
  '测试': '研发协作',
};

/**
 * 判定一条事项的分类。
 *
 * V3.6 优先级（用户 2026-09-24 明确要求）：
 *
 * ```text
 * ① 显式 category（用户/AI 写了什么就是什么，永不覆盖）
 * ② 生活类强信号（运动 / 休闲 / 生活 —— 永远不被项目与工作抢走）
 * ③ 项目归属：探索类项目 → 探索沉淀；其它具名项目 → 工作
 * ④ 无项目时才看内容关键词：探索沉淀 → 个人成长 → 工作
 * ```
 *
 * 为什么把**项目归属**抬到内容关键词之前：
 * 同一个人既会「为工作做需求分析」，也会「为 skill 做需求分析」，
 * 只靠内容关键词必然把 AI 能力建设误判成工作 —— 这正是用户反馈的
 * 「总结总偏开发视角、看不出我的实际工作内容」。项目名是可核对的证据，
 * 比措辞可靠。
 *
 * @param {object} rec 事项（WorkItem 或 Work Activity）
 * @param {object} [section] `config.work`（读 exploration_projects / exploration_keywords）
 * @returns {string} 分类之一（默认七分类）
 */
function categoryOf(rec, section) {
  if (!rec) return '其他';
  const explicit = rec.category;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const text = [rec.project_name, rec.work_type, rec.content, rec.notes]
    .filter(Boolean)
    .join(' ');
  // ② 生活类强信号
  for (const rule of LIFE_CATEGORY_RULES) {
    if (rule.re.test(text)) return rule.category;
  }
  // ③ 项目归属优先
  const project = String(rec.project_name || '').trim();
  if (project) {
    return isExplorationProject(project, section) ? EXPLORATION_CATEGORY : '工作';
  }
  // ④ 无项目：内容关键词
  if (matchesExplorationText(text, section)) return EXPLORATION_CATEGORY;
  // 「研究/探索」+ 工具词共现（如「研究一下 hook 怎么配」）也归探索沉淀
  if (EXPLORE_HINT.test(text) && TOOLING_HINT.test(text)) return EXPLORATION_CATEGORY;
  if (GROWTH_RULE.test(text)) return '个人成长';
  if (WORK_RULE.test(text)) return '工作';
  return '其他';
}

/**
 * 一条事项是否属于「工作」。
 *
 * 只有 `category = 工作` 的事项才允许套用产品经理视角（用户 §10）；
 * 分类未知时退回四分类：产品工作/其他工作算工作，探索沉淀/日常活动不算。
 */
function isWorkCategory(rec, section) {
  const c = categoryOf(rec, section);
  if (c === '工作') return true;
  // 生活 / 成长 / 健康 / 休闲 / 探索沉淀 都不是工作，无需再退回四分类
  if (c !== '其他') return false;
  if (typeof (rec || {}).category === 'string' && rec.category.trim()) return false;
  const cls = classifyRecord(rec, section);
  return cls === 'product' || cls === 'unclassified';
}

/** 工作类型 → PM 分组（未映射的进「其他」，不丢事项） */
function pmWorkGroupOf(rec) {
  const t = String((rec && rec.work_type) || '').trim();
  if (t && PM_GROUP_OF_TYPE[t]) return PM_GROUP_OF_TYPE[t];
  // 工作类型缺失时按内容兜底识别（仍属推导，不写回记录）
  const text = String((rec && rec.content) || '');
  if (/需求|PRD|竞品|调研/i.test(text)) return '需求';
  if (/原型|交互|页面|界面|设计/i.test(text)) return '产品设计';
  if (/数据|指标|报表|看板|埋点/i.test(text)) return '数据分析';
  if (/开发|联调|接口|技术|缺陷|bug|测试|验收/i.test(text)) return '研发协作';
  if (/进度|排期|推进|跟进|上线|发布|运营|复盘/i.test(text)) return '项目推进';
  return '其他';
}

/**
 * 把一条事项归入四类之一（顺序敏感）。
 *
 * ```text
 * ① daily        运动/生活类优先 —— 即使写着「运动计划」也不算工作
 * ② exploration  技能/工具/MCP/自动化，或学习调研类措辞
 * ③ product      有项目名（且不是工具项目）
 * ④ unclassified 有工作类型但无项目，也无学习/生活信号
 * ```
 *
 * **项目允许为空**：③④ 之外的事项依然会被汇总，
 * 只是按「探索学习 / 日常活动」这类**贴合个人方向**的维度呈现，
 * 而不是当成「项目识别失败」的异常。
 */
function classifyRecord(rec, section) {
  if (!rec) return 'unclassified';
  const text = [rec.project_name, rec.content, rec.notes].filter(Boolean).join(' ');
  if (DAILY_HINT.test(text)) return 'daily';
  // 项目本身就属探索类 → 探索沉淀（先于内容词，保证项目归属优先）
  if (isExplorationProject(rec.project_name, section)) return 'exploration';
  if (TOOLING_HINT.test(text) || EXPLORE_HINT.test(text)) return 'exploration';
  if (rec.project_name) return 'product';
  return 'unclassified';
}

/* ------------------------------------------------------------------ *
 * 配置归一化
 * ------------------------------------------------------------------ */

/**
 * 归一化角色画像配置。
 *
 * 缺省字段回落到 DEFAULT_ROLE；`enabled` 显式 false 时才关闭。
 * 词表为空数组时回落到默认词表（避免用户误删一个字段导致识别全失效）。
 *
 * @param {object} raw config.role
 * @returns {object} 归一化后的画像
 */
function normalizeRole(raw) {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const list = (v, fallback) => {
    if (!Array.isArray(v)) return fallback.slice();
    const out = v.map((x) => String(x).trim()).filter(Boolean);
    return out.length ? out : fallback.slice();
  };
  return {
    // title 可为空串（表示「不声明角色，只做维度组织」），但不允许非字符串
    title: typeof r.title === 'string' ? r.title.trim() : DEFAULT_ROLE.title,
    enabled: r.enabled === undefined ? DEFAULT_ROLE.enabled : Boolean(r.enabled),
    stages: list(r.stages, DEFAULT_ROLE.stages),
    deliverables: list(r.deliverables, DEFAULT_ROLE.deliverables),
    // 产品线留空是**有意义**的默认（表示用记录里的项目名），不回落
    product_lines: Array.isArray(r.product_lines)
      ? r.product_lines.map((x) => String(x).trim()).filter(Boolean)
      : [],
    focus: list(r.focus, DEFAULT_ROLE.focus),
  };
}

/* ------------------------------------------------------------------ *
 * 识别
 * ------------------------------------------------------------------ */

/**
 * 判断一条事项是否属于「角色相关」工作。
 *
 * 规则：
 *   - 有项目名 → 相关（项目工作就是职业工作）
 *   - 有工作类型且不是「其他」 → 相关
 *   - 其余（纯探索/生活） → 不相关，单列
 *
 * 注意：NON_ROLE_HINT 只对**无项目**的事项生效 ——
 * 项目工作里出现「学习」字样（如「学习平台的需求分析」）不应被误判为个人学习。
 */
function isRoleRelevant(rec) {
  if (!rec) return false;
  if (rec.project_name) return true;
  const wt = rec.work_type;
  if (wt && wt !== '其他') return true;
  return false;
}

/** 是否为「非角色」内容（探索/学习/生活），用于单列提示 */
function isNonRole(rec) {
  if (!rec) return false;
  if (isRoleRelevant(rec)) return false;
  return true;
}

/**
 * 是否为「工具建设」类事项（为记录工具/自动化本身做的工作）。
 *
 * 见 TOOLING_HINT 注释：这类事项计入角色相关但**不产出 PM 交付物**。
 */
function isTooling(rec) {
  if (!rec) return false;
  const text = [rec.content, rec.notes].filter(Boolean).join(' ');
  return TOOLING_HINT.test(text);
}

/**
 * 项目名本身是否为工具项目（如「每日工作记录 skill」）。
 *
 * 与 isTooling 分开：事项内容可能不含工具词，但所属项目就是工具项目。
 */
function isToolingProject(rec, section) {
  if (!rec) return false;
  const p = rec.project_name;
  return isExplorationProject(p, section);
}

/**
 * 识别事项所处的需求阶段。
 *
 * @returns {string|null} 阶段名；识别不出返回 null（不硬套「其他阶段」）
 */
function detectStage(rec, role) {
  const text = [rec && rec.content, rec && rec.work_type, rec && rec.notes]
    .filter(Boolean)
    .join(' ');
  if (!text) return null;
  const stages = (role && role.stages) || DEFAULT_ROLE.stages;
  // 只对画像里声明过的阶段做识别：用户删掉的阶段不该再出现
  for (const stage of stages) {
    const re = STAGE_RULES[stage];
    if (re && re.test(text)) return stage;
  }
  return null;
}

/**
 * 识别事项产出的交付物。
 *
 * 一条事项可命中多个交付物（如「需求文档 + 原型一起更新」）。
 *
 * @returns {string[]} 交付物名列表；无则空数组
 */
function detectDeliverables(rec, role) {
  const text = [rec && rec.content, rec && rec.notes].filter(Boolean).join(' ');
  if (!text) return [];
  const allowed = (role && role.deliverables) || DEFAULT_ROLE.deliverables;
  const out = [];
  for (const name of allowed) {
    const re = DELIVERABLE_RULES[name];
    if (re && re.test(text)) out.push(name);
  }
  return out;
}

/** 解析一条事项的产品线：优先显式 project_name，画像里有 product_lines 时做映射 */
function productLineOf(rec, role) {
  const p = (rec && rec.project_name) || null;
  if (!p) return null;
  const lines = role && role.product_lines;
  if (Array.isArray(lines) && lines.length) {
    const hit = lines.find((l) => p.includes(l) || l.includes(p));
    if (hit) return hit;
  }
  return p;
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

/**
 * 构建角色视角视图。
 *
 * 输出三块（对应用户指定的关注重点）：
 *   stages       需求阶段分布 —— 各阶段事项数 / 分钟数
 *   product_lines 按产品线汇总
 *   deliverables 交付物产出 —— 实际产出了什么（去重计次）
 *
 * 无任何角色相关事项时返回 null，由调用方决定是否跳过该块。
 *
 * @param {Array} items 合并后的工作事项（buildSummaryView().items）
 * @param {object} role 角色画像
 * @param {object} [section] `config.work`（探索沉淀归属用）
 */
function buildRoleView(items, role, section) {
  const r = normalizeRole(role);
  if (!r.enabled) return null;
  const list = Array.isArray(items) ? items : [];
  const operational = list.filter((x) => isOperationalSupport(x));
  const actionable = list.filter((x) => !isOperationalSupport(x));
  const relevant = actionable.filter(isRoleRelevant);
  const nonRole = actionable.filter(isNonRole);
  // 工具建设类：是工作但非 PM 交付，单列且不参与阶段/交付物/产品线识别
  const tooling = relevant.filter((r) => isTooling(r) || isToolingProject(r, section));
  const productWork = relevant.filter((r) => !isTooling(r) && !isToolingProject(r, section));
  // 探索沉淀（V3.6）：AI 工具 / Skill / MCP / 提示词建设 —— 个人方向，不计职业产出
  const exploration = actionable.filter((x) => categoryOf(x, section) === EXPLORATION_CATEGORY);

  // ① 需求阶段分布（只看产品工作）
  const stageMap = new Map();
  for (const it of productWork) {
    const stage = detectStage(it, r);
    const key = stage || '未识别阶段';
    const cur = stageMap.get(key) || { stage: key, items: 0, minutes: 0, titles: [] };
    cur.items += 1;
    cur.minutes += Number(it.actual_duration) || 0;
    cur.titles.push(it.content);
    stageMap.set(key, cur);
  }
  // 画像声明的顺序优先，未识别阶段永远排最后
  const declaredOrder = new Map(r.stages.map((s, i) => [s, i]));
  const stages = [...stageMap.values()].sort((a, b) => {
    const ai = declaredOrder.has(a.stage) ? declaredOrder.get(a.stage) : 999;
    const bi = declaredOrder.has(b.stage) ? declaredOrder.get(b.stage) : 999;
    return ai - bi;
  });

  // ② 按产品线汇总（只看产品工作）
  //    注意：项目名本身命中 TOOLING_HINT 时也要排除 ——
  //    「每日工作记录 skill」是工具项目，不是产品线（真实踩到）
  const lineMap = new Map();
  for (const it of productWork) {
    if (isToolingProject(it, section)) continue;
    const line = productLineOf(it, r) || '未归属产品线';
    const cur = lineMap.get(line) || { product_line: line, items: 0, minutes: 0, titles: [] };
    cur.items += 1;
    cur.minutes += Number(it.actual_duration) || 0;
    cur.titles.push(it.content);
    lineMap.set(line, cur);
  }
  const productLines = [...lineMap.values()].sort((a, b) => b.minutes - a.minutes);

  // ③ 交付物产出（只看产品工作，避免工具建设虚增交付物）
  const delivMap = new Map();
  for (const it of productWork) {
    for (const d of detectDeliverables(it, r)) {
      const cur = delivMap.get(d) || { deliverable: d, count: 0, titles: [] };
      cur.count += 1;
      cur.titles.push(it.content);
      delivMap.set(d, cur);
    }
  }
  const declaredDeliv = new Map(r.deliverables.map((s, i) => [s, i]));
  const deliverables = [...delivMap.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const ai = declaredDeliv.has(a.deliverable) ? declaredDeliv.get(a.deliverable) : 999;
    const bi = declaredDeliv.has(b.deliverable) ? declaredDeliv.get(b.deliverable) : 999;
    return ai - bi;
  });

  // 只要当天**有任何事项**就构建视图 —— 不再以「有没有角色相关事项」为门槛。
  //
  // ⚠️ 2026-09-21 修正：原判据是 `if (!relevant.length) return null`，而
  // `isRoleRelevant` 要求「有项目 或 有工作类型」。于是「无项目 + 无类型」的
  // 探索学习事项（如「完成每日日程Skill的搭建」）会让整个视图返回 null ——
  // 用户明确「项目允许为空」，这类事项恰恰必须被汇总，而不是被整块丢弃。
  if (!list.length) return null;

  return {
    role_title: r.title,
    focus: r.focus,
    role_relevant_count: relevant.length,
    role_relevant_minutes: relevant.reduce((s, x) => s + (Number(x.actual_duration) || 0), 0),
    stages,
    product_lines: productLines,
    deliverables,
    // 产品工作（真正进入阶段/交付物统计的部分）
    product_work_count: productWork.length,
    product_work_minutes: productWork.reduce((s, x) => s + (Number(x.actual_duration) || 0), 0),
    // 过程 / 维护活动：保留计数，不进入成果、阶段、交付物或工时口径。
    operational: operational.map((x) => ({
      content: x.content,
      project_name: x.project_name || null,
      duration: x.actual_duration ?? x.duration_minutes ?? null,
    })),
    operational_count: operational.length,
    // 探索沉淀（V3.6）：独立于职业维度，供总结「探索沉淀」块与 focus 维度使用
    exploration: exploration.map((x) => ({
      content: x.content,
      duration: x.actual_duration ?? x.duration_minutes ?? null,
      project_name: x.project_name || null,
      work_type: x.work_type || null,
      output: x.output || null,
      change_type: detectExplorationChange(x),
    })),
    exploration_count: exploration.length,
    exploration_minutes: exploration.reduce(
      (s, x) => s + (Number(x.actual_duration ?? x.duration_minutes) || 0),
      0
    ),
    // 工具建设：是工作但不是 PM 交付，单列（附项目与类型，便于按项目归并展示）
    tooling: tooling.map((x) => ({
      content: x.content,
      duration: x.actual_duration,
      project_name: x.project_name || null,
      work_type: x.work_type || null,
    })),
    tooling_count: tooling.length,
    // 探索 / 学习 / 生活类：单列，不塞进职业维度
    non_role: nonRole.map((x) => ({ content: x.content, duration: x.actual_duration })),
    non_role_count: nonRole.length,
    // 四分类分桶（2026-09-21，2026-09-24 更名）：产品工作 / 探索沉淀 / 日常活动 / 其他工作
    buckets: (() => {
      const out = {};
      for (const key of Object.keys(CLASSES)) {
        const items = actionable.filter((x) => classifyRecord(x, section) === key);
        out[key] = {
          key,
          label: CLASSES[key],
          count: items.length,
          minutes: items.reduce((s, x) => s + (Number(x.actual_duration) || 0), 0),
          titles: items.map((x) => x.content),
        };
      }
      return out;
    })(),
    // 工作时长与日常活动时长**分开**：混在一起会让工时虚高
    work_minutes:
      actionable.filter((x) => classifyRecord(x, section) !== 'daily').reduce(
        (s, x) => s + (Number(x.actual_duration) || 0),
        0
      ),
    daily_minutes:
      actionable.filter((x) => classifyRecord(x, section) === 'daily').reduce(
        (s, x) => s + (Number(x.actual_duration) || 0),
        0
      ),
  };
}

/**
 * 把角色视角渲染成文本块（供 daily-summary 的 draft 使用）。
 *
 * 渲染规则：
 *   - 无角色相关事项 → 返回空数组（不产出空块）
 *   - 阶段 / 产品线 / 交付物 均按「用户 focus 顺序」排列
 *   - 交付物块用「产出」措辞而非「事项」，强调 PM 的实际交付
 */
function renderRoleView(view) {
  if (!view) return [];
  const L = [];
  const title = view.role_title ? `（${view.role_title}视角）` : '';
  L.push(`十、角色维度汇总${title}`);
  // 角色相关为 0 时不要打印「0 项 / 0 分钟」的空壳标题行
  // （今天只记录了运动的情况是合法的，不该出现一行无意义的 0）
  if (view.role_relevant_count) {
    L.push(
      `  角色相关事项 ${view.role_relevant_count} 项 / ${view.role_relevant_minutes} 分钟` +
        (view.product_work_count
          ? `，其中产品工作 ${view.product_work_count} 项 / ${view.product_work_minutes} 分钟`
          : '')
    );
  }
  // 工作与日常活动分开报，避免「运动也算工时」
  if (view.buckets) {
    const b = view.buckets;
    L.push(
      `  工作 ${view.work_minutes} 分钟　日常活动 ${view.daily_minutes} 分钟` +
        `（日常活动不计入工时）`
    );
    if (b.exploration.count) {
      L.push(
        `  · ${EXPLORATION_CATEGORY} ${b.exploration.count} 项 / ${b.exploration.minutes} 分钟` +
          '（AI 工具 / Skill / MCP / 提示词建设 —— 属个人方向，不计 PM 交付物）'
      );
    }
    if (b.daily.count) {
      L.push(
        `  · 日常活动 ${b.daily.count} 项 / ${b.daily.minutes} 分钟：` +
          b.daily.titles.slice(0, 8).map((t) => String(t).slice(0, 20)).join('；')
      );
    }
    if (b.unclassified.count) {
      L.push(
        `  · 其他工作 ${b.unclassified.count} 项 / ${b.unclassified.minutes} 分钟` +
          '（无项目、也无学习/生活信号；可按需要补项目名）'
      );
    }
    if (view.operational_count) {
      L.push(
        `  · 过程 / 维护 ${view.operational_count} 项` +
          '（查看日志、环境恢复、任务重跑等；不计入成果与工时口径）'
      );
    }
  }
  L.push('');

  const order = view.focus.length ? view.focus : ['需求阶段分布', '按产品线汇总', '交付物产出'];

  // 无产品工作时，只保留「交付物产出」并如实说明为空 ——
  // 不打印三块空壳（阶段 / 产品线都没有可说的内容），避免总结被空块淹没
  const hasProductWork = view.product_work_count > 0;

  for (const dim of order) {
    if (dim === '需求阶段分布' && view.stages.length && hasProductWork) {
      L.push('  · 需求阶段分布');
      view.stages.forEach((s) => {
        const tail = s.titles.length
          ? `：${s.titles.map((t) => (t.length > 28 ? t.slice(0, 28) + '…' : t)).join('；')}`
          : '';
        L.push(`      ${s.stage}　${s.items} 项 / ${s.minutes} 分钟${tail}`);
      });
      L.push('');
    }
    if (dim === '按产品线汇总' && view.product_lines.length && hasProductWork) {
      L.push('  · 按产品线汇总');
      view.product_lines.forEach((p) => {
        L.push(`      ${p.product_line}　${p.items} 项 / ${p.minutes} 分钟`);
      });
      L.push('');
    }
    if (dim === '交付物产出') {
      L.push('  · 交付物产出（产品工作）');
      if (view.deliverables.length) {
        view.deliverables.forEach((d) => {
          L.push(`      ${d.deliverable}　×${d.count}`);
        });
      } else if (hasProductWork) {
        L.push('      （本日产品工作未识别到明确交付物）');
      } else {
        // 不编造：确实没有产品工作，就如实说明，并指明今日时间去向
        L.push('      （本日无产品工作，未产出角色交付物；时间去向见「探索沉淀」块）');
      }
      L.push('');
    }
    // V3.6：探索沉淀独立维度 —— 与职业交付物严格分开，不做职业化解读
    if (dim === EXPLORATION_CATEGORY) {
      L.push(`  · ${EXPLORATION_CATEGORY}（个人方向，不计职业产出）`);
      if (view.exploration_count) {
        L.push(`      ${view.exploration_count} 项 / ${view.exploration_minutes} 分钟`);
        view.exploration.slice(0, 10).forEach((x) => {
          const d =
            x.duration === null || x.duration === undefined ? '时长未记录' : `${x.duration} 分钟`;
          const proj = x.project_name ? `【${x.project_name}】` : '';
          const out = x.output ? `　产出：${x.output}` : '';
        L.push(`      ${proj}${x.change_type}：${x.content}　（${d}）${out}`);
        });
      } else {
        L.push('      （本日无探索沉淀）');
      }
      L.push('');
    }
  }

  // 工具建设：**只给汇总，不再逐条铺陈**（用户 2026-09-21：
  // 「同项目同类型合并、总结日程即可，不用把细节都写出来」）。
  // 逐条明细保留在 current.json.records 与 logs/<date>/work-activities.jsonl。
  if (view.tooling_count) {
    const byProject = new Map();
    for (const x of view.tooling) {
      const key = x.project_name || '（未归属项目）';
      const cur = byProject.get(key) || { n: 0, min: 0, types: new Set() };
      cur.n += 1;
      cur.min += Number(x.duration) || 0;
      if (x.work_type) cur.types.add(x.work_type);
      byProject.set(key, cur);
    }
    const total = view.tooling.reduce((s, x) => s + (Number(x.duration) || 0), 0);
    L.push(
      `  · 工具建设 ${view.tooling_count} 项 / ${total} 分钟（真实工作，但不计入 PM 交付物）`
    );
    [...byProject.entries()]
      .sort((a, b) => b[1].min - a[1].min)
      .forEach(([proj, v]) => {
        const types = [...v.types].join('/') || '（未分类）';
        L.push(`      ${proj}｜${types}　${v.n} 项 / ${v.min} 分钟`);
      });
    L.push('');
  }

  // 非角色相关（运动 / 生活）：单列且**不计入工时**
  if (view.non_role_count) {
    const mins = view.non_role.reduce((s, x) => s + (Number(x.duration) || 0), 0);
    L.push(
      `  · 日常活动 ${view.non_role_count} 项 / ${mins} 分钟` +
        '（运动与生活，**不计入工时**）'
    );
    view.non_role.forEach((x) => {
      const d = x.duration === null || x.duration === undefined ? '时长未记录' : `${x.duration} 分钟`;
      L.push(`      ${x.content}　（${d}）`);
    });
    L.push('');
  }

  // 去掉末尾空行
  while (L.length && L[L.length - 1] === '') L.pop();
  return L;
}

/**
 * 把事项按 **category** 分桶（用户 §10/§16.6「时间结构」）。
 *
 * 只统计，不做职业化解读 —— 生活/运动/休闲的原样呈现。
 *
 * @param {Array} items
 * @param {string[]} [categories] 允许的分类（默认七分类 + 记录中出现的其它值）
 * @param {object} [section] `config.work`
 * @returns {{buckets: Array, total_minutes: number, work_minutes: number,
 *            exploration_minutes: number, life_minutes: number}}
 */
function categoryBreakdown(items, categories, section) {
  const list = Array.isArray(items) ? items : [];
  const declared = Array.isArray(categories) && categories.length ? categories : DEFAULT_CATEGORIES;
  const map = new Map();
  for (const it of list) {
    const c = categoryOf(it, section);
    const cur = map.get(c) || { category: c, count: 0, minutes: 0, titles: [], open_ended: 0 };
    cur.count += 1;
    cur.minutes += Number(it.actual_duration ?? it.duration_minutes) || 0;
    if (!it.end_time) cur.open_ended += 1;
    cur.titles.push(it.content || '');
    map.set(c, cur);
  }
  // 先按声明顺序，再按记录里出现但未声明的分类（不丢数据）
  const order = new Map(declared.map((c, i) => [c, i]));
  const buckets = [...map.values()].sort((a, b) => {
    const ai = order.has(a.category) ? order.get(a.category) : 999;
    const bi = order.has(b.category) ? order.get(b.category) : 999;
    if (ai !== bi) return ai - bi;
    return b.minutes - a.minutes;
  });
  const sum = (sel) => buckets.filter(sel).reduce((s, b) => s + b.minutes, 0);
  return {
    buckets,
    total_minutes: sum(() => true),
    work_minutes: sum((b) => b.category === '工作'),
    // 探索沉淀单列：它既不是职业工作，也不该混进「生活」
    exploration_minutes: sum((b) => b.category === EXPLORATION_CATEGORY),
    // 「非工作时间」= 除工作以外的全部（探索沉淀/生活/健康/休闲/成长/其他）
    life_minutes: sum((b) => b.category !== '工作'),
  };
}

/**
 * 按 **产品线 / 项目 → 项目阶段 → 交付物** 组织工作（V3.6，用户 2026-09-24）。
 *
 * 用户原话：
 *   「现在的总结都是我解决了什么问题……在工作上面，没有很体现我的实际工作内容。」
 *
 * 因此工作块的主轴从「工作类型分组 + 内容叙述」换成 **PM 的交付物视角**：
 *   ① 每个产品线/项目下，先看**项目阶段**分布；
 *   ② 再看**实际产出的交付物**（需求文档 / PRD / 原型 / 评审结论 …）；
 *   ③ 事项内容只作明细行，不再占据主位。
 *
 * 约束：
 *   · **只覆盖 `category = 工作` 的事项** —— 探索沉淀 / 生活 / 运动永不进入；
 *   · 阶段优先取记录里的显式 `project_stage`，缺失时才用画像规则**推导**
 *     （推导结果只用于展示，不写回记录）；
 *   · `output` 只收集记录里**确实写了**的，不虚构成果。
 *
 * @param {Array} items 合并后的事项
 * @param {object} role 角色画像（交付物词表来自这里）
 * @param {object} [section] `config.work`
 */
function groupWorkBoard(items, role, section) {
  const r = normalizeRole(role);
  const candidates = (Array.isArray(items) ? items : []).filter((it) =>
    isWorkCategory(it, section)
  );
  const operational = candidates.filter((it) => isOperationalSupport(it));
  const list = candidates.filter((it) => !isOperationalSupport(it));
  const projects = new Map();
  const stageAgg = new Map();
  const delivAgg = new Map();

  for (const it of list) {
    // 阶段：显式字段优先，其次按画像词表推导（推导只展示、不写回）
    const stage = it.project_stage || detectStage(it, r) || '未标注阶段';
    const line = productLineOf(it, r) || '（未归属产品线）';
    const minutes = Number(it.actual_duration ?? it.duration_minutes) || 0;

    if (!projects.has(line)) {
      projects.set(line, {
        product_line: line,
        count: 0,
        minutes: 0,
        stageCount: new Map(),
        delivCount: new Map(),
        items: [],
        outputs: [],
      });
    }
    const p = projects.get(line);
    p.count += 1;
    p.minutes += minutes;
    p.stageCount.set(stage, (p.stageCount.get(stage) || 0) + 1);
    p.items.push({
      content: it.content,
      work_type: it.work_type || null,
      stage,
      start_time: it.start_time || null,
      end_time: it.end_time || null,
      duration: minutes || null,
      output: it.output || null,
    });
    if (it.output) p.outputs.push(it.output);

    const cur =
      stageAgg.get(stage) || { stage, count: 0, minutes: 0, titles: [] };
    cur.count += 1;
    cur.minutes += minutes;
    if (it.content) cur.titles.push(it.content);
    stageAgg.set(stage, cur);

    for (const d of detectDeliverables(it, r)) {
      const dc = delivAgg.get(d) || { deliverable: d, count: 0, titles: [] };
      dc.count += 1;
      if (it.content) dc.titles.push(it.content);
      delivAgg.set(d, dc);
      p.delivCount.set(d, (p.delivCount.get(d) || 0) + 1);
    }
  }

  const declaredStage = new Map(r.stages.map((s, i) => [s, i]));
  const stages = [...stageAgg.values()].sort((a, b) => {
    const ai = declaredStage.has(a.stage) ? declaredStage.get(a.stage) : 999;
    const bi = declaredStage.has(b.stage) ? declaredStage.get(b.stage) : 999;
    if (ai !== bi) return ai - bi;
    return b.minutes - a.minutes;
  });

  const declaredDeliv = new Map(r.deliverables.map((s, i) => [s, i]));
  const deliverables = [...delivAgg.values()].sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    const ai = declaredDeliv.has(a.deliverable) ? declaredDeliv.get(a.deliverable) : 999;
    const bi = declaredDeliv.has(b.deliverable) ? declaredDeliv.get(b.deliverable) : 999;
    return ai - bi;
  });

  const projectRows = [...projects.values()]
    .map((p) => ({
      product_line: p.product_line,
      count: p.count,
      minutes: p.minutes,
      stages: [...p.stageCount.entries()]
        .map(([stage, count]) => ({ stage, count }))
        .sort((a, b) => b.count - a.count),
      deliverables: [...p.delivCount.entries()]
        .map(([deliverable, count]) => ({ deliverable, count }))
        .sort((a, b) => b.count - a.count),
      items: p.items,
      outputs: p.outputs,
    }))
    .sort((a, b) => b.minutes - a.minutes || b.count - a.count);

  return {
    item_count: list.length,
    minutes: list.reduce(
      (s, x) => s + (Number(x.actual_duration ?? x.duration_minutes) || 0),
      0
    ),
    operational_count: operational.length,
    operational: operational.map((x) => ({
      content: x.content,
      project_name: x.project_name || null,
      work_type: x.work_type || null,
      duration: x.actual_duration ?? x.duration_minutes ?? null,
    })),
    projects: projectRows,
    stages,
    deliverables,
  };
}

/**
 * 汇总探索沉淀中的用户可感知变化（V3.24）。
 *
 * 主总结只展开能力变化；纯修复 / 稳定性维护单独计数，避免“修了什么”挤占
 * “新增了什么能力”的位置。
 */
function buildExplorationView(items, section) {
  const list = (Array.isArray(items) ? items : []).filter(
    (it) => categoryOf(it, section) === EXPLORATION_CATEGORY
  );
  const updates = list.map((it) => ({
    content: it.content || '',
    output: it.output || null,
    project_name: it.project_name || null,
    work_type: it.work_type || null,
    duration: it.actual_duration ?? it.duration_minutes ?? null,
    change_type: detectExplorationChange(it),
  }));
  const maintenance = updates.filter(
    (x) => x.change_type === '稳定性维护' && !x.output
  );
  const main = updates.filter((x) => !maintenance.includes(x));
  return {
    total: updates.length,
    minutes: updates.reduce((s, x) => s + (Number(x.duration) || 0), 0),
    updates,
    main,
    maintenance,
    maintenance_count: maintenance.length,
  };
}

/**
 * 按 **产品经理工作类型分组**组织工作事项（用户 §11/§16.2）。
 *
 * ```text
 * 需求 / 产品设计 / 项目推进 / 研发协作 / 项目管理 / 数据分析 / 其他
 * ```
 *
 * 约束：
 *   · **只覆盖 category = 工作 的事项** —— 生活与运动不进入产品工作章节；
 *   · 只输出**实际存在**的分组（不打印空块）；
 *   · `outputs` 只收集记录中**确实写了 `output`** 的事项，不虚构成果。
 *
 * @returns {{groups: Array, product_work_count: number, products_minutes: number}}
 */
function groupPmWork(items, section) {
  const list = (Array.isArray(items) ? items : []).filter((it) => isWorkCategory(it, section));
  const map = new Map();
  for (const it of list) {
    const g = pmWorkGroupOf(it);
    const cur = map.get(g) || { group: g, count: 0, minutes: 0, titles: [], outputs: [] };
    cur.count += 1;
    cur.minutes += Number(it.actual_duration ?? it.duration_minutes) || 0;
    cur.titles.push(it.content || '');
    if (it.output) cur.outputs.push({ content: it.content || '', output: it.output });
    map.set(g, cur);
  }
  const order = new Map(PM_WORK_GROUPS.map((g, i) => [g, i]));
  const groups = [...map.values()].sort((a, b) => {
    const ai = order.has(a.group) ? order.get(a.group) : 999;
    const bi = order.has(b.group) ? order.get(b.group) : 999;
    if (ai !== bi) return ai - bi;
    return b.minutes - a.minutes;
  });
  return {
    groups,
    product_work_count: list.length,
    products_minutes: list.reduce((s, x) => s + (Number(x.actual_duration ?? x.duration_minutes) || 0), 0),
  };
}

/**
 * 按 **项目** 聚合（用户 §16.4「项目进展」/§19「项目总结」）。
 *
 * @returns {Array<{project_name, count, minutes, stages: object, outputs: string[], work_types: object}>}
 */
function groupByProjectWithStage(items) {
  const list = Array.isArray(items) ? items : [];
  const map = new Map();
  for (const it of list) {
    const key = it.project_name || '（未归属项目）';
    const cur =
      map.get(key) ||
      {
        project_name: key,
        count: 0,
        minutes: 0,
        titles: [],
        outputs: [],
        stages: {},
        work_types: {},
        open_ended: 0,
      };
    cur.count += 1;
    cur.minutes += Number(it.actual_duration ?? it.duration_minutes) || 0;
    if (!it.end_time) cur.open_ended += 1;
    cur.titles.push(it.content || '');
    if (it.output) cur.outputs.push(it.output);
    const stage = it.project_stage || '未标注阶段';
    cur.stages[stage] = (cur.stages[stage] || 0) + 1;
    const wt = it.work_type || '未分类';
    cur.work_types[wt] = (cur.work_types[wt] || 0) + 1;
    map.set(key, cur);
  }
  return [...map.values()].sort((a, b) => b.minutes - a.minutes);
}

module.exports = {
  DEFAULT_ROLE,
  STAGE_RULES,
  DELIVERABLE_RULES,
  NON_ROLE_HINT,
  TOOLING_HINT,
  EXPLORE_HINT,
  DAILY_HINT,
  CLASSES,
  classifyRecord,
  // V3.3：分类与 PM 分组
  DEFAULT_CATEGORIES,
  CATEGORY_RULES,
  // V3.6：探索沉淀（独立分类 + 项目归属优先）
  EXPLORATION_CATEGORY,
  DEFAULT_EXPLORATION_KEYWORDS,
  EXPLORATION_CHANGE_RULES,
  OPERATIONAL_PATTERNS,
  LIFE_CATEGORY_RULES,
  GROWTH_RULE,
  WORK_RULE,
  normalizeSection,
  isExplorationProject,
  categoryForProject,
  matchesExplorationText,
  PM_WORK_GROUPS,
  PM_GROUP_OF_TYPE,
  groupWorkBoard,
  buildExplorationView,
  detectExplorationChange,
  categoryOf,
  isWorkCategory,
  isOperationalSupport,
  pmWorkGroupOf,
  categoryBreakdown,
  groupPmWork,
  groupByProjectWithStage,
  normalizeRole,
  isRoleRelevant,
  isNonRole,
  isTooling,
  isToolingProject,
  detectStage,
  detectDeliverables,
  productLineOf,
  buildRoleView,
  renderRoleView,
};
