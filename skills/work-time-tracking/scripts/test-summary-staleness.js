#!/usr/bin/env node
'use strict';
/**
 * test-summary-staleness.js — 日报过期检测（V3.27）回归测试。
 *
 * 为什么必须存在这个文件：
 *   2026-09-28 实测事故 —— `summaries/2026-09-28.md` 生成于 14:36，
 *   而当天 Conversation 从 10 个涨到 25 个。文件本身没有任何过期标记，
 *   人和 AI 都可能把这份旧日报当成当日全貌（当时确实据此得出了不完整结论）。
 *
 *   本测试把「过期必须被识别出来」钉成不变量，并同时钉住反向条件：
 *   日报是最新的时候**不得**误报 —— 误报会让提示失去可信度，
 *   比漏报更糟（用户会对所有 ⚠ 脱敏）。
 *
 * 覆盖：
 *   ① 无日报          → stale=false, reason=no_summary
 *   ② 日报最新        → stale=false, reason=up_to_date
 *   ③ 有新增但不足阈值 → stale=false, reason=below_threshold
 *   ④ 有新增且达阈值   → stale=true，message 含「数据截止」与新增会话数
 *   ⑤ 阈值可配置      → 同一份数据，阈值调大后不再判为过期
 *   ⑥ 非法配置值回退   → 回退默认 3，不抛错
 *   ⑦ 只读性          → 检测前后文件字节完全一致
 *   ⑧ 日报头部写「数据截止」→ 静态文件不含会随时间失效的「是否过期」判断
 *
 *   node scripts/test-summary-staleness.js
 *
 * 用临时目录 + 沙箱 HOME，不触碰真实 LOG_ROOT。退出码 0 = 全部通过。
 *
 * 说明：本测试**进程内**调用被测函数。
 *   受限沙箱常禁止 node→node 派生（实测 EBUSY），子进程式测试会整片假失败；
 *   过期检测是纯计算，进程内调用更可靠，也不受退出码与 stdout 捕获影响。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRIPTS = __dirname;
const DAY = '2026-09-28';

/** 沙箱 HOME：避免把真实全局定位器改成临时目录（同其他回归测试） */
const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-home-'));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;

const DS = require(path.join(SCRIPTS, 'daily-summary.js'));
const C = require(path.join(SCRIPTS, 'lib', 'log-core.js'));

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-stale-'));
console.log(`\n临时目录：${tmp}`);

/** 写入 current.json（含 summary），模拟「日报已落盘」。 */
function writeCurrent(date, generatedAt) {
  const log = {
    date,
    version: 1,
    records: [],
    pending_items: [],
    sync: { status: 'pending' },
    summary: {
      generated_at: generatedAt,
      generated_by: 'test',
      trigger: 'manual',
      ai_assisted: true,
      ai_blocked_reason: null,
      text: `# ${date} 今日总结\n\n（测试正文）`,
    },
  };
  fs.writeFileSync(C.currentPath(tmp), JSON.stringify(log, null, 2), 'utf8');
  const sdir = path.join(tmp, 'summaries');
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, `${date}.md`), `> **${date} 工作总结**\n\n（测试正文）\n`, 'utf8');
}

function clearCurrent() {
  try {
    fs.unlinkSync(C.currentPath(tmp));
  } catch (e) {
    /* 不存在即可 */
  }
}

/** 写入 N 个会话，结算时间从 startHour 起每小时一个（settled_at = :35）。 */
function writeConversations(date, count, startHour) {
  const dayDir = path.join(tmp, 'logs', date);
  fs.mkdirSync(dayDir, { recursive: true });
  const lines = [];
  for (let i = 0; i < count; i += 1) {
    const hh = String(startHour + i).padStart(2, '0');
    lines.push(
      JSON.stringify({
        conversation_id: `CON-${date.replace(/-/g, '')}-T${String(i).padStart(4, '0')}`,
        agent: 'workbuddy',
        model_name: 'test-model-flash',
        models: ['test-model-flash'],
        start_time: `${date}T${hh}:00:00+08:00`,
        end_time: `${date}T${hh}:30:00+08:00`,
        duration_seconds: 1800,
        total_token: 1000,
        total_score: 0,
        status: 'completed',
        settlement_status: 'settled',
        settled_at: `${date}T${hh}:35:00+08:00`,
        source: 'workbuddy',
        session_id: `sess-stale-${i}`,
        project: '测试项目',
        title: `测试会话 ${i}`,
        request_count: 1,
        turn_count: 1,
        skill_count: 0,
        missing_fields: [],
        raw_ref: null,
        parser_version: 'test-1.0.0',
        created_at: `${date}T${hh}:00:00+08:00`,
        updated_at: `${date}T${hh}:35:00+08:00`,
      })
    );
  }
  fs.writeFileSync(
    path.join(dayDir, 'conversations.jsonl'),
    lines.length ? `${lines.join('\n')}\n` : '',
    'utf8'
  );
}

/** 改配置里的过期阈值。 */
function setThreshold(value) {
  const p = C.configPath(tmp);
  const conf = JSON.parse(fs.readFileSync(p, 'utf8'));
  conf.summary = conf.summary || {};
  if (value === undefined) delete conf.summary.stale_conversation_threshold;
  else conf.summary.stale_conversation_threshold = value;
  fs.writeFileSync(p, JSON.stringify(conf, null, 2), 'utf8');
}

/* ---------- 初始化 ---------- */
// 手工构造最小可用日志目录：config.json（取模板）+ 必要子目录 + manifest。
// 不调用 init-log.js 的原因：受限沙箱禁止 node→node 派生，CLI 方式会整片假失败。
(function initDir() {
  fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'summaries'), { recursive: true });
  const template = path.join(SCRIPTS, '..', 'templates', 'config.json');
  if (fs.existsSync(template)) {
    fs.copyFileSync(template, C.configPath(tmp));
  } else {
    fs.writeFileSync(
      C.configPath(tmp),
      JSON.stringify({ version: 1, summary: {}, work: {} }, null, 2),
      'utf8'
    );
  }
  fs.writeFileSync(
    path.join(tmp, '.log-manifest.json'),
    JSON.stringify(
      { manifest_type: 'work-time-log', log_id: 'test-stale', created_at: C.nowIso() },
      null,
      2
    ),
    'utf8'
  );
})();
ok('测试目录初始化完成', fs.existsSync(C.configPath(tmp)));

/* ---------- ① 无日报：不得误报 ---------- */
{
  clearCurrent();
  writeConversations(DAY, 2, 10);
  const s = DS.detectSummaryStaleness(tmp, DAY, { threshold: 3 });
  ok('① 无日报 → stale=false', s.stale === false, JSON.stringify(s));
  ok('① reason=no_summary', s.reason === 'no_summary', String(s.reason));
}

/* ---------- ② 日报最新：不得误报 ---------- */
{
  // 会话结算到 11:35；日报生成于 12:00（晚于全部结算）
  writeCurrent(DAY, `${DAY}T12:00:00+08:00`);
  const s = DS.detectSummaryStaleness(tmp, DAY, { threshold: 3 });
  ok(
    '② 日报晚于全部结算 → stale=false（up_to_date）',
    s.stale === false && s.new_conversations === 0 && s.reason === 'up_to_date',
    JSON.stringify(s)
  );
}

/* ---------- ③ 有新增但不足阈值（2 个 < 默认 3） ---------- */
{
  writeCurrent(DAY, `${DAY}T10:20:00+08:00`);
  writeConversations(DAY, 2, 11); // 结算 11:35 / 12:35，都晚于 10:20
  const s = DS.detectSummaryStaleness(tmp, DAY, { threshold: 3 });
  ok(
    '③ 新增 2 个、阈值 3 → stale=false（below_threshold）',
    s.stale === false && s.new_conversations === 2 && s.reason === 'below_threshold',
    JSON.stringify(s)
  );
}

/* ---------- ④ 有新增且达阈值 ---------- */
{
  writeCurrent(DAY, `${DAY}T09:00:00+08:00`);
  writeConversations(DAY, 5, 10); // 结算 10:35 ~ 14:35，全部晚于 09:00
  const s = DS.detectSummaryStaleness(tmp, DAY, { threshold: 3 });
  ok('④ 新增 5 个 → stale=true', s.stale === true, JSON.stringify(s));
  ok('④ new_conversations=5', s.new_conversations === 5, JSON.stringify(s));
  ok('④ threshold 生效', s.threshold === 3, String(s.threshold));
  ok(
    '④ message 含「数据截止」「5 个会话」「建议重新生成」',
    typeof s.message === 'string' &&
      s.message.includes('数据截止') &&
      s.message.includes('5 个会话') &&
      s.message.includes('建议重新生成'),
    String(s.message)
  );
  ok('④ generated_at 为日报时间', s.generated_at === `${DAY}T09:00:00+08:00`, String(s.generated_at));
  ok(
    '④ last_settled_at 取最大值',
    s.last_settled_at === `${DAY}T14:35:00+08:00`,
    String(s.last_settled_at)
  );
}

/* ---------- ⑤ 阈值可配置：调大后不再过期 ---------- */
{
  setThreshold(10);
  const eff = DS.staleThresholdOf(tmp);
  ok('⑤ 配置阈值被读出（=10）', eff === 10, String(eff));
  const s = DS.detectSummaryStaleness(tmp, DAY, { threshold: eff });
  ok('⑤ 阈值调至 10 后，新增 5 个不再判为过期', s.stale === false, JSON.stringify(s));
  setThreshold(3);
}

/* ---------- ⑥ 非法配置值回退默认 ---------- */
{
  setThreshold('abc');
  ok('⑥ 非法阈值回退 3', DS.staleThresholdOf(tmp) === 3, String(DS.staleThresholdOf(tmp)));
  setThreshold(0);
  ok('⑥ 阈值 0 回退 3', DS.staleThresholdOf(tmp) === 3, String(DS.staleThresholdOf(tmp)));
  setThreshold(undefined);
  ok('⑥ 缺省阈值回退 3', DS.staleThresholdOf(tmp) === 3, String(DS.staleThresholdOf(tmp)));
}

/* ---------- ⑦ 只读性：检测不得改写任何文件 ---------- */
{
  const curBefore = fs.readFileSync(C.currentPath(tmp), 'utf8');
  const mdPath = path.join(tmp, 'summaries', `${DAY}.md`);
  const mdBefore = fs.readFileSync(mdPath, 'utf8');
  const convPath = path.join(tmp, 'logs', DAY, 'conversations.jsonl');
  const convBefore = fs.readFileSync(convPath, 'utf8');
  DS.detectSummaryStaleness(tmp, DAY, { threshold: 3 });
  ok('⑦ 不改写 current.json', curBefore === fs.readFileSync(C.currentPath(tmp), 'utf8'));
  ok('⑦ 不改写 summaries/<date>.md', mdBefore === fs.readFileSync(mdPath, 'utf8'));
  ok('⑦ 不改写 conversations.jsonl', convBefore === fs.readFileSync(convPath, 'utf8'));
}

/* ---------- ⑧ 时间解析与头部渲染 ---------- */
{
  ok('⑧ parseLocalTime 接受 ISO', DS.parseLocalTime(`${DAY}T09:00:00+08:00`) !== null);
  ok('⑧ parseLocalTime 接受空格分隔', DS.parseLocalTime(`${DAY} 09:00:00`) !== null);
  ok('⑧ parseLocalTime 拒绝非法串', DS.parseLocalTime('not-a-time') === null);
  ok('⑧ readableTime 去掉 T 与时区', DS.readableTime(`${DAY}T09:00:00+08:00`) === `${DAY} 09:00:00`);

  // 头部必须写「数据截止」，且**不得**写死「是否过期」
  const file = DS.writeSummaryMarkdown(
    tmp,
    {
      generated_at: `${DAY}T09:00:00+08:00`,
      trigger: 'manual',
      ai_assisted: true,
      ai_blocked_reason: null,
      text: '# 正文',
    },
    DAY
  );
  const md = fs.readFileSync(file, 'utf8');
  ok('⑧ 头部含「数据截止」', md.includes('数据截止'));
  ok('⑧ 头部不含写死的过期判断', !md.includes('已过期') && !md.includes('建议重新生成'));
}

/* ---------- ⑨ 快照回落：历史日期（P1-3） ---------- */
{
  // 场景：current.json 已跨日滚动到新日期、summary 被清空，
  // 但旧日期的 summaries/<date>.md 仍在磁盘上。
  // 修复前：检测返回 no_summary（静默放过过时日报）。
  // 修复后：回落读 md 头部，正确判定过期。
  const SNAP_DAY = '2026-09-20';
  const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-snap-'));
  try {
    // ① 造一份「次日已滚动」的 current.json：date 是新的，summary 为 null
    const rolled = { date: '2026-09-21', version: 1, records: [], summary: null };
    fs.writeFileSync(C.currentPath(snapDir), JSON.stringify(rolled, null, 2), 'utf8');

    // ② 造旧日期的快照 md，头部含真实生成时间（格式与 writeSummaryMarkdown 一致）
    const sdir = path.join(snapDir, 'summaries');
    fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(
      path.join(sdir, `${SNAP_DAY}.md`),
      `> **${SNAP_DAY} 工作总结**　生成时间：${SNAP_DAY} 14:36:00　数据截止：${SNAP_DAY} 14:36:00　触发方式：manual　AI 参与：是\n\n# 正文\n`,
      'utf8'
    );

    // ③ 造 4 个「生成之后才结算」的会话
    const dayDir = path.join(snapDir, 'logs', SNAP_DAY);
    fs.mkdirSync(dayDir, { recursive: true });
    const lines = [];
    for (let i = 0; i < 4; i += 1) {
      const hh = String(15 + i).padStart(2, '0');
      lines.push(
        JSON.stringify({
          conversation_id: `CON-${SNAP_DAY.replace(/-/g, '')}-S${String(i).padStart(4, '0')}`,
          agent: 'workbuddy',
          start_time: `${SNAP_DAY}T${hh}:00:00+08:00`,
          end_time: `${SNAP_DAY}T${hh}:30:00+08:00`,
          settled_at: `${SNAP_DAY}T${hh}:35:00+08:00`,
          settlement_status: 'settled',
          total_token: 100,
          total_score: 0,
          status: 'completed',
          source: 'workbuddy',
          session_id: `sess-snap-${i}`,
        })
      );
    }
    fs.writeFileSync(path.join(dayDir, 'conversations.jsonl'), `${lines.join('\n')}\n`, 'utf8');

    const r = DS.detectSummaryStaleness(snapDir, SNAP_DAY, { threshold: 3 });
    ok('⑨ 跨日后仍能判定历史日报过期', r.stale === true, `实际 stale=${r.stale} reason=${r.reason}`);
    ok('⑨ reason 为 stale（不再静默 no_summary）', r.reason === 'stale', `实际 ${r.reason}`);
    ok(
      '⑨ 生成时间取自 md 快照头部',
      r.generated_at === `${SNAP_DAY} 14:36:00`,
      `实际 ${r.generated_at}`
    );
    ok('⑨ 新增会话数正确', r.new_conversations === 4, `实际 ${r.new_conversations}`);

    // ④ 反向条件：快照不存在时，仍如实报 no_summary（不臆造）
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-snap-empty-'));
    try {
      const r2 = DS.detectSummaryStaleness(emptyDir, SNAP_DAY, { threshold: 3 });
      ok('⑨ 无快照时仍报 no_summary', r2.stale === false && r2.reason === 'no_summary');
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }

    // ⑤ 只读性：回落读 md 不得写任何文件
    const mdPath2 = path.join(sdir, `${SNAP_DAY}.md`);
    const before = fs.readFileSync(mdPath2, 'utf8');
    DS.detectSummaryStaleness(snapDir, SNAP_DAY, { threshold: 3 });
    ok('⑨ 回落读快照不改写文件', before === fs.readFileSync(mdPath2, 'utf8'));
  } finally {
    fs.rmSync(snapDir, { recursive: true, force: true });
  }
}

/* ---------- 汇总 ---------- */
console.log(`\n通过 ${pass}　失败 ${fail}`);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(SANDBOX_HOME, { recursive: true, force: true });
} catch (e) {
  /* 清理失败不影响结论 */
}
process.exit(fail === 0 ? 0 : 1);
