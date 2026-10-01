#!/usr/bin/env node
'use strict';
/**
 * test-activity-link.js — 「事项 ↔ 会话」关联与项目归属的回归测试（零依赖、离线）。
 *
 * 覆盖本次修复（V3.4）的两个真实故障：
 *
 * ```text
 * ① Conversation Log 的 project 恒为 null
 *    → 会话有 project_id 却没解析出名称，「按项目看 Token」永远是空表
 * ② Work Activity 的 conversation_id 恒为 null
 *    → 事项侧丢了 session_id，导出后无法挂回会话，成本归因整条断链
 * ```
 *
 *   node scripts/test-activity-link.js
 *
 * 退出码 0 = 全部通过；1 = 存在偏差。**只在临时目录里写数据**。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const SP = require(path.join(__dirname, 'lib', 'space-projects.js'));
const PR = require(path.join(__dirname, 'lib', 'project-resolver.js'));
const CS = require(path.join(__dirname, 'lib', 'conversation-store.js'));
const AL = require(path.join(__dirname, 'lib', 'activity-link.js'));
const EX = require(path.join(__dirname, 'export-work-activities.js'));

let fail = 0;
const ok = (desc, cond, extra) => {
  if (!cond) fail += 1;
  console.log(`  ${cond ? '✔' : '✘'}  ${desc}${extra && !cond ? '  → ' + extra : ''}`);
};
const section = (t) => {
  console.log();
  console.log(`=== ${t} ===`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-link-'));
const PID = 'p_ff834e75564f4baab995b39ace8c38b5';
const SESSION_LINKED = 'sess-settled-0001';
const SESSION_UNSETTLED = 'sess-unsettled-0002';
const DATE = '2026-01-05';

// 夹具：一个带空间项目名称缓存的日志目录
SP.writeCache(tmp, { [PID]: '气象数据' });
fs.mkdirSync(path.join(tmp, 'logs'), { recursive: true });
PR.clearMemo(); // 清掉可能被上一轮测试记忆的缓存

/* ------------------------------------------------------------------ *
 * 1. project-resolver：项目名从哪来
 * ------------------------------------------------------------------ */
section('1. 项目归属解析（project_id → 名称）');
const cfgEmpty = { project_map: {} };
const r1 = PR.resolveProjectContext({ projectId: PID, cwd: 'E:/whatever' }, { config: cfgEmpty, dir: tmp });
ok('缓存命中 → 名称解析成功', r1.project_name === '气象数据', JSON.stringify(r1));
ok('来源标为 space_project', r1.project_source === 'space_project');
ok('保留 project_id 便于溯源', r1.project_id === PID);
ok('置信度 high', r1.project_confidence === 'high');

const r2 = PR.resolveProjectContext(
  { projectId: PID },
  { config: { project_map: { [PID]: '气象数据系统' } }, dir: tmp }
);
ok('project_map 覆盖优先于缓存', r2.project_name === '气象数据系统', JSON.stringify(r2));

const r3 = PR.resolveProjectContext({ projectId: 'p_unknown' }, { config: cfgEmpty, dir: tmp });
ok('有 project_id 但无名称 → project 为 null', r3.project_name === null);
ok('无名称时仍保留 project_id（不丢线索）', r3.project_id === 'p_unknown');
ok('来源标为 space_project_unmapped', r3.project_source === 'space_project_unmapped');

const r4 = PR.resolveProjectContext({ cwd: 'D:/workBuddy/2026-01-01-00-00-00' }, { config: cfgEmpty, dir: tmp });
ok('无空间项目且目录未登记 → 不猜，返回 null', r4.project_name === null, JSON.stringify(r4));
ok('来源标为 cwd_unregistered', r4.project_source === 'cwd_unregistered');

const r5 = PR.resolveProjectContext(
  { existingName: '人工确认过的项目' },
  { config: cfgEmpty, dir: tmp }
);
ok('记录里已有项目名 → 原样尊重，不被机器覆盖', r5.project_name === '人工确认过的项目');

/* ------------------------------------------------------------------ *
 * 2. Conversation Log：project 必须落盘
 * ------------------------------------------------------------------ */
section('2. Conversation Log 的 project（此前恒为 null）');
CS.upsertConversation(
  tmp,
  {
    conversation_id: 'CON-20260105-AAAA1111',
    session_id: SESSION_LINKED,
    date: DATE,
    start_time: `${DATE}T09:00:00+08:00`,
    end_time: `${DATE}T10:00:00+08:00`,
    total_token: 12345,
    project: '气象数据',
    project_id: PID,
    project_source: 'space_project',
    project_confidence: 'high',
  },
  { date: DATE }
);
const convBack = CS.read(tmp, 'conversation', DATE)[0];
ok('project 落盘', convBack.project === '气象数据', JSON.stringify(convBack.project));
ok('project_id 一并保留', convBack.project_id === PID);
ok('project_source 落盘（可解释 null 的原因）', convBack.project_source === 'space_project');
ok('project_confidence 落盘', convBack.project_confidence === 'high');

const convNull = CS.normalizeConversation({
  conversation_id: 'CON-20260105-BBBB2222',
  session_id: 'x',
  project: null,
  project_source: 'space_project_unmapped',
});
ok('未命名空间项目：project=null 但 source 说明原因', convNull.project === null && convNull.project_source === 'space_project_unmapped');
ok('project_source 不会被空值归一化抹掉', convNull.project_source !== null);

const convBad = CS.normalizeConversation({
  conversation_id: 'CON-20260105-CCCC3333',
  session_id: 'y',
  project_confidence: 'very-high',
});
ok('非法置信度被拒（不留脏值）', convBad.project_confidence === null);

/* ------------------------------------------------------------------ *
 * 3. session → conversation 索引
 * ------------------------------------------------------------------ */
section('3. 会话索引（只认日志里确实存在的对话）');
const built = AL.buildSessionConversationIndex(tmp);
ok('索引含已结算会话', built.index[SESSION_LINKED] === 'CON-20260105-AAAA1111', JSON.stringify(built.index));
ok('未结算会话不在索引里', AL.conversationIdOf(SESSION_UNSETTLED, built.index) === null);
ok('未知 session → null（不派生）', AL.conversationIdOf('nope', built.index) === null);
ok('空 session → null', AL.conversationIdOf('', built.index) === null);

/* ------------------------------------------------------------------ *
 * 4. 导出：conversation_id 按证据挂，不按证据不挂
 * ------------------------------------------------------------------ */
section('4. 导出 Work Activity 时的 conversation_id');
const ctx = { convBySession: built.index };
const aLinked = EX.toActivity(
  { id: 'WI-1', date: DATE, content: '整理需求', session_id: SESSION_LINKED },
  ctx
);
ok('有 session 且会话已结算 → 挂上 conversation_id', aLinked.conversation_id === 'CON-20260105-AAAA1111');
ok('session_id 作为证据留档', aLinked.session_id === SESSION_LINKED);

const aUnsettled = EX.toActivity(
  { id: 'WI-2', date: DATE, content: '待结算的活', session_id: SESSION_UNSETTLED },
  ctx
);
ok('会话尚未结算 → conversation_id 为 null（不编造 ID）', aUnsettled.conversation_id === null);
ok('但证据 session_id 仍留档（供结算后回链）', aUnsettled.session_id === SESSION_UNSETTLED);

const aManual = EX.toActivity({ id: 'WI-3', date: DATE, content: '散步', source: 'manual' }, ctx);
ok('人工事项无 session → conversation_id 为 null（合法常态）', aManual.conversation_id === null);
ok('人工事项 session_id 也为 null', aManual.session_id === null);

const aExplicit = EX.toActivity(
  { id: 'WI-4', date: DATE, content: 'x', conversation_id: 'CON-EXPLICIT', session_id: 'z' },
  ctx
);
ok('WorkItem 已有 conversation_id → 直接沿用', aExplicit.conversation_id === 'CON-EXPLICIT');

const aNoCtx = EX.toActivity({ id: 'WI-5', date: DATE, content: 'y', session_id: SESSION_LINKED });
ok('没有索引时退回 null（宁缺不猜）', aNoCtx.conversation_id === null);

/* ------------------------------------------------------------------ *
 * 5. 回链：时序倒置时的自愈 + 幂等
 * ------------------------------------------------------------------ */
section('5. 回链（事项先导出、会话后结算）');
CS.upsertWorkActivity(
  tmp,
  [
    { date: DATE, content: '待结算的活', session_id: SESSION_UNSETTLED, conversation_id: null, source: 'agent', work_item_id: 'WI-2' },
    { date: DATE, content: '散步', source: 'manual', conversation_id: null, work_item_id: 'WI-3' },
  ],
  { date: DATE }
);

const dry1 = AL.relinkActivities(tmp, { dryRun: true });
ok('会话还没结算 → 回链 0 条', dry1.linked === 0, JSON.stringify(dry1));
ok('如实记入 unresolved（不是静默忽略）', dry1.unresolved === 1 && dry1.unresolved_sessions.includes(SESSION_UNSETTLED));
ok('无证据的记入 no_evidence', dry1.no_evidence === 1);

// 现在把会话结算掉
CS.upsertConversation(
  tmp,
  {
    conversation_id: 'CON-20260105-DDDD4444',
    session_id: SESSION_UNSETTLED,
    date: DATE,
    start_time: `${DATE}T11:00:00+08:00`,
    end_time: `${DATE}T12:00:00+08:00`,
    total_token: 999,
  },
  { date: DATE }
);

const relink1 = AL.relinkActivities(tmp, {});
ok('结算后回链成功', relink1.linked === 1, JSON.stringify(relink1));
const after = CS.read(tmp, 'work_activity', DATE);
const fixed = after.find((a) => a.content === '待结算的活');
ok('conversation_id 已写入永久日志', fixed.conversation_id === 'CON-20260105-DDDD4444', JSON.stringify(fixed.conversation_id));
ok('人工事项仍为 null（不被牵连）', after.find((a) => a.content === '散步').conversation_id === null);

const relink2 = AL.relinkActivities(tmp, {});
ok('重复回链幂等：不再新增关联', relink2.linked === 0, JSON.stringify(relink2));
ok('重复回链幂等：unchanged 被识别', relink2.updated === 0);
ok('第二次把已有 onelink 记为 already_linked', relink2.already_linked === 1);

// 结算场景：conversation_id 已知，直接传答案（不构建整份索引）
CS.upsertWorkActivity(
  tmp,
  [{ date: DATE, content: '结算时直接回链', session_id: 'sess-direct-3', conversation_id: null, source: 'agent' }],
  { date: DATE }
);
const relinkDirect = AL.relinkActivities(tmp, {
  onlySessionId: 'sess-direct-3',
  knownConversationId: 'CON-DIRECT-KNOWN',
});
ok('结算路径：已知 conversation_id 时直接回链', relinkDirect.linked === 1, JSON.stringify(relinkDirect));
ok(
  '结算路径：写回的就是调用方给的 ID（不去猜）',
  CS.read(tmp, 'work_activity', DATE).find((a) => a.content === '结算时直接回链').conversation_id ===
    'CON-DIRECT-KNOWN'
);
const relinkDirect2 = AL.relinkActivities(tmp, {
  onlySessionId: 'sess-direct-3',
  knownConversationId: 'CON-DIRECT-KNOWN',
});
ok('结算路径重复调用幂等', relinkDirect2.linked === 0 && relinkDirect2.updated === 0);

/* ------------------------------------------------------------------ *
 * 6. 归因覆盖率：改动后确实算得出项目维度成本
 * ------------------------------------------------------------------ */
section('6. 归因覆盖率（成本归因能不能算出数）');
const total = after.length;
const linked = after.filter((a) => a.conversation_id).length;
ok('存在可归因的事项（>0）', linked > 0, `linked=${linked}/${total}`);
ok('覆盖率不被虚增：无证据的仍是 0', after.filter((a) => !a.conversation_id && !a.session_id).length === 1);

fs.rmSync(tmp, { recursive: true, force: true });
PR.clearMemo();

/* ------------------------------------------------------------------ *
 * 7. 端到端：采集 → 回写成事项 → 导出 → 结算回链
 *
 *    这一段专门锁死本次的真实故障链路：
 *    Hook 的 session_id 在「批量判定回写」这一步被丢掉，导致导出时无从挂账。
 * ------------------------------------------------------------------ */
section('7. 端到端链路（Hook → 事项 → 导出 → 回链）');
{
  const { spawnSync } = require('child_process');
  const SCRIPT_DIR = __dirname;
  const node = process.execPath;
  const e2eDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-e2e-'));
  const SID = 'e2e-session-abc';

  const cli = (script, args) =>
    spawnSync(node, [path.join(SCRIPT_DIR, script)].concat(args), {
      cwd: SCRIPT_DIR,
      encoding: 'utf8',
      timeout: 60000,
      env: Object.assign({}, process.env, {
        WORK_TIME_TRACKING_DIR: e2eDir,
        HOME: e2eDir,
        USERPROFILE: e2eDir,
      }),
    });

  // CLI 输出是**缩进过的单个 JSON 对象**（C.emit 的格式），不能按行取最后一行
  const parseOut = (text) => {
    const t = String(text || '').trim();
    if (!t) return {};
    try {
      return JSON.parse(t);
    } catch (e) {
      /* 落下去找最后一个可解析的 JSON 对象 */
    }
    for (let i = t.length - 1; i >= 0; i -= 1) {
      if (t[i] !== '{') continue;
      try {
        return JSON.parse(t.slice(i));
      } catch (e) {
        /* 继续往前找 */
      }
    }
    return {};
  };

  const init = cli('init-log.js', ['init', '--dir', e2eDir, '--create']);
  ok('初始化日志目录', init.status === 0, (init.stdout || '').slice(-300) + (init.stderr || '').slice(-300));

  const ing = cli('collect-activity.js', [
    'ingest', '--dir', e2eDir, '--force',
    '--event', 'UserPromptSubmit',
    '--content', '整理中大气象原型的仪器参数配置',
    '--session', SID,
    '--timestamp', new Date().toISOString(),
  ]);
  const ingOut = parseOut(ing.stdout);
  ok('采集入队成功', ing.status === 0 && ingOut.action === 'queued', (ing.stdout || '').slice(-300));

  const pendOut = parseOut(cli('collect-activity.js', ['pending', '--dir', e2eDir, '--json']).stdout);
  const queue = pendOut.pending_items || [];
  ok('队列里有 1 条待判断事项', queue.length === 1, JSON.stringify(queue).slice(0, 300));
  const hash = queue[0] && (queue[0].hash || queue[0].id);
  ok('待判断事项保留了 session_id（此前在这里丢的）', queue[0] && queue[0].session_id === SID, JSON.stringify(queue[0] && queue[0].session_id));

  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;

  const ap = cli('collect-activity.js', [
    'apply', '--dir', e2eDir, '--hash', String(hash), '--new',
    '--content', '整理中大气象原型的仪器参数配置',
    '--start', '09:00', '--trigger', 'auto_analysis',
  ]);
  ok('批量判定回写成功（新建事项）', ap.status === 0, (ap.stdout || '').slice(-400));

  const cur = JSON.parse(fs.readFileSync(path.join(e2eDir, 'current.json'), 'utf8'));
  const wi = (cur.records || [])[0];
  ok('事项已生成', Boolean(wi && wi.id));
  ok('事项带上了 session_id（本轮修复的核心）', wi && wi.session_id === SID, wi ? JSON.stringify(wi.session_id) : 'no item');

  // 导出（会话尚未结算 → 应留 null 但保留证据）
  const ex1 = cli('export-work-activities.js', ['--dir', e2eDir, '--date', todayStr]);
  const ex1Out = parseOut(ex1.stdout);
  ok('导出成功', ex1.status === 0 && ex1Out.action === 'exported', (ex1.stdout || '').slice(-400));
  ok('导出报告如实披露关联覆盖率', ex1Out.link_coverage && ex1Out.link_coverage.session_not_settled === 1, JSON.stringify(ex1Out.link_coverage));
  const acts1 = CS.read(e2eDir, 'work_activity', todayStr);
  ok('导出产物有 1 条', acts1.length === 1, JSON.stringify(acts1).slice(0, 300));
  ok('结算前：conversation_id 为 null（不编造）', acts1[0].conversation_id === null);
  ok('结算前：session_id 作为证据保留', acts1[0].session_id === SID);

  // 结算这次会话（等价于「事项先导出、会话后结算」的时序）
  CS.upsertConversation(
    e2eDir,
    {
      conversation_id: 'CON-E2E-0001',
      session_id: SID,
      date: todayStr,
      start_time: `${todayStr}T09:00:00+08:00`,
      end_time: `${todayStr}T09:30:00+08:00`,
      total_token: 4321,
    },
    { date: todayStr }
  );

  const rel = cli('settle-conversation.js', ['--relink', '--dir', e2eDir]);
  const relOut = parseOut(rel.stdout);
  ok('回链命令执行成功', rel.status === 0, (rel.stdout || '').slice(-400));
  ok('回链补上了 1 条', relOut.activities && relOut.activities.linked === 1, JSON.stringify(relOut.activities));

  const acts2 = CS.read(e2eDir, 'work_activity', todayStr);
  ok('永久日志里的 conversation_id 已补齐', acts2[0].conversation_id === 'CON-E2E-0001', JSON.stringify(acts2[0].conversation_id));

  const rel2Out = parseOut(cli('settle-conversation.js', ['--relink', '--dir', e2eDir]).stdout);
  ok('再次回链幂等：linked=0', rel2Out.activities && rel2Out.activities.linked === 0, JSON.stringify(rel2Out.activities));
  ok('再次回链：识别为 already_linked', rel2Out.activities && rel2Out.activities.already_linked === 1);

  fs.rmSync(e2eDir, { recursive: true, force: true });
}

console.log();
console.log(fail === 0 ? '✓ 全部通过' : `✗ 存在 ${fail} 处偏差 / 共 ${fail} 项`);
process.exit(fail === 0 ? 0 : 1);
