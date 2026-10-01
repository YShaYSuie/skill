#!/usr/bin/env node
'use strict';
/**
 * status.js — 自动记录状态 / 安全状态查询（§56/§57/§12）。
 *
 * 两个命令都是**零 Token 操作**（§36）：只读本地文件与本地规则，不调用 AI。
 *
 * §57 要求必须区分三件事，不能把"Skill 已安装"理解为"自动记录已启动"：
 *   Skill 状态       —— 技能是否加载
 *   宿主触发状态     —— Codex / WorkBuddy 是否配置了 Hook / Event / 定时任务
 *   日志记录状态     —— 是否真的产生了可写入的活动
 *
 * 用法：
 *   status.js                  状态（§56 规范输出）
 *   status.js today            状态 + 今日记录
 *   status.js check [--json]   仅结构化检查结果
 *   status.js security         安全状态（§12/§55）
 *   status.js host --host <名称> --mechanism <hooks|skill|manual|unavailable>
 */

const fs = require('fs');
const C = require('./lib/log-core');

/** 不可获取的统一显示文案（数据层用 null，展示层说明原因） */
const NA_TEXT = '不可获取';

const USAGE = `status.js — 自动记录状态 / 安全状态（均为零 Token 操作）

  status.js [--json]                 查看状态（§56）
  status.js today [--json]           状态 + 今日记录
  status.js check [--json]           仅输出结构化检查项
  status.js security [--json]        查看安全状态（§12/§55）
  status.js host --host <codex|workbuddy|generic|other>
                 --mechanism <hooks|skill|manual|unavailable>
                 [--available true|false]
                 [--trigger-configured true|false]
                 [--note "说明"]
                                     登记宿主触发能力

状态含义：
  🟢 正在记录    已检测到有效宿主活动，并成功写入日志
  🟡 暂无活动    已开启，但近期没有检测到活动（或宿主触发未配置，等待手动触发）
  🔴 记录异常    日志无法写入 / 权限异常 / 适配器异常 / 文件锁异常 / 数据损坏
  ⚪ 未开启      auto_tracking=false 或运行状态暂停

注意：Skill 本身不是后台服务（§43）。能否自动记录取决于宿主是否配置了 Hook / Event。
`;

function load(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const status = C.computeStatus(dir, { includeToday: C.flagBool(flags, 'today') });
  // V3.0：附带对话结算状态（只读结构化日志，零 Token）
  try {
    status.settlement = settlementStatus(dir);
  } catch (e) {
    status.settlement = { enabled: true, error: String((e && e.message) || e) };
  }
  return { dir, status };
}

/**
 * 宿主是否**真的**把「对话结束结算」（任务A）挂上了 Hook。
 *
 * 为什么必须有这个函数（2026-09-22 实测踩实）：
 *   `/status` 早先用「今天有没有 conversation 记录」判定任务A，于是出现
 *   「绿灯 + 会话其实冻结在半路」的**静默故障** —— 记录只要被人手动补算过一次，
 *   就永远显示「🟢 已结算」，而实际上五个 Hook 全都没接结算。
 *   这与 §57「不能把『Skill 已安装』当成『自动记录已启动』」是同一条纪律：
 *   **数据存在 ≠ 触发已配**。
 *
 * 判定方式是直接看宿主配置里有没有引用 `settle-conversation.js`：
 *   能查到 → 说实话；一个宿主配置都没找到 → 返回 `configured: null`（不知道，不猜，不报警）。
 * 可用 `WTT_HOST_HOME` 覆盖家目录（测试用）。
 */
function detectSettleTrigger() {
  const path = require('path');
  const os = require('os');
  const home = process.env.WTT_HOST_HOME || os.homedir();
  const candidates = [
    path.join(home, '.workbuddy', 'settings.json'),
    path.join(home, '.workbuddy', 'settings.local.json'),
    path.join(home, '.codex', 'config.toml'),
  ];

  // 结算有两条可达路径，两条都要认：
  //   ① 直连：Hook 命令里出现 settle-conversation.js
  //   ② 间接：Hook 命令指向 hook-bridge.js，而它的 EVENT_PLAN 里有 settle 动作
  //      （这是本 skill 的推荐接法 —— Stop / SessionEnd 本来就已指向 hook-bridge）
  let bridgeHasSettle = false;
  try {
    const bridge = fs.readFileSync(path.join(__dirname, 'hook-bridge.js'), 'utf8');
    bridgeHasSettle = /settle:\s*true/.test(bridge) && /settle-conversation/.test(bridge);
  } catch (e) {
    /* 读不到就只认直连路径 */
  }

  const checked = [];
  const where = [];
  let invalidCodexHook = null;
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const text = fs.readFileSync(p, 'utf8');
      checked.push(p);
      if (text.includes('settle-conversation')) {
        where.push(`${p}（直连结算脚本）`);
      } else if (
        bridgeHasSettle &&
        (text.includes('hook-bridge') || text.includes('codex-hook-launcher'))
      ) {
        const unsafePowerShellHook =
          /^command(?:Windows|_windows)?\s*=\s*'"(?:[^']*hook-bridge\.js[^']*)'\s*$/m.test(
            text
          );
        if (unsafePowerShellHook) {
          invalidCodexHook = `${p}（Codex Hook 命令缺少 PowerShell & 调用符）`;
        } else {
          where.push(
            `${p}（经 ${
              text.includes('codex-hook-launcher') ? 'codex-hook-launcher' : 'hook-bridge'
            } 接 settle）`
          );
        }
      }
    } catch (e) {
      /* 读不到就当没查过，不影响状态查询本身 */
    }
  }
  if (!checked.length) {
    return { configured: null, checked: [], where: [], hint: '未找到宿主配置文件（无法判定）' };
  }
  if (invalidCodexHook) {
    return {
      configured: false,
      bridge_has_settle: bridgeHasSettle,
      checked,
      where,
      hint:
        `检测到不可执行的 Codex Hook：${invalidCodexHook}；` +
        '运行 ensure-codex-hooks.js --repair 修复',
    };
  }
  return {
    configured: where.length > 0,
    bridge_has_settle: bridgeHasSettle,
    checked,
    where,
    hint: where.length
      ? null
      : `已检查 ${checked.length} 个宿主配置：既没有直连 settle-conversation.js，` +
        `hook-bridge.js 的 Hook 里也没有 settle 动作`,
  };
}

/**
 * V3.0：对话结算状态（只读、零 Token）。
 *
 * 回答用户最关心的那个问题：**「对话结束到底有没有被立即结算？」**
 * 用两条独立的证据回答，缺一不可：
 *   ① 行为证据 —— 结构化日志里有没有今天的记录（`conversations` 等计数）
 *   ② 触发证据 —— 宿主 Hook 里有没有接 `settle-conversation.js`（`trigger`）
 * 只靠 ① 会把「人工补算」误判成「自动结算已配」（2026-09-22 修正）。
 *
 * 与 §57「不能把『Skill 已安装』当成『自动记录已启动』」同一纪律。
 */
function settlementStatus(dir) {
  let CS;
  try {
    CS = require('./lib/conversation-store');
  } catch (e) {
    return { available: false, label: '不可用', reason: String((e && e.message) || e) };
  }
  const cfg = C.readConfig(dir);
  const today = C.today();
  const out = {
    enabled: cfg.settlement ? cfg.settlement.enabled !== false : true,
    auto_on_conversation_end: cfg.settlement ? cfg.settlement.auto_on_conversation_end !== false : true,
    // 触发证据：宿主 Hook 里到底有没有接 settle-conversation.js（null = 查不到，不猜）
    trigger: detectSettleTrigger(),
    skill_token_method: (cfg.settlement && cfg.settlement.skill_token_method) || 'injection',
    date: today,
    conversations: 0,
    skill_usages: 0,
    activities: 0,
    total_token: 0,
    total_score: 0,
    score_known: 0,
    raw_snapshots: 0,
    latest_settled_at: null,
    has_any_logs: false,
  };
  try {
    const convs = CS.read(dir, 'conversation', today);
    const skills = CS.read(dir, 'skill_usage', today);
    const acts = CS.read(dir, 'work_activity', today);
    out.conversations = convs.length;
    out.skill_usages = skills.length;
    out.activities = acts.length;
    for (const c of convs) {
      if (typeof c.total_token === 'number') out.total_token += c.total_token;
      if (typeof c.total_score === 'number') {
        out.total_score += c.total_score;
        out.score_known += 1;
      }
      // 结算时间优先用 settled_at，回退 updated_at（兼容 V3.0 记录）
      const at = c.settled_at || c.updated_at;
      if (at && (!out.latest_settled_at || at > out.latest_settled_at)) {
        out.latest_settled_at = at;
      }
    }
    out.total_score = out.total_score ? CS.round6(out.total_score) : 0;
    out.raw_snapshots = CS.listRawSnapshotFiles(dir, today).length;
    out.has_any_logs = fs.existsSync(CS.logsDir(dir)) || fs.existsSync(CS.structuredDir(dir));
  } catch (e) {
    out.error = String((e && e.message) || e);
  }
  return out;
}

/** 把结算状态渲染成几行（无记录时也只有一行，不刷屏） */
function renderSettlement(st) {
  const L = [];
  if (!st) return L;
  if (!st.enabled) {
    L.push('对话结算：🔴 已在 config.settlement.enabled 中关闭');
    return L;
  }
  if (st.error) {
    L.push(`对话结算：🔴 读取结构化日志失败（${st.error}）`);
    return L;
  }

  // 触发证据（2026-09-22 新增）：configured=false 表示「宿主 Hack 里没接结算」，
  // true 表示已接，null 表示一个宿主配置都没找到（无法判定）。
  const trig = st.trigger || {};
  const triggerMissing = trig.configured === false;
  const triggerLine = triggerMissing
    ? `  宿主触发：🔴 未配置 —— ${trig.hint}` +
      '\n    已结算的记录只可能来自人工补算，不会随对话继续刷新（Token / 时长会偏小）。'
    : trig.configured === true
      ? `  宿主触发：🟢 已配置（${(trig.where || []).join('、')}）`
      : `  宿主触发：○ 无法判定（${trig.hint || '未找到宿主配置文件'}）`;

  if (!st.conversations && !st.skill_usages && !st.activities) {
    L.push(
      triggerMissing
        ? '对话结算：🔴 今日尚未结算，且宿主触发未配置'
        : `对话结算：🟡 今日尚未结算任何对话${
            st.has_any_logs ? '' : '（尚无 logs/ 目录）'
          }`
    );
    if (!triggerMissing) {
      L.push(`  ${trig.configured === true ? '触发已配置' : '若今天确实用过 Agent，说明任务1（Conversation End Handler）还没接上'}。`);
    }
    L.push(triggerLine);
    L.push('  手动补算：node scripts/settle-conversation.js --backfill');
    return L;
  }

  // 有记录 ≠ 触发已配 —— 这两个信号必须分开报，否则会再次静默（见 detectSettleTrigger 注释）
  L.push(triggerMissing ? '对话结算：🟡 已结算，但宿主触发未配置（数据来源可疑）' : '对话结算：🟢 已结算');
  L.push(
    `  今日 Conversation ${st.conversations} 次　Skill 调用 ${st.skill_usages} 次` +
      `${st.activities ? `　Work Activity ${st.activities} 条` : ''}`
  );
  L.push(
    `  Token 合计 ${st.total_token.toLocaleString('en-US')}　Score / Credit ${
      st.score_known ? st.total_score : NA_TEXT
    }${st.score_known && st.score_known < st.conversations ? '（下界：部分对话无积分记录）' : ''}`
  );
  L.push(
    `  Skill token 口径：${
      st.skill_token_method === 'off' ? 'off（一律 null）' : 'injection（载入体积）'
    }`
  );
  if (st.latest_settled_at) L.push(`  最近结算时间：${st.latest_settled_at}`);
  L.push(triggerLine);
  if (triggerMissing) {
    L.push('  修复：references/automation.md §5（给 hook-bridge 的 Stop/SessionEnd 接 settle）');
    L.push('  补算：node scripts/settle-conversation.js --backfill');
  }
  return L;
}

const RULE = '────────────────────';

/** §56 规范输出 */
function render(s) {
  const L = [];
  L.push('工作时间自动记录');
  L.push(RULE);
  L.push('');
  L.push('Skill：');
  L.push(`${s.skill.emoji} ${s.skill.label}`);
  L.push('');
  L.push('自动记录：');
  L.push(`${s.overall.emoji} ${s.overall.status_label}`);
  if (s.overall.reasons.length) s.overall.reasons.forEach((r) => L.push(`  - ${r}`));
  L.push('');
  L.push(`宿主触发：${s.host_trigger.emoji} ${s.host_trigger.label}`);
  L.push('');
  L.push('触发来源：');
  L.push(s.host_trigger.text);
  if (s.hosts.length) {
    L.push('');
    s.hosts.forEach((h) => {
      L.push(`${h.label}：${h.emoji}`);
      L.push(
        `  采集机制 ${h.mechanism || '未登记'}${
          h.trigger_configured ? '　宿主触发已配置' : '　宿主触发未配置'
        }`
      );
      if (h.reason && h.level !== 'recording') L.push(`  ${h.reason}`);
    });
  }
  L.push('');
  L.push('手动：○（/start、/log 与自然语言记录，作为人工兜底，§6）');
  // V3.0：对话结算状态（任务A 是否真的跑起来了）—— 用结构化日志的实证判定，不看配置
  const settleLines = renderSettlement(s.settlement);
  if (settleLines.length) {
    L.push('');
    L.push(...settleLines);
  }
  const hostErrors = s.hosts.filter((h) => h.level === 'error');
  if (hostErrors.length) {
    L.push('');
    L.push(
      `注意：以下宿主无法自动采集活动 —— ${hostErrors
        .map((h) => `${h.label}（${h.reason}）`)
        .join('、')}`
    );
  }
  L.push('');
  L.push('日志目录：');
  L.push(s.log_directory);
  L.push(
    `  可读 ${s.checks.log_directory_readable ? '✓' : '✗'}　可写 ${
      s.checks.log_directory_writable ? '✓' : '✗'
    }　manifest ${s.checks.manifest}　log_id ${s.checks.log_id || '-'}`
  );
  L.push('');
  L.push('今日事项：');
  L.push(String(s.today.count));
  L.push('');
  L.push('进行中：');
  L.push(String(s.today.in_progress));
  L.push('');
  L.push('待确认：');
  L.push(String(s.today.needs_confirmation + s.today.pending_items));
  L.push('');
  L.push('最近活动：');
  L.push(s.last_event_time || '暂无');
  L.push('');
  L.push(RULE);
  L.push('');
  L.push('自动AI：');
  L.push('');
  L.push('调用次数：');
  L.push(`${s.ai.automatic_calls_today} / ${s.ai.safety_max_calls_per_day}`);
  L.push('');
  L.push('状态：');
  L.push(s.ai.blocked ? `🔴 ${s.ai.block_reason}` : '🟢 正常');
  L.push('');
  L.push('手动AI：');
  L.push(`${s.ai.manual_calls_today} 次（不受安全熔断限制，§35）`);
  L.push('');
  L.push(RULE);
  L.push('');
  L.push('今日总结：');
  L.push(s.summary_saved ? `已生成（${s.summary_trigger || 'manual'}）` : '未执行');
  if (s.last_automatic_summary_date) L.push(`最近自动总结：${s.last_automatic_summary_date}`);
  L.push('');
  L.push(RULE);
  L.push('');
  L.push('TickTick同步：');
  L.push(
    s.sync.status === 'success'
      ? '已同步'
      : s.sync.status === 'failed'
      ? '同步失败'
      : s.sync.status === 'partial'
      ? '部分成功'
      : '未触发'
  );
  if (s.pending_sync_dates.length) L.push(`待同步日期：${s.pending_sync_dates.join('、')}`);
  L.push('');
  L.push('同步方式：');
  L.push(s.sync_modes.join(' / '));
  L.push('');
  L.push('同步Skill：');
  L.push(s.sync_skill);
  L.push('');
  L.push(RULE);
  L.push('');
  L.push('Skill 不是后台服务：不会自行创建进程或定时器。');
  L.push('自动记录依赖宿主 Hook / Event；定时总结与同步由宿主任务触发（§43/§45）。');
  return L.join('\n');
}

function renderToday(s) {
  const L = [render(s), '', RULE, ''];
  L.push('今日工作：');
  const records = (s.daily_log && s.daily_log.records) || [];
  if (!records.length) {
    L.push('（暂无记录）');
  } else {
    records
      .slice()
      .sort((a, b) => {
        const av = C.toMinutes(a.start_time);
        const bv = C.toMinutes(b.start_time);
        return (av === null ? 1e9 : av) - (bv === null ? 1e9 : bv);
      })
      .forEach((r) => {
        L.push(`${C.recordSpan(r)}  ${r.content}`);
        L.push(
          `  来源 ${C.SOURCE_LABEL[r.source] || r.source}　状态 ${
            C.STATUS_LABEL[r.status] || r.status
          }`
        );
      });
    L.push('');
    L.push(
      `合计：事项累计 ${s.stats.work_item_total_minutes} 分钟　实际占用 ${
        s.stats.wall_clock_minutes
      } 分钟（§17.1）`
    );
  }
  if (s.active_work_items.length) {
    L.push('');
    L.push('进行中：');
    s.active_work_items.forEach((a) => L.push(a.content));
  }
  const needsConfirm = records.filter((r) => r.status === 'needs_confirmation');
  const pending = (s.daily_log && s.daily_log.pending_items) || [];
  if (needsConfirm.length || pending.length) {
    L.push('');
    L.push('待确认：');
    needsConfirm.forEach((r) =>
      L.push(
        `${r.start_time || '--:--'}  ${r.content}（${
          r.start_time ? '缺少结束时间' : '缺少开始时间'
        }）`
      )
    );
    pending.forEach((p) => L.push(`${p.time || p.timestamp || '--:--'}  ${p.content}`));
  }
  return L.join('\n');
}

/** §12/§55 安全状态 */
function renderSecurity(dir, s) {
  const L = ['工作时间自动记录 · 安全状态', ''];
  L.push(`严格模式：${s.security.strict_mode ? '开启' : '关闭'}`);
  L.push('');
  L.push('访问边界：');
  s.security.access_boundaries.forEach((b) =>
    L.push(`  ${b.label}：${b.fixed === 'restricted' ? '已限制' : '关闭'}`)
  );
  L.push('');
  L.push('记录禁止项：');
  s.security.record_prohibitions.forEach((p) => L.push(`  记录${p.label}：关闭`));
  L.push('');
  L.push(`内容脱敏：${s.security.redact_sensitive ? '开启' : '关闭'}`);
  L.push(`单条内容上限：${s.security.max_activity_length} 字`);
  L.push(`结构化 detail 上限：${s.security.max_detail_length || 4000} 字`);
  L.push(
    s.security.ai_summarize
      ? `超长处理：AI 压缩（超时 ${s.security.ai_summarize_timeout_sec}s；失败才截断）`
      : '超长处理：直接截断（AI 压缩已关闭，完全离线）'
  );
  L.push(`日志目录：${dir}`);
  L.push('');
  L.push('本地脱敏规则：');
  L.push('  ' + s.security.rules.map((r) => r.label).join('、'));
  return L.join('\n');
}

C.runMain(() => {
  const { pos, flags } = C.parseArgs(process.argv.slice(2));
  const cmd = pos[0] || 'show';

  if (cmd === 'help' || C.flagBool(flags, 'help')) {
    C.emitText(USAGE);
    return C.EXIT.OK;
  }

  if (cmd === 'host' || cmd === 'collector') {
    const dir = C.resolveDir(C.flagStr(flags, 'dir'));
    C.ensureWritable(dir);
    const host = C.flagStr(flags, 'host') || C.flagStr(flags, 'tool');
    if (!host) throw new C.LogError('host 需要 --host <codex|workbuddy|generic|other>');
    if (!C.VALID_SOURCE.includes(host)) {
      throw new C.LogError(`--host 非法：${host}（允许：${C.VALID_SOURCE.join(', ')}）`);
    }
    const mechanism = C.flagStr(flags, 'mechanism') || 'unknown';
    if (!C.VALID_MECHANISM.includes(mechanism)) {
      throw new C.LogError(
        `--mechanism 非法：${mechanism}（允许：${C.VALID_MECHANISM.join(', ')}）`
      );
    }
    const availableRaw = C.flagStr(flags, 'available');
    const available =
      availableRaw === null ? mechanism !== 'unavailable' : availableRaw !== 'false';
    // §57：宿主触发是否**真的已配置**由调用方如实声明，不得默认假定已配置
    const triggerRaw = C.flagStr(flags, 'trigger-configured');
    const triggerConfigured =
      triggerRaw === null
        ? mechanism !== 'unavailable' && mechanism !== 'manual'
        : triggerRaw !== 'false';
    const result = C.runMutation(
      dir,
      'workbuddy',
      [
        {
          kind: 'host',
          registry: {
            host,
            tool: host,
            mechanism,
            available,
            trigger_configured: triggerConfigured,
            note: C.flagStr(flags, 'note') || null,
            registered_at: C.nowIso(),
            registered_by: 'status.js',
          },
        },
      ],
      {}
    );
    C.emit({
      action: 'host_registered',
      version: result.log.version,
      host: result.applied[0].host,
      note:
        mechanism === 'hooks'
          ? '已登记为宿主生命周期 Hook 触发（自动记录）。'
          : mechanism === 'skill'
          ? '已登记为宿主事件/Skill 触发。'
          : mechanism === 'manual'
          ? '已登记为仅手动触发（宿主能力不足，§42）。'
          : '已登记为自动触发不可用。',
    });
    return C.EXIT.OK;
  }

  if (cmd === 'check') {
    const { status } = load(flags);
    C.emit(status);
    return C.EXIT.OK;
  }

  if (cmd === 'security') {
    const dir = C.resolveDir(C.flagStr(flags, 'dir'));
    const s = C.computeStatus(dir);
    if (C.flagBool(flags, 'json')) {
      C.emit({
        log_directory: dir,
        security: s.security,
        checks: { strict_mode: true, log_directory_only: true },
        note: '安全状态为本地规则，不调用 AI（§36）。',
      });
      return C.EXIT.OK;
    }
    C.emitText(renderSecurity(dir, s));
    return C.EXIT.OK;
  }

  if (cmd !== 'show' && cmd !== 'today') {
    C.emitText(USAGE);
    throw new C.LogError(`未知子命令：${cmd}`);
  }

  const withToday = cmd === 'today';
  const { dir, status } = load(Object.assign({}, flags, { today: withToday ? 'true' : null }));
  if (C.flagBool(flags, 'json')) {
    C.emit(status);
    return C.EXIT.OK;
  }
  C.emitText(withToday ? renderToday(status) : render(status));
  if (!status.initialized) {
    C.emitText('');
    C.emitText(`提示：日志目录尚未就绪（${dir}）。请先指定一个本地日志目录并初始化（§7）。`);
  }
  return C.EXIT.OK;
});
