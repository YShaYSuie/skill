'use strict';
/**
 * adapters/codex/index.js — Codex 宿主适配层（§41）。
 *
 * 职责：把 Codex 宿主的 Hook / Event 统一转换为 Skill 内部的 Activity 结构。
 * Skill 核心逻辑不依赖具体宿主（§41），只依赖这里产出的统一格式。
 *
 * 只做结构转换，不做采集范围判断 —— Security Filter 由 collect-activity.js 统一执行（§12）。
 */

const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'log-core'));

/**
 * §3.1 事件 → §11.1 event_type 映射。
 * ToolResult / FileOperation / Command 归入 tool_activity / file_operation / command。
 */
const HOOK_MAP = {
  SessionStart: 'session_start',
  UserPromptSubmit: 'user_interaction',
  PostToolUse: 'tool_activity',
  ToolResult: 'tool_activity',
  ToolUse: 'tool_activity',
  FileOperation: 'file_operation',
  Command: 'command',
  Stop: 'tool_activity',
  SessionEnd: 'session_end',
  Interrupt: 'interrupt',
};

/** 从 Hook 载荷中提取可用于识别 WorkItem 的内容摘要来源 */
function extractContent(payload) {
  const p = payload || {};
  const tool = p.tool_name || p.tool || (p.tool_input && p.tool_input.name);
  if (tool) {
    const target = p.file_path || (p.tool_input && (p.tool_input.file_path || p.tool_input.path));
    return target ? `${tool}：${path.basename(String(target))}` : String(tool);
  }
  return p.prompt || p.content || p.message || p.summary || p.text || '';
}

/**
 * @param {object} input { hook|event, payload, timestamp, session_id, content, activity_id }
 * @returns {object} 统一 Activity（§11.1）
 */
function toActivity(input) {
  const i = input || {};
  const hook = i.hook || i.event || 'UserPromptSubmit';
  const eventType = HOOK_MAP[hook] || 'tool_activity';
  const ts = i.timestamp || C.nowIso();
  return {
    id: i.activity_id || C.makeActivityId(),
    timestamp: ts,
    time: C.fmtHHMM(C.toMinutes(ts) === null ? C.nowMinutes() : C.toMinutes(ts)),
    source: 'codex',
    event_type: eventType,
    content: String(i.content || extractContent(i.payload) || '').trim(),
    session_id: i.session_id || (i.payload && i.payload.session_id) || null,
    metadata: i.metadata || {},
    hook,
  };
}

module.exports = {
  host: 'codex',
  tool: 'codex',
  defaultMechanism: 'hooks',
  HOOK_MAP,
  extractContent,
  toActivity,
};
