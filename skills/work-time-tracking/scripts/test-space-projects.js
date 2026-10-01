#!/usr/bin/env node
'use strict';
/**
 * test-space-projects.js — 空间项目名称解析回归测试（零依赖、离线）。
 *
 * 只测**不需要联网**的部分：缓存读写、名称解析优先级、作用范围与跳过条件。
 * 联网部分（findCredentials / fetchProjectMap）由真实环境验证，不进单元测试。
 *
 *   node scripts/test-space-projects.js
 *
 * 退出码 0 = 全部通过；1 = 存在偏差。**不写日志数据**。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const SP = require(path.join(__dirname, 'lib', 'space-projects.js'));

let fail = 0;
const ok = (desc, cond, extra) => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? '✔' : '✘'}  ${desc}${extra && !cond ? '  → ' + extra : ''}`);
};

console.log('=== resolveName 优先级 ===');
ok(
  'project_map 覆盖优先于缓存',
  SP.resolveName('p_a', { cache: { p_a: '线上名' }, project_map: { p_a: '覆盖名' } }) === '覆盖名'
);
ok('无覆盖时用缓存', SP.resolveName('p_a', { cache: { p_a: '线上名' }, project_map: {} }) === '线上名');
ok('都无 → null', SP.resolveName('p_x', { cache: {}, project_map: {} }) === null);
ok('空 project_id → null', SP.resolveName('', { cache: { '': 'x' } }) === null);
ok(
  '空白覆盖值不算覆盖',
  SP.resolveName('p_a', { cache: { p_a: '线上名' }, project_map: { p_a: '   ' } }) === '线上名'
);

console.log();
console.log('=== 缓存读写 ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-sp-'));
ok('初始读空缓存不报错', Object.keys(SP.readCache(tmp).map).length === 0);
ok('写入成功', SP.writeCache(tmp, { p_a: '甲' }) === true);
const c1 = SP.readCache(tmp);
ok('读回正确', c1.map.p_a === '甲');
ok('带 fetched_at', Boolean(c1.fetched_at));
fs.writeFileSync(SP.cachePath(tmp), '{bad json', 'utf8');
ok('损坏缓存静默降级', Object.keys(SP.readCache(tmp).map).length === 0);
fs.rmSync(tmp, { recursive: true, force: true });

console.log();
console.log('=== 无空间项目时应跳过（不联网） ===');
{
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-sp2-'));
  fs.mkdirSync(path.join(tmp2, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(tmp2, 'config.json'), JSON.stringify({ project_map: {} }, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(tmp2, 'current.json'),
    JSON.stringify(
      { date: '2026-01-01', records: [], pending_items: [{ id: 'x', content: '非项目工作' }] },
      null,
      2
    ),
    'utf8'
  );
  const r = SP.syncUnresolvedProjects(tmp2);
  ok('skipped=true（不发起网络请求）', r.skipped === true, JSON.stringify(r));
  ok('scoped=0', r.scoped === 0);
  fs.rmSync(tmp2, { recursive: true, force: true });
}

console.log();
console.log('=== 新鲜缓存时应跳过（不联网） ===');
{
  const tmp3 = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-sp3-'));
  fs.mkdirSync(path.join(tmp3, 'pending'), { recursive: true });
  fs.writeFileSync(path.join(tmp3, 'config.json'), JSON.stringify({ project_map: {} }, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(tmp3, 'current.json'),
    JSON.stringify(
      {
        date: '2026-01-01',
        records: [],
        pending_items: [{ id: 'x', project_id: 'p_a', project_name: null, content: '项目工作' }],
      },
      null,
      2
    ),
    'utf8'
  );
  SP.writeCache(tmp3, { p_a: '甲项目' });
  const r = SP.syncUnresolvedProjects(tmp3);
  ok('缓存新鲜 → skipped=true', r.skipped === true, JSON.stringify(r));
  ok('标记为缓存命中', r.cached === true);
  fs.rmSync(tmp3, { recursive: true, force: true });
}

console.log();
console.log(fail === 0 ? '✓ 全部通过' : `✗ 存在 ${fail} 处偏差`);
process.exit(fail === 0 ? 0 : 1);
