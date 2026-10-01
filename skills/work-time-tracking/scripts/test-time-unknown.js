#!/usr/bin/env node
'use strict';
/**
 * test-time-unknown.js — 「已完成 · 时间未知」（§14 扩展）回归测试。
 *
 * 该状态容易写错：既可能把「漏填时间」当成合法完成（放宽过度），
 * 也可能把「确实完成但没时长」判为非法（放宽不足）。因此用**正反用例**锁定边界。
 *
 *   node scripts/test-time-unknown.js
 *
 * 退出码 0 = 全部通过；1 = 存在偏差。**只在临时目录写入，不碰真实日志**。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const NODE = process.execPath;
const SCRIPTS = __dirname;

let fail = 0;
const ok = (desc, cond, extra) => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? '✔' : '✘'}  ${desc}${extra && !cond ? '  → ' + extra : ''}`);
};

/** 在临时目录造一份日志并跑校验，返回 problems */
function validate(recordPatch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-tu-'));
  fs.mkdirSync(path.join(dir, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ project_map: {} }, null, 2), 'utf8');
  const rec = Object.assign(
    {
      id: 'WI-20260101-AAAA1111',
      date: '2026-01-01',
      project_name: '云浮门户',
      project_confidence: 'high',
      work_type: '需求梳理',
      work_type_confidence: 'medium',
      content: '需求文档梳理',
      display_content: '【云浮门户】【需求梳理】需求文档梳理',
      start_time: null,
      end_time: null,
      estimated_duration: null,
      actual_duration: null,
      status: 'completed',
      source: 'workbuddy',
      confidence: 'medium',
      time_segments: [],
      activities: [],
      parent_id: null,
      tags: [],
      notes: '',
    },
    recordPatch
  );
  fs.writeFileSync(
    path.join(dir, 'current.json'),
    JSON.stringify({ date: '2026-01-01', timezone: '+08:00', version: 1, records: [rec], pending_items: [] }, null, 2),
    'utf8'
  );
  let out = '';
  try {
    out = execFileSync(NODE, [path.join(SCRIPTS, 'validate-log.js'), '--dir', dir], { encoding: 'utf8' });
  } catch (e) {
    out = (e.stdout && String(e.stdout)) || '{}';
  }
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    return JSON.parse(out).problems || [];
  } catch (e) {
    return ['（校验输出无法解析）'];
  }
}

/** 只保留与该 WorkItem 相关的校验问题（忽略 manifest / 日期等全局检查） */
function recordProblems(list) {
  return list.filter((p) => /WI-20260101-AAAA1111|time_unknown|start_time|WorkItem/.test(String(p)));
}

console.log('=== 应判为「合法」 ===');
{
  const p = recordProblems(validate({ status: 'completed', time_unknown: true }));
  ok('completed + time_unknown + 时间全空', p.length === 0, JSON.stringify(p));
}
{
  const p = recordProblems(validate({ status: 'needs_confirmation', time_unknown: false }));
  ok('needs_confirmation + 无时间（原规则不变）', p.length === 0, JSON.stringify(p));
}

console.log();
console.log('=== 应判为「非法」 ===');
{
  const p = recordProblems(validate({ status: 'completed', time_unknown: false }));
  ok('completed + 无时间 + 未标记 time_unknown → 报错', p.length > 0, '未被拦截');
}
{
  const p = recordProblems(validate({ status: 'completed', time_unknown: true, start_time: '10:00' }));
  ok('time_unknown 却带 start_time → 报错', p.length > 0, '未被拦截');
}
{
  const p = recordProblems(validate({ status: 'completed', time_unknown: true, actual_duration: 30 }));
  ok('time_unknown 却带 actual_duration → 报错', p.length > 0, '未被拦截');
}
{
  const p = recordProblems(validate({ status: 'in_progress', time_unknown: true }));
  ok('time_unknown 却不属于 completed/cancelled → 报错', p.length > 0, '未被拦截');
}

console.log();
console.log('=== 真实日志自检 ===');
{
  const real = 'D:/WorkTimeLog';
  if (fs.existsSync(path.join(real, 'current.json'))) {
    let r = null;
    try {
      r = JSON.parse(execFileSync(NODE, [path.join(SCRIPTS, 'validate-log.js'), '--dir', real], { encoding: 'utf8' }));
    } catch (e) {
      r = null;
    }
    const good = r && r.ok === true;
    ok('真实日志 validate ok', good, r ? JSON.stringify(r.problems) : '无法读取');
    if (r) {
      const n = (r.checks || []).length;
      console.log(`       ${n} 项检查通过`);
    }
  } else {
    console.log('  （跳过：未找到真实日志）');
  }
}

console.log();
console.log(fail === 0 ? '✓ 全部通过' : `✗ 存在 ${fail} 处偏差`);
process.exit(fail === 0 ? 0 : 1);
