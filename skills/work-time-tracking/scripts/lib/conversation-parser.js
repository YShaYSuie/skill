'use strict';
/**
 * conversation-parser.js — WorkBuddy 本地数据的**确定性**解析器（V3.0 新增）。
 *
 * ## 定位
 *
 * 用户 §8「脚本优先原则」：Conversation ID / Agent / Model / 起止时间 / Token /
 * Score / Skill / Skill Token / Skill Version 的提取**全部由脚本完成**，
 * 不调用 LLM、不消耗 token、结果可复现。
 *
 * LLM 只负责「工作内容识别、事项总结、项目归类、每日复盘」（用户 §8 后半段）。
 *
 * ## 数据源（已逐一实测核对，不是推测）
 *
 * | 源 | 路径 / 表 | 提供什么 |
 * |---|---|---|
 * | 请求级用量 | `<home>/projects/<workspace-slug>/<sessionId>.jsonl` | 每次模型请求的 `providerData.usage`、`conversationRequestId`、`requestModelName`、`agent` |
 * | Skill 调用 | 同上 | `function_call[name=Skill].arguments.skill` + 经 `callId` 关联的 `function_call_result.output.text` |
 * | 会话元信息 | `<home>/workbuddy.db` → `sessions` | `title` / `cwd` / `model` / `mode` / `expert_id` / `project_id` / 起止时间 / `status` |
 * | Token 与积分 | `<home>/workbuddy.db` → `session_usage` | `used`（上下文窗口占用）、`credit_json = {<requestId>: 积分}` |
 *
 * ## 三条必须记住的口径事实
 *
 * 1. **同一 API 请求会拆成多条记录**（reasoning / function_call ×N / message），
 *    必须按 `providerData.conversationRequestId` **去重**，否则 token 会被重复累加。
 * 2. **`session_usage.credit_json` 是可 join 的**：键就是 `conversationRequestId`，
 *    因此「一次对话消耗多少 WorkBuddy 积分」= 该会话全部 credit 之和，**可精确求和**。
 * 3. **`session_usage.used/size` 是上下文窗口占用，不是计费 token** ——
 *    不能拿它当 `total_token`。`total_token` 一律来自 JSONL 的请求级 usage。
 *
 * ## Skill Token 的口径（用户 §6）
 *
 * WorkBuddy **没有官方 Skill 级 token 口径**。本模块只提供两种可用口径，绝不混用：
 *
 * ```text
 * injection      Skill 载入体积：工具返回文本字符数 × token_per_char
 *                → 精确、可归因（实测返回文本 ≈ SKILL.md 全文，比 93%~102%）
 *                → 写入 skill_token，来源标 token_source = "injection"
 * unavailable    取不到就写 unavailable
 *
 * call_request_total_token   该 Skill 调用**所在请求**的 usage.totalTokens
 *                → 这个值本身是精确的，但**含全部历史上下文**，不是 Skill 独占，
 *                  同请求内多个 Skill 会重复计入，**禁止跨 Skill 相加**，
 *                  也**禁止**降级写进 skill_token
 * ```
 *
 * **严禁**：`total_token ÷ skill 数量`、按调用次数摊派、按字符占比反推独占 token。
 * 这些都不是观测值，而是编造（用户 §6 明令禁止）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('./log-core');
const CS = require('./conversation-store');
const PR = require('./project-resolver');
const SI = require('./skill-inventory');

const PARSER_VERSION = CS.PARSER_VERSION;

/**
 * node:sqlite 在 Node 22 上是实验特性，首次使用会向 stderr 打一行 ExperimentalWarning。
 * 本技能的输出可能被宿主当作结构化结果读取，因此把这条噪声过滤掉。
 */
let sqliteWarningMuted = false;
function muteSqliteWarning() {
  if (sqliteWarningMuted) return;
  sqliteWarningMuted = true;
  const orig = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === 'string' ? warning : (warning && warning.message) || '';
    if (/SQLite is an experimental feature/i.test(text)) return undefined;
    return orig.call(process, warning, ...rest);
  };
}

/** WorkBuddy 数据目录（默认 `~/.workbuddy`） */
function resolveHome(opts) {
  const o = opts || {};
  return path.resolve(o.home || process.env.WORKBUDDY_HOME || path.join(os.homedir(), '.workbuddy'));
}

/* ------------------------------------------------------------------ *
 * 会话元信息与用量（SQLite）
 * ------------------------------------------------------------------ */

/**
 * 只读打开 workbuddy.db。
 *
 * 库正被宿主以 WAL 模式占用，readOnly 打开是安全的；任何异常（无 node:sqlite /
 * 结构变化 / 被独占）一律**静默降级**，绝不让记录流程因此失败。
 */
function openDb(home) {
  const file = path.join(home, 'workbuddy.db');
  if (!fs.existsSync(file)) return null;
  try {
    muteSqliteWarning();
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(file, { readOnly: true });
  } catch (e) {
    return null;
  }
}

const SESSION_COLUMNS = [
  'id',
  'cwd',
  'title',
  'custom_title',
  'status',
  'created_at',
  'updated_at',
  'last_activity_at',
  'model',
  'mode',
  'source_mode',
  'project_id',
  'expert_id',
  'expert_runtime_identity',
  'is_background_automation',
];

/** 读取单个会话的元信息行（sessions 表） */
function readSessionRow(home, sessionId) {
  const db = openDb(home);
  if (!db) return null;
  try {
    const row = db
      .prepare(`SELECT ${SESSION_COLUMNS.join(', ')} FROM sessions WHERE id = ?`)
      .get(String(sessionId));
    return row || null;
  } catch (e) {
    return null;
  } finally {
    try {
      db.close();
    } catch (e) {
      /* 忽略 */
    }
  }
}

/** 列出最近有活动的会话 id（供 `--latest` 使用），按最后活动时间倒序 */
function listRecentSessions(home, limit) {
  const db = openDb(home);
  if (!db) return [];
  try {
    return db
      .prepare(
        'SELECT id, cwd, title, status, created_at, updated_at, last_activity_at ' +
          'FROM sessions WHERE deleted_at IS NULL ' +
          'ORDER BY COALESCE(last_activity_at, updated_at) DESC LIMIT ?'
      )
      .all(Number(limit) || 20);
  } catch (e) {
    return [];
  } finally {
    try {
      db.close();
    } catch (e) {
      /* 忽略 */
    }
  }
}

/**
 * 读取会话的 Token 占用与 WorkBuddy 积分。
 *
 * `credit_json` 的键是 `conversationRequestId`，与 JSONL 的请求 ID 同源，
 * 因此积分可以**按请求 join**，进而按会话精确求和 —— 这是 `total_score` 的来源。
 */
function readSessionUsage(home, sessionId) {
  const out = {
    ok: false,
    used: CS.UNAVAILABLE,
    size: CS.UNAVAILABLE,
    updated_at: null,
    credits: {},
    credit_total: CS.UNAVAILABLE,
    credit_count: 0,
  };
  const db = openDb(home);
  if (!db) return out;
  try {
    const row = db
      .prepare('SELECT session_id, used, size, updated_at, credit_json FROM session_usage WHERE session_id = ?')
      .get(String(sessionId));
    if (!row) return out;
    out.used = Number.isFinite(Number(row.used)) ? Number(row.used) : CS.UNAVAILABLE;
    out.size = Number.isFinite(Number(row.size)) ? Number(row.size) : CS.UNAVAILABLE;
    out.updated_at = row.updated_at ? Number(row.updated_at) : null;
    if (row.credit_json) {
      try {
        const parsed = JSON.parse(row.credit_json);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          let sum = 0;
          let n = 0;
          for (const [k, v] of Object.entries(parsed)) {
            const num = Number(v);
            if (Number.isFinite(num)) {
              out.credits[String(k)] = num;
              sum += num;
              n += 1;
            }
          }
          out.credit_count = n;
          out.credit_total = n ? CS.round2(sum) : CS.UNAVAILABLE;
        }
      } catch (e) {
        /* credit_json 损坏 → 保持 unavailable，不影响其余字段 */
      }
    }
    out.ok = true;
    return out;
  } catch (e) {
    return out;
  } finally {
    try {
      db.close();
    } catch (e) {
      /* 忽略 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * JSONL 解析
 * ------------------------------------------------------------------ */

/** 字符串预筛：避免对超长 content 行做无谓的 JSON.parse */
const NEEDLES = ['"usage"', '"Skill"', '"callId"', '"aiTitle"', '"input_text"'];
const SKILL_TOOL_NAMES = new Set(['Skill', 'skill']);

/** 定位某个 session 的 JSONL（projects/<slug>/<sessionId>.jsonl） */
function findSessionFile(home, sessionId) {
  const root = path.join(home, 'projects');
  if (!fs.existsSync(root)) return null;
  const want = `${String(sessionId)}.jsonl`;
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch (e) {
    return null;
  }
  for (const d of dirs) {
    const candidate = path.join(root, d.name, want);
    if (fs.existsSync(candidate)) return candidate;
    // 少数宿主把子代理会话放在二级目录
    const sub = path.join(root, d.name, 'subagents', want);
    if (fs.existsSync(sub)) return sub;
  }
  return null;
}

/** 从 message 记录的 content 数组里抽出用户真正输入的文字（剥掉注入的包装块） */
function extractUserText(content) {
  let items = content;
  if (typeof items === 'string') {
    try {
      const parsed = JSON.parse(items);
      items = Array.isArray(parsed) ? parsed : [parsed];
    } catch (e) {
      items = [{ type: 'input_text', text: items }];
    }
  }
  if (!Array.isArray(items)) return '';
  const parts = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const text = typeof it.text === 'string' ? it.text : '';
    if (!text) continue;
    parts.push(sanitizeUserText(text));
  }
  return parts.filter(Boolean).join(' ').trim();
}

/**
 * 清洗用户输入文本。
 *
 * 宿主会在用户输入外面套若干层标签：有的**整块丢弃**（系统注入，不是用户写的），
 * 有的只**脱壳保留内容**（`<user_query>` 里才是用户真正打的字）。
 */
function sanitizeUserText(text) {
  return String(text)
    // 整块丢弃：宿主注入的上下文，不属于用户输入
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<user_references>[\s\S]*?<\/user_references>/gi, ' ')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, ' ')
    .replace(/<identity_context>[\s\S]*?<\/identity_context>/gi, ' ')
    .replace(/<project_context>[\s\S]*?<\/project_context>/gi, ' ')
    .replace(/<memory>[\s\S]*?<\/memory>/gi, ' ')
    // 脱壳保留内容
    .replace(/<\/?(?:user_query|long_text_quote)>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 解析单个会话 JSONL。
 *
 * @returns {{
 *   requests: Object,     // requestId → 请求级用量（已按 conversationRequestId 去重）
 *   calls: Array,         // Skill 调用（含调用所在请求、载入字符数、结果状态）
 *   prompts: Array,       // 用户输入（供可选的 Work Activity 兜底采集）
 *   title: string|null,
 *   first_ts: number|null,
 *   last_ts: number|null,
 *   agents: Array<string>,
 * }}
 */
function parseSessionFile(file) {
  const out = {
    requests: {},
    calls: [],
    prompts: [],
    title: null,
    first_ts: null,
    last_ts: null,
    agents: [],
    bad_lines: 0,
  };
  if (!file || !fs.existsSync(file)) return out;

  const pendingCalls = new Map();
  const agents = new Set();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return out;
  }

  for (const line of text.split('\n')) {
    if (!line || !NEEDLES.some((n) => line.includes(n))) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (e) {
      out.bad_lines += 1;
      continue;
    }
    if (!o || typeof o !== 'object') continue;

    const ts = Number(o.timestamp);
    if (Number.isFinite(ts)) {
      if (out.first_ts === null || ts < out.first_ts) out.first_ts = ts;
      if (out.last_ts === null || ts > out.last_ts) out.last_ts = ts;
    }

    const pd = o.providerData || {};
    const rid = pd.conversationRequestId || pd.traceId || null;
    if (pd.agent) agents.add(String(pd.agent));

    // 请求级 usage：同一 requestId 只取一次（多条记录共用同一个 requestId）
    const usage = pd.usage;
    if (rid && !out.requests[rid] && usage && typeof usage === 'object') {
      const di = Array.isArray(usage.inputTokensDetails) ? usage.inputTokensDetails[0] : null;
      const doo = Array.isArray(usage.outputTokensDetails) ? usage.outputTokensDetails[0] : null;
      out.requests[rid] = {
        request_id: String(rid),
        input: numOrZero(usage.inputTokens),
        output: numOrZero(usage.outputTokens),
        total: numOrZero(usage.totalTokens),
        cached: numOrZero(di && di.cached_tokens),
        reasoning: numOrZero(doo && doo.reasoning_tokens),
        model:
          (pd.requestModelName && String(pd.requestModelName)) ||
          (pd.requestModelId && String(pd.requestModelId)) ||
          null,
        ts: Number.isFinite(ts) ? ts : null,
      };
    }

    if (o.type === 'ai-title' && o.aiTitle && !out.title) out.title = String(o.aiTitle);

    if (o.type === 'message' && o.role === 'user') {
      const userText = extractUserText(o.content);
      // 单条极短的输入（如 "继续"）没有记录价值
      if (userText && userText.length >= 4) {
        out.prompts.push({ time: Number.isFinite(ts) ? ts : null, text: userText });
      }
    }

    if (o.type === 'function_call' && SKILL_TOOL_NAMES.has(o.name)) {
      let args = {};
      try {
        args = JSON.parse(o.arguments || '{}');
      } catch (e) {
        args = {};
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
      // P0-1（2026-09-29）：宿主可能把**中文 display_name** 当 skill 传进来
      // （实测原文 `{"skill":"网页设计工程师"}`）。这里立刻归一化回稳定英文 id，
      // 否则同一个 Skill 会在日志里分裂成两个身份，去重与成本归因全部算错。
      pendingCalls.set(String(o.callId), {
        skill_id: SI.resolveSkillId(String(args.skill || args.command || '').trim()),
        args: args.args ? String(args.args) : '',
        request_id: rid ? String(rid) : null,
        start_time: Number.isFinite(ts) ? ts : null,
        end_time: null,
        load_chars: CS.UNAVAILABLE,
        call_status: null,
        result_text_head: '',
        invocation_id: o.callId ? String(o.callId) : null,
      });
      continue;
    }

    if (o.type === 'function_call_result' && pendingCalls.has(String(o.callId))) {
      const info = pendingCalls.get(String(o.callId));
      pendingCalls.delete(String(o.callId));
      const output = o.output && typeof o.output === 'object' ? o.output : {};
      const resultText = typeof output.text === 'string' ? output.text : '';
      info.end_time = Number.isFinite(ts) ? ts : null;
      info.load_chars = resultText.length;
      info.result_text_head = resultText.slice(0, 200);
      info.call_status = o.status ? String(o.status) : null;
      // 工具返回文本以 Error 开头 = Skill 载入失败（不产生有效注入）
      info.result_error = /^\s*Error/i.test(resultText);
      out.calls.push(info);
    }
  }

  // 只有 call 没有 result 的（会话在 Skill 执行中被中断）也要留痕，标 unknown
  for (const info of pendingCalls.values()) out.calls.push(info);

  out.calls.sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
  out.prompts.sort((a, b) => (a.time || 0) - (b.time || 0));
  out.agents = [...agents];
  return out;
}

const numOrZero = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/* ------------------------------------------------------------------ *
 * Skill 版本
 * ------------------------------------------------------------------ */

const versionCache = new Map();

/**
 * 解析 Skill 版本号。
 *
 * 查找顺序（取到即用，**全部是「已声明的版本」而非猜测**）：
 *
 * ```text
 * ① <home>/skills/<id>/SKILL.md 的 YAML frontmatter `version:`
 * ② 同上文件前 4000 字符里的 `Vx.y[.z]` 标题标记（本技能的标题就写着「V3.0」）
 * ③ 同目录的 VERSION / package.json / .skill-meta.json
 * ④ 插件缓存路径里的版本段（形如 plugins/cache/<mkt>/<plugin>/5.5.6-wb.xxx/skills/<id>/）
 * ⑤ 取不到 → unavailable（不猜版本号）
 * ```
 *
 * ⚠️ 实测本机多数 Skill 的 frontmatter **只有 name/description，没有 version** ——
 * 此时正确答案就是 `unavailable`，不要为了「字段完整」而编一个版本号。
 */
function resolveSkillVersion(skillId, home) {
  const id = String(skillId || '').trim();
  if (!id) return CS.UNAVAILABLE;
  const key = `${home}::${id}`;
  if (versionCache.has(key)) return versionCache.get(key);

  const skillDir = path.join(home, 'skills', id);
  const candidates = [path.join(skillDir, 'SKILL.md')];
  const pluginMd = safeGlobSkillMd(path.join(home, 'plugins', 'cache'), id);
  for (const f of pluginMd) candidates.push(f);

  const readIf = (f) => {
    try {
      return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    } catch (e) {
      return '';
    }
  };

  let version = CS.UNAVAILABLE;

  // ① / ② SKILL.md
  for (const file of candidates) {
    const text = readIf(file);
    if (!text) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
    if (fm) {
      const m = /^\s*version\s*:\s*["']?([^"'\r\n]+)/m.exec(fm[1]);
      if (m && m[1].trim()) {
        version = m[1].trim();
        break;
      }
    }
    const h = /\bV(\d+(?:\.\d+){1,2})\b/.exec(text.slice(0, 4000));
    if (h) {
      version = h[1];
      break;
    }
  }

  // ③ 同目录的显式版本文件
  if (version === CS.UNAVAILABLE) {
    const plain = readIf(path.join(skillDir, 'VERSION')).trim();
    if (/^v?\d+(\.\d+)*$/.test(plain)) version = plain.replace(/^v/i, '');
  }
  if (version === CS.UNAVAILABLE) {
    for (const f of ['package.json', '.skill-meta.json']) {
      const text = readIf(path.join(skillDir, f));
      if (!text) continue;
      try {
        const j = JSON.parse(text);
        if (j && typeof j.version === 'string' && j.version.trim()) {
          version = j.version.trim();
          break;
        }
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  // ④ 插件缓存路径里的版本段
  if (version === CS.UNAVAILABLE && pluginMd.length) {
    const seg = pluginMd[0].split(/[\\/]/);
    const at = seg.indexOf(id);
    // <plugin>/<version>/skills/<id>/SKILL.md —— 版本在 id 之前两段
    const cand = at >= 3 ? seg[at - 2] : '';
    if (/^\d+\.\d+\.\d+/.test(String(cand))) version = String(cand);
  }

  versionCache.set(key, version);
  return version;
}

/** 在插件缓存里按 skillId 找 SKILL.md（有界搜索，不递归 node_modules） */
function safeGlobSkillMd(root, skillId) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const skip = new Set(['node_modules', '.git', 'dist', 'build']);
  const walk = (dir, depth) => {
    if (depth > 6 || out.length >= 4) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.name === skillId) {
        const md = path.join(full, 'SKILL.md');
        if (fs.existsSync(md)) out.push(md);
      }
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/* ------------------------------------------------------------------ *
 * 结算载荷（Conversation + Skill Usage）
 * ------------------------------------------------------------------ */

/** Agent 解析顺序：专家 → 模式 → 宿主上报的 agent 类型 → null */
function resolveAgent(sessionRow, parsed) {
  if (sessionRow) {
    const runtime = sessionRow.expert_runtime_identity || sessionRow.expert_id;
    if (runtime) return `expert:${String(runtime)}`;
    if (sessionRow.mode) return String(sessionRow.mode);
  }
  if (parsed && parsed.agents && parsed.agents.length) return String(parsed.agents[0]);
  return CS.NA;
}

/**
 * 对话在宿主侧的状态。
 *
 * 与 `settlement_status` 是两件事：前者说「这个会话本身怎么了」
 * （`working` / `completed` / `archived` / …），后者说「这次结算成功了没有」。
 * 宿主给出未知值时写 `unknown`，不猜成 `completed`。
 */
const HOST_STATUS_MAP = {
  working: 'working',
  running: 'working',
  pending: 'working',
  completed: 'completed',
  done: 'completed',
  archived: 'archived',
  interrupted: 'interrupted',
  aborted: 'interrupted',
};
function hostStatusOf(sessionRow) {
  const raw = sessionRow && sessionRow.status ? String(sessionRow.status).toLowerCase() : '';
  return HOST_STATUS_MAP[raw] || 'unknown';
}

const isoOfMs = (ms) => {
  if (!Number.isFinite(Number(ms))) return null;
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return null;
  return (
    `${d.getFullYear()}-${C.pad(d.getMonth() + 1)}-${C.pad(d.getDate())}` +
    `T${C.pad(d.getHours())}:${C.pad(d.getMinutes())}:${C.pad(d.getSeconds())}${C.tzOffset(d)}`
  );
};

const hhmmOfMs = (ms) => {
  if (!Number.isFinite(Number(ms))) return null;
  const d = new Date(Number(ms));
  if (Number.isNaN(d.getTime())) return null;
  return `${C.pad(d.getHours())}:${C.pad(d.getMinutes())}`;
};

/**
 * 采集一次对话的完整结算载荷。
 *
 * **纯函数式输出**：只读磁盘，返回对象，不写任何日志 ——
 * 写盘由 `scripts/settle-conversation.js` 统一负责，方便 `--dry-run` 与测试。
 *
 * @param {string} sessionId 宿主会话 ID（= conversation 的业务键来源）
 * @param {object} [opts] { home, config, date, skillTokenMethod, tokenPerChar, workbuddyBase }
 */
function collectConversation(sessionId, opts) {
  const o = opts || {};
  const home = resolveHome(o);
  const config = o.config || {};
  const settlement = config.settlement || {};
  const diagnostics = { missing_fields: [], notes: [], source_files: [] };

  const sessionRow = readSessionRow(home, sessionId);
  const file = findSessionFile(home, sessionId);
  const parsed = parseSessionFile(file);
  if (file) diagnostics.source_files.push(file);
  if (!file) diagnostics.notes.push('未找到会话 JSONL（projects/<workspace>/<sessionId>.jsonl）');
  if (!sessionRow) diagnostics.notes.push('sessions 表未找到该会话');

  const usage = readSessionUsage(home, sessionId);
  const requestList = Object.values(parsed.requests);

  // ---- 起止时间：优先宿主会话表，JSONL 时间戳用于校正结束时间 ----
  let startMs = sessionRow ? Number(sessionRow.created_at) : null;
  let endMs = sessionRow
    ? Number(sessionRow.last_activity_at || sessionRow.updated_at)
    : null;
  if (parsed.first_ts !== null && (startMs === null || parsed.first_ts < startMs)) {
    startMs = parsed.first_ts;
  }
  if (parsed.last_ts !== null && (endMs === null || parsed.last_ts > endMs)) {
    endMs = parsed.last_ts;
  }
  if (startMs === null) diagnostics.missing_fields.push('start_time');
  if (endMs === null) diagnostics.missing_fields.push('end_time');

  const startTime = isoOfMs(startMs);
  const endTime = isoOfMs(endMs);
  const date =
    CS.dateOf(startTime) || CS.dateOf(endTime) || (o.date ? CS.assertDate(o.date) : C.today());

  // ---- Token：请求级 usage 去重后求和 ----
  const sum = (field) => requestList.reduce((a, r) => a + (Number(r[field]) || 0), 0);
  const hasRequests = requestList.length > 0;
  const totalToken = hasRequests ? sum('total') : CS.UNAVAILABLE;
  if (!hasRequests) diagnostics.missing_fields.push('total_token');

  const models = [...new Set(requestList.map((r) => r.model).filter(Boolean))];
  const modelName =
    (sessionRow && sessionRow.model && String(sessionRow.model)) ||
    models[0] ||
    CS.UNAVAILABLE;
  if (modelName === CS.UNAVAILABLE) diagnostics.missing_fields.push('model_name');

  // ---- WorkBuddy 积分：与 Token 完全独立，不做任何换算（用户 §七） ----
  //
  // 来源判定（用户 2026-09-21 明确）：
  // ```text
  // 宿主上报了 credit        → workbuddy_credit，记真实值
  // 一次 credit 都没上报      → not_applicable
  //   成因：该会话走**模型 API** 调用，不经积分通道，**积分本就是 0**。
  // ```
  // ⚠️ 「不可获取」（宿主该报没报）与「本就不适用」（这条通道不计积分）
  //    是两件不同的事。此前一律记 null/unavailable，导致：
  //    · 明细里显示「不可获取」，读者以为是数据缺失；
  //    · 这些会话被标成 settlement_status=partial，虚增「数据不全」的条数。
  // 现在把两者分开：not_applicable → 值为 0，且不计入 missing_fields。
  const score = usage.credit_total;
  const scoreSource = score === CS.NA ? 'not_applicable' : 'workbuddy_credit';
  const scoreValue = score === CS.NA ? 0 : score;
  // 只有「宿主该报但没报」才算缺失；不适用不算缺失
  if (score === CS.NA && Number(usage.credit_count) > 0) {
    diagnostics.missing_fields.push('total_score');
  }

  // ---- Skill Usage：每个 Skill 调用一条记录 ----
  const method = settlement.skill_token_method === 'off' ? 'off' : 'injection';
  const perChar = Number.isFinite(Number(settlement.token_per_char))
    ? Number(settlement.token_per_char)
    : 0.28;
  const conversationId = CS.makeConversationId(date, sessionId);
  const agentName = resolveAgent(sessionRow, parsed);

  const ordinalBySkill = new Map();
  const skillUsages = parsed.calls.map((call) => {
    const skillId = call.skill_id || 'unknown';
    const version = resolveSkillVersion(skillId, home);
    const ord = ordinalBySkill.get(skillId) || 0;
    ordinalBySkill.set(skillId, ord + 1);

    let skillToken = CS.UNAVAILABLE;
    let tokenSource = 'unavailable';
    const failed = call.call_status !== 'completed' || call.result_error === true;
    // 载入失败的调用没有有效注入，不产生 Skill token
    if (method === 'injection' && !failed && typeof call.load_chars === 'number') {
      skillToken = Math.round(call.load_chars * perChar);
      tokenSource = 'injection';
    }

    const req = call.request_id ? parsed.requests[call.request_id] : null;
    return {
      date,
      conversation_id: conversationId,
      // Skill 调用也带上 agent，便于不 join 也能回答「谁在什么 agent 下用了这个 Skill」
      agent: agentName,
      skill_id: skillId,
      skill_name: skillId,
      skill_version: version,
      start_time: isoOfMs(call.start_time),
      end_time: isoOfMs(call.end_time),
      skill_token: skillToken,
      token_source: tokenSource,
      call_request_id: call.request_id,
      // 「精确但非独占」：仅作旁证，禁止与 skill_token 混用或跨 Skill 相加
      call_request_total_token: req ? req.total : CS.NA,
      load_chars: call.load_chars,
      args: call.args,
      skill_invocation_id: call.invocation_id,
      ordinal: ord,
      source: 'workbuddy',
      // 结果未回来 = unknown，不能假定成功
      status: call.call_status === null ? 'unknown' : failed ? 'failed' : 'completed',
      // Skill 是在对话里被 agent 调起的（JSONL 无法区分用户显式触发，保持 unknown 更诚实）
      trigger_type: 'agent',
    };
  });

  // ---- 结算结果判定（用户 §二十五：部分失败不丢整条记录） ----
  // settlement_status 描述**本次结算**的结果；对话本身的宿主状态另由 `status` 表达。
  const settlementStatus =
    !hasRequests && !sessionRow && !file
      ? 'failed'
      : diagnostics.missing_fields.length || !file || !sessionRow
        ? 'partial'
        : 'settled';

  // ---- 项目归属（V3.4）：空间项目 id → 名称，不联网、不猜 ----
  // 此前这里写死 `project: null`，导致「按项目看 Token」永远是空表 ——
  // 事项有项目名、会话没有，而成本归因只认「事项.conversation_id → 会话」。
  const cwd = sessionRow && sessionRow.cwd ? String(sessionRow.cwd) : null;
  const proj = PR.resolveProjectContext(
    { projectId: sessionRow && sessionRow.project_id, cwd },
    {
      config,
      dir: o.dir,
      cache: o.projectCache,
      // 仅在「会话未关联任何空间项目」时才回退目录推导（§4.1）
      cwdResolver: (dir0) => C.projectFromCwd(dir0, { config, hostProjects: o.hostProjects }),
    }
  );
  if (proj.project_source === 'space_project_unmapped') diagnostics.notes.push(proj.reason);

  const conversation = {
    date,
    conversation_id: conversationId,
    session_id: String(sessionId),
    source: 'workbuddy',
    agent: agentName,
    model_name: modelName,
    models,
    start_time: startTime,
    end_time: endTime,
    // 宿主侧的会话状态（completed / working / archived / …）
    status: hostStatusOf(sessionRow),
    settlement_status: settlementStatus,
    total_token: totalToken,
    input_token: hasRequests ? sum('input') : CS.NA,
    output_token: hasRequests ? sum('output') : CS.NA,
    cached_token: hasRequests ? sum('cached') : CS.NA,
    reasoning_token: hasRequests ? sum('reasoning') : CS.NA,
    total_score: scoreValue,
    score_source: scoreSource,
    // 宿主只为部分请求落 credit 记录 → total_score 是**下界**，把覆盖度一并记下
    score_request_count: usage.credit_count,
    project: proj.project_name,
    project_id: proj.project_id,
    project_source: proj.project_source,
    project_confidence: proj.project_confidence,
    workspace: cwd,
    title:
      (parsed.title && String(parsed.title)) ||
      (sessionRow && (sessionRow.title || sessionRow.custom_title)
        ? String(sessionRow.title || sessionRow.custom_title)
        : null),
    request_count: requestList.length,
    skill_count: skillUsages.length,
    skill_invocation_count: skillUsages.length,
    distinct_skill_count: new Set(skillUsages.map((s) => s.skill_id)).size,
    missing_fields: diagnostics.missing_fields,
    parser_version: PARSER_VERSION,
  };

  return {
    conversation,
    skill_usages: skillUsages,
    prompts: parsed.prompts,
    diagnostics,
    // 原始快照：解析产物 + 来源文件，供 §16「重新解析」使用
    raw: {
      session_id: String(sessionId),
      session_row: sessionRow || null,
      session_usage: {
        used: usage.used,
        size: usage.size,
        updated_at: usage.updated_at,
        credit_total: usage.credit_total,
        credit_count: usage.credit_count,
        credits: usage.credits,
      },
      requests: requestList,
      skill_calls: parsed.calls,
      source_files: diagnostics.source_files,
      notes: diagnostics.notes,
      collected_at: C.nowIso(),
    },
  };
}

module.exports = {
  PARSER_VERSION,
  resolveHome,
  // SQLite
  openDb,
  readSessionRow,
  listRecentSessions,
  readSessionUsage,
  // JSONL
  findSessionFile,
  parseSessionFile,
  // 工具
  resolveSkillVersion,
  resolveAgent,
  hostStatusOf,
  isoOfMs,
  hhmmOfMs,
  round6: CS.round6,
  // 主入口
  collectConversation,
};
