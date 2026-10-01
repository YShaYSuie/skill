'use strict';
/**
 * codex-conversation-parser.js — Codex rollout 会话的确定性解析器。
 *
 * Codex Desktop / CLI 会把会话写在：
 *   <CODEX_HOME>/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl
 *
 * 本模块只读这些 rollout，把它投影成与 WorkBuddy parser 相同的结算载荷：
 * Conversation + Skill Usage + prompts。Codex 当前不暴露可归因的 Skill 载入
 * 体积或会话级 Credit，因此这些字段诚实写 null / unavailable，绝不估算。
 *
 * V3.6（用户 2026-09-24）：新增**显式 Skill 引用识别**。
 *   用户的 Skill 主要用在 Codex 里，但此前 Codex 侧一条 Skill Usage 都没有，
 *   导致「高频 Skill / 哪个 Skill 用不上」缺了一半数据。现在从用户输入里识别
 *   `$skill-name` 与 `skills/<name>/SKILL.md` 这类**显式引用**：
 *     · 能数出**调用次数**（每个引用一条记录，序号参与去重键 → 幂等）；
 *     · 载入体积仍为 **null + token_source: 'unavailable'**（宿主不提供，不估算）；
 *     · 只认本机**确实装过**的 Skill 名，避免把 `$PATH` 之类当成 Skill。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const C = require('./log-core');
const CS = require('./conversation-store');
const PR = require('./project-resolver');
const CPR = require('./codex-project-resolver');
const SI = require('./skill-inventory');

const PARSER_VERSION = 'codex-1.5.0';
const ROLLOUT_INDEX_CACHE = new Map();
// 已安装 Skill 名单只扫一次（本地文件系统，零 Token）
let KNOWN_SKILLS_CACHE = null;

/**
 * V3.22：不计入「Skill 载入证据」的工具。
 *
 * 改技能源码 ≠ 使用技能 —— `apply_patch` 的参数里带着技能目录路径，
 * 用它判定会把「开发 / 排查这个技能」记成「使用了这个技能」。
 */
const SKILL_EVIDENCE_EXCLUDED_TOOLS = new Set(['apply_patch', 'update_plan', 'update_goal']);
/** 单个工具调用参数的最大扫描长度（防超长 base64 / 日志把内存撑爆） */
const MAX_TOOL_ARGS_CHARS = 20000;
/** 单会话最多保留的工具调用数（只用于找 Skill 载入证据，不需要全量） */
const MAX_TOOL_CALLS = 400;

/** 本机已安装的 skill_id 集合（读不到就返回空集，宁可漏报也不误报） */
function knownSkillIds() {
  if (KNOWN_SKILLS_CACHE) return KNOWN_SKILLS_CACHE;
  try {
    const inv = SI.load({ summary: { insights: {} } });
    KNOWN_SKILLS_CACHE = new Set(inv.installed.map((s) => String(s.skill_id)));
  } catch (e) {
    KNOWN_SKILLS_CACHE = new Set();
  }
  return KNOWN_SKILLS_CACHE;
}

function resolveCodexHome(opts) {
  const o = opts || {};
  return path.resolve(
    o.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  );
}

function walkRolloutFiles(root, out, depth) {
  if (!root || depth > 7) return;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'tmp') continue;
      walkRolloutFiles(full, out, depth + 1);
      continue;
    }
    if (!e.isFile() || !/^rollout-.*\.jsonl$/.test(e.name)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch (err) {
      /* 忽略不可读文件 */
    }
    out.push({ file: full, mtime_ms: mtimeMs });
  }
}

function listRolloutFiles(codexHome) {
  const out = [];
  walkRolloutFiles(path.join(codexHome, 'sessions'), out, 0);
  walkRolloutFiles(path.join(codexHome, 'archived_sessions'), out, 0);
  out.sort((a, b) => (b.mtime_ms || 0) - (a.mtime_ms || 0));
  return out;
}

function readJsonl(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { rows: [], bad_lines: 0 };
  }
  const rows = [];
  let bad = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object') rows.push(o);
      else bad += 1;
    } catch (e) {
      bad += 1;
    }
  }
  return { rows, bad_lines: bad };
}

function readSessionMeta(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = Math.min(64 * 1024, fs.statSync(file).size);
    const buf = Buffer.alloc(size);
    const bytes = fs.readSync(fd, buf, 0, size, 0);
    const head = buf.slice(0, bytes).toString('utf8');
    for (const line of head.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row.type === 'session_meta' && row.payload && row.payload.session_id) {
          return row.payload;
        }
      } catch (e) {
        if (line.includes('session_meta')) continue;
      }
    }
    return null;
  } catch (e) {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {
        /* 忽略 */
      }
    }
  }
}

function normalizeExistingRolloutPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const candidates = [raw, raw.replace(/^\\\\\?\\/, '')];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findCodexSessionFile(codexHome, sessionId) {
  const id = String(sessionId || '');
  if (!id) return null;
  const threadRow = readThreadRow(codexHome, id);
  const selected = listSessionRollouts(codexHome, id, threadRow);
  return selected.primary ? selected.primary.file : null;
}

function openDb(codexHome) {
  const file = path.join(codexHome, 'state_5.sqlite');
  if (!fs.existsSync(file)) return null;
  try {
    const { DatabaseSync } = require('node:sqlite');
    return new DatabaseSync(file, { readOnly: true });
  } catch (e) {
    return null;
  }
}

function readThreadRow(codexHome, sessionId) {
  const db = openDb(codexHome);
  if (!db) return null;
  try {
    const row = db.prepare('SELECT * FROM threads WHERE id = ?').get(String(sessionId));
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

function isUserRollout(meta) {
  if (!meta) return false;
  const threadSource = String(meta.thread_source || '').trim();
  if (threadSource) return threadSource === 'user';
  if (meta.source && typeof meta.source === 'object' && meta.source.subagent) return false;
  return true;
}

function metaTimeMs(meta, fallback) {
  const parsed = Number(meta && meta.timestamp ? Date.parse(meta.timestamp) : NaN);
  if (Number.isFinite(parsed)) return parsed;
  const fallbackValue = Number(fallback);
  return Number.isFinite(fallbackValue) ? fallbackValue : null;
}

function describeRollout(item, sessionId, metaOverride) {
  const meta = metaOverride || readSessionMeta(item.file);
  if (!meta || String(meta.session_id) !== String(sessionId)) return null;
  return {
    file: item.file,
    mtime_ms: Number(item.mtime_ms) || 0,
    meta,
    meta_time: metaTimeMs(meta, item.mtime_ms),
    payload_id: meta.id ? String(meta.id) : null,
    thread_source: String(meta.thread_source || '') || null,
    history_base: meta.history_base || null,
  };
}

function sessionRolloutIndex(codexHome) {
  const files = listRolloutFiles(codexHome);
  const signature = files
    .map((item) => `${item.file}:${Number(item.mtime_ms) || 0}`)
    .join('|');
  const cached = ROLLOUT_INDEX_CACHE.get(codexHome);
  if (cached && cached.signature === signature) return cached.bySession;

  const bySession = new Map();
  for (const item of files) {
    const meta = readSessionMeta(item.file);
    if (!meta || !meta.session_id) continue;
    const id = String(meta.session_id);
    const info = describeRollout(item, id, meta);
    if (!info) continue;
    if (!bySession.has(id)) bySession.set(id, []);
    bySession.get(id).push(info);
  }
  ROLLOUT_INDEX_CACHE.set(codexHome, { signature, bySession });
  return bySession;
}

function listSessionRollouts(codexHome, sessionId, threadRow) {
  const id = String(sessionId || '');
  if (!id) return { canonical_file: null, user: [], internal: [], primary: null, all: [] };

  const canonicalFile = normalizeExistingRolloutPath(threadRow && threadRow.rollout_path);
  const all = (sessionRolloutIndex(codexHome).get(id) || []).slice();
  if (canonicalFile && !all.some((item) => fileKey(item.file) === fileKey(canonicalFile))) {
    let mtime = 0;
    try {
      mtime = fs.statSync(canonicalFile).mtimeMs;
    } catch (e) {
      mtime = 0;
    }
    const info = describeRollout({ file: canonicalFile, mtime_ms: mtime }, id);
    if (info) all.push(info);
  }

  const user = all
    .filter((item) => isUserRollout(item.meta))
    .sort((a, b) => (a.meta_time || a.mtime_ms || 0) - (b.meta_time || b.mtime_ms || 0));
  const internal = all.filter((item) => !isUserRollout(item.meta));
  const primary =
    user.find((item) => canonicalFile && fileKey(item.file) === fileKey(canonicalFile)) ||
    user
      .slice()
      .sort((a, b) => (b.meta_time || b.mtime_ms || 0) - (a.meta_time || a.mtime_ms || 0))[0] ||
    null;

  return { canonical_file: canonicalFile, user, internal, primary, all };
}

function stripInjectedText(text) {
  return String(text || '')
    .replace(/<app-context>[\s\S]*?<\/app-context>/gi, ' ')
    .replace(/<recommended_plugins>[\s\S]*?<\/recommended_plugins>/gi, ' ')
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, ' ')
    .replace(/<system-reminder[\s\S]*?<\/system-reminder>/gi, ' ')
    .replace(/<user_references>[\s\S]*?<\/user_references>/gi, ' ')
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/gi, ' ')
    .replace(/<identity_context>[\s\S]*?<\/identity_context>/gi, ' ')
    .replace(/<project_context>[\s\S]*?<\/project_context>/gi, ' ')
    .replace(/<memory>[\s\S]*?<\/memory>/gi, ' ')
    .replace(/<\/?(?:user_query|long_text_quote)>/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractUserText(payload) {
  if (!payload || payload.role !== 'user') return '';
  const parts = [];
  const content = Array.isArray(payload.content) ? payload.content : [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    if (typeof item.text !== 'string') continue;
    const text = stripInjectedText(item.text);
    if (text) parts.push(text);
  }
  return parts.join(' ').trim();
}

function isoOfMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  return (
    `${d.getFullYear()}-${C.pad(d.getMonth() + 1)}-${C.pad(d.getDate())}` +
    `T${C.pad(d.getHours())}:${C.pad(d.getMinutes())}:${C.pad(d.getSeconds())}${C.tzOffset(d)}`
  );
}

function hhmmOfMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const d = new Date(n);
  if (Number.isNaN(d.getTime())) return null;
  return `${C.pad(d.getHours())}:${C.pad(d.getMinutes())}`;
}

function parseRollout(file) {
  const out = {
    session_meta: null,
    last_ts: null,
    prompts: [],
    tool_calls: [],
    turn_records: [],
    turn_events: [],
    total_usage: null,
    last_token_count: null,
    request_ids: new Set(),
    request_records: [],
    task_started: 0,
    task_complete: 0,
    cwd: null,
    workspace_roots: [],
    min_ordinal: null,
    max_ordinal: null,
    bad_lines: 0,
  };
  const parsed = readJsonl(file);
  out.bad_lines = parsed.bad_lines;

  const promptSeen = new Set();
  for (const row of parsed.rows) {
    const ts = Date.parse(row.timestamp || '');
    const ordinal = Number(row.ordinal);
    if (Number.isFinite(ts)) out.last_ts = ts;
    if (Number.isFinite(ordinal)) {
      if (out.min_ordinal === null || ordinal < out.min_ordinal) out.min_ordinal = ordinal;
      if (out.max_ordinal === null || ordinal > out.max_ordinal) out.max_ordinal = ordinal;
    }
    const payload = row.payload || {};

    if (row.type === 'session_meta' && payload.session_id && !out.session_meta) {
      out.session_meta = payload;
      if (payload.cwd) out.cwd = String(payload.cwd);
      if (Array.isArray(payload.runtime_workspace_roots)) {
        out.workspace_roots = payload.runtime_workspace_roots.map(String);
      }
    }

    if (row.type === 'turn_context') {
      if (payload.cwd) out.cwd = String(payload.cwd);
      if (Array.isArray(payload.workspace_roots)) {
        out.workspace_roots = payload.workspace_roots.map(String);
      }
    }

    if (row.type === 'response_item' && payload.type === 'message') {
      const text = extractUserText(payload);
      if (text && text.length >= 4) {
        const key = text.slice(0, 160);
        if (!promptSeen.has(key)) {
          promptSeen.add(key);
          out.prompts.push({
            time: Number.isFinite(ts) ? ts : null,
            ordinal: Number.isFinite(ordinal) ? ordinal : null,
            text,
          });
        }
      }
    }

    // V3.22：收集工具调用参数，用于识别「本会话真实载入过哪个 Skill 的 SKILL.md」。
    // 只存参数文本 + 时间/序号，不做判定（判定要等 known skill 名单就绪）。
    if (row.type === 'response_item' && payload.type === 'function_call') {
      const toolName = String(payload.name || '');
      if (!SKILL_EVIDENCE_EXCLUDED_TOOLS.has(toolName) && out.tool_calls.length < MAX_TOOL_CALLS) {
        const raw =
          typeof payload.arguments === 'string'
            ? payload.arguments
            : payload.arguments
              ? JSON.stringify(payload.arguments)
              : '';
        if (raw && raw.length <= MAX_TOOL_ARGS_CHARS) {
          out.tool_calls.push({
            time: Number.isFinite(ts) ? ts : null,
            ordinal: Number.isFinite(ordinal) ? ordinal : null,
            text: raw,
          });
        }
      }
    }

    if (row.type === 'event_msg' && payload.type === 'task_started') {
      out.task_started += 1;
      if (payload.turn_id) {
        out.turn_events.push({
          provider_turn_id: String(payload.turn_id),
          event: 'started',
          time: Number.isFinite(ts) ? ts : null,
          ordinal: Number.isFinite(ordinal) ? ordinal : null,
        });
      }
    }
    if (row.type === 'event_msg' && payload.type === 'task_complete') {
      out.task_complete += 1;
      if (payload.turn_id) {
        out.turn_events.push({
          provider_turn_id: String(payload.turn_id),
          event: 'completed',
          time: Number.isFinite(ts) ? ts : null,
          ordinal: Number.isFinite(ordinal) ? ordinal : null,
        });
      }
    }

    if (row.type === 'event_msg' && payload.type === 'token_count' && payload.info) {
      out.last_token_count = {
        ts: Number.isFinite(ts) ? ts : null,
        usage: payload.info.total_token_usage || null,
      };
    }

    if (row.type === 'token_usage_record') {
      const providerTurnId = payload.turn_id ? String(payload.turn_id) : null;
      if (providerTurnId) {
        out.turn_records.push({
          provider_turn_id: providerTurnId,
          response_id: payload.response_id ? String(payload.response_id) : null,
          time: Number.isFinite(ts) ? ts : null,
          ordinal: Number.isFinite(ordinal) ? ordinal : null,
          usage: payload.usage || null,
          turn_usage: payload.turn_token_usage || null,
        });
      }
      if (payload.response_id) {
        const responseId = String(payload.response_id);
        out.request_ids.add(responseId);
        out.request_records.push({
          id: responseId,
          ordinal: Number.isFinite(ordinal) ? ordinal : null,
        });
      }
      if (payload.thread_token_usage) {
        out.total_usage = {
          ts: Number.isFinite(ts) ? ts : null,
          usage: payload.thread_token_usage,
        };
      }
    }
  }
  out.prompts.sort((a, b) => (a.time || 0) - (b.time || 0));
  return out;
}

function numOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : CS.NA;
}

function fileKey(file) {
  return path.resolve(String(file || '')).toLowerCase();
}

function mergeRolloutLineage(selection) {
  const items = selection.user.map((info) => ({
    info,
    parsed: parseRollout(info.file),
  }));
  if (!items.length) return null;

  const byFile = new Map(items.map((item) => [fileKey(item.info.file), item]));
  const selectedPrimary =
    (selection.primary && byFile.get(fileKey(selection.primary.file))) ||
    items
      .slice()
      .sort((a, b) => (b.info.meta_time || b.info.mtime_ms || 0) - (a.info.meta_time || a.info.mtime_ms || 0))[0];
  const used = new Set([fileKey(selectedPrimary.info.file)]);

  function sameSessionBefore(candidate, child) {
    const candidateTime = candidate.info.meta_time || candidate.info.mtime_ms || 0;
    const childTime = child.info.meta_time || child.info.mtime_ms || 0;
    return !candidateTime || !childTime || candidateTime <= childTime;
  }

  function chooseAncestor(child) {
    const threshold = Number(
      child.info.history_base && child.info.history_base.end_ordinal_exclusive
    );
    const childStart = Number(child.parsed.min_ordinal);
    const pool = items.filter(
      (candidate) =>
        !used.has(fileKey(candidate.info.file)) && sameSessionBefore(candidate, child)
    );
    if (!pool.length) return null;

    if (Number.isFinite(threshold)) {
      const covering = pool.filter((candidate) => {
        const minOrdinal = Number(candidate.parsed.min_ordinal);
        const maxOrdinal = Number(candidate.parsed.max_ordinal);
        return (
          Number.isFinite(minOrdinal) &&
          Number.isFinite(maxOrdinal) &&
          minOrdinal < threshold &&
          maxOrdinal >= threshold - 1
        );
      });
      if (covering.length) {
        covering.sort(
          (a, b) =>
            (b.info.meta_time || b.info.mtime_ms || 0) -
              (a.info.meta_time || a.info.mtime_ms || 0) ||
            (b.parsed.max_ordinal || 0) - (a.parsed.max_ordinal || 0)
        );
        return covering[0];
      }
    }

    if (Number.isFinite(childStart) && childStart > 0) {
      const before = pool.filter((candidate) => {
        const maxOrdinal = Number(candidate.parsed.max_ordinal);
        return Number.isFinite(maxOrdinal) && maxOrdinal < childStart;
      });
      if (before.length) {
        before.sort(
          (a, b) =>
            (b.parsed.max_ordinal || 0) - (a.parsed.max_ordinal || 0) ||
            (b.info.meta_time || b.info.mtime_ms || 0) -
              (a.info.meta_time || a.info.mtime_ms || 0)
        );
        return before[0];
      }
    }
    return null;
  }

  function walk(child, incomingCutoff) {
    const parent = chooseAncestor(child);
    if (!parent) return [{ item: child, cutoff: incomingCutoff }];
    used.add(fileKey(parent.info.file));
    const ownThreshold = Number(
      child.info.history_base && child.info.history_base.end_ordinal_exclusive
    );
    const parentCutoff = Number.isFinite(ownThreshold)
      ? Math.min(incomingCutoff, ownThreshold)
      : incomingCutoff;
    return walk(parent, parentCutoff).concat([{ item: child, cutoff: incomingCutoff }]);
  }

  const lineage = walk(selectedPrimary, Number.POSITIVE_INFINITY);
  const prompts = [];
  const promptSeen = new Set();
  const toolCalls = [];
  const toolCallSeen = new Set();
  const requestIds = new Set();
  const requestSeen = new Set();
  const turnRecords = [];
  const turnRecordSeen = new Set();
  const turnEvents = [];
  const turnEventSeen = new Set();
  const startCandidates = items
    .map((item) => item.info.meta_time)
    .filter(Number.isFinite);
  let endMs = selectedPrimary.parsed.last_ts;

  for (const entry of lineage) {
    const cutoff = Number(entry.cutoff);
    if (entry.item.info.meta_time) startCandidates.push(entry.item.info.meta_time);

    for (const prompt of entry.item.parsed.prompts) {
      if (Number.isFinite(cutoff) && Number.isFinite(prompt.ordinal) && prompt.ordinal >= cutoff) {
        continue;
      }
      if (prompt.time) startCandidates.push(prompt.time);
      const key = `${Number.isFinite(prompt.ordinal) ? prompt.ordinal : ''}|${String(
        prompt.text || ''
      ).slice(0, 160)}`;
      if (!promptSeen.has(key)) {
        promptSeen.add(key);
        prompts.push(prompt);
      }
    }

    // V3.22：同一分片链上的工具调用也按「序号 + 前 160 字」去重后合并
    for (const call of entry.item.parsed.tool_calls || []) {
      if (Number.isFinite(cutoff) && Number.isFinite(call.ordinal) && call.ordinal >= cutoff) {
        continue;
      }
      const key = `${Number.isFinite(call.ordinal) ? call.ordinal : ''}|${String(
        call.text || ''
      ).slice(0, 160)}`;
      if (!toolCallSeen.has(key)) {
        toolCallSeen.add(key);
        toolCalls.push(call);
      }
    }

    for (const request of entry.item.parsed.request_records) {
      if (Number.isFinite(cutoff) && Number.isFinite(request.ordinal) && request.ordinal >= cutoff) {
        continue;
      }
      const key = request.id || `${request.ordinal}`;
      if (!requestSeen.has(key)) {
        requestSeen.add(key);
        requestIds.add(key);
      }
    }

    for (const turn of entry.item.parsed.turn_records || []) {
      if (Number.isFinite(cutoff) && Number.isFinite(turn.ordinal) && turn.ordinal >= cutoff) {
        continue;
      }
      const key = `${turn.provider_turn_id}|${turn.response_id || turn.ordinal || ''}`;
      if (!turnRecordSeen.has(key)) {
        turnRecordSeen.add(key);
        turnRecords.push(turn);
      }
    }

    for (const event of entry.item.parsed.turn_events || []) {
      if (Number.isFinite(cutoff) && Number.isFinite(event.ordinal) && event.ordinal >= cutoff) {
        continue;
      }
      const key = `${event.provider_turn_id}|${event.event}|${event.ordinal || ''}`;
      if (!turnEventSeen.has(key)) {
        turnEventSeen.add(key);
        turnEvents.push(event);
      }
    }
  }
  if (!Number.isFinite(Number(endMs))) {
    const endpoints = lineage
      .map((entry) => entry.item.parsed.last_ts)
      .filter(Number.isFinite);
    endMs = endpoints.length ? Math.max(...endpoints) : null;
  }

  prompts.sort(
    (a, b) =>
      (a.time || 0) - (b.time || 0) ||
      (Number.isFinite(a.ordinal) ? a.ordinal : 0) - (Number.isFinite(b.ordinal) ? b.ordinal : 0)
  );
  toolCalls.sort(
    (a, b) =>
      (a.time || 0) - (b.time || 0) ||
      (Number.isFinite(a.ordinal) ? a.ordinal : 0) - (Number.isFinite(b.ordinal) ? b.ordinal : 0)
  );
  turnRecords.sort(
    (a, b) =>
      (a.time || 0) - (b.time || 0) ||
      (Number.isFinite(a.ordinal) ? a.ordinal : 0) -
        (Number.isFinite(b.ordinal) ? b.ordinal : 0)
  );
  turnEvents.sort(
    (a, b) =>
      (a.time || 0) - (b.time || 0) ||
      (Number.isFinite(a.ordinal) ? a.ordinal : 0) -
        (Number.isFinite(b.ordinal) ? b.ordinal : 0)
  );
  const turnMap = new Map();
  for (const rec of turnRecords) {
    const key = rec.provider_turn_id;
    if (!turnMap.has(key)) {
      turnMap.set(key, {
        provider_turn_id: key,
        request_ids: new Set(),
        start_ms: null,
        end_ms: null,
        start_ordinal: null,
        end_ordinal: null,
        usage: null,
        usage_ordinal: null,
        status: 'unknown',
      });
    }
    const row = turnMap.get(key);
    if (rec.response_id) row.request_ids.add(rec.response_id);
    if (Number.isFinite(rec.time)) {
      row.start_ms = row.start_ms === null ? rec.time : Math.min(row.start_ms, rec.time);
      row.end_ms = row.end_ms === null ? rec.time : Math.max(row.end_ms, rec.time);
    }
    if (Number.isFinite(rec.ordinal)) {
      row.start_ordinal =
        row.start_ordinal === null ? rec.ordinal : Math.min(row.start_ordinal, rec.ordinal);
      row.end_ordinal =
        row.end_ordinal === null ? rec.ordinal : Math.max(row.end_ordinal, rec.ordinal);
    }
    if (
      rec.turn_usage &&
      (row.usage_ordinal === null ||
        (Number.isFinite(rec.ordinal) && rec.ordinal >= row.usage_ordinal))
    ) {
      row.usage = rec.turn_usage;
      row.usage_ordinal = Number.isFinite(rec.ordinal) ? rec.ordinal : row.usage_ordinal;
    }
  }
  for (const event of turnEvents) {
    if (!turnMap.has(event.provider_turn_id)) continue;
    const row = turnMap.get(event.provider_turn_id);
    if (Number.isFinite(event.time)) {
      row.start_ms = row.start_ms === null ? event.time : Math.min(row.start_ms, event.time);
      row.end_ms = row.end_ms === null ? event.time : Math.max(row.end_ms, event.time);
    }
    if (Number.isFinite(event.ordinal)) {
      row.start_ordinal =
        row.start_ordinal === null ? event.ordinal : Math.min(row.start_ordinal, event.ordinal);
      row.end_ordinal =
        row.end_ordinal === null ? event.ordinal : Math.max(row.end_ordinal, event.ordinal);
    }
    if (event.event === 'completed') row.status = 'completed';
    else if (event.event === 'started' && row.status === 'unknown') row.status = 'working';
  }
  const turns = [...turnMap.values()]
    .sort(
      (a, b) =>
        (a.start_ms || 0) - (b.start_ms || 0) ||
        (a.start_ordinal || 0) - (b.start_ordinal || 0) ||
        a.provider_turn_id.localeCompare(b.provider_turn_id)
    )
    .map((row, index, all) =>
      Object.assign({}, row, {
        ordinal: index,
        // 后续 Turn 已开始，说明前一轮至少已经正常结束。这样可避免
        // rollout 历史边界把前一轮的 task_complete 截掉后误留为 working。
        status: row.status === 'working' && index < all.length - 1 ? 'completed' : row.status,
        request_ids: [...row.request_ids],
        request_count: row.request_ids.size,
      })
    );
  const startMs = startCandidates.filter(Number.isFinite).sort((a, b) => a - b)[0] || null;
  const included = new Set(lineage.map((entry) => fileKey(entry.item.info.file)));
  const ignored = items
    .filter((item) => !included.has(fileKey(item.info.file)))
    .map((item) => ({
      file: item.info.file,
      reason: '不属于主分片的历史链或为重复回放',
    }));

  return {
    primary: selectedPrimary,
    lineage,
    ignored,
    prompts,
    tool_calls: toolCalls,
    turns,
    request_ids: requestIds,
    start_ms: startMs,
    end_ms: endMs,
    usage:
      (selectedPrimary.parsed.total_usage && selectedPrimary.parsed.total_usage.usage) ||
      (selectedPrimary.parsed.last_token_count &&
        selectedPrimary.parsed.last_token_count.usage) ||
      null,
    task_started: selectedPrimary.parsed.task_started,
    task_complete: selectedPrimary.parsed.task_complete,
    cwd: selectedPrimary.parsed.cwd,
  };
}

function listRecentSessions(codexHome, limit) {
  const max = Number(limit) || 20;
  const groups = new Map();
  for (const [id, items] of sessionRolloutIndex(codexHome)) {
    for (const item of items) {
      if (!isUserRollout(item.meta)) continue;
      const createdMs = item.meta_time;
      const current = groups.get(id);
      if (!current) {
        groups.set(id, {
          id,
          cwd: item.meta.cwd || null,
          created_at: createdMs,
          last_activity_at: item.mtime_ms || createdMs,
          file: item.file,
          file_mtime_ms: item.mtime_ms || 0,
        });
        continue;
      }
      if (createdMs && (!current.created_at || createdMs < current.created_at)) {
        current.created_at = createdMs;
      }
      if ((item.mtime_ms || 0) >= (current.file_mtime_ms || 0)) {
        current.file = item.file;
        current.file_mtime_ms = item.mtime_ms || 0;
        current.last_activity_at = item.mtime_ms || current.last_activity_at;
      }
      if (item.meta.cwd && !current.cwd) current.cwd = item.meta.cwd;
    }
  }

  return [...groups.values()]
    .sort((a, b) => (b.last_activity_at || 0) - (a.last_activity_at || 0))
    .slice(0, max)
    .map((item) => {
      const row = readThreadRow(codexHome, item.id);
      const canonical = normalizeExistingRolloutPath(row && row.rollout_path);
      return {
        id: item.id,
        cwd: (row && row.cwd) || item.cwd || null,
        title: row && (row.title || row.name) ? String(row.title || row.name) : null,
        created_at: item.created_at || item.last_activity_at,
        last_activity_at: Math.max(
          item.last_activity_at || 0,
          Number(row && row.updated_at_ms) || 0
        ),
        source: 'codex',
        file: canonical || item.file,
      };
    });
}

/**
 * 构造 Codex 侧的 Skill Usage（V3.6 建立，V3.22 修口径）。
 *
 * ```text
 * 证据（user 2026-09-26：匹配到 ≠ 实际使用）：
 *   ① explicit_invocation —— 用户输入里显式调用了它（$skill / 技能路径引用）
 *   ② skill_md_loaded     —— 会话中真实载入了该技能的 SKILL.md（工具调用参数命中）
 * 每条证据 = 一次调用记录；ordinal = 该 Skill 在本会话内的第几次（参与 usage_id ⇒ 幂等）
 * skill_token = null + token_source 'unavailable'
 *   （Codex 不暴露可归因的载入体积；按字符数反推属于估算，明令禁止）
 * ```
 *
 * 扫描范围**只限**用户输入与工具调用参数 —— 绝不能扫整份 rollout：
 * 每一轮请求都注入一份技能目录（本机 25 条），全文扫描会把所有技能记成用过。
 *
 * @param {Array} prompts `{time(ms), ordinal, text}` 列表
 * @param {Array} toolCalls `{time(ms), ordinal, text}` 列表（function_call 参数）
 * @param {Array} turns 已归一化的 Turn 列表
 * @param {string} conversationId
 * @param {string} date
 * @param {string} fallbackStart
 */
function findTurnForEvent(event, turns) {
  const list = turns || [];
  if (!list.length) return null;
  const time = Number.isFinite(event && event.time) ? event.time : null;
  const ordinal = Number.isFinite(event && event.order) ? event.order : null;

  if (time !== null) {
    const containing = list.filter(
      (turn) =>
        Number.isFinite(turn.start_ms) &&
        time >= turn.start_ms &&
        (!Number.isFinite(turn.end_ms) || time <= turn.end_ms)
    );
    if (containing.length) return containing[containing.length - 1];
    const before = list.filter((turn) => Number.isFinite(turn.start_ms) && turn.start_ms <= time);
    if (before.length) return before[before.length - 1];
    return list[0];
  }

  if (ordinal !== null) {
    const containing = list.filter(
      (turn) =>
        Number.isFinite(turn.start_ordinal) &&
        ordinal >= turn.start_ordinal &&
        (!Number.isFinite(turn.end_ordinal) || ordinal <= turn.end_ordinal)
    );
    if (containing.length) return containing[containing.length - 1];
    const before = list.filter(
      (turn) => Number.isFinite(turn.start_ordinal) && turn.start_ordinal <= ordinal
    );
    if (before.length) return before[before.length - 1];
  }
  return null;
}

function buildSkillUsages(prompts, toolCalls, turns, conversationId, date, fallbackStart) {
  const known = knownSkillIds();
  if (!known.size || !conversationId) return [];

  const events = [];
  for (const p of prompts || []) {
    for (const hit of SI.extractSkillRefs((p && p.text) || '', known)) {
      events.push({
        skill_id: hit.skill_id,
        time: p && Number.isFinite(p.time) ? p.time : null,
        order: p && Number.isFinite(p.ordinal) ? p.ordinal : 0,
        evidence: 'explicit_invocation',
        trigger_type: 'user',
      });
    }
  }
  for (const c of toolCalls || []) {
    for (const hit of SI.extractSkillMdLoads((c && c.text) || '', known)) {
      events.push({
        skill_id: hit.skill_id,
        time: c && Number.isFinite(c.time) ? c.time : null,
        order: c && Number.isFinite(c.ordinal) ? c.ordinal : 0,
        evidence: 'skill_md_loaded',
        trigger_type: 'agent',
      });
    }
  }
  if (!events.length) return [];

  // 时间（缺失的排到最后、用序号兜底）→ 重放同一份 rollout 时顺序稳定 ⇒ usage_id 幂等
  const at = (e) => (e.time === null ? Number.POSITIVE_INFINITY : e.time);
  events.sort((a, b) => at(a) - at(b) || a.order - b.order || a.skill_id.localeCompare(b.skill_id));

  const seenOrdinal = new Map();
  const eventOrdinalByTurn = new Map();
  const out = [];
  for (const ev of events) {
    const ordinal = seenOrdinal.get(ev.skill_id) || 0;
    seenOrdinal.set(ev.skill_id, ordinal + 1);
    const turn = findTurnForEvent(ev, turns);
    const turnKey = turn ? turn.turn_id : '__unassigned__';
    const eventOrdinal = (eventOrdinalByTurn.get(turnKey) || 0) + 1;
    eventOrdinalByTurn.set(turnKey, eventOrdinal);
    const stamp = ev.time === null ? fallbackStart : isoOfMs(ev.time);
    out.push({
      conversation_id: conversationId,
      turn_id: turn ? turn.turn_id : null,
      provider_turn_id: turn ? turn.provider_turn_id : null,
      turn_ordinal: turn ? turn.ordinal : null,
      event_ordinal: eventOrdinal,
      date: CS.dateOf(stamp) || date,
      agent: 'codex',
      source: 'codex',
      skill_id: ev.skill_id,
      skill_name: ev.skill_id,
      skill_version: null,
      start_time: stamp,
      end_time: stamp,
      ordinal,
      // —— 消耗：Codex 侧不可精确归因，一律 null（不估算、不摊派）——
      skill_token: null,
      token_source: 'unavailable',
      call_request_id: null,
      call_request_total_token: null,
      load_chars: null,
      status: 'completed',
      trigger_type: ev.trigger_type,
      evidence: ev.evidence,
    });
  }
  return out;
}

function collectConversation(sessionId, opts) {
  const o = opts || {};
  const codexHome = resolveCodexHome(o);
  const config = o.config || {};
  const threadRow = readThreadRow(codexHome, sessionId);
  const selection = listSessionRollouts(codexHome, sessionId, threadRow);
  if (!selection.primary) return null;
  const merged = mergeRolloutLineage(selection);
  if (!merged) return null;

  const file = merged.primary.info.file;
  const parsed = merged.primary.parsed;
  const meta = parsed.session_meta || {};
  const primaryMetaMs = metaTimeMs(meta, merged.primary.info.mtime_ms);
  const startMs =
    merged.start_ms ||
    Number(threadRow && threadRow.created_at_ms) ||
    primaryMetaMs ||
    Number(threadRow && Number(threadRow.created_at) * 1000) ||
    null;
  const endMs = merged.end_ms || Number(threadRow && threadRow.updated_at_ms) || startMs;
  const startTime = isoOfMs(startMs);
  const endTime = isoOfMs(endMs);
  const date =
    CS.dateOf(startTime) || CS.dateOf(endTime) || (o.date ? CS.assertDate(o.date) : C.today());

  let usage = merged.usage;
  let usageSource = usage ? 'rollout_thread_token_usage' : null;
  const threadTokens = Number(threadRow && threadRow.tokens_used);
  if (!usage && Number.isFinite(threadTokens) && threadTokens > 0) {
    usage = { total_tokens: threadTokens };
    usageSource = 'threads.tokens_used';
  }
  const modelName =
    (threadRow && threadRow.model && String(threadRow.model)) ||
    (meta.model && String(meta.model)) ||
    CS.UNAVAILABLE;
  const missing = [];
  if (!startTime) missing.push('start_time');
  if (!endTime) missing.push('end_time');
  if (!usage) missing.push('total_token');
  if (modelName === CS.UNAVAILABLE) missing.push('model_name');

  const cwd = (merged.cwd || (threadRow && threadRow.cwd) || null);
  const project = PR.resolveProjectContext(
    {
      codexProjectId: threadRow && threadRow.project_id,
      codexSessionId: sessionId,
      cwd,
    },
    {
      config,
      dir: o.dir,
      cache: o.projectCache,
      codexResolver: (src) =>
        CPR.resolveCodexProject(Object.assign({}, src, { threadRow }), { codexHome }),
      cwdResolver: (dir0) => C.projectFromCwd(dir0, { config, hostProjects: o.hostProjects }),
    }
  );

  const status =
    threadRow && Number(threadRow.archived) === 1
      ? 'archived'
      : merged.task_complete > 0 && merged.task_complete >= merged.task_started
        ? 'completed'
        : merged.task_started > 0
          ? 'working'
          : 'unknown';

  const conversationId = CS.makeConversationId(date, sessionId);
  const turns = (merged.turns || []).map((turn, index) => {
    const turnStart = isoOfMs(turn.start_ms) || startTime;
    const turnEnd = isoOfMs(turn.end_ms) || turnStart || endTime;
    const turnDate = CS.dateOf(turnStart) || date;
    const usage = turn.usage || null;
    const turnId = CS.makeTurnId(
      turnDate,
      conversationId,
      turn.provider_turn_id,
      index,
      turnStart
    );
    return {
      date: turnDate,
      turn_id: turnId,
      conversation_id: conversationId,
      provider_turn_id: turn.provider_turn_id,
      ordinal: index,
      start_time: turnStart,
      end_time: turnEnd,
      request_count: Number.isFinite(turn.request_count) ? turn.request_count : 0,
      request_ids: Array.isArray(turn.request_ids) ? turn.request_ids : [],
      total_token: usage ? numOrNull(usage.total_tokens) : CS.NA,
      input_token: usage ? numOrNull(usage.input_tokens) : CS.NA,
      output_token: usage ? numOrNull(usage.output_tokens) : CS.NA,
      cached_token: usage ? numOrNull(usage.cached_input_tokens) : CS.NA,
      reasoning_token: usage ? numOrNull(usage.reasoning_output_tokens) : CS.NA,
      token_source: usage ? 'turn_usage' : 'unavailable',
      status: turn.status || 'unknown',
      source: 'codex',
      model: modelName === CS.UNAVAILABLE ? null : modelName,
      start_ms: turn.start_ms,
      end_ms: turn.end_ms,
      start_ordinal: turn.start_ordinal,
      end_ordinal: turn.end_ordinal,
    };
  });
  const conversation = {
    date,
    conversation_id: conversationId,
    session_id: String(sessionId),
    source: 'codex',
    agent: 'codex',
    model_name: modelName === CS.UNAVAILABLE ? null : modelName,
    models: modelName === CS.UNAVAILABLE ? [] : [modelName],
    start_time: startTime,
    end_time: endTime,
    status,
    settlement_status: missing.length ? 'partial' : 'settled',
    total_token: usage ? numOrNull(usage.total_tokens) : CS.NA,
    input_token: usage ? numOrNull(usage.input_tokens) : CS.NA,
    output_token: usage ? numOrNull(usage.output_tokens) : CS.NA,
    cached_token: usage ? numOrNull(usage.cached_input_tokens) : CS.NA,
    reasoning_token: usage ? numOrNull(usage.reasoning_output_tokens) : CS.NA,
    total_score: 0,
    score_source: 'not_applicable',
    score_request_count: 0,
    project: project.project_name,
    project_id: project.project_id,
    project_source: project.project_source,
    project_confidence: project.project_confidence,
    workspace: cwd,
    title: threadRow && (threadRow.title || threadRow.name) ? String(threadRow.title || threadRow.name) : null,
    turn_count: turns.length,
    request_count: merged.request_ids.size,
    skill_invocation_count: 0,
    distinct_skill_count: null,
    skill_count: 0,
    missing_fields: missing,
    parser_version: PARSER_VERSION,
  };

  // V3.6 起从用户输入识别显式 Skill 引用；V3.22 起并入「真实载入 SKILL.md」的证据
  const skillUsages = buildSkillUsages(
    merged.prompts,
    merged.tool_calls,
    turns,
    conversation.conversation_id,
    date,
    conversation.start_time
  );
  // 口径与 WorkBuddy 侧、data-schema §1 一致：skill_count = 该对话的 Skill **调用次数**
  // （= Skill Usage Log 条数）。此前这里写的是「去重后的技能数」，会被 validate-log
  // 的交叉核对判为不一致（V3.22 修正）。
  conversation.skill_count = skillUsages.length;
  conversation.skill_invocation_count = skillUsages.length;
  conversation.distinct_skill_count = new Set(skillUsages.map((s) => s.skill_id)).size;

  const sourceFiles = merged.lineage.map((entry) => entry.item.info.file);
  const notes = [];
  if (selection.internal.length) {
    notes.push(
      `已隔离 ${selection.internal.length} 个 Codex 内部子线程 rollout，不作为用户问答或 Conversation 总账。`
    );
  }
  if (merged.ignored.length) {
    notes.push(
      `已忽略 ${merged.ignored.length} 个不属于主分片历史链的重复回放/分支 rollout。`
    );
  }
  if (selection.canonical_file && fileKey(selection.canonical_file) === fileKey(file)) {
    notes.push('主分片来自 state_5.sqlite.threads.rollout_path。');
  } else if (selection.canonical_file) {
    notes.push(
      `state_5.sqlite.threads.rollout_path 未指向可读的主分片，已回退到最新用户 rollout：${file}`
    );
  }

  return {
    conversation,
    turns,
    skill_usages: skillUsages,
    prompts: merged.prompts,
    diagnostics: {
      missing_fields: missing,
      notes,
      source_files: sourceFiles,
    },
    raw: {
      session_id: String(sessionId),
      session_meta: meta,
      thread_row: threadRow || null,
      canonical_file: selection.canonical_file || null,
      primary_file: file,
      rollout_files: merged.lineage.map((entry) => ({
        file: entry.item.info.file,
        thread_source: entry.item.thread_source,
        first_ordinal: entry.item.parsed.min_ordinal,
        last_ordinal: entry.item.parsed.max_ordinal,
        cutoff_ordinal: Number.isFinite(entry.cutoff) ? entry.cutoff : null,
      })),
      ignored_user_rollouts: merged.ignored,
      internal_rollouts: selection.internal.map((item) => ({
        file: item.file,
        thread_source: item.thread_source,
        reason: 'thread_source != user，不作为用户问答',
      })),
      token_usage: usage || null,
      token_usage_source: usageSource,
      turns,
      prompts: merged.prompts,
      source_files: sourceFiles,
      notes,
      collected_at: C.nowIso(),
    },
  };
}

module.exports = {
  PARSER_VERSION,
  resolveCodexHome,
  listRolloutFiles,
  findCodexSessionFile,
  readSessionMeta,
  readThreadRow,
  parseRollout,
  listRecentSessions,
  collectConversation,
  hhmmOfMs,
};
