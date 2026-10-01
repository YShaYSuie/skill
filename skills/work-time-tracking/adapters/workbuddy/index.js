'use strict';
/**
 * adapters/workbuddy/index.js — WorkBuddy 宿主适配层（§41）。
 *
 * WorkBuddy 若提供 Skill 事件 / Script / Hook / 生命周期事件 / 自动化接口，
 * 通过本适配器统一转换为 Activity；若宿主能力不足（§42），
 * 应登记 mechanism=unavailable 并由 /status 如实显示，**不得声称已实现完全自动记录**。
 */

const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'log-core'));

const EVENT_MAP = {
  session_start: 'session_start',
  session_end: 'session_end',
  user_interaction: 'user_interaction',
  prompt: 'user_interaction',
  tool_activity: 'tool_activity',
  tool: 'tool_activity',
  tool_result: 'tool_activity',
  file_operation: 'file_operation',
  file: 'file_operation',
  command: 'command',
  manual_input: 'manual_input',
  interrupt: 'interrupt',
};

function extractContent(payload) {
  const p = payload || {};
  if (p.tool) {
    const target = p.file_path || p.path;
    return target ? `${p.tool}：${path.basename(String(target))}` : String(p.tool);
  }
  return p.prompt || p.content || p.message || p.summary || p.text || '';
}

function toActivity(input) {
  const i = input || {};
  const rawEvent = i.event || i.event_type || 'user_interaction';
  const eventType = EVENT_MAP[rawEvent] || 'user_interaction';
  const ts = i.timestamp || C.nowIso();
  return {
    id: i.activity_id || C.makeActivityId(),
    timestamp: ts,
    time: C.fmtHHMM(C.toMinutes(ts) === null ? C.nowMinutes() : C.toMinutes(ts)),
    source: 'workbuddy',
    event_type: eventType,
    content: String(i.content || extractContent(i.payload) || '').trim(),
    session_id: i.session_id || (i.payload && i.payload.session_id) || null,
    metadata: i.metadata || {},
    event: rawEvent,
  };
}

module.exports = {
  host: 'workbuddy',
  tool: 'workbuddy',
  defaultMechanism: 'skill',
  EVENT_MAP,
  extractContent,
  toActivity,
};
