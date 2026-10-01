#!/usr/bin/env node
'use strict';
/**
 * parse-workbuddy.js — WorkBuddy 本地数据的**解析入口与体检工具**（用户 §五/§二十六）。
 *
 * ## 定位
 *
 * 真正的解析逻辑在 `lib/conversation-parser.js`（被 `settle-conversation.js` 复用）。
 * 本脚本是它的 **CLI 入口**，专门用于「看数据源到底能用什么」这类排查场景 ——
 * 不重复实现任何解析逻辑。
 *
 * ```bash
 * parse-workbuddy.js --doctor          # 体检：数据源是否可用、各能取到多少
 * parse-workbuddy.js --list            # 列出最近会话（含 JSONL 是否找到）
 * parse-workbuddy.js --session <id>    # 预演一次解析（**不写任何文件**）
 * ```
 *
 * 什么时候用它：
 *
 * ```text
 * 结算结果里 total_token = null         → --session <id> 看是 JSONL 没找到还是 usage 缺失
 * Score 一直是 null                     → --doctor 看 session_usage / credit_json 是否有数据
 * 不确定某个会话属于哪个 Agent / Model   → --session <id>
 * ```
 *
 * **本脚本只读**：不写日志、不写快照、不改任何状态。
 */

const C = require('./lib/log-core');
const CP = require('./lib/conversation-parser');
const CS = require('./lib/conversation-store');

const USAGE = `parse-workbuddy.js — WorkBuddy 数据源解析与体检（只读）

  --doctor                体检数据源（workbuddy.db / projects / node:sqlite / 覆盖量）
  --list                  列出最近会话（标注能否找到 JSONL 与 USAGE）
  --limit <n>             --list 的条数（默认 20）
  --session <id>          预演解析指定会话（不写任何文件）
  --json                  输出 JSON
  --home <路径>           WorkBuddy 数据目录（默认 ~/.workbuddy）
`;

/* ------------------------------------------------------------------ *
 * 体检
 * ------------------------------------------------------------------ */

function doctor(home) {
  const fs = require('fs');
  const path = require('path');
  const out = {
    action: 'doctor',
    workbuddy_home: home,
    home_exists: fs.existsSync(home),
    db: { path: path.join(home, 'workbuddy.db'), exists: false, readable: false, sessions: null, session_usage: null },
    projects_dir: { path: path.join(home, 'projects'), exists: false, slug_count: 0, jsonl_count: 0 },
    node_sqlite: false,
    data_sources: {},
    verdict: [],
  };

  try {
    require('node:sqlite');
    out.node_sqlite = true;
  } catch (e) {
    out.node_sqlite = false;
  }

  out.db.exists = fs.existsSync(out.db.path);
  if (out.db.exists && out.node_sqlite) {
    const db = CP.openDb(home);
    if (db) {
      out.db.readable = true;
      try {
        out.db.sessions = db.prepare('SELECT COUNT(*) c FROM sessions').get().c;
      } catch (e) {
        out.db.sessions = null;
      }
      try {
        out.db.session_usage = db.prepare('SELECT COUNT(*) c FROM session_usage').get().c;
      } catch (e) {
        out.db.session_usage = null;
      }
      try {
        db.close();
      } catch (e) {
        /* 忽略 */
      }
    }
  }

  const pd = out.projects_dir.path;
  out.projects_dir.exists = fs.existsSync(pd);
  if (out.projects_dir.exists) {
    const slugs = fs.readdirSync(pd, { withFileTypes: true }).filter((e) => e.isDirectory());
    out.projects_dir.slug_count = slugs.length;
    let n = 0;
    for (const s of slugs) {
      try {
        n += fs.readdirSync(path.join(pd, s.name)).filter((f) => f.endsWith('.jsonl')).length;
      } catch (e) {
        /* 忽略 */
      }
    }
    out.projects_dir.jsonl_count = n;
  }

  out.data_sources = {
    conversation_id: '由 session_id 派生（sessions.id / Hook 入参）',
    agent: 'sessions.expert_runtime_identity → sessions.mode → JSONL providerData.agent',
    model: 'sessions.model → JSONL providerData.requestModelName',
    start_end_time: 'sessions.created_at / last_activity_at，用 JSONL 时间戳校正',
    total_token: 'JSONL providerData.usage（按 conversationRequestId 去重后求和）',
    total_score: 'workbuddy.db session_usage.credit_json（按 requestId 求和，**仅覆盖部分请求**）',
    skills: 'JSONL function_call[name=Skill] + callId 关联的返回文本',
    skill_token: 'A 口径：Skill 载入体积（返回字符 × 系数）；拿不到写 null',
  };

  if (!out.db.exists) out.verdict.push('未找到 workbuddy.db：Token 与 Score 都取不到，只能靠 JSONL。');
  if (out.db.exists && !out.node_sqlite) out.verdict.push('node:sqlite 不可用：无法读取 SQLite，Score 与会话元信息取不到。');
  if (out.db.exists && out.db.session_usage === 0) {
    out.verdict.push('session_usage 表为空：所有对话的 total_score 都会是 null（宿主尚未落积分记录）。');
  }
  if (!out.projects_dir.exists || !out.projects_dir.jsonl_count) {
    out.verdict.push('projects/ 下没有会话 JSONL：无法解析 Token 与 Skill。');
  }
  if (!out.verdict.length) out.verdict.push('数据源齐备，可以正常结算。');
  return out;
}

/* ------------------------------------------------------------------ *
 * 列出会话
 * ------------------------------------------------------------------ */

function listSessions(home, limit) {
  const rows = CP.listRecentSessions(home, limit);
  return {
    action: 'list_sessions',
    workbuddy_home: home,
    count: rows.length,
    sessions: rows.map((r) => {
      const file = CP.findSessionFile(home, r.id);
      const usage = CP.readSessionUsage(home, r.id);
      return {
        session_id: r.id,
        title: r.title || null,
        status: r.status || null,
        cwd: r.cwd || null,
        last_activity_at: r.last_activity_at || r.updated_at || null,
        jsonl_found: Boolean(file),
        jsonl: file || null,
        credit_records: usage.credit_count,
        credit_total: usage.credit_total,
      };
    }),
  };
}

/* ------------------------------------------------------------------ *
 * 预演解析
 * ------------------------------------------------------------------ */

function preview(home, sessionId, config, dir) {
  const collected = CP.collectConversation(sessionId, { home, config, dir });
  return {
    action: 'preview',
    session_id: String(sessionId),
    // 只读展示：结构就是将要写入 Structured Logs 的形状
    conversation: collected.conversation,
    skill_usages: collected.skill_usages,
    prompt_count: collected.prompts.length,
    diagnostics: collected.diagnostics,
    note: '预演只读：未写入任何日志、未生成快照。真正结算请用 settle-conversation.js。',
  };
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

C.runMain(() => {
  const { pos, flags } = C.parseArgs(process.argv.slice(2));
  if (pos[0] === 'help') {
    C.emitText(USAGE);
    return C.EXIT.OK;
  }

  const home = CP.resolveHome({ home: C.flagStr(flags, 'home') });
  const asJson = C.flagBool(flags, 'json');
  const sessionId = C.flagStr(flags, 'session');

  let result;
  if (C.flagBool(flags, 'doctor')) {
    result = doctor(home);
  } else if (C.flagBool(flags, 'list') || sessionId === null) {
    result = listSessions(home, C.flagNum(flags, 'limit') || 20);
  } else {
    // config 只用于 skill_token_method / token_per_char；
    // 日志目录未初始化时仍允许预演（回落默认口径），不影响读 WorkBuddy 数据。
    let config = {};
    let dir = null;
    try {
      dir = C.resolveDir(C.flagStr(flags, 'dir'));
      config = C.readConfig(dir);
    } catch (e) {
      config = {};
      dir = null;
    }
    result = preview(home, sessionId, config, dir);
  }

  if (asJson) {
    C.emit(result);
    return C.EXIT.OK;
  }

  if (result.action === 'doctor') {
    const L = [
      'WorkBuddy 数据源体检',
      '─'.repeat(24),
      `数据目录：${result.workbuddy_home}${result.home_exists ? '' : '（不存在）'}`,
      `workbuddy.db：${result.db.exists ? (result.db.readable ? '可读' : '存在但不可读') : '缺失'}` +
        `　sessions=${result.db.sessions === null ? '不可用' : result.db.sessions}` +
        `　session_usage=${result.db.session_usage === null ? '不可用' : result.db.session_usage}`,
      `projects/：${result.projects_dir.exists ? `${result.projects_dir.slug_count} 个工作区 / ${result.projects_dir.jsonl_count} 个会话文件` : '缺失'}`,
      `node:sqlite：${result.node_sqlite ? '可用' : '不可用'}`,
      '',
      '可解析的数据：',
    ];
    for (const [k, v] of Object.entries(result.data_sources)) L.push(`  ${k}：${v}`);
    L.push('');
    L.push('结论：');
    result.verdict.forEach((v) => L.push(`  - ${v}`));
    C.emitText(L.join('\n'));
    return C.EXIT.OK;
  }

  if (result.action === 'list_sessions') {
    const L = [`最近 ${result.count} 个会话：`, ''];
    result.sessions.forEach((s) => {
      L.push(
        `  ${s.session_id.slice(0, 8)}　${s.jsonl_found ? 'JSONL✓' : 'JSONL✗'}` +
          `　积分 ${s.credit_total === null ? 'null' : s.credit_total}（${s.credit_records} 条）` +
          `　${s.title || '（无标题）'}`
      );
    });
    C.emitText(L.join('\n'));
    return C.EXIT.OK;
  }

  // preview
  const c = result.conversation;
  const L = [
    `会话解析预演：${result.session_id}`,
    '─'.repeat(24),
    `conversation_id : ${c.conversation_id}`,
    `agent / model   : ${c.agent} / ${c.model_name}`,
    `时间            : ${c.start_time} → ${c.end_time}（${c.duration_seconds === null ? 'null' : c.duration_seconds + 's'}）`,
    `Token           : total=${c.total_token} in=${c.input_token} out=${c.output_token} cached=${c.cached_token}`,
    `Score           : ${c.total_score}（来源 ${c.score_source}，覆盖 ${c.score_request_count}/${c.request_count} 请求）`,
    `结算状态        : ${c.settlement_status}（宿主状态 ${c.status}）` +
      (c.missing_fields.length ? `　缺失：${c.missing_fields.join('、')}` : ''),
    '',
    `Skill 调用 ${result.skill_usages.length} 次：`,
  ];
  result.skill_usages.forEach((s) => {
    L.push(
      `  - ${s.skill_id}@${s.skill_version}　token=${s.skill_token}（${s.token_source}）` +
        `　${s.status}　请求用量 ${s.call_request_total_token}`
    );
  });
  if (result.diagnostics.notes.length) {
    L.push('', '诊断：');
    result.diagnostics.notes.forEach((n) => L.push(`  - ${n}`));
  }
  L.push('', result.note);
  C.emitText(L.join('\n'));
  return C.EXIT.OK;
});
