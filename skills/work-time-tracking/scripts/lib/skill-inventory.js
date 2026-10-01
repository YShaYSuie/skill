'use strict';
/**
 * skill-inventory.js —— 本地 Skill 清单盘点（**只读、零 Token、零出网**）。
 *
 * 背景（用户 2026-09-24）：
 *   用户要回答「哪个 Skill 我压根用不上」「哪个是我高频 Skill」。
 *   只统计日志里出现过的 Skill 是不够的 —— 那只能看到「用过什么」，
 *   看不到「装了但一次没用过」。因此需要与**本地已安装/已部署清单**对账。
 *
 * 数据来源（全部为本地目录，纯文件系统读取）：
 *   · 中央库：`<skills-manager>/skills/<skill>/SKILL.md`
 *   · 各 Agent 的全局技能目录：`<agent-home>/skills/<skill>`（多为软链接/联接）
 *
 * 硬约束：
 *   · 不联网、不起子进程、不读数据库 —— 只 `fs` + `path`；
 *   · 读不到就如实标注 `exists: false`，**不推断、不编造**；
 *   · Skill 名称/描述会截断，避免把整篇 SKILL.md 带进日志或报告。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

/** 名称与描述的展示上限（字符） */
const MAX_NAME = 80;
const MAX_DESCRIPTION = 160;

/** 取本机用户主目录（优先 USERPROFILE，兼容 HOME） */
function homeDir() {
  const h = process.env.USERPROFILE || process.env.HOME || '';
  if (h) return h;
  try {
    return os.homedir() || '';
  } catch (e) {
    return '';
  }
}

/**
 * 默认扫描的根目录清单。
 *
 * `label` 即「这个 Skill 被部署到了哪个 Agent」；
 * 中央库的 label 固定为 `central`（它代表「已安装」，不代表「已部署」）。
 */
function defaultRoots(home) {
  const h = home || homeDir();
  if (!h) return [];
  return [
    { label: 'central', path: path.join(h, '.skills-manager', 'skills') },
    { label: 'codex', path: path.join(h, '.codex', 'skills') },
    { label: 'workbuddy', path: path.join(h, '.workbuddy', 'skills') },
    { label: 'claude-code', path: path.join(h, '.claude', 'skills') },
  ];
}

/**
 * 归一化根目录配置。
 *
 * 接受三种写法，便于用户改路径：
 *   `["D:\\x\\skills"]`、`[{label,path}]`、`{codex: "D:\\x"}`。
 * 为空或非法时回落到默认清单。
 */
function normalizeRoots(raw, home) {
  const list = [];
  const push = (label, p) => {
    const pp = String(p || '').trim();
    if (!pp) return;
    list.push({ label: String(label || 'custom').trim() || 'custom', path: pp });
  };
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') push('custom', item);
      else if (item && typeof item === 'object') push(item.label, item.path);
    }
  } else if (raw && typeof raw === 'object') {
    for (const [label, p] of Object.entries(raw)) push(label, p);
  }
  return list.length ? list : defaultRoots(home);
}

/**
 * 解析 `SKILL.md` 的 YAML frontmatter（只取需要的字段）。
 *
 * 容错：没有 frontmatter、字段缺失、文件不可读 —— 一律返回空值，
 * 由调用方回落到目录名。**不抛异常**：一个坏文件不该让整份盘点失败。
 *
 * `display_name` 只用于建立「显示名 → 稳定 id」的别名表（见 `resolveSkillId`），
 * **绝不**作为 `skill_id` 落盘 —— 它是展示字段，不是业务键。
 */
function parseFrontmatter(text) {
  const out = { name: null, version: null, description: null, display_name: null };
  const src = String(text || '');
  if (!src.startsWith('---')) return out;
  const end = src.indexOf('\n---', 3);
  if (end < 0) return out;
  const block = src.slice(3, end);
  for (const line of block.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key !== 'name' && key !== 'version' && key !== 'description' && key !== 'display_name') {
      continue;
    }
    let v = m[2].trim();
    // 去掉成对引号；不解析多行块（description 取首行即可，后续统一截断）
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (v) out[key] = v;
  }
  return out;
}

const clip = (v, n) => {
  const s = String(v == null ? '' : v).trim();
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

/** 别名归一化的键：去空白 + 小写。中文显示名保持原样（只做大小写与空白归一）。 */
function normAlias(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/**
 * 把上游传来的「可能是别名」的 Skill 标识归一化为稳定 `skill_id`。
 *
 * 背景（2026-09-29 P0-1）：
 *   宿主（WorkBuddy）在 Skill 工具调用里可能直接把**中文 display_name** 塞进
 *   `args.skill`（实测原文 `{"skill":"网页设计工程师"}`）。解析器若原样照抄，
 *   同一个 Skill 就会在日志里分裂成两个身份（英文 id 与中文名各一条），
 *   导致去重、聚合、成本归因全部算错。
 *
 * 归一化顺序（先精确后模糊）：
 *   1. 命中别名表（显示名 / 目录名 / 稳定 id 的大小写不敏感匹配）→ 返回 canonical id；
 *   2. 未命中 → **原样返回**（不臆造、不猜测）。
 *      未命中是正常情况（Skill 可能未安装在本机，或名字拼写有出入），
 *      此时保留原值比强行归一到错误 id 更诚实。
 *
 * @param {string} raw 上游传来的标识（英文 id 或中文显示名）
 * @param {{aliasToId?: Map<string,string>}} [index] scan() 的别名表；缺省时自行加载本机清单
 * @returns {string} 稳定 skill_id；无法判定时返回去空白后的原值
 */
function resolveSkillId(raw, index) {
  const value = String(raw == null ? '' : raw).trim();
  if (!value) return value;

  let aliasToId = index && index.aliasToId;
  if (!aliasToId) {
    // 未显式传入时加载本机清单。失败则退化为「原样返回」——
    // 归一化是增强，不该因为读不到清单就让整条记录失败。
    try {
      const inv = load(null, null);
      aliasToId = (inv && inv.aliasToId) || null;
    } catch (e) {
      aliasToId = null;
    }
  }
  if (!aliasToId || typeof aliasToId.get !== 'function') return value;

  const hit = aliasToId.get(normAlias(value));
  return hit || value;
}

/**
 * 扫描一组根目录，得到「本机有哪些 Skill、分别部署到哪」。
 *
 * 同一个 Skill 名出现在多个根目录（例如中央库 + codex 软链）时**合并为一条**，
 * 并用 `deployed_in` 记录部署位置 —— 这正是「已装 vs 已部署」的区别来源。
 *
 * @param {Array} rootSpecs 根目录清单（见 normalizeRoots）
 * @returns {{roots: Array, skills: Array}}
 */
function scan(rootSpecs) {
  const roots = Array.isArray(rootSpecs) ? rootSpecs : [];
  const byId = new Map();
  const rootReport = [];
  // 别名表：显示名 / 目录名（小写）→ 稳定 skill_id。
  // 用于把宿主可能传进来的中文 display_name 归一化回英文 id（见 resolveSkillId）。
  const aliasToId = new Map();
  // 记录别名冲突：两个不同 skill_id 声明了同一个别名，保留先到的并留下警告。
  const aliasConflicts = [];

  for (const spec of roots) {
    const label = spec.label;
    const dir = spec.path;
    let entries = [];
    let exists = false;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
      exists = true;
    } catch (e) {
      exists = false;
    }
    rootReport.push({ label, path: dir, exists, skill_count: 0 });
    if (!exists) continue;

    let count = 0;
    for (const e of entries) {
      const name = e.name;
      // 跳过隐藏目录与中央库自身的元数据目录
      if (name.startsWith('.')) continue;
      const abs = path.join(dir, name);
      let isDir = e.isDirectory();
      if (!isDir) {
        // 软链接 / 联接：Dirent 里可能两者都不是，用 stat 兜底
        try {
          isDir = fs.statSync(abs).isDirectory();
        } catch (err) {
          isDir = false;
        }
      }
      if (!isDir) continue;

      let meta = { name: null, version: null, description: null, display_name: null };
      try {
        const md = fs.readFileSync(path.join(abs, 'SKILL.md'), 'utf8');
        meta = parseFrontmatter(md);
      } catch (err) {
        meta = { name: null, version: null, description: null, display_name: null };
      }
      const skillId = clip(meta.name || name, MAX_NAME);
      if (!skillId) continue;

      const cur =
        byId.get(skillId) || {
          skill_id: skillId,
          dir_name: name,
          display_name: null,
          version: null,
          description: null,
          deployed_in: [],
        };
      if (!cur.version && meta.version) cur.version = clip(meta.version, 40);
      if (!cur.display_name && meta.display_name) cur.display_name = clip(meta.display_name, MAX_NAME);
      if (!cur.description && meta.description) {
        cur.description = clip(meta.description, MAX_DESCRIPTION);
      }
      if (!cur.deployed_in.includes(label)) cur.deployed_in.push(label);
      byId.set(skillId, cur);

      // 登记别名：目录名与显示名都可指向这个 skill_id。
      // 稳定 id 自身也登记（小写），使 `Web-Design-Engineer` 这类大小写变体也能归一。
      const aliases = [name, meta.display_name, skillId];
      for (const a of aliases) {
        const key = normAlias(a);
        if (!key) continue;
        const existed = aliasToId.get(key);
        if (!existed) aliasToId.set(key, skillId);
        else if (existed !== skillId) {
          aliasConflicts.push({ alias: String(a), kept: existed, ignored: skillId });
        }
      }
      count += 1;
    }
    rootReport[rootReport.length - 1].skill_count = count;
  }

  const skills = [...byId.values()].sort((a, b) => a.skill_id.localeCompare(b.skill_id));
  return { roots: rootReport, skills, aliasToId, aliasConflicts };
}

/**
 * 把「本机装了什么」与「实际用过什么」对账。
 *
 * @param {{skills: Array}} inventory scan() 的结果
 * @param {object} opts
 * @param {Iterable<string>} opts.usedSkillIds 区间内出现过的 skill_id
 * @param {Map<string,string>} [opts.lastUsedAt] skill_id → 最后一次调用时间（ISO）
 * @param {number} [opts.staleDays] 多少天未用算「低频/未用」
 * @param {Date}   [opts.now] 注入时间以便测试可重复
 */
function annotate(inventory, opts) {
  const o = opts || {};
  const used = new Set([...(o.usedSkillIds || [])].map((x) => String(x)));
  const lastUsedAt = o.lastUsedAt instanceof Map ? o.lastUsedAt : new Map();
  const declaredStale = Number(o.staleDays);
  const staleDays = Number.isFinite(declaredStale) && declaredStale > 0 ? declaredStale : 30;
  const now = o.now instanceof Date ? o.now : new Date();
  const skills = (inventory && inventory.skills) || [];

  const installed = [];
  const neverUsed = [];
  const stale = [];
  const usedInRange = [];
  const installedIds = new Set();

  for (const s of skills) {
    installedIds.add(s.skill_id);
    const isUsed = used.has(s.skill_id);
    const last = lastUsedAt.get(s.skill_id) || null;
    // 已部署到至少一个 Agent（central 只代表「已安装」）
    const deployedAgents = s.deployed_in.filter((x) => x !== 'central');
    const row = {
      skill_id: s.skill_id,
      // 仅用于展示（报告里想显示中文名时取它）；**不是**业务键，不得落盘到 skill_id。
      display_name: s.display_name || null,
      version: s.version || null,
      description: s.description || null,
      deployed_in: s.deployed_in,
      deployed: deployedAgents.length > 0,
    };
    installed.push(row);
    if (isUsed) usedInRange.push({ ...row, last_used_at: last });
    else neverUsed.push({ ...row, last_used_at: last });

    if (isUsed && last) {
      const ageDays = (now.getTime() - new Date(last).getTime()) / 86400000;
      if (Number.isFinite(ageDays) && ageDays > staleDays) {
        stale.push({ ...row, last_used_at: last, days_since_last_use: Math.floor(ageDays) });
      }
    }
  }

  return {
    roots: (inventory && inventory.roots) || [],
    // 别名表透传（P0-1）：resolveSkillId 需要它把中文 display_name 归一化回英文 id。
    aliasToId: (inventory && inventory.aliasToId) || new Map(),
    aliasConflicts: (inventory && inventory.aliasConflicts) || [],
    installed_count: installed.length,
    deployed_count: installed.filter((x) => x.deployed).length,
    used_count: usedInRange.length,
    stale_days: staleDays,
    installed,
    used: usedInRange,
    never_used: neverUsed,
    // 「装了但 staleDays 天没动」—— 与 never_used 分开：前者可能曾经有用
    stale,
    // 日志里用过、但本机清单里找不到（改名 / 已卸载 / 清单路径没配全）。
    // 如实列出以便对账 —— 不把它算进「已安装」。
    used_not_installed: [...used].filter((id) => !installedIds.has(id)).sort(),
  };
}

/**
 * 一步到位：读配置 → 扫描 → 对账。
 *
 * @param {object} config 归一化后的 config（读 summary.insights.skill_roots）
 * @param {object} opts 见 annotate
 */
function load(config, opts) {
  const ins = (config && config.summary && config.summary.insights) || {};
  const roots = normalizeRoots(ins.skill_roots);
  return annotate(scan(roots), opts);
}

/* ------------------------------------------------------------------ *
 * 显式 Skill 引用识别（V3.6）
 * ------------------------------------------------------------------ */

/**
 * 匹配「显式引用 Skill」的三种写法。
 *
 * 为什么需要白名单过滤：`$NAME` 也是 shell 变量写法，不加约束会把
 * `$PATH`、`$HOME`、`$env` 全判成 Skill 调用 —— 那不是统计，是噪声。
 * 因此只在**本机确实装了该 Skill** 时才认。
 */
const SKILL_REF_PATTERNS = [
  // ① `$skill-name`（Codex / WorkBuddy 的技能调用写法）
  /\$([A-Za-z][A-Za-z0-9_-]{1,60})/g,
  // ② 路径直指 SKILL.md：`.../skills/<name>/SKILL.md`
  //    分隔符用 `[\\/]+`：工具调用参数是 JSON 字符串，路径里的 `\` 是**双写**的
  //    （`skills\\name\\SKILL.md`），只允许单个分隔符会一条都匹配不到。
  /skills[\\/]+([A-Za-z0-9][A-Za-z0-9_.-]{1,60})[\\/]+SKILL\.md/gi,
  // ③ 技能目录被提到：`.../skills/<name>`（含 markdown 链接目标）
  /skills[\\/]+([A-Za-z0-9][A-Za-z0-9_.-]{1,60})(?=[\\/\s"'`)\]]|$)/gi,
];

/**
 * 从一段文本里抽出显式引用的 Skill（按出现顺序，允许重复）。
 *
 * @param {string} text 用户输入 / 会话正文
 * @param {Set<string>|string[]} knownIds 本机已安装的 skill_id
 * @returns {Array<{skill_id: string, index: number}>}
 */
function extractSkillRefs(text, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  if (!known.size) return [];
  const lowerToCanonical = new Map();
  for (const id of known) lowerToCanonical.set(String(id).toLowerCase(), String(id));

  const src = String(text || '');
  if (!src) return [];
  const hits = [];
  for (const re of SKILL_REF_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const canon = lowerToCanonical.get(String(m[1] || '').toLowerCase());
      if (canon) hits.push({ skill_id: canon, index: m.index });
    }
  }
  hits.sort((a, b) => a.index - b.index);
  // 同一次引用往往同时命中多个模式（`$name` + 路径 + 目录），
  // 例如 Codex UI 会把它渲染成 `[$name](.../skills/name/SKILL.md)` —— 三个模式各中一次。
  // 按「同一行内同一 Skill 只算一次」收敛：一次引用 = 一次调用，避免调用次数翻倍。
  const out = [];
  const seen = new Set();
  let line = 0;
  let cursor = 0;
  for (const hit of hits) {
    while (cursor < hit.index) {
      if (src[cursor] === '\n') line += 1;
      cursor += 1;
    }
    const key = `${hit.skill_id}\u0000${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ skill_id: hit.skill_id, index: hit.index, line });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 「SKILL.md 被真实载入」检测（V3.22）
 * ------------------------------------------------------------------ */

/**
 * 只匹配 SKILL.md 本身，**不**匹配技能目录里的其它文件。
 *
 * 为什么单独做一套（不复用 `extractSkillRefs`）：
 *   Codex 没有 Skill 工具调用。最接近「实际执行了这个 Skill」的客观证据，
 *   是**模型真的载入了该技能的 SKILL.md** —— 读了技能定义才可能照它执行。
 *   而 `skills/<name>/scripts/x.js` 这类路径很可能是开发 / 排查该技能，
 *   把它算成「使用了技能」就是误报（user 2026-09-26：匹配到 ≠ 实际使用）。
 */
const SKILL_MD_LOAD_PATTERN = /skills[\\/]+([A-Za-z0-9][A-Za-z0-9_.-]{1,60})[\\/]+SKILL\.md/gi;

/**
 * 从一段文本（通常是工具调用参数）里抽出「被载入的 SKILL.md」。
 *
 * @param {string} text 工具调用参数等原始文本
 * @param {Set<string>|string[]} knownIds 本机已安装的 skill_id
 * @returns {Array<{skill_id: string, index: number, line: number}>}
 */
function extractSkillMdLoads(text, knownIds) {
  const known = knownIds instanceof Set ? knownIds : new Set(knownIds || []);
  if (!known.size) return [];
  const lowerToCanonical = new Map();
  for (const id of known) lowerToCanonical.set(String(id).toLowerCase(), String(id));
  const src = String(text || '');
  if (!src) return [];

  const out = [];
  const seen = new Set();
  let line = 0;
  let cursor = 0;
  SKILL_MD_LOAD_PATTERN.lastIndex = 0;
  let m;
  while ((m = SKILL_MD_LOAD_PATTERN.exec(src)) !== null) {
    while (cursor < m.index) {
      if (src[cursor] === '\n') line += 1;
      cursor += 1;
    }
    const canon = lowerToCanonical.get(String(m[1] || '').toLowerCase());
    if (!canon) continue;
    // 同一行里同一 Skill 只算一次（同一次载入常同时出现在命令与回显里）
    const key = `${canon}\u0000${line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ skill_id: canon, index: m.index, line });
  }
  return out;
}

module.exports = {
  MAX_NAME,
  MAX_DESCRIPTION,
  homeDir,
  defaultRoots,
  normalizeRoots,
  parseFrontmatter,
  scan,
  annotate,
  load,
  normAlias,
  resolveSkillId,
  SKILL_REF_PATTERNS,
  extractSkillRefs,
  SKILL_MD_LOAD_PATTERN,
  extractSkillMdLoads,
};
