#!/usr/bin/env node
'use strict';
/**
 * test-summary-material-v324.js — V3.24 正式总结素材回归。
 *
 * 钉住三件事：
 *   1. material / draft 共用工作看板与探索沉淀能力变化；
 *   2. 自动采集的过程 / 维护活动不进主总结；
 *   3. 探索沉淀的 output 能进入能力变化，而不是被分类规则清空。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPTS = __dirname;
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-v324-home-'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-v324-'));
const env = Object.assign({}, process.env, {
  HOME: SANDBOX_HOME,
  USERPROFILE: SANDBOX_HOME,
});

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ''}`);
  }
}

function node(script, args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf-8',
    env,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error) {
    console.log(`\n  ⚠ 无法派生 node 子进程：${r.error.code || r.error.message}\n`);
    return { code: null, stdout: '', stderr: '', spawnError: r.error };
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

try {
  console.log(`\n临时目录：${tmp}`);
  const init = node('init-log.js', [
    'init',
    '--dir',
    tmp,
    '--actor',
    'test',
    '--config',
    path.join(SCRIPTS, '..', 'templates', 'config.json'),
  ]);
  ok('init-log 初始化成功', init.code === 0, `exit=${init.code} ${init.stderr.slice(0, 200)}`);

  const items = [
    [
      '工作成果',
      '--content',
      '梳理需求说明书',
      '--project',
      '测试项目',
      '--work-type',
      '需求分析',
      '--category',
      '工作',
      '--project-stage',
      '需求分析',
      '--output',
      '完成需求文档',
      '--start',
      '10:00',
      '--end',
      '11:00',
    ],
    [
      '探索沉淀能力变化',
      '--content',
      '完善日报结构',
      '--project',
      'AI Skill 探索',
      '--work-type',
      '开发',
      '--category',
      '探索沉淀',
      '--output',
      '新增按工作成果组织日报',
      '--start',
      '11:10',
      '--end',
      '11:40',
    ],
    [
      '过程维护',
      '--content',
      '修复网络问题',
      '--project',
      '测试项目',
      '--work-type',
      '问题处理',
      '--category',
      '工作',
      '--source',
      'auto',
      '--start',
      '11:45',
      '--end',
      '11:50',
    ],
  ];

  for (const item of items) {
    const label = item[0];
    const args = item.slice(1);
    const r = node('write-work-item.js', args);
    ok(`写入「${label}」`, r.code === 0, `exit=${r.code} ${r.stderr.slice(0, 200)}`);
  }

  const draft = node('daily-summary.js', ['draft', '--dir', tmp]);
  ok('draft 可运行', draft.code === 0, `exit=${draft.code} ${draft.stderr.slice(0, 200)}`);
  ok('draft 含能力变化', draft.stdout.includes('新增能力'));
  ok('draft 展示探索成果', draft.stdout.includes('新增按工作成果组织日报'));
  ok('draft 将过程维护折叠计数', draft.stdout.includes('过程 / 维护 1 项'));
  ok('draft 不展开维护事项', !draft.stdout.includes('修复网络问题'));

  const material = node('daily-summary.js', ['material', '--dir', tmp]);
  ok('material 可运行', material.code === 0, `exit=${material.code} ${material.stderr.slice(0, 200)}`);
  ok('material 含工作看板', material.stdout.includes('work_board'));
  ok('material 含探索能力变化', material.stdout.includes('exploration_updates'));
  ok('material 不再使用旧 project_rollup', !material.stdout.includes('项目 × 类型'));
  ok('material 不展开维护事项', !material.stdout.includes('修复网络问题'));

  const json = node('daily-summary.js', ['material', '--dir', tmp, '--json']);
  ok('material --json 可解析', json.code === 0 && !!JSON.parse(json.stdout || '{}'));
  if (json.code === 0) {
    const data = JSON.parse(json.stdout);
    ok('JSON work_items 带 category', data.work_items.every((x) => !!x.category));
    ok('JSON 工作看板维护计数为 1', data.work_board.operational_count === 1);
    ok(
      'JSON 探索能力变化含 output',
      data.exploration_updates.main.some(
        (x) => x.output === '新增按工作成果组织日报' && x.change_type === '新增能力'
      )
    );
  }
} finally {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (_) {}
  try {
    fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
  } catch (_) {}
}

console.log();
console.log(fail === 0 ? `✓ 全部通过（${pass} 项）` : `✗ 存在 ${fail} 处偏差 / 共 ${pass + fail} 项`);
process.exit(fail === 0 ? 0 : 1);
