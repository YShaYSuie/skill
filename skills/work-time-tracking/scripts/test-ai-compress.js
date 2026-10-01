#!/usr/bin/env node
'use strict';
/**
 * test-ai-compress.js — 超长内容的 AI 压缩 / 截断降级 / 跨日策略回归测试。
 *
 * 覆盖 2026-09-21 的三项改动：
 *   1. 超长内容改为「AI 压缩优先、失败才截断」，且**留痕可见**
 *      （此前自动采集路径静默截断到 200 字、无任何标记，用户完全无感）
 *   2. 总结只针对 current.json；--date 与日志日期不一致必须报错
 *   3. 跨日：已同步 → 直接覆盖不备份；未同步 → 中断提示用户
 *
 * 全部在 os.tmpdir() 下建临时目录跑真实 CLI，**不碰 LOG_ROOT**。
 *
 *   node scripts/test-ai-compress.js
 *
 * 退出码 0 = 全部通过；1 = 存在偏差。
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPTS = __dirname;
const C = require(path.join(SCRIPTS, 'lib', 'log-core.js'));
const S = require(path.join(SCRIPTS, 'lib', 'security.js'));
const L = require(path.join(SCRIPTS, 'lib', 'llm.js'));

let pass = 0;
let fail = 0;
const roots = [];

/**
 * 本技能脚本会通过 HOME 下的定位器文件解析默认日志目录：
 *   ~/.workbuddy/work-time-tracking.json
 * 若测试继承真实 HOME，`init-log.js init` 会把**真实的全局定位器**改写成临时目录，
 * 跑完删除临时目录后，生产侧的 Hook / status 就会指向一个已消失的路径。
 * 因此这里把 HOME 指向测试沙箱，让定位器也落在沙箱里，实现完全隔离。
 */
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-home-'));
const CHILD_ENV = Object.assign({}, process.env, {
  HOME: SANDBOX_HOME,
  USERPROFILE: SANDBOX_HOME,
});

function ok(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ✔  ${name}`);
  } else {
    fail += 1;
    console.log(`  ✘  ${name}${detail ? '    ' + detail : ''}`);
  }
}

/** 跑一个技能脚本，返回 {status, stdout, json} */
function run(script, args, opts) {
  const p = spawnSync(process.execPath, [path.join(SCRIPTS, script)].concat(args), {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: CHILD_ENV,
    timeout: (opts && opts.timeout) || 90000,
  });
  let json = null;
  try {
    json = JSON.parse((p.stdout || '').trim());
  } catch (e) {
    json = null;
  }
  return { status: p.status, stdout: p.stdout || '', stderr: p.stderr || '', json };
}

function newDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-aic-'));
  roots.push(d);
  run('init-log.js', ['init', '--dir', d, '--create']);
  return d;
}

function readLog(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'));
}

function writeLog(dir, mutate) {
  const f = path.join(dir, 'current.json');
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  mutate(d);
  fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8');
}

console.log('=== 1. AI 压缩模块（lib/llm.js） ===');
{
  const cfg = L.readModelConfig();
  ok('能读到宿主模型配置', cfg.ok, cfg.ok ? `model=${cfg.model}` : cfg.error);
  ok('配置里带 url 与 apiKey', Boolean(cfg.url && cfg.apiKey));

  // 短文本不触发压缩（零 AI 调用）
  const short = L.summarizeToLimit('整理需求文档', 200);
  ok('短文本不调 AI', short.ok && short.summarized === false && short.attempts === 0);

  // 提示词必须包含目标字数
  const msgs = L.buildMessages('x'.repeat(500), 200);
  ok('提示词含目标字数', msgs[0].content.includes('200'));
  ok('提示词要求保留关键信息', msgs[0].content.includes('关键信息'));

  // 正文提取兼容 reasoning 模型
  ok(
    'extractContent 兼容 content',
    L.extractContent({ choices: [{ message: { content: 'abc' } }] }) === 'abc'
  );
  ok(
    'extractContent 兼容 reasoning_content 回退',
    L.extractContent({ choices: [{ message: { reasoning_content: 'abc' } }] }) === 'abc'
  );
  ok('空响应返回空串', L.extractContent({ choices: [{}] }) === '');

  // 摘要清洗
  ok('去掉首尾引号', L.normalizeSummary('「摘要内容」') === '摘要内容');
  ok('去掉「摘要：」前缀', L.normalizeSummary('摘要：内容') === '内容');
  ok('多行压成单行', L.normalizeSummary('a\nb') === 'a b');
}

console.log();
console.log('=== 2. Security Filter：超长 → AI 压缩 / 降级截断 ===');
{
  const long = '排查 work-time-tracking 日志写入链路，发现自动采集路径静默截断超 200 字内容、手动路径报错。'.repeat(8);
  ok('构造的文本确实超长', long.length > 200, `${long.length} 字`);

  // ① 注入假 llm：压缩成功
  const fakeOk = {
    summarizeToLimit: (t, max) => ({ ok: true, text: 'AI压缩后的摘要', summarized: true, attempts: 1 }),
  };
  const r1 = S.filterContent(long, { security: { max_activity_length: 200 }, llm: fakeOk });
  ok('压缩成功时 content 用摘要', r1.content === 'AI压缩后的摘要', r1.content);
  ok('压缩成功时不标记截断', r1.truncated === false);
  ok('压缩成功时标记 summarized', r1.summarized === true && r1.ai_used === true);
  ok('记录 compressed_from 原长', r1.compressed_from === long.length, String(r1.compressed_from));

  // ② 注入假 llm：压缩失败 → 降级截断且带原因
  const fakeBad = { summarizeToLimit: () => ({ ok: false, error: '模拟网络失败' }) };
  const r2 = S.filterContent(long, { security: { max_activity_length: 200 }, llm: fakeBad });
  ok('压缩失败时降级为截断', r2.truncated === true && r2.summarized === false);
  ok('降级后长度恰为上限', r2.content.length === 200, String(r2.content.length));
  ok('降级时带出失败原因', r2.llm_error === '模拟网络失败', r2.llm_error);

  // ③ 显式关闭 AI → 截断
  const r3 = S.filterContent(long, { security: { max_activity_length: 200 }, aiSummarize: false });
  ok('关闭 AI 时走截断', r3.truncated === true && r3.ai_used === false);

  // ④ 短文本完全不受影响（不引入任何新字段）
  const r4 = S.filterContent('整理需求文档', { security: { max_activity_length: 200 }, llm: fakeOk });
  ok('短文本不压缩不截断', r4.content === '整理需求文档' && r4.truncated === false && r4.summarized === false);

  // ⑤ 压缩留痕形态
  const meta1 = S.compressionMeta(r1);
  ok('压缩留痕 summarized=true', meta1 && meta1.summarized === true && meta1.truncated === false);
  ok('压缩留痕含原长与终长', meta1.original_length === long.length && meta1.final_length === r1.content.length);
  const meta2 = S.compressionMeta(r2);
  ok('截断留痕 truncated=true', meta2 && meta2.truncated === true);
  ok('截断留痕写明原因', Boolean(meta2.reason && meta2.reason.includes('模拟网络失败')), meta2.reason);
  ok('未压缩时无留痕', S.compressionMeta(r4) === null);

  // ⑥ 关闭 AI 时留痕仍存在（截断必须可见）
  ok('关闭 AI 时仍有截断留痕', S.compressionMeta(r3) !== null);
}

console.log();
console.log('=== 3. content_compression 归一化（幂等 + 无意义置 null） ===');
{
  const mk = (cc) =>
    C.normalizeItem({
      id: 'WI-T', date: '2026-09-21', content: 'x', status: 'completed', source: 'manual',
      confidence: 'high', start_time: '10:00', end_time: '10:30',
      time_segments: [{ start: '10:00', end: '10:30' }], tags: [], notes: '',
      content_compression: cc,
    });

  const a = mk({ summarized: true, truncated: false, original_length: 426, final_length: 71, reason: 'r' });
  ok('保留有效压缩', a.content_compression && a.content_compression.summarized === true);

  const b = mk({ summarized: false, truncated: false, original_length: 100 });
  ok('两者皆 false → null', b.content_compression === null);

  const c = mk({ summarized: true, truncated: false, final_length: 50 });
  ok('缺 original_length → null', c.content_compression === null);

  const d = mk(undefined);
  ok('未提供 → null', d.content_compression === null);

  const e = mk({ summarized: true, truncated: true, original_length: 300, final_length: 200, reason: 'r' });
  ok('两者皆 true → 保留更保守的 truncated', e.content_compression.truncated === true && e.content_compression.summarized === false);

  const f = mk('不是对象');
  ok('非对象 → null', f.content_compression === null);

  // 幂等
  let idemOk = true;
  for (const cc of [
    { summarized: true, truncated: false, original_length: 426, final_length: 71, reason: 'r' },
    { summarized: false, truncated: true, original_length: 426, final_length: 200, reason: 'r' },
    { summarized: true, truncated: true, original_length: 300, final_length: 200, reason: 'r' },
    { summarized: false, truncated: false, original_length: 10 },
  ]) {
    const one = mk(cc).content_compression;
    const two = mk(JSON.parse(JSON.stringify(one))).content_compression;
    if (JSON.stringify(one) !== JSON.stringify(two)) idemOk = false;
  }
  ok('归一化幂等', idemOk);
}

console.log();
console.log('=== 4. 配置项（ai_summarize / 超时预算） ===');
{
  const cfg = S.normalizeSecurityConfig({});
  ok('默认开启 AI 压缩', cfg.ai_summarize === true);
  ok('默认超时 6s（小于 Hook 子进程 7s 预算）', cfg.ai_summarize_timeout_sec === 6);
  ok('可关闭', S.normalizeSecurityConfig({ ai_summarize: false }).ai_summarize === false);
  ok('超时上限收敛到 60s', S.normalizeSecurityConfig({ ai_summarize_timeout_sec: 999 }).ai_summarize_timeout_sec === 60);
  ok('非法超时回落默认', S.normalizeSecurityConfig({ ai_summarize_timeout_sec: -1 }).ai_summarize_timeout_sec === 6);
  const rep = S.report({});
  ok('/security 报告带 ai_summarize', rep.ai_summarize === true);
  // status.js 的 /security 输出会打印这一项；漏掉会让报告出现「超时 undefineds」
  ok('/security 报告带超时秒数', rep.ai_summarize_timeout_sec === 6);
  ok(
    '/security 关闭 AI 时超时仍有值',
    S.report({ ai_summarize: false }).ai_summarize_timeout_sec === 6
  );
}

console.log();
console.log('=== 5. 端到端：自动采集落库留痕 ===');
{
  const dir = newDir();
  const long = '排查 work-time-tracking 日志写入链路，发现自动采集路径静默截断超 200 字内容、手动路径报错，截断未持久化导致用户无感。'.repeat(8);
  const r = run('collect-activity.js', [
    'ingest', '--host', 'workbuddy', '--event', 'UserPromptSubmit',
    '--content', long, '--dir', dir, '--force',
  ]);
  ok('ingest 成功', r.status === 0, `exit=${r.status}`);

  const log = readLog(dir);
  const p = (log.pending_items || [])[0];
  ok('已入队待判断事项', Boolean(p));
  if (p) {
    ok('落库长度不超过上限', p.content.length <= 200, `${p.content.length} 字`);
    ok('落库带 content_compression 留痕', Boolean(p.content_compression), JSON.stringify(p.content_compression));
    if (p.content_compression) {
      ok(
        '留痕记录了原始长度',
        p.content_compression.original_length === long.length,
        `${p.content_compression.original_length} vs ${long.length}`
      );
      ok('留痕有可读原因', Boolean(p.content_compression.reason), p.content_compression.reason);
    }
  }
  // 校验器应通过
  const v = run('validate-log.js', ['--dir', dir]);
  ok('自检 ok', v.json && v.json.ok === true, v.json ? JSON.stringify(v.json.problems).slice(0, 200) : v.stdout.slice(0, 200));
}

console.log();
console.log('=== 6. 端到端：手动写入超长内容 ===');
{
  const dir = newDir();
  const long = '完善 GPU 细粒度调度需求规格说明，逐条核对资源申请、配额校验、抢占策略与优先级继承等章节，并与研发确认边界条件。'.repeat(4);
  const r = run('write-work-item.js', [
    '--content', long, '--start', '10:00', '--source', 'manual', '--dir', dir,
  ]);
  ok('超长手动写入不再报错（改为 AI 压缩）', r.status === 0, `exit=${r.status} ${r.stdout.slice(0, 150)}`);
  const log = readLog(dir);
  const rec = (log.records || [])[0];
  ok('已写入 WorkItem', Boolean(rec));
  if (rec) {
    ok('内容在限内', rec.content.length <= 200, `${rec.content.length} 字`);
    ok('带留痕', Boolean(rec.content_compression), JSON.stringify(rec.content_compression));
    ok('原始长度正确', rec.content_compression && rec.content_compression.original_length === long.length);
  }
  const v = run('validate-log.js', ['--dir', dir]);
  ok('自检 ok', v.json && v.json.ok === true, v.json ? JSON.stringify(v.json.problems).slice(0, 200) : v.stdout.slice(0, 200));
}

console.log();
console.log('=== 7. 校验器抓得住「截断无留痕」 ===');
{
  const dir = newDir();
  // 手工塞一条超长且无留痕的记录，校验器必须报 problem
  writeLog(dir, (d) => {
    d.records = [{
      id: 'WI-20260921-AAAA1111', date: d.date, content: 'x'.repeat(260),
      project_name: null, project_confidence: null, work_type: null, work_type_confidence: null,
      start_time: '10:00', end_time: '10:30', estimated_duration: null, actual_duration: 30,
      status: 'completed', source: 'manual', confidence: 'high',
      time_segments: [{ start: '10:00', end: '10:30' }], activities: [], parent_id: null,
      tags: [], notes: '', display_content: 'x'.repeat(260),
    }];
  });
  const v = run('validate-log.js', ['--dir', dir]);
  const problems = (v.json && v.json.problems) || [];
  ok('检出超长未压缩', problems.some((p) => p.includes('内容超过上限')), JSON.stringify(problems).slice(0, 200));

  // 加上「截断但无原因」的留痕，也必须报错
  writeLog(dir, (d) => {
    d.records[0].content = 'x'.repeat(200);
    d.records[0].display_content = 'x'.repeat(200);
    d.records[0].content_compression = { summarized: false, truncated: true, original_length: 260, final_length: 200, reason: null };
  });
  const v2 = run('validate-log.js', ['--dir', dir]);
  const p2 = (v2.json && v2.json.problems) || [];
  ok('检出「已截断但未记原因」', p2.some((p) => p.includes('未记录原因')), JSON.stringify(p2).slice(0, 200));

  // 补齐原因后应通过
  writeLog(dir, (d) => {
    d.records[0].content_compression.reason = 'AI 压缩失败，已截断至 200 字：超时';
  });
  const v3 = run('validate-log.js', ['--dir', dir]);
  ok('补齐原因后通过', v3.json && v3.json.ok === true, v3.json ? JSON.stringify(v3.json.problems).slice(0, 200) : '');
}

console.log();
console.log('=== 8. 总结只针对 current.json ===');
{
  const dir = newDir();
  // 放一个别的日期的历史日志副本，它绝不应该出现在今日总结中
  fs.mkdirSync(path.join(dir, 'pending'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'pending', '2026-09-20.json'),
    JSON.stringify({
      date: '2026-09-20', version: 1,
      records: [{
        id: 'WI-20260920-ZZZZ9999', date: '2026-09-20', content: '昨天的工作不该出现在今天',
        status: 'completed', source: 'manual', confidence: 'high',
        start_time: '09:00', end_time: '09:30', time_segments: [{ start: '09:00', end: '09:30' }],
        activities: [], tags: [], notes: '',
      }],
      pending_items: [],
    }, null, 2),
    'utf8'
  );

  const r = run('daily-summary.js', ['draft', '--dir', dir, '--no-online']);
  ok('draft 成功', r.status === 0, `exit=${r.status}`);
  ok('总结不含历史日志内容', !r.stdout.includes('昨天的工作不该出现在今天'));

  // --date 与日志日期不一致 → 必须报错（拒绝总结历史日期）
  const mismatch = run('daily-summary.js', ['draft', '--dir', dir, '--date', '2026-09-20']);
  ok('--date 与 current.json 不一致时报错', mismatch.status !== 0, `exit=${mismatch.status}`);
  ok(
    '错误信息说明历史日期不支持总结',
    mismatch.stdout.includes('历史') || mismatch.stdout.includes('不一致'),
    mismatch.stdout.slice(0, 160)
  );
}

console.log();
console.log('=== 9. 跨日策略：先永久导出工作事项，再按同步状态处理 ===');
{
  // ① 已同步 + 无 decision → 覆盖 current.json，但工作事项必须先导出到 logs/
  const d1 = newDir();
  writeLog(d1, (d) => {
    d.date = '2026-09-20';
    d.sync = { status: 'success' };
    d.records = [{
      id: 'WI-20260920-AAAA1111', date: '2026-09-20', content: '跨日前必须被永久导出',
      project_name: 'P', work_type: '开发', status: 'completed', source: 'auto',
      confidence: 'high', start_time: '09:00', end_time: '10:00', actual_duration: 60,
      time_segments: [{ start: '09:00', end: '10:00' }], activities: [], tags: [], notes: '',
      display_content: '【P】【开发】跨日前必须被永久导出',
    }];
  });
  const r1 = run('init-log.js', ['rollover', '--dir', d1]);
  ok('已同步时跨日成功', r1.status === 0, `exit=${r1.status} ${r1.stdout.slice(0, 150)}`);
  const exported = path.join(d1, 'logs', '2026-09-20', 'work-activities.jsonl');
  ok('跨日前已把工作事项导出到 logs/<date>/work-activities.jsonl', fs.existsSync(exported));
  ok(
    '导出的内容与 WorkItem 一致',
    fs.existsSync(exported) && fs.readFileSync(exported, 'utf8').includes('跨日前必须被永久导出')
  );
  ok('已同步时不再写 archive/', !fs.existsSync(path.join(d1, 'archive')));
  ok('已同步时 current.json 换新日期', readLog(d1).date !== '2026-09-20', readLog(d1).date);
  ok(
    'rollover 报告里带上导出结果',
    r1.json && r1.json.work_activity_export && r1.json.work_activity_export.exportable === 1,
    JSON.stringify(r1.json && r1.json.work_activity_export)
  );

  // ② 未同步 + 无 decision → 中断提示（NEED_DECISION=4）
  const d2 = newDir();
  writeLog(d2, (d) => { d.date = '2026-09-20'; d.sync = { status: 'pending' }; });
  const r2 = run('init-log.js', ['rollover', '--dir', d2]);
  ok('未同步时中断（exit 4）', r2.status === 4, `exit=${r2.status}`);
  ok('中断时原日志未被覆盖', readLog(d2).date === '2026-09-20', readLog(d2).date);
  ok(
    '提示信息给出两个选项',
    r2.stdout.includes('同步') && r2.stdout.includes('keep'),
    r2.stdout.slice(0, 200)
  );

  // ③ --decision archive 已废弃 → 必须被拒绝且说明原因
  const d3 = newDir();
  writeLog(d3, (d) => { d.date = '2026-09-20'; d.sync = { status: 'pending' }; });
  const r3 = run('init-log.js', ['rollover', '--dir', d3, '--decision', 'archive']);
  ok('--decision archive 已被拒绝（退出码非 0）', r3.status !== 0, `exit=${r3.status}`);
  ok(
    '拒绝时说明 archive 已废弃',
    r3.stdout.includes('废弃'),
    r3.stdout.slice(0, 200)
  );
  ok('archive 参数未被接受时不影响 current.json', readLog(d3).date === '2026-09-20');

  // ④ 未同步 + --decision keep → 转 pending
  const d4 = newDir();
  writeLog(d4, (d) => { d.date = '2026-09-20'; d.sync = { status: 'pending' }; });
  const r4 = run('init-log.js', ['rollover', '--dir', d4, '--decision', 'keep']);
  ok('keep 时成功', r4.status === 0, `exit=${r4.status}`);
  ok('转入 pending', fs.existsSync(path.join(d4, 'pending', '2026-09-20.json')));
  ok('未写 archive', !fs.existsSync(path.join(d4, 'archive')));

  // ⑤ 当天日志 → 无需跨日
  const d5 = newDir();
  const r5 = run('init-log.js', ['rollover', '--dir', d5]);
  ok('当天日志不触发跨日', r5.status === 0 && r5.json && r5.json.action === 'none', r5.stdout.slice(0, 150));
}

console.log();
console.log('=== 10. 测试隔离：不得污染真实全局定位器 ===');
{
  const realLocator = path.join(os.homedir(), '.workbuddy', 'work-time-tracking.json');
  let realDir = null;
  try {
    realDir = JSON.parse(fs.readFileSync(realLocator, 'utf8')).log_directory || null;
  } catch (e) {
    realDir = null;
  }
  const sandboxLocator = path.join(SANDBOX_HOME, '.workbuddy', 'work-time-tracking.json');
  ok(
    '真实全局定位器未被指向临时目录',
    !(realDir && /[\\/](Temp|tmp)[\\/]wtt-/.test(realDir)),
    realDir ? `当前指向：${realDir}` : '（真实定位器不存在，跳过）'
  );
  ok('沙箱定位器已生成（HOME 已重定向）', fs.existsSync(sandboxLocator), sandboxLocator);
}

// 收尾：清理临时目录
for (const d of roots.concat([SANDBOX_HOME])) {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch (e) {
    /* 清理失败不影响结论 */
  }
}

console.log();
console.log(fail === 0 ? `✓ 全部通过（${pass} 项）` : `✗ 存在 ${fail} 处偏差 / 共 ${pass + fail} 项`);
process.exit(fail === 0 ? 0 : 1);
