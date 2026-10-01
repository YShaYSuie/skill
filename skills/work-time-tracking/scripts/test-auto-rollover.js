#!/usr/bin/env node
'use strict';
/**
 * test-auto-rollover.js — 新日期记录到达时的自动跨日回归测试。
 *
 * 覆盖：
 *   1. Hook/采集路径不需要 --rollover，也会先导出旧 WorkItem 再切到当天；
 *   2. 手工新增事项同样自动跨日，不因 current.json 落后而拒绝写入；
 *   3. 未同步旧日志转入 pending/，不静默丢弃；
 *   4. dry-run 不修改 current.json，也不创建 pending/。
 *
 *   node scripts/test-auto-rollover.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require(path.join(__dirname, 'lib', 'log-core.js'));

let pass = 0;
let fail = 0;
const roots = [];
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-rollover-home-'));
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

function run(script, args) {
  const p = spawnSync(process.execPath, [path.join(__dirname, script)].concat(args), {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
    env: CHILD_ENV,
    timeout: 90000,
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-rollover-'));
  roots.push(dir);
  const init = run('init-log.js', ['init', '--dir', dir, '--create']);
  if (init.status !== 0) throw new Error(`初始化测试目录失败：${init.stdout}${init.stderr}`);
  return dir;
}

function readLog(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'));
}

function writeLog(dir, mutate) {
  const file = path.join(dir, 'current.json');
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  mutate(log);
  fs.writeFileSync(file, JSON.stringify(log, null, 2) + '\n', 'utf8');
}

function previousDate() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function seedOldLog(dir, syncStatus) {
  const oldDate = previousDate();
  writeLog(dir, (log) => {
    log.date = oldDate;
    log.sync = { status: syncStatus };
    log.records = [
      {
        id: `WI-${oldDate.replace(/-/g, '')}-AAAA1111`,
        date: oldDate,
        content: '跨日前已存在的旧事项',
        display_content: '【测试项目】【开发】跨日前已存在的旧事项',
        project_name: '测试项目',
        work_type: '开发',
        status: 'completed',
        source: 'auto',
        confidence: 'high',
        start_time: '09:00',
        end_time: '09:30',
        actual_duration: 30,
        time_segments: [{ start: '09:00', end: '09:30' }],
        activities: [],
        tags: [],
        notes: '',
      },
    ];
    log.pending_items = [];
  });
  return oldDate;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 5000);
  while (Date.now() < deadline) {
    if (fn()) return true;
    sleep(100);
  }
  return fn();
}

console.log('=== 1. 采集路径收到新日期记录时自动跨日 ===');
{
  const dir = newDir();
  const oldDate = seedOldLog(dir, 'pending');
  const result = run('collect-activity.js', [
    'ingest',
    '--dir',
    dir,
    '--host',
    'codex',
    '--source',
    'auto',
    '--event',
    'UserPromptSubmit',
    '--timestamp',
    `${C.today()}T09:10:00+08:00`,
    '--content',
    '开发工时记录技能的新日期自动采集能力',
    '--skip-work-filter',
  ]);
  const log = readLog(dir);
  ok('采集成功', result.status === 0 && result.json && result.json.action === 'queued', result.stdout);
  ok('current.json 已切换到今天', log.date === C.today(), log.date);
  ok(
    '未同步旧日志转入 pending',
    fs.existsSync(path.join(dir, 'pending', `${oldDate}.json`)),
    path.join(dir, 'pending', `${oldDate}.json`)
  );
  ok(
    '旧 WorkItem 已永久导出',
    fs.existsSync(path.join(dir, 'logs', oldDate, 'work-activities.jsonl'))
  );
  ok(
    '本次新记录保留在当天日志',
    (log.pending_items || []).some((x) => x.content.includes('新日期自动采集能力'))
  );
  ok('返回跨日结果', result.json && result.json.rollover && result.json.rollover.action === 'rolled_over');
}

console.log();
console.log('=== 2. 已同步旧日志自动跨日且不转 pending ===');
{
  const dir = newDir();
  const oldDate = seedOldLog(dir, 'success');
  const result = run('collect-activity.js', [
    'ingest',
    '--dir',
    dir,
    '--host',
    'codex',
    '--source',
    'auto',
    '--event',
    'UserPromptSubmit',
    '--content',
    '继续整理新日期工作事项',
    '--skip-work-filter',
  ]);
  ok('采集成功', result.status === 0, result.stdout);
  ok('current.json 已切换到今天', readLog(dir).date === C.today());
  ok('已同步旧日志不转 pending', !fs.existsSync(path.join(dir, 'pending', `${oldDate}.json`)));
  ok(
    '已同步旧 WorkItem 仍永久导出',
    fs.existsSync(path.join(dir, 'logs', oldDate, 'work-activities.jsonl'))
  );
}

console.log();
console.log('=== 3. 手工新增事项同样自动跨日 ===');
{
  const dir = newDir();
  const oldDate = seedOldLog(dir, 'pending');
  const result = run('write-work-item.js', [
    '--dir',
    dir,
    '--content',
    '整理客户上线前数据清单',
    '--start',
    '09:20',
    '--source',
    'manual',
  ]);
  const log = readLog(dir);
  ok('写入成功', result.status === 0 && result.json && result.json.action === 'written', result.stdout);
  ok('current.json 已切换到今天', log.date === C.today(), log.date);
  ok('新事项已写入当天日志', (log.records || []).some((x) => x.content.includes('客户上线前数据清单')));
  ok('旧日志保留在 pending', fs.existsSync(path.join(dir, 'pending', `${oldDate}.json`)));
}

console.log();
console.log('=== 4. dry-run 不执行跨日副作用 ===');
{
  const dir = newDir();
  const oldDate = seedOldLog(dir, 'pending');
  const result = run('write-work-item.js', [
    '--dir',
    dir,
    '--content',
    '仅预览的新日期事项',
    '--start',
    '09:30',
    '--source',
    'manual',
    '--dry-run',
  ]);
  const log = readLog(dir);
  ok('dry-run 成功', result.status === 0 && result.json && result.json.action === 'dry_run', result.stdout);
  ok('current.json 日期不变', log.date === oldDate, log.date);
  ok('不创建 pending 归档', !fs.existsSync(path.join(dir, 'pending', `${oldDate}.json`)));
  ok('dry-run 返回拟跨日信息', result.json && result.json.rollover && result.json.rollover.action === 'would_roll_over');
}

console.log();
console.log('=== 5. Codex Hook 以 codex 主机自动跨日 ===');
{
  const dir = newDir();
  const oldDate = seedOldLog(dir, 'pending');
  const payload = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'codex-auto-rollover-test',
    cwd: 'D:/codex/work-time-tracking-skill-ai-skill',
    prompt: '修复 Codex 新日期记录没有切换到当天的问题',
  };
  const hook = spawnSync(
    process.execPath,
    [path.join(__dirname, 'hook-bridge.js'), '--host', 'codex'],
    {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      windowsHide: true,
      env: CHILD_ENV,
      timeout: 10000,
    }
  );
  ok('Hook 静默且不阻断宿主', hook.status === 0 && !hook.stdout, hook.stdout || hook.stderr);
  ok(
    'Hook 异步完成新日期跨日',
    waitFor(() => readLog(dir).date === C.today(), 5000),
    readLog(dir).date
  );
  ok('旧日志保留在 pending', fs.existsSync(path.join(dir, 'pending', `${oldDate}.json`)));
  // ⚠️ 断言必须等「阶段②」而不是「阶段①」：
  //   Hook 采集是 fire-and-forget 的异步子进程，且 ingest 内部先做跨日滚动（阶段①：写当日
  //   current.json），再做匹配入队与宿主登记（阶段②：再写 current.json 与 state.json）。
  //   上面「日期已切换」只证明阶段①完成 —— 若在此刻直接读 state.json / pending_items，
  //   读到的是中间态。本机实测：并发 settle 子进程争用写锁时，阶段②会慢到被断言抢跑，
  //   表现为「主机未登记」「新记录不在当天」两项随机失败（2026-09-23 定位于此）。
  ok(
    'Codex 活动登记到 codex 主机',
    waitFor(() => {
      const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      return Boolean(st.hosts && st.hosts.codex && st.hosts.codex.last_activity_at);
    }, 8000),
    JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).hosts || {})
  );
  ok(
    'Codex 新记录进入当天日志',
    waitFor(
      () => (readLog(dir).pending_items || []).some((x) => x.content.includes('Codex 新日期记录')),
      8000
    )
  );
}

for (const dir of roots) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* 临时目录清理失败不影响测试结论 */
  }
}
try {
  fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
} catch (e) {
  /* 同上 */
}

console.log();
console.log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
