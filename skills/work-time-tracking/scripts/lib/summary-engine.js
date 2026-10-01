'use strict';
/**
 * summary-engine.js — 每日总结的「过滤 + 合并」层（§26）。
 *
 * §26 明确要求：**DailySummary 不应机械复制 Activity**，而应
 *   1 合并同一 WorkItem 的多个 Activity
 *   2 合并连续且明显属于同一工作的活动
 *   …
 *   9 标记无法确认项目的事项
 *
 * 本模块把这两件事从采集层分离出来：
 *
 *   current.json.records   ← 原始记录，**保持完整，采集层不做过滤**
 *            ↓ buildSummaryView()（只读派生，不写回）
 *   合并后的工作事项 + 被过滤的无关对话
 *
 * 关键约束（§25）：本模块**只读**。合并与过滤结果用于生成总结，
 * 绝不覆盖或删改 records —— 原始数据永远可重新分析。
 *
 * 纯本地规则，零 Token。
 */

const path = require('path');
const C = require('./log-core');
const RP = require('./role-profile');

/** 时间相邻判定：两个片段间隔不超过该值即视为连续工作（分钟） */
const MERGE_GAP_MINUTES = 15;

/** 内容相似判定阈值（共享关键词数 / Jaccard 相似度） */
const MERGE_SHARED_TOKENS = 2;
const MERGE_SIMILARITY = 0.3;

/** 同会话上下文归并：同一目标在较长时间跨度内仍视为连续工作 */
const CONTEXT_GAP_MINUTES = 90;
const CONTEXT_SHORT_MAX = 14;

/** 明确的上下文续接信号；只有同会话时才允许借用上下文。 */
const CONTEXT_REFERENCE_RE =
  /(?:继续|接着|再|补充|改成|调整为|按照|按建议|这个|上述|刚才|前面|同样|也|统一为|怎么解决|解决这个|修复这个)/;

/** 明确的主题切换信号，出现时应拆分，不能仅因同会话就合并。 */
const EXPLICIT_TOPIC_SWITCH_RE =
  /(?:换个(?:话题|问题|方向)|先不说|先不讨论|转到|切换到|另(?:一|个)项目|新(?:的)?(?:项目|需求|问题))/;

/** 中文 2-gram 切分（与 activity-engine 保持一致的思路，避免循环依赖故此处独立实现） */
const STOPWORDS = new Set([
  '的', '了', '和', '与', '及', '在', '是', '我', '你', '他', '她', '它', '这', '那', '个', '把',
  '帮', '请', '一下', '继续', '然后', '以及', '看看', '我们', '他们', '进行', '完成', '一个',
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'for', 'in', 'on', 'is', 'are',
]);

function tokenize(text) {
  const src = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of src.match(/[a-z0-9_]{2,}/g) || []) if (!STOPWORDS.has(w)) out.add(w);
  for (const run of src.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (run.length === 1) {
      if (!STOPWORDS.has(run)) out.add(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i += 1) {
      const g = run.slice(i, i + 2);
      if (!STOPWORDS.has(g)) out.add(g);
    }
  }
  return out;
}

function sharedTokens(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  const s = [];
  for (const t of ta) if (tb.has(t)) s.push(t);
  return s;
}

function similarity(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/* ------------------------------------------------------------------ *
 * 1. 无关对话过滤
 * ------------------------------------------------------------------ */

/**
 * 工作/生活「事项性」词汇白名单。
 *
 * 命中即视为真实事项 —— 这是防误杀的关键：
 * 「你好，帮我完善GPU需求」会命中「完善/需求」，因此不会被寒暄规则过滤掉。
 */
const WORK_KEYWORDS =
  /(?:设计|开发|实现|编码|整理|梳理|分析|排查|定位|修复|优化|完善|编写|撰写|评审|对接|联调|测试|验证|部署|上线|调研|输出|搭建|配置|重构|跟进|推进|讨论|沟通|规划|拆解|安排|汇报|记录|更新|调整|新增|删除|迁移|升级|需求|方案|文档|规格|接口|页面|界面|模块|功能|系统|平台|项目|流程|数据|指标|报表|原型|交互|架构|算法|调度|部署|任务|计划|会议|进度|风险|成本|预算)/;

/** 闲聊 / 寒暄特征（仅在无工作词汇时才判定为噪声） */
const CHITCHAT_PATTERNS = [
  { re: /^(?:你好|您好|嗨|哈喽|早上好|下午好|晚上好|hi|hello|hey)/i, reason: '寒暄' },
  {
    re: /^(?:谢谢|多谢|感谢|辛苦了|thanks|thank you|thx|3q)[\s。.!！~]*$/i,
    reason: '致谢',
    strict: true,
  },
  {
    // 纯应答：只有整句就是应答词时才过滤，避免吃掉「继续完善需求」这类真实指令
    re: /^(?:好的?|嗯+|哦+|ok|okay|k|收到|明白|了解|可以|行|没问题)[\s。.!！?？~]*$/i,
    reason: '确认或应答',
    strict: true,
  },
  { re: /(?:过得怎么样|最近怎么样|在忙什么|干嘛呢|在做什么呀|忙不忙)/, reason: '闲聊寒暄' },
  { re: /(?:天气|吃了吗|午饭|晚饭|周末愉快|辛苦了)/, reason: '生活闲聊' },
];

/**
 * 与「工作/生活事项」无关的对话特征。
 *
 * `strict: true` 表示**高置信度**噪声：即使含工作性词汇也判定为无关对话
 * （例如「现在这个skill开始自动记录了吗」含「记录」，但显然是系统状态询问）。
 * 不带 strict 的特征会先让工作词汇白名单放行，避免误杀真实指令。
 *
 * 注意：只对 `source === 'auto'`（宿主对话采集）的事项生效 ——
 * 用户手动记录的内容一律保留，那是刻意记的（§6 人工兜底优先）。
 */
const NOISE_PATTERNS = [
  {
    // 宿主生成的系统通知（任务完成回执、后台命令输出）会经事件通道进入采集，
    // 形如 <task-notification>…<tool-use-id>…<status>completed</status>，不是用户输入。
    // 内容里可能带项目路径，因此必须能**压过项目名**（见 classify 的 strict 优先段）。
    re: /^\s*<[a-zA-Z][\w-]*>|<\/[a-zA-Z][\w-]*>|<(?:task-notification|tool-use-id|status|summary|task-id)\b/i,
    reason: '宿主系统通知（非用户输入）',
    strict: true,
  },
  {
    // 工具操作指令：必须**整句**就是指令才算，避免误杀「总结今日会议结论」这类真实工作。
    // 同时覆盖「总结今日」与「输出今日总结」两种语序，以及「总结一下」。
    //
    // ⚠️ 2026-09-21 修正：原先只匹配到动词为止（`(?:一下|今日|今天|本日)?` 后面直接 `$`），
    // 导致「总结今日工作」「总结一下今天的工作」这类**带宾语**的指令漏网，混进每日总结。
    // 修正方式是给宾语位留一个**极窄**的槽：只允许「工作/记录/日志/情况/总结/汇总」
    // 这类**指代记录本身**的词，且必须紧接句末 ——
    // 因此「总结基金金融调研记录」（真实工作）不会被误杀：宾语是「基金金融调研记录」，
    // 不在白名单内，整句匹配失败。
    re: /^(?:(?:输出|生成|写|做|来|出)\s*)?(?:(?:今日|今天|本日)\s*(?:的)?\s*(?:工作总结|总结|汇总|复盘)|(?:工作总结|总结|汇总|复盘)\s*(?:一下)?\s*(?:今日|今天|本日|当天|当日)?\s*(?:的)?\s*(?:(?:工作|记录|日志|情况|总结|汇总)){0,2})[\s。.!！]*$/,
    reason: '对记录工具的操作指令',
    strict: true,
  },
  {
    // 技能调用语法与技能文档引用，形如 @skill:work-time-tracking、[$work-time-tracking](…SKILL.md)
    re: /@skill:|(?:\$|\[)work-time-tracking\b|work-time-tracking\]\(|skills[\\/]work-time-tracking/i,
    reason: '关于记录工具本身的引用',
    strict: true,
  },
  {
    // 指向「记录工具自身」的请求与讨论：项目映射 / 空间项目 / 日志记录 / skill 逻辑 …
    // 这些是在维护记录工具，不是被记录的工作内容。
    // 注意：不要把「项目名称」这类**业务字段**（如需求里的"项目名称非必填"）算进来，
    // 因此这里只匹配工具机制相关的组合词（项目映射、映射到项目、记录到事项中…）。
    re: /项目映射|映射到项目|空间项目|项目空间|记录工具|更新\s*skill|skill\s*的?逻辑|按本地文件路径|自动同步过去|从\s*workbuddy\s*自动同步|线上接口|记录在线上|操作日志|记录到事项中|这个\s*skill|日志记录是正常记录|已有的项目名称/i,
    reason: '对记录工具的操作指令',
    strict: true,
  },
  {
    // 图片/附件占位符（用户粘贴截图时宿主注入的文本）
    re: /^@image#|^\[image|^@image\b/i,
    reason: '图片附件占位符',
    strict: true,
  },
  {
    // 粘贴回来的日志/清单片段，形如 `9. [14:47]@…`；不是用户的工作描述
    re: /^\d{1,3}\.\s*\[\d{2}:\d{2}\]/,
    reason: '粘贴的日志片段',
    strict: true,
  },
  {
    // 以「日志/记录」为话题的讨论（讨论记录机制本身，不是被记录的工作）
    re: /(?:^|[，,。；;])\s*(?:总结|汇总)\s*日志|log\s*文件中|对话记录也会同步|同步到\s*log/i,
    reason: '对记录工具的操作指令',
    strict: true,
  },
  {
    // /log 指令前缀：「记录：…」是用户调用记录工具，不是工作内容本身
    re: /^记录\s*[:：]/,
    reason: '对记录工具的操作指令',
    strict: true,
  },
  {
    // 以查询动作收尾且宾语是「日志/记录」：查看今日记录、输出原日志记录…
    re: /(?:输出|查看|列出|显示|打印|导出)\s*(?:一下)?\s*(?:原)?\s*(?:今日)?\s*(?:日志记录|日志|记录)\s*[。.!！]*$/,
    reason: '查询类指令',
    strict: true,
  },
  {
    // 纯续接指令：只说"继续上一个任务"没有任何工作信息
    re: /^(?:继续|接着)(?:上|前)一个?(?:任务|话题|问题)[\s。.!！]*$/,
    reason: '续接指令（无工作信息）',
    strict: true,
  },
  {
    // 必须点名同步目标（滴答/TickTick/清单/日历），否则「同步一下需求到需求池」这类真实工作会被误杀
    re: /^(?:同步|推送|上传)[^。！？]{0,10}(?:滴答|ticktick|tick\s*清单|待办|日历|清单)/i,
    reason: '对同步工具的操作指令',
    strict: true,
  },
  {
    re: /(?:记录|日志|技能|skill|hook|钩子|插件)[^。！？]{0,8}(?:怎么|如何|是否|能不能|可以|操作|配置|开启|关闭)/i,
    reason: '关于记录工具本身的问答',
    strict: true,
  },
  {
    re: /^(?:查看|查看一下|看看|显示|列出|给我看)[^。！？]{0,12}(?:状态|记录|日志|今日|总结|待办)/,
    reason: '查询类指令',
    strict: true,
  },
  {
    // 必须同时出现「系统词 + 启停词」，否则「现在开始设计容器创建页面」这类指令会被误杀
    re: /(?:自动记录|记录功能|这个技能|这个\s*skill|hook|钩子|日志功能)[^。！？]{0,12}(?:开始|生效|用上|跑起来|开了|启用)/i,
    reason: '关于系统运行状态的询问',
    strict: true,
  },
  { re: /[吗么呢][？?。！!]*$/, reason: '疑问句（对话性质）' },
].concat(CHITCHAT_PATTERNS);

/**
 * 判定一条记录是否应进入总结。
 * @returns {{include: boolean, reason: string, kind: 'work'|'life'|'noise'}}
 */
function classify(rec) {
  const text = String(rec.content || '').trim();

  // ① 高置信度噪声：无论来源、无论是否带项目名，一律排除。
  //
  // 这类内容**本身就不构成工作事项**（宿主通知、纯指令、图片占位符…）。
  // 必须先于「有 project_name 即真实事项」判断 —— 否则一旦给噪声条目赋了项目名
  // （例如通知内容里含项目路径、或在某项目空间里问了句"继续"），
  // 它就会绕过过滤混进总结。此前的 `<task-notification>` 与「继续上一个任务」
  // 都是这样漏进来的。
  for (const p of NOISE_PATTERNS) {
    if (p.strict && p.re.test(text)) {
      return { include: false, reason: `无关对话：${p.reason}`, kind: 'noise' };
    }
  }

  // ② 用户手动记录的一律保留（§6）
  if (rec.source === 'manual') {
    return { include: true, reason: '手动记录，属用户刻意登记', kind: 'work' };
  }
  // ③ 自动采集的运行过程 / 维护操作 → 不进入主总结。
  //    这类事项可以保留原始记录，但“查看日志 / 修复网络 / 自动化任务结果”
  //    不是用户完成的成果，不能因为带了项目名就自动放行。
  if (RP.isOperationalSupport(rec)) {
    return { include: false, reason: '系统运行或维护操作（非用户成果）', kind: 'operational' };
  }
  // ④ 有结构化归属信息 → 是真实事项
  if (rec.project_name || rec.work_type) {
    return { include: true, reason: '已识别项目或工作类型', kind: 'work' };
  }
  // ⑤ 有实际工时或已结束 → 视为真实事项
  const hasClosedSegment = (rec.time_segments || []).some((s) => s.end);
  if (rec.status === 'completed' && hasClosedSegment) {
    return { include: true, reason: '已完成且有实际工时', kind: 'work' };
  }
  // ⑥ 非对话来源（文件/命令/工具类）→ 属工作痕迹
  if (rec.source !== 'auto' && rec.source !== 'workbuddy') {
    return { include: true, reason: `来源为 ${rec.source}，非对话采集`, kind: 'work' };
  }

  // ⑦ 对话采集且无归属线索 → 检查是否无关对话
  const hasWorkKeyword = WORK_KEYWORDS.test(text);
  for (const p of NOISE_PATTERNS) {
    if (!p.re.test(text)) continue;
    // 高置信度噪声特征：即使含工作性词汇也过滤
    //（例如「现在这个skill开始自动记录了吗」含「记录」，但显然是系统状态询问）
    if (p.strict) {
      return { include: false, reason: `无关对话：${p.reason}`, kind: 'noise' };
    }
    // 其余特征：含明确工作性词汇时保留，避免误杀
    //（例如「你好，帮我完善GPU需求」不应因为寒暄开头被丢弃）
    if (hasWorkKeyword) {
      return {
        include: true,
        reason: `命中「${p.reason}」特征但含工作性词汇，保留`,
        kind: 'work',
      };
    }
    return { include: false, reason: `无关对话：${p.reason}`, kind: 'noise' };
  }
  // 未命中任何噪声特征 → 视为事项
  // 注意：**不要**再用「内容过短即噪声」这种粗暴规则 ——
  // 「散步」「瑜伽」这类短生活事项会被误杀。噪声必须由具体特征命中。
  return { include: true, reason: '未命中无关对话特征，暂予保留待确认', kind: 'work' };
}

/* ------------------------------------------------------------------ *
 * 1b. 功能 / 模块识别（用于「按模块合并」）
 * ------------------------------------------------------------------ */

/**
 * 模块关键词表（可按业务用 config.summary.module_keywords 扩展）。
 *
 * 为什么需要它：合并原先要求「同工作类型 + 措辞相近」，
 * 但同一模块的工作往往**措辞差异很大**，例如
 *   「在系统管理需要添加二级菜单：邮箱配置」与
 *   「在邮件管理中需要提供是否开启邮箱服务」
 * 都属「邮箱配置/邮件管理」模块，却几乎没有共同词。
 * 因此先识别模块，同模块即可合并。
 *
 * 匹配按**长优先**，避免「配置」这类短词抢占「邮箱配置」。
 */
const DEFAULT_MODULE_KEYWORDS = [
  // 门户/平台
  '邮箱配置', '邮箱服务', '邮件管理', '系统配置', '配置页面', '实验中心', '课程中心',
  '共享平台', '规章制度', '分类管理', '实体关系', '资源统计', '数据查询', '数据下载',
  '权限配置', '原型导航', '门户导航', '首页', '导航',
  // 需求/设计/文档
  '需求说明书', '需求文档', '需求规格', '状态机', '考核模块', '测试用例', '功能描述表', '三方测试',
  '验收材料', '使用说明书', '项目周报', '周报', '实施方案', '落地方案',
  // 常见系统模块
  '用户管理', '角色管理', '字典管理', '日志管理', '消息通知', '审批流', '报表',
];

/**
 * 模块别名 → 规范模块名。
 *
 * 同一模块在措辞上常出现多种说法，若不归一就会被拆成多个模块：
 *   「邮箱配置」「邮箱服务」「邮件管理」 → 邮件与邮箱配置
 *   「实验中心」「课程中心」「权限配置」 → 权限与中心管理
 * 这些是"同一件事的不同叫法"，必须归到同一模块才能按模块合并。
 */
const DEFAULT_MODULE_ALIASES = {
  邮箱配置: '邮件与邮箱配置',
  邮箱服务: '邮件与邮箱配置',
  邮件管理: '邮件与邮箱配置',
  系统配置: '系统配置',
  配置页面: '系统配置',
  实验中心: '权限与中心管理',
  课程中心: '权限与中心管理',
  权限配置: '权限与中心管理',
  门户导航: '导航与布局',
  原型导航: '导航与布局',
  首页: '导航与布局',
  导航: '导航与布局',
  数据查询: '数据查询与下载',
  数据下载: '数据查询与下载',
  需求说明书: '需求文档',
  需求规格: '需求文档',
  使用说明书: '文档编写',
  验收材料: '验收与测试',
  三方测试: '验收与测试',
  测试用例: '验收与测试',
  项目周报: '项目管理与汇报',
  周报: '项目管理与汇报',
  实施方案: '方案编写',
  落地方案: '方案编写',
};

/**
 * 从内容里识别所属模块（返回规范模块名）。
 * @param {string} content
 * @param {object} [opts] { module_keywords, module_aliases } 覆盖默认词表/别名
 * @returns {{module:string|null, keyword:string|null}}
 */
function extractModule(content, opts) {
  const o = typeof opts === 'object' && opts !== null ? opts : { module_keywords: opts };
  const text = String(content || '');
  if (!text) return { module: null, keyword: null };
  const aliases = Object.assign({}, DEFAULT_MODULE_ALIASES, o.module_aliases || {});
  const extra = Array.isArray(o.module_keywords) ? o.module_keywords : [];
  // 注意：必须把**规范化后的模块名**（aliases 的 value）也纳入匹配 ——
  // 否则已用规范名表述的内容（如「权限与中心管理梳理」）会识别不到模块。
  const list = [
    ...extra,
    ...Object.values(aliases),
    ...Object.keys(aliases),
    ...DEFAULT_MODULE_KEYWORDS,
  ]
    .filter((k) => k && String(k).trim())
    .map(String)
    .sort((a, b) => b.length - a.length); // 长优先，避免「配置」抢占「邮箱配置」
  for (const kw of list) {
    if (text.includes(kw)) return { module: aliases[kw] || kw, keyword: kw };
  }
  return { module: null, keyword: null };
}

/**
 * 按「项目 + 模块」把条目分组，同组可合并为一条。
 *
 * 组内按时间升序，**组的最早时间即合并后事项的开始时间**。
 * 无模块可识别的条目各自独立成组（不强行合并）。
 *
 * @returns {Array<{project_name:string|null, module:string|null, items:object[], earliest_time:string|null, count:number}>}
 */
function groupByModule(items, opts) {
  const o = opts || {};
  const groups = new Map();
  for (const it of items || []) {
    const { module } = extractModule(it.content, o);
    const project = it.project_name || null;
    // 无模块 → 每条独立成组，key 用 id 保证不互相合并
    const key = module ? `${project || ''}::${module}` : `${project || ''}::#${it.id || Math.random()}`;
    if (!groups.has(key)) {
      groups.set(key, { project_name: project, module, items: [], earliest_time: null, count: 0 });
    }
    const g = groups.get(key);
    g.items.push(it);
    g.count += 1;
  }
  // 组内排序 + 取最早时间
  const out = [...groups.values()];
  for (const g of out) {
    g.items.sort((a, b) => (toMin(a.start_time ?? a.time) ?? 1e9) - (toMin(b.start_time ?? b.time) ?? 1e9));
    const times = g.items.map((x) => x.start_time || x.time).filter(Boolean);
    g.earliest_time = times.length ? times.slice().sort()[0] : null;
  }
  out.sort((a, b) => (a.earliest_time || '99:99').localeCompare(b.earliest_time || '99:99'));
  return out;
}

/**
 * 动作词表（用于把长句提炼成「模块 + 动作」的短语）。
 *
 * 例：`在系统管理需要添加二级菜单：邮箱配置，该页面主要是配置系统发件箱的授权信息…`
 *     → 模块「邮件与邮箱配置」+ 动作「需求分析」→ `邮件与邮箱配置需求分析`
 *
 * 顺序敏感：先匹配更具体的（需求分析 先于 配置）。
 */
const ACTION_HINTS = [
  [/需求(分析|澄清|确认|对齐)|分析需求/, '需求分析'],
  [/需求(梳理|整理|文档|规格|说明书)/, '需求梳理'],
  [/问题排查|异常|报错|错误|空白|显示.{0,4}奇怪|Syntax error|修复/i, '问题排查'],
  [/更新日志|更新|修改|调整|补充|新增|添加/, '更新'],
  [/优化|完善|改进|提升/, '优化'],
  [/设计/, '设计'],
  [/测试用例|测试|验证|验收/, '测试'],
  [/开发|实现|编码|重构/, '开发'],
  [/配置/, '配置'],
  [/整理|梳理/, '梳理'],
];

/** 从内容里提炼动作词；命不中返回 null（不编造） */
function detectAction(content) {
  const text = String(content || '');
  if (!text) return null;
  for (const [re, label] of ACTION_HINTS) {
    if (re.test(text)) return label;
  }
  return null;
}

/** 模块名以这类**动作名词**结尾时，不再追加动作，否则读起来别扭（如「方案编写梳理」） */
const MODULE_ACTIVITY_SUFFIX = /(编写|梳理|分析|测试|设计|方案|评审|汇报)$/;

/**
 * 拼接「模块 + 动作」，避免重复与别扭。
 *
 *  系统配置 + 配置      → 系统配置            （动作已在模块名里）
 *  需求文档 + 需求梳理  → 需求文档梳理         （去掉重复的「需求」）
 *  方案编写 + 梳理      → 方案编写            （模块本身已是动宾结构）
 *  邮件与邮箱配置 + 更新 → 邮件与邮箱配置更新
 *  权限与中心管理 + 配置 → 权限与中心管理配置
 */
function joinModuleAction(module, action) {
  if (!module) return action || '';
  if (!action) return module;
  if (module.includes(action)) return module;
  if (MODULE_ACTIVITY_SUFFIX.test(module)) return module;
  if (/需求/.test(module) && /^需求/.test(action)) return module + action.replace(/^需求/, '');
  return module + action;
}

/**
 * 生成总结用的**条目标题**：`【项目名称】【功能/模块名称】事项内容`。
 *
 * 事项内容优先用「模块 + 动作」短语（如 `邮箱配置需求分析`）；
 * 无法识别模块时退回内容首句截断（不编造）。
 *
 * @param {object} item 记录（需含 content；可选 project_name）
 * @param {object} [opts] { module_keywords, module_aliases, maxDetail }
 * @returns {{title:string, project:string, module:string|null, detail:string, action:string|null}}
 */
function buildItemTitle(item, opts) {
  const o = opts || {};
  const content = String((item && item.content) || '').trim();
  const project = (item && item.project_name) || null;
  const { module } = extractModule(content, o);
  const action = detectAction(content);
  const maxDetail = Number(o.maxDetail) > 0 ? Number(o.maxDetail) : 30;

  let detail;
  if (module && action) detail = joinModuleAction(module, action);
  else if (module) detail = module;
  else {
    // 无模块 → 取首个分句截断（不编造）
    detail = content.split(/[。；;，,\n]/)[0].trim();
    if (detail.length > maxDetail) detail = detail.slice(0, maxDetail) + '…';
  }
  // 标签按需拼装：**模块识别不到就不显示该块**（用户要求），项目同理
  const tags = [];
  if (project) tags.push(`【${project}】`);
  if (module) tags.push(`【${module}】`);
  return {
    title: tags.join('') + detail,
    project: project || null,
    module: module || null,
    detail,
    action,
  };
}

/* ------------------------------------------------------------------ *
 * 2. 相关事项合并
 * ------------------------------------------------------------------ */

const toMin = (v) => C.toMinutes(v);

function recordStart(rec) {
  const value = toMin(rec && (rec.start_time ?? rec.time));
  return value === null ? Number.POSITIVE_INFINITY : value;
}

function recordEnd(rec) {
  const value = toMin(rec && rec.end_time);
  return value === null ? recordStart(rec) : value;
}

function conversationKey(rec) {
  return (rec && (rec.conversation_id || rec.session_id)) || null;
}

function sameConversation(a, b) {
  const left = conversationKey(a);
  const right = conversationKey(b);
  return Boolean(left && right && left === right);
}

function sameProject(a, b) {
  return Boolean(a.project_name && b.project_name && a.project_name === b.project_name);
}

function projectConflict(a, b) {
  return Boolean(a.project_name && b.project_name && a.project_name !== b.project_name);
}

function categoryConflict(a, b) {
  return Boolean(a.category && b.category && a.category !== b.category);
}

function sameSegment(a, b) {
  return Boolean(a.segment_id && b.segment_id && a.segment_id === b.segment_id);
}

function recordText(rec) {
  return [rec && rec.content, rec && rec.detail].filter(Boolean).join(' ');
}

function isShortContext(rec) {
  return String((rec && rec.content) || '').trim().length <= CONTEXT_SHORT_MAX;
}

function timeGapMinutes(a, b) {
  const aStart = recordStart(a);
  const bStart = recordStart(b);
  const aEnd = recordEnd(a);
  const bEnd = recordEnd(b);
  if (!Number.isFinite(aStart) || !Number.isFinite(bStart)) return null;
  if (bStart >= aEnd) return bStart - aEnd;
  if (aStart >= bEnd) return aStart - bEnd;
  return 0;
}

/**
 * 同一 Conversation 内的上下文续接。
 *
 * 这里不使用完整问答，也不跨会话借用代词；只使用已结算的事项内容、detail、
 * segment_id、项目与时间顺序。完整问答仍保留为原始证据，不进入总结事项正文。
 */
function contextContinuation(a, b, ctx) {
  if (!sameConversation(a, b)) return false;
  if (sameSegment(a, b)) return true;

  const text = recordText(b);
  if (EXPLICIT_TOPIC_SWITCH_RE.test(text)) return false;

  const shared = sharedTokens(recordText(a), text);
  const sim = similarity(recordText(a), text);
  const ma = extractModule(a.content, ctx).module;
  const mb = extractModule(b.content, ctx).module;
  const sameModule = Boolean(ma && mb && ma === mb);
  const gap = timeGapMinutes(a, b);

  if (CONTEXT_REFERENCE_RE.test(text)) {
    if (isShortContext(b) || shared.length >= 1 || sameModule || sim >= 0.2) {
      return true;
    }
  }

  if (isShortContext(a) && gap !== null && gap <= CONTEXT_GAP_MINUTES) {
    return true;
  }

  if (sameProject(a, b) && gap !== null && gap <= CONTEXT_GAP_MINUTES) {
    return true;
  }

  return Boolean(
    sameProject(a, b) &&
      gap !== null &&
      gap <= CONTEXT_GAP_MINUTES &&
      ((a.work_type && a.work_type === b.work_type) || sameModule || shared.length >= 1)
  );
}

/** 合并重叠/相邻的时间片段（相邻阈值 MERGE_GAP_MINUTES） */
function unionSegments(segments, nowMin) {
  const list = (segments || [])
    .filter((s) => s && s.start)
    .map((s) => ({
      start: toMin(s.start),
      end: s.end ? toMin(s.end) : nowMin,
      open: !s.end,
    }))
    .filter((s) => s.start !== null && s.end !== null && s.end >= s.start)
    .sort((a, b) => a.start - b.start);
  if (!list.length) return [];
  const out = [list[0]];
  for (let i = 1; i < list.length; i += 1) {
    const cur = list[i];
    const last = out[out.length - 1];
    if (cur.start - last.end <= MERGE_GAP_MINUTES) {
      last.end = Math.max(last.end, cur.end);
      last.open = last.open || cur.open;
    } else {
      out.push(cur);
    }
  }
  return out.map((s) => ({
    start: C.fmtHHMM(s.start),
    end: s.open ? null : C.fmtHHMM(s.end),
  }));
}

/**
 * 判断两条记录是否属于「同一件工作」。
 *
 * 先排除硬冲突，再按「同一工作意图」合并：
 *   ① 同 segment_id
 *   ② 同 Conversation + 上下文续接
 *   ③ 同项目 + 同模块
 *   ④ 同项目 + 同类型 + 内容相关
 *   ⑤ 内容强相关（无需同项目，但项目不得互相冲突）
 *   ⑥ 同项目 + 同类型 + 时间紧接
 *
 * 仅同工作类型、同时间或同一天，不能单独构成合并理由。
 *
 * @param {object} [ctx] { module_keywords }
 */
function isRelated(a, b, ctx) {
  const opts = ctx || {};
  if (projectConflict(a, b) || categoryConflict(a, b)) return null;

  if (sameSegment(a, b)) {
    return { reason: `同 Conversation 且同 Work Segment（${a.segment_id}）` };
  }

  const ma = extractModule(a.content, opts).module;
  const mb = extractModule(b.content, opts).module;
  const sameType = Boolean(a.work_type && b.work_type && a.work_type === b.work_type);
  const sameModule = Boolean(ma && mb && ma === mb);
  const sameProj = sameProject(a, b);
  const shared = sharedTokens(recordText(a), recordText(b));
  const sim = similarity(recordText(a), recordText(b));
  const gap = timeGapMinutes(a, b);

  // 同 Conversation 优先使用上下文判断，而不是只看字段与措辞。
  if (sameConversation(a, b)) {
    if (sameProj && sameModule) {
      return { reason: `同 Conversation 且同项目同模块（${ma}）` };
    }
    if (contextContinuation(a, b, opts)) {
      return { reason: '同 Conversation 且上下文续接同一工作目标' };
    }
    if (sameType && (shared.length >= MERGE_SHARED_TOKENS || sim >= MERGE_SIMILARITY)) {
      return {
        reason: `同 Conversation 且同类型内容相关（共同关键词：${shared.slice(0, 4).join('、')}）`,
      };
    }
    if (shared.length >= MERGE_SHARED_TOKENS + 1 || sim >= 0.5) {
      return {
        reason: `同 Conversation 且内容强相关（共同关键词：${shared.slice(0, 4).join('、')}）`,
      };
    }
    return null;
  }

  // 跨 Conversation 仍可在结构证据充分时归并；没有证据就保持拆分。
  if (sameModule && (sameProj || shared.length >= MERGE_SHARED_TOKENS || sim >= MERGE_SIMILARITY)) {
    return { reason: `同一工作模块（${ma}）` };
  }

  // ② 同工作类型 + 内容相关
  if (sameType && (shared.length >= MERGE_SHARED_TOKENS || sim >= MERGE_SIMILARITY)) {
    return {
      reason: `同类型且内容相关（共同关键词：${shared.slice(0, 4).join('、')}）`,
    };
  }
  // ③ 内容强相关（无需同类型）
  if (shared.length >= MERGE_SHARED_TOKENS + 1 || sim >= 0.5) {
    return { reason: `内容强相关（共同关键词：${shared.slice(0, 4).join('、')}）` };
  }
  // ④ 同工作类型 + 时间紧接 → 视为同一工作的连续片段
  if (sameProj && sameType) {
    const segA = (a.time_segments || []).filter((s) => s.start);
    const segB = (b.time_segments || []).filter((s) => s.start);
    if (segA.length && segB.length) {
      const aEnd = Math.max(...segA.map((s) => toMin(s.end || s.start)));
      const bStart = Math.min(...segB.map((s) => toMin(s.start)));
      if (bStart - aEnd >= 0 && bStart - aEnd <= MERGE_GAP_MINUTES) {
        return { reason: `同项目同类型且时间紧接（间隔 ${bStart - aEnd} 分钟）` };
      }
    }
    if (gap !== null && gap <= MERGE_GAP_MINUTES) {
      return { reason: `同项目同类型且时间紧接（间隔 ${gap} 分钟）` };
    }
  }
  return null;
}

/**
 * 把「记录自带 start_time / end_time 但 time_segments 为空」的情况补成片段。
 *
 * 为什么需要：`/log 14:00-14:40 开会` 这类手动补录只写 start_time/end_time，
 * 不写 time_segments。若合并时只认 time_segments，这些记录的时间段会被整体丢弃
 * （start_time 有回退、end_time 没有 → end_time 变 null、duration 变 0）。
 */
function fallbackSegments(rec) {
  const segs = (rec.time_segments || []).filter((s) => s && s.start);
  if (segs.length) return segs;
  if (!rec.start_time) return [];
  return [{ start: rec.start_time, end: rec.end_time || null }];
}

/** 给合并内容选一个信息量最高的代表，排除“怎么解决”这类上下文短句。 */
function chooseMergedContent(items) {
  const contentScore = (r) => {
    const text = String((r && r.content) || '').trim();
    let value = Math.min(text.length, 120);
    if (isShortContext(r) || /^(?:怎么解决|这个|上述|继续|统一为)/.test(text)) value -= 40;
    if (extractModule(text).module) value += 15;
    if (detectAction(text)) value += 8;
    if (/(?:V\d+(?:\.\d+)*|settle|rollover|Hook|Token|Raw|API)/i.test(text)) value += 8;
    if (r.output) value += 6;
    return value;
  };
  const best = items.slice().sort((a, b) => contentScore(b) - contentScore(a))[0] || {};
  const moduleNames = [
    ...new Set(items.map((r) => extractModule(r.content).module).filter(Boolean)),
  ];
  if (moduleNames.length === 1) {
    const actions = [...new Set(items.map((r) => detectAction(r.content)).filter(Boolean))];
    if (actions.length) return joinModuleAction(moduleNames[0], actions.join('与'));
  }

  const texts = items.map((r) => recordText(r)).filter(Boolean);
  const entityCounts = new Map();
  for (const text of texts) {
    for (const token of text.match(/[a-z][a-z0-9_-]{4,}/gi) || []) {
      const key = token.toLowerCase();
      if (/^(?:today|workitem|worktime|worktimelog)$/i.test(key)) continue;
      entityCounts.set(key, (entityCounts.get(key) || 0) + 1);
    }
  }
  const entity = [...entityCounts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]?.[0];
  const versions = [
    ...new Set(
      texts.flatMap((text) => text.match(/V\d+(?:\.\d+)*(?:\.\d+)?/gi) || []).map((x) => x.toUpperCase())
    ),
  ].sort((a, b) => {
    const pa = a.replace(/^V/i, '').split('.').map(Number);
    const pb = b.replace(/^V/i, '').split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
      if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
    }
    return 0;
  });
  const themes = [];
  const allText = texts.join(' ');
  if (/(?:Hook|日志|采集|跨日|记录|补录|写入)/i.test(allText)) themes.push('日志采集与记录链路');
  if (/(?:Raw|保留期|清理策略)/i.test(allText)) themes.push('Raw 保留策略');
  if (/(?:settle|rollover|竞争|并发|稳定性)/i.test(allText)) themes.push('并发稳定性');
  if (/(?:统一|版本|升级|兼容)/i.test(allText)) themes.push('版本兼容与统一');
  if (/(?:Markdown|\bMD\b)/i.test(allText)) themes.push('Markdown 输出规则');
  if (/(?:项目级|用户级|总纲|细则)/i.test(allText)) themes.push('项目级细则与用户级总纲');
  if (themes.length) {
    const head = [entity, versions.length ? `（${versions.join('、')}）` : ''].filter(Boolean).join('');
    return `${head}${head ? ' ' : ''}${[...new Set(themes)].join('、')}处理`;
  }
  return String(best.content || best.detail || '').trim();
}

/** 合并一组记录为一条事项（不修改原对象） */
function mergeGroup(items, nowMin, ctx) {
  const sorted = items.slice().sort((a, b) => recordStart(a) - recordStart(b));
  const first = sorted.find((r) => Number.isFinite(recordStart(r))) || sorted[0];
  // 用 fallbackSegments 保证「只有 start/end 的记录」也能参与时间段合并
  const segments = unionSegments(
    sorted.flatMap((r) => fallbackSegments(r)),
    nowMin
  );
  const content = chooseMergedContent(sorted);
  const projects = [...new Set(sorted.map((r) => r.project_name).filter(Boolean))];
  const projectName = projects.length === 1 ? projects[0] : first.project_name || null;
  const projectSource = sorted.find((r) => r.project_name === projectName) || first;
  const categories = [...new Set(sorted.map((r) => r.category).filter(Boolean))];
  const category = categories.length === 1 ? categories[0] : first.category ?? null;
  const workTypeSource = sorted.find((r) => r.work_type) || first;
  const stageSource = sorted.find((r) => r.project_stage) || first;
  const mergeEvidence = [
    ...new Set(
      sorted
        .slice(1)
        .map((r) => {
          const rel = isRelated(first, r, ctx);
          return rel && rel.reason;
        })
        .filter(Boolean)
    ),
  ];
  const allCompleted = sorted.every((r) => r.status === 'completed');
  const anyInProgress = sorted.some((r) => r.status === 'in_progress');
  const merged = {
    id: first.id,
    merged_from: sorted.map((r) => r.id),
    // §26 透明度：记录各来源条目的原始内容，便于总结输出「合并了哪些条目」。
    // 只用于展示，不参与 display_content 生成（§9 结构化字段仍以主条目为准）。
    merged_titles: sorted.map((r) => r.content).filter(Boolean),
    date: first.date,
    project_name: projectName,
    project_confidence: projectSource.project_confidence ?? first.project_confidence,
    work_type: workTypeSource.work_type,
    work_type_confidence: workTypeSource.work_type_confidence,
    // V3.3（用户 2026-09-22）：归因字段随主条目保留；
    // `output` 汇集组内**实际记录到的**成果（去重），不虚构、不推测。
    category,
    project_stage: stageSource.project_stage ?? null,
    output:
      [...new Set(sorted.map((r) => r.output).filter(Boolean))].join('；') || null,
    content,
    // 开始时间取**组内最早**（有片段用片段最早，否则用各条 start_time 最早）
    start_time: segments.length
      ? segments[0].start
      : sorted.map((r) => r.start_time).filter(Boolean).sort()[0] || first.start_time,
    // 结束时间取**组内最晚**。与 start_time 对称：片段闭合时用片段末端；
    // 否则回退到各条自带的 end_time（`/log` 补录、手动记录常只写 start/end）。
    // 无法确定结束时间时保持 null —— 但 start_time 已保留，同步时据此推送（§13 不编造）。
    end_time: (() => {
      const last = segments.length ? segments[segments.length - 1] : null;
      if (last && last.end) return last.end;
      return sorted.map((r) => r.end_time).filter(Boolean).sort().pop() || null;
    })(),
    estimated_duration: sorted.find((r) => r.estimated_duration !== null)?.estimated_duration ?? null,
    actual_duration: segments.reduce(
      (sum, s) => sum + Math.max(0, (s.end ? toMin(s.end) : nowMin) - toMin(s.start)),
      0
    ),
    status: allCompleted ? 'completed' : anyInProgress ? 'in_progress' : first.status,
    source: first.source,
    confidence: sorted.some((r) => r.confidence === 'low') ? 'medium' : first.confidence,
    time_segments: segments,
    merge_evidence: mergeEvidence,
    activities: sorted.flatMap((r) => r.activities || []),
    parent_id: null,
    tags: [],
    notes: sorted.map((r) => r.notes).filter(Boolean).join(' / '),
    merged_count: sorted.length,
  };
  return C.normalizeItem(merged);
}

/**
 * 合并相关事项。
 * 采用贪心聚合：按开始时间排序后，逐条尝试并入已有分组。
 */
function mergeRelated(records, nowMin, ctx) {
  const sorted = records
    .slice()
    .sort((a, b) => recordStart(a) - recordStart(b));
  const groups = [];
  const mergeLog = [];
  for (const rec of sorted) {
    let relation = null;
    for (const g of groups) {
      for (const member of g) {
        const rel = isRelated(member, rec, ctx);
        if (rel) {
          relation = rel;
          break;
        }
      }
      if (relation) {
        g.push(rec);
        mergeLog.push({ into: g[0].id, added: rec.id, reason: relation.reason });
        break;
      }
    }
    if (!relation) groups.push([rec]);
  }
  return {
    merged: groups.map((g) => (g.length === 1 ? g[0] : mergeGroup(g, nowMin, ctx))),
    mergeLog,
  };
}

/* ------------------------------------------------------------------ *
 * 3. 组合视图
 * ------------------------------------------------------------------ */

/** 归一化内容，用于「重复内容」判定（去空白、统一小写） */
function normalizeContent(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * 生成总结用的视图。
 *
 * **只读**：不写回 current.json，原始 records 保持完整（§25）。
 */
function buildSummaryView(log, options) {
  const opts = options || {};
  const nowMin = C.nowMinutes();
  const records = log.records || [];

  // ① 过滤无关对话
  const included = [];
  const excluded = [];
  const operational = [];
  for (const rec of records) {
    const verdict = classify(rec);
    if (verdict.include) included.push(Object.assign({}, rec, { _classify: verdict }));
    else if (verdict.kind === 'operational') {
      operational.push({ id: rec.id, reason: verdict.reason });
    }
    else excluded.push({ id: rec.id, content: rec.content, reason: verdict.reason });
  }

  // ② 合并相关事项
  const { merged, mergeLog } = mergeRelated(included, nowMin, opts);

  // ③ 待判断事项（pending_items）同样需要过滤与去重：
  //    对话采集产生的无关对话、宿主通知、重复内容都不应出现在总结里
  const pendingRelevant = [];
  const pendingExcluded = [];
  const seenContent = new Set();
  for (const p of log.pending_items || []) {
    const verdict = classify({
      content: p.content,
      source: p.source,
      status: 'needs_confirmation',
      time_segments: [],
      project_name: p.project_name || null,
      work_type: p.work_type || null,
    });
    if (!verdict.include) {
      pendingExcluded.push({ content: p.content, reason: verdict.reason });
      continue;
    }
    const key = normalizeContent(p.content);
    if (seenContent.has(key)) {
      pendingExcluded.push({ content: p.content, reason: '与已有待判断事项内容重复' });
      continue;
    }
    seenContent.add(key);
    pendingRelevant.push(p);
  }

  // ④ 时长实时重算，保证派生视图内部一致（进行中事项不落盘时长）
  const items = merged.map((r) => {
    const copy = JSON.parse(JSON.stringify(r));
    C.recalc(copy, nowMin, true);
    return copy;
  });

  // ⑤ 统计（基于合并后事项）
  const stats = C.buildStats(Object.assign({}, log, { records: items }));
  const groups = C.groupByProject(Object.assign({}, log, { records: items }));
  // 待判断事项也按「项目 + 模块」分组：同模块多条 → 合并为一条展示（§按功能/模块总结）
  const pendingModules = groupByModule(pendingRelevant, opts);

  return {
    items,
    excluded,
    operational,
    pending_items: pendingRelevant,
    pending_excluded: pendingExcluded,
    pending_modules: pendingModules,
    merge_log: mergeLog,
    groups,
    stats,
    raw_count: records.length,
    merged_count: items.length,
    excluded_count: excluded.length,
    operational_count: operational.length,
    notes: [
      `原始记录 ${records.length} 条 → 过滤无关对话 ${excluded.length} 条 → ` +
        `折叠过程 / 维护 ${operational.length} 条 → ` +
        `合并为 ${items.length} 条工作事项`,
      '本视图为只读派生结果，原始 records 未被修改（§25）。',
    ],
  };
}

module.exports = {
  MERGE_GAP_MINUTES,
  MERGE_SHARED_TOKENS,
  MERGE_SIMILARITY,
  NOISE_PATTERNS,
  CHITCHAT_PATTERNS,
  WORK_KEYWORDS,
  DEFAULT_MODULE_KEYWORDS,
  extractModule,
  buildItemTitle,
  joinModuleAction,
  detectAction,
  ACTION_HINTS,
  groupByModule,
  normalizeContent,
  tokenize,
  sharedTokens,
  similarity,
  classify,
  isRelated,
  unionSegments,
  mergeGroup,
  mergeRelated,
  buildSummaryView,
};
