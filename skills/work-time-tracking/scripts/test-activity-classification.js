#!/usr/bin/env node
'use strict';
/**
 * test-activity-classification.js — 事项四分类与「工作/日常」时长分离的回归测试。
 *
 * ## 背景（用户 2026-09-21 明确的三条口径）
 *
 * ```text
 * ① 我不止记录工作，也会记录运动等日常活动
 * ② 同项目、同类型的事项可以合并，总结日程即可，不用把细节都写出来
 * ③ AI 自动记录的都是工作或学习；不是所有事项都必须关联项目，
 *    项目允许为空 —— 但事项总结要贴合我的角色
 *    （「skill 对我来说不是开发，而是一种探索学习」）
 * ```
 *
 * 因此事项被归入四类，且**工作与日常活动的时长必须分开统计** ——
 * 混在一起会让工时虚高（把散步算成工作）。
 *
 * 运行：`node scripts/test-activity-classification.js`；退出码非 0 = 存在偏差。
 */

const assert = require('assert');
const path = require('path');

const RP = require(path.join(__dirname, 'lib', 'role-profile'));

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (e) {
    failed += 1;
    failures.push({ name, error: String((e && e.message) || e) });
    process.stdout.write(`  ✗ ${name}\n      ${String((e && e.message) || e).split('\n')[0]}\n`);
  }
}
const section = (t) => process.stdout.write(`\n${t}\n`);

process.stdout.write('test-activity-classification.js — 事项四分类回归测试\n');

/* ---------------- 1. 四分类 ---------------- */
section('1. 四分类：产品工作 / 探索学习 / 日常活动 / 其他');

const CASES = [
  // 日常活动（运动、生活）—— 必须优先于其它规则
  [{ content: '肩背拉伸瑜伽' }, 'daily', '运动 → 日常活动'],
  [{ content: '散步', project_name: '运动计划' }, 'daily', '运动计划项目也算日常活动'],
  [{ content: '去健身房锻炼', project_name: '运动计划' }, 'daily', '健身 → 日常活动'],
  // 探索学习（技能 / 工具 / MCP / 调研）
  [{ content: '完成每日日程Skill的搭建' }, 'exploration', 'skill 建设 → 探索学习'],
  [{ content: '创建原型版本发布 skill' }, 'exploration', '技能 → 探索学习（不是开发）'],
  [
    { content: '调整 manage-skills 的 Skill 存放路径', project_name: '技能库管理' },
    'exploration',
    '技能库 → 探索学习',
  ],
  [
    { content: '参考 GitHub MCP 设计本地 GitLab MCP', project_name: 'GitLab MCP' },
    'exploration',
    'MCP → 探索学习',
  ],
  [{ content: '调研新工具的可行性' }, 'exploration', '调研 → 探索学习'],
  // 产品工作
  [{ content: '考核模块状态机设计', project_name: '粤企知' }, 'product', '有产品项目 → 产品工作'],
  [
    { content: '需求文档梳理', project_name: '云浮门户', work_type: '需求梳理' },
    'product',
    '产品线项目 → 产品工作',
  ],
  [
    { content: '运行 browser-verify.js 校验原型', project_name: '气象数据' },
    'product',
    '含「脚本」字样的产品验证不得误判为工具建设',
  ],
  // 其他
  [{ content: '未知事项', work_type: '其他' }, 'unclassified', '无信号 → 其他工作'],
];

check('12 个分类用例全部符合预期', () => {
  const bad = [];
  for (const [rec, want, desc] of CASES) {
    const got = RP.classifyRecord(rec);
    if (got !== want) bad.push(`${desc}：期望 ${want}，实际 ${got}`);
  }
  assert.deepStrictEqual(bad, [], `\n      ${bad.join('\n      ')}`);
});

check('分类结果一定是已知类型（不会漏出 undefined）', () => {
  for (const [rec] of CASES) {
    const got = RP.classifyRecord(rec);
    assert.ok(Object.prototype.hasOwnProperty.call(RP.CLASSES, got), `未知分类：${got}`);
  }
});

/* ---------------- 2. 工作与日常活动时长分离 ---------------- */
section('2. 工作与日常活动时长必须分开');

const MIXED = [
  { content: '需求文档梳理', project_name: '云浮门户', actual_duration: 100 },
  { content: '肩背拉伸瑜伽', actual_duration: 30 },
  { content: '散步', project_name: '运动计划', actual_duration: 20 },
];

check('buckets 含四个分类', () => {
  const v = RP.buildRoleView(MIXED, null);
  assert.ok(v.buckets, 'buildRoleView 未返回 buckets');
  assert.deepStrictEqual(
    Object.keys(v.buckets).sort(),
    ['daily', 'exploration', 'product', 'unclassified']
  );
});

check('日常活动被正确识别为 2 项', () => {
  const v = RP.buildRoleView(MIXED, null);
  assert.strictEqual(v.buckets.daily.count, 2, String(v.buckets.daily.count));
  assert.strictEqual(v.buckets.daily.minutes, 50, String(v.buckets.daily.minutes));
});

check('工时不含日常活动（100 而非 150）', () => {
  const v = RP.buildRoleView(MIXED, null);
  assert.strictEqual(v.work_minutes, 100, `work_minutes=${v.work_minutes}`);
  assert.strictEqual(v.daily_minutes, 50, `daily_minutes=${v.daily_minutes}`);
});

check('渲染文本明确标注「不计入工时」', () => {
  const v = RP.buildRoleView(MIXED, null);
  const text = RP.renderRoleView(v).join('\n');
  assert.ok(text.includes('日常活动'), '缺日常活动块');
  assert.ok(text.includes('不计入工时'), '缺「不计入工时」标注');
  assert.ok(text.includes('散步'), '日常活动块未列出内容');
});

/* ---------------- 3. 项目允许为空 ---------------- */
section('3. 项目允许为空（不是异常）');

check('无项目但含 skill 信号 → 探索学习，而非「其他」', () => {
  const v = RP.buildRoleView([{ content: '完成每日日程Skill的搭建', actual_duration: 60 }], null);
  assert.strictEqual(v.buckets.exploration.count, 1, String(v.buckets.exploration.count));
  assert.strictEqual(v.buckets.unclassified.count, 0, String(v.buckets.unclassified.count));
});

check('无项目且无信号 → 其他工作（照常汇总，不报错）', () => {
  const v = RP.buildRoleView([{ content: '整理一下', work_type: '文档整理' }], null);
  assert.strictEqual(v.buckets.unclassified.count, 1, String(v.buckets.unclassified.count));
});

/* ---------------- 4. 工具建设按项目归并 ---------------- */
section('4. 工具建设按项目归并（不逐条铺陈）');

check('工具建设块给出「N 项」汇总', () => {
  const items = [
    { content: '排查 Hook 超时', project_name: '每日工作记录 skill', actual_duration: 10 },
    { content: '实现 taskId 回写', project_name: '每日工作记录 skill', actual_duration: 20 },
  ];
  const text = RP.renderRoleView(RP.buildRoleView(items, null)).join('\n');
  assert.ok(text.includes('工具建设 2 项'), text.slice(0, 240));
});

check('同项目同类型合并为一行（含条数与分钟）', () => {
  const items = [
    { content: '排查 Hook 超时', project_name: '每日工作记录 skill', actual_duration: 10 },
    { content: '实现 taskId 回写', project_name: '每日工作记录 skill', actual_duration: 20 },
  ];
  const text = RP.renderRoleView(RP.buildRoleView(items, null)).join('\n');
  assert.ok(/每日工作记录 skill｜.+2 项 \/ 30 分钟/.test(text), text.slice(0, 320));
});

check('不再逐条列出明细内容', () => {
  const items = [
    { content: '排查 Hook 超时', project_name: '每日工作记录 skill', actual_duration: 10 },
    { content: '实现 taskId 回写', project_name: '每日工作记录 skill', actual_duration: 20 },
  ];
  const text = RP.renderRoleView(RP.buildRoleView(items, null)).join('\n');
  assert.ok(!text.includes('排查 Hook 超时'), '仍出现逐条明细');
  assert.ok(!text.includes('实现 taskId 回写'), '仍出现逐条明细');
});

/* ---------------- 收尾 ---------------- */

process.stdout.write(`\n结果：${passed} 通过，${failed} 失败（共 ${passed + failed} 项）\n`);
if (failed) {
  process.stdout.write('\n失败明细：\n');
  failures.forEach((f) => process.stdout.write(`  ✗ ${f.name}\n      ${f.error}\n`));
  process.exitCode = 1;
}
