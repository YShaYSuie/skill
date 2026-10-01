'use strict';
/**
 * adapters/generic/index.js — 通用宿主 / 手动适配层（§41/§42）。
 *
 * 用于：
 *   1. 未提供专用适配器的其他 AI 工具（source=generic）；
 *   2. 用户手动命令与自然语言记录（source=manual）。
 *
 * 宿主能力不足时（不支持 Hook / 事件回调），Skill 无法凭空获得该工具的实时活动（§42），
 * 此时只能走手动触发。本适配器是能力降级链路的最后一环。
 */

const path = require('path');
const C = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'log-core'));

/** 用户自然语言前缀 → 意图（§5/§6） */
const NORMALIZE = [
  { re: /^(?:开始记录|开始|start)[:：\s]*/, intent: 'start' },
  { re: /^(?:继续|恢复|resume)[:：\s]*/, intent: 'resume' },
  { re: /^(?:暂停|pause)[:：\s]*/, intent: 'pause' },
  { re: /^(?:完成|结束|done)[:：\s]*/, intent: 'done' },
  { re: /^(?:记录|补录|log)[:：\s]*/, intent: 'log' },
];

const INTENT_MAP = {
  start: 'manual_input',
  resume: 'manual_input',
  pause: 'manual_input',
  done: 'manual_input',
  log: 'manual_input',
};

/** 去掉命令前缀，只留事项内容（时间范围由调用方解析） */
function extractContent(input) {
  let text = String((input && input.content) || '').trim();
  for (const n of NORMALIZE) {
    if (n.re.test(text)) {
      text = text.replace(n.re, '').trim();
      break;
    }
  }
  return text.replace(/^[/／]\w+\s*/, '').trim();
}

function detectIntent(input) {
  const text = String((input && input.content) || '');
  if (/^(?:暂停|pause)/.test(text) || /^\/pause/.test(text)) return 'pause';
  if (/^(?:继续|恢复|resume)/.test(text) || /^\/resume/.test(text)) return 'resume';
  if (/^(?:完成|结束|done)/.test(text) || /^\/done/.test(text)) return 'done';
  if (/^(?:记录|补录|log)/.test(text) || /^\/log/.test(text)) return 'log';
  if (/^(?:开始记录|开始|start)/.test(text) || /^\/start/.test(text)) return 'start';
  return 'record';
}

/**
 * @param {object} input { content, source?, timestamp?, session_id?, event?, event_type? }
 * @returns {object} 统一 Activity
 */
function toActivity(input) {
  const i = input || {};
  const intent = detectIntent(i);
  const source = C.VALID_SOURCE.includes(i.source) ? i.source : 'manual';
  const ts = i.timestamp || C.nowIso();
  const eventType =
    i.event_type || (intent === 'record' ? 'manual_input' : INTENT_MAP[intent] || 'manual_input');
  return {
    id: i.activity_id || C.makeActivityId(),
    timestamp: ts,
    time: C.fmtHHMM(C.toMinutes(ts) === null ? C.nowMinutes() : C.toMinutes(ts)),
    source,
    event_type: eventType,
    content: String(i.content === undefined ? '' : extractContent(i)),
    session_id: i.session_id || null,
    metadata: i.metadata || {},
    intent,
  };
}

module.exports = {
  host: 'generic',
  tool: 'generic',
  defaultMechanism: 'manual',
  NORMALIZE,
  extractContent,
  detectIntent,
  toActivity,
};
