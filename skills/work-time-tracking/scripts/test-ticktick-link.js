/**
 * ticktick 字段（taskId 回写）功能测试
 *
 * 覆盖：
 *   1. normalizeTicktick 的归一化规则（无 taskId → null、白名单过滤、缺省补 null）
 *   2. update-work-item.js link / unlink 端到端写入
 *   3. validate-log.js 对 ticktick 的校验（合法通过、缺 taskId 报错）
 *
 * 用临时目录，不触碰真实 LOG_ROOT。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const C = require('./lib/log-core.js');
const SKILL_DIR = __dirname;
const SCRIPTS = SKILL_DIR;

/**
 * 技能脚本会通过 HOME 下的定位器文件解析默认日志目录：
 *   ~/.workbuddy/work-time-tracking.json
 * 若测试继承真实 HOME，`init-log.js init` 会把**真实的全局定位器**改写成临时目录，
 * 跑完删除临时目录后，生产侧的 Hook / status 就会指向一个已消失的路径。
 * 因此把 HOME 指向测试沙箱，让定位器也落在沙箱里，实现完全隔离。
 */
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-home-'));
const CHILD_ENV = Object.assign({}, process.env, {
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

/* ---------- 1. normalizeTicktick 单元测试 ---------- */

console.log('\n[1] normalizeTicktick 归一化规则');

ok('无 ticktick 字段 → null', C.normalizeTicktick({}).ticktick === null);
ok('ticktick 为 null → 保持 null', C.normalizeTicktick({ ticktick: null }).ticktick === null);
ok('空对象（无 taskId）→ null', C.normalizeTicktick({ ticktick: {} }).ticktick === null);
ok(
  'taskId 为空串 → null',
  C.normalizeTicktick({ ticktick: { taskId: '   ' } }).ticktick === null
);
ok(
  '数组 → null（非对象）',
  C.normalizeTicktick({ ticktick: ['x'] }).ticktick === null
);
ok(
  '字符串 → null（非对象）',
  C.normalizeTicktick({ ticktick: 'abc' }).ticktick === null
);

const full = C.normalizeTicktick({
  ticktick: { taskId: '6aaf6b5ee4b066c22040c33d', projectId: '5a4329c3', syncedAt: '2026-09-21T11:57:44+08:00' },
}).ticktick;
ok('完整对象原样保留', full.taskId === '6aaf6b5ee4b066c22040c33d' && full.projectId === '5a4329c3');
ok('syncedAt 保留', full.syncedAt === '2026-09-21T11:57:44+08:00');

const partial = C.normalizeTicktick({ ticktick: { taskId: 'abc123' } }).ticktick;
ok('仅有 taskId 时 projectId/syncedAt 补 null', partial.projectId === null && partial.syncedAt === null);

const dirty = C.normalizeTicktick({
  ticktick: { taskId: 'abc', projectId: 'p', syncedAt: 's', evil: 'x', nested: { a: 1 } },
}).ticktick;
ok('白名单外字段被丢弃', !('evil' in dirty) && !('nested' in dirty));
ok('白名单字段仍保留', dirty.taskId === 'abc' && dirty.projectId === 'p' && dirty.syncedAt === 's');

const trimmed = C.normalizeTicktick({ ticktick: { taskId: '  abc  ' } }).ticktick;
ok('taskId 两端空白被 trim', trimmed.taskId === 'abc');

/* ---------- 2. link / unlink 端到端 ---------- */

console.log('\n[2] update-work-item.js link / unlink');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-ticktick-'));
console.log(`  临时目录：${tmp}`);

function node(script, args) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf-8',
    env: CHILD_ENV,
  });
  let json = null;
  try {
    json = JSON.parse((r.stdout || '').trim());
  } catch (e) {
    json = null;
  }
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json };
}

// 初始化目录
const cfg = path.join(SKILL_DIR, '..', 'templates', 'config.json');
const init = spawnSync(
  process.execPath,
  [path.join(SCRIPTS, 'init-log.js'), 'init', '--dir', tmp, '--actor', 'test', '--config', cfg],
  { encoding: 'utf-8', env: CHILD_ENV }
);
ok('init-log 初始化成功', init.status === 0, `exit=${init.status} ${(init.stderr || '').slice(0, 200)}`);

// 建一个 WorkItem
const w = node('write-work-item.js', [
  '--dir', tmp, '--actor', 'test',
  '--content', '【测试项目】【开发】taskId 回写测试',
  '--start', '10:00', '--end', '11:00',
  '--source', 'workbuddy',
]);
ok('write-work-item 成功', w.code === 0, `exit=${w.code} ${(w.stderr || '').slice(0, 200)}`);
const wiId = (w.json && w.json.work_item && w.json.work_item.id) || null;
ok('拿到 WorkItem id', Boolean(wiId), JSON.stringify(w.json).slice(0, 200));

// 新建后 ticktick 应为 null
ok(
  '新建 WorkItem 的 ticktick 为 null',
  w.json && w.json.work_item && w.json.work_item.ticktick === null,
  JSON.stringify(w.json && w.json.work_item && w.json.work_item.ticktick)
);

// link
const link = node('update-work-item.js', [
  'link', '--dir', tmp, '--actor', 'test',
  '--id', wiId,
  '--task-id', '6aaf6b5ee4b066c22040c33d',
  '--project-id', '5a4329c34686f1f8e0f0f802',
  '--synced-at', '2026-09-21T12:00:00+08:00',
]);
ok('link 命令成功', link.code === 0, `exit=${link.code} ${(link.stderr || '').slice(0, 300)}`);
ok('返回 action=linked', link.json && link.json.action === 'linked', JSON.stringify(link.json && link.json.action));
ok(
  'taskId 已写入',
  link.json && link.json.ticktick && link.json.ticktick.taskId === '6aaf6b5ee4b066c22040c33d',
  JSON.stringify(link.json && link.json.ticktick)
);
ok('ticktick_before 为 null', link.json && link.json.ticktick_before === null);

// 落盘核对
const log1 = JSON.parse(fs.readFileSync(path.join(tmp, 'current.json'), 'utf-8'));
const rec1 = (log1.records || []).find((r) => r.id === wiId);
ok(
  'current.json 中已落盘 taskId',
  rec1 && rec1.ticktick && rec1.ticktick.taskId === '6aaf6b5ee4b066c22040c33d',
  JSON.stringify(rec1 && rec1.ticktick)
);
ok('projectId 已落盘', rec1 && rec1.ticktick.projectId === '5a4329c34686f1f8e0f0f802');
ok('syncedAt 已落盘', rec1 && rec1.ticktick.syncedAt === '2026-09-21T12:00:00+08:00');

// 通过 validate-log 校验
const v1 = node('validate-log.js', ['--dir', tmp]);
ok(
  'validate-log 对合法 ticktick 无 problems',
  v1.code === 0,
  `exit=${v1.code} ${(v1.stdout || '').slice(0, 400)}`
);

// 缺 taskId 应报错
const bad = node('update-work-item.js', ['link', '--dir', tmp, '--actor', 'test', '--id', wiId]);
ok('link 缺 --task-id 报错', bad.code !== 0, `exit=${bad.code}`);

// unlink
const un = node('update-work-item.js', ['unlink', '--dir', tmp, '--actor', 'test', '--id', wiId]);
ok('unlink 命令成功', un.code === 0, `exit=${un.code} ${(un.stderr || '').slice(0, 200)}`);
ok('unlink 后 ticktick 为 null', un.json && un.json.ticktick === null, JSON.stringify(un.json && un.json.ticktick));
ok('unlink 前值已记录', un.json && un.json.ticktick_before && un.json.ticktick_before.taskId === '6aaf6b5ee4b066c22040c33d');

const log2 = JSON.parse(fs.readFileSync(path.join(tmp, 'current.json'), 'utf-8'));
const rec2 = (log2.records || []).find((r) => r.id === wiId);
ok('落盘后 ticktick 为 null', rec2 && rec2.ticktick === null, JSON.stringify(rec2 && rec2.ticktick));

// 重新 link 一次，并测试「传白名单外字段会被丢弃」在 CLI 路径也成立
const link2 = node('update-work-item.js', [
  'link', '--dir', tmp, '--actor', 'test', '--id', wiId, '--task-id', 'abc999',
]);
ok('重新 link 成功', link2.code === 0, `exit=${link2.code}`);
ok('未传 projectId 时为 null', link2.json.ticktick.projectId === null);
ok('未传 syncedAt 时自动用当前时间', typeof link2.json.ticktick.syncedAt === 'string' && link2.json.ticktick.syncedAt.length > 10);

/* ---------- 3. validate-log 对异常 ticktick 的校验 ---------- */

console.log('\n[3] validate-log 对异常 ticktick 的校验');

const badLog = JSON.parse(fs.readFileSync(path.join(tmp, 'current.json'), 'utf-8'));
badLog.records[0].ticktick = { projectId: 'p' }; // 缺 taskId
fs.writeFileSync(path.join(tmp, 'current.json'), JSON.stringify(badLog, null, 2));
const vBad = node('validate-log.js', ['--dir', tmp]);
ok(
  '缺 taskId 时报 problems',
  vBad.code !== 0 || /ticktick/.test(vBad.stdout || ''),
  `exit=${vBad.code} ${(vBad.stdout || '').slice(0, 500)}`
);

// 清理
try {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
  console.log(`\n  已清理临时目录（含沙箱 HOME）`);
} catch (e) {
  console.log(`\n  临时目录清理失败：${e.message}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
