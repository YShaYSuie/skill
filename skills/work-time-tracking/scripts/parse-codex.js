#!/usr/bin/env node
'use strict';
/**
 * parse-codex.js — Codex rollout 数据源只读体检。
 *
 * 用法：
 *   node scripts/parse-codex.js --doctor
 *   node scripts/parse-codex.js --session <id>
 *   node scripts/parse-codex.js --latest 10
 */

const C = require('./lib/log-core');
const CodexCP = require('./lib/codex-conversation-parser');

function run() {
  const { flags } = C.parseArgs(process.argv.slice(2));
  const codexHome = CodexCP.resolveCodexHome({
    codexHome: C.flagStr(flags, 'codex-home'),
  });
  const sessionId = C.flagStr(flags, 'session');

  if (C.flagBool(flags, 'doctor')) {
    const files = CodexCP.listRolloutFiles(codexHome);
    const latest = files.slice(0, 5).map((f) => {
      const meta = CodexCP.readSessionMeta(f.file);
      return {
        session_id: meta && meta.session_id ? String(meta.session_id) : null,
        file: f.file,
        mtime: new Date(f.mtime_ms).toISOString(),
      };
    });
    return {
      action: 'doctor',
      codex_home: codexHome,
      sessions_dir: require('path').join(codexHome, 'sessions'),
      rollout_files: files.length,
      latest,
      parser_version: CodexCP.PARSER_VERSION,
      notes: [
        'Codex 不提供会话级 Credit；total_score 一律 null + score_source=unavailable。',
        'Codex rollout 当前不暴露可归因的 Skill 载入体积；skill_token 不做估算。',
      ],
    };
  }

  if (sessionId) {
    const collected = CodexCP.collectConversation(sessionId, { codexHome });
    if (!collected) {
      throw new C.LogError(`未找到 Codex 会话：${sessionId}`, 7);
    }
    return {
      action: 'session',
      codex_home: codexHome,
      conversation: collected.conversation,
      prompt_count: collected.prompts.length,
      source_files: collected.diagnostics.source_files,
    };
  }

  const limit = C.flagNum(flags, 'latest') || 20;
  return {
    action: 'latest',
    codex_home: codexHome,
    sessions: CodexCP.listRecentSessions(codexHome, limit),
  };
}

C.runMain(() => {
  const out = run();
  if (!C.flagBool(C.parseArgs(process.argv.slice(2)).flags, 'quiet')) C.emit(out);
  return C.EXIT.OK;
});
