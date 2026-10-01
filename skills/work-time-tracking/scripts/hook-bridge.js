#!/usr/bin/env node
'use strict';
/**
 * hook-bridge.js — 宿主 Hook 桥接脚本（§3.1 / §43）。
 *
 * 宿主（WorkBuddy / Codex）在会话生命周期节点调用本脚本，stdin 传入事件 JSON：
 *
 *   { "hook_event_name": "...", "session_id": "...", "cwd": "...", ... }
 *
 * 本脚本把事件转成统一 Activity，再交给 collect-activity.js 处理。
 * 它**只做桥接**，不含任何定时器与后台逻辑（§2.2/§61）。
 * 顶层使用 async IIFE（readStdinAsync 是异步的）。
 *
 * 三条硬约束：
 *   1. **绝不向 stdout 输出任何内容。** SessionStart / UserPromptSubmit 的 stdout
 *      会被宿主当作上下文注入对话，污染会话。
 *   2. **永远退出码 0。** Hook 失败不得阻断用户会话。
 *   3. **快速返回。** 子进程以 detached 方式发射后立即返回（fire-and-forget），
 *      即使宿主在 10s 预算内杀死本进程，子进程也会独立完成写入；
 *      写失败由 collect-activity 暂存 op 待重放。
 *
 * 2026-09-22 第二次修复（超时复发）：
 *   fire-and-forget 只解决了「子进程阻塞父进程」，但 readStdin() 仍用
 *   fs.readSync(0, …) 同步等 EOF —— Windows 上管道写端未关闭时 readSync
 *   会无限阻塞（宿主若等进程退出才关管道即死锁），10s 预算照样耗尽。
 *   现改为异步读 + 硬截止（STDIN_DEADLINE_MS），并把 writeTrace /
 *   hasInProgressItem 对 log-core 的 require 从热路径摘除（直接读文件）。
 *
 * 2026-09-22 第三次修复（超时仍偶发）—— 依据宿主日志实证：
 *   宿主按 `<bash.exe> -c "<node> hook-bridge.js >/dev/null 2>&1"` 调用本脚本，
 *   预算 10s，并在日志里如实记账：
 *     [HookExecutor] spawn pid=… shell=bash.exe timeout=10000ms cmd=…
 *     [HookExecutor] abnormal exit pid=… code=0 elapsed=12413ms timedOut=true
 *   记账时长**包含本机 Git Bash 冷启动（实测 1.2~3.9s）、node 冷启动（实测 ~0.6s）**
 *   以及本脚本自身耗时；12.4s 那次发生在应用重启 + 多会话并发期间，属于成本叠加。
 *
 *   ⚠️ 2026-09-23 修正（早前把该口径误判为「仅 bash 包装进程的存活时长」）：
 *   同刻另一个与本技能无关的 Hook —— tencent-docx 插件 SessionStart 的 setup.sh ——
 *   命令里**已经显式写了 `& ... </dev/null >/dev/null 2>&1` 后台化**，
 *   宿主却仍记 `elapsed=38799ms timedOut=true`。可见**后台化并不能让 Hook 提前结账**，
 *   记账口径覆盖 Hook 派生的子进程树。由此得三条结论：
 *     · 本脚本 158ms 返回并不会让记账变短，`collect-activity` / `settle-conversation`
 *       的耗时同样会被计入；
 *     · 想让 Hook 稳定落在预算内，**得让 Hook 不派生子进程**（改为只落盘 spool、
 *       由下次会话或定时任务消费），继续压缩脚本自身已无收益；
 *     · 若要容忍负载高峰，调大 `settings.json` 里该 Hook 的 `timeout`（单位：秒）。
 *   实证（2026-09-23，同机同 Hook）：空闲时 `elapsed=3010/3158/5253ms timedOut=false`；
 *   会话启动与插件 setup 抢资源时 `elapsed=29598/31187/38907ms timedOut=true`。
 *   即超时是**环境负载的函数**，与采集是否成功无关 —— 产物（current.json / state.json /
 *   conversations.jsonl）均在用户消息后 ~1.3s 内落盘，零丢数据。
 *   2026-09-22 当轮先把**本脚本自身的可压缩耗时**压到最小（事后看，这只是必要条件、
 *   不是充分条件 —— 真正的瓶颈在脚本之外）：
 *     ① stdin 首字节截止 300ms：管道数据通常在 node 起来前就已缓冲，接不到
 *        任何数据就说明本次没有载荷，直接返回，不再空等整段截止时间；
 *     ② stdin 整体截止 3000ms → 1000ms：一旦开始收数据，留 1s 收尾；
 *     ③ trace 记录 elapsed_ms 与 stdin_mode，下次复发一次读文件即可定位。
 *   注意：冷启动成本（bash + node）不在本脚本可控范围内，故不追求 0 耗时。
 *   本脚本自身最坏 ≈ 冷启动 + 1s —— 但这**只保证脚本自身不拖后腿，不等于 Hook 不超时**，
 *   原因见上文的记账口径修正（宿主记账覆盖子进程树）。
 *
 * 手动测试：
 *   echo '{"hook_event_name":"UserPromptSubmit","prompt":"继续完善GPU调度需求"}' | node hook-bridge.js
 *   node hook-bridge.js --self-test
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const COLLECT = path.join(__dirname, 'collect-activity.js');
const STATUS = path.join(__dirname, 'status.js');
const SETTLE = path.join(__dirname, 'settle-conversation.js');
// V3.21：Codex 侧 Hook 的自愈入口（见 register-host 分支的说明）
const ENSURE_CODEX_HOOKS = path.join(__dirname, 'ensure-codex-hooks.js');
// V3.21：会话开始时的对账入口（补齐 Hook 没覆盖到的那一段）
const MAINTENANCE = path.join(__dirname, 'auto-maintenance.js');

/**
 * V3.4.1（自中央副本线并入）：宿主名与采集机制由命令行给定。
 * 此前写死 'workbuddy'，Codex 侧的活动也会被登记成 WorkBuddy。
 */
function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] || fallback;
}

const HOST = ['codex', 'workbuddy'].includes(argValue('--host', ''))
  ? argValue('--host', '')
  : 'workbuddy';
const MECHANISM = argValue('--mechanism', 'hooks');

/**
 * 2026-09-22 修复「Hook timed out after 10000ms」：
 *
 * 旧实现用 spawnSync **同步等待**子进程跑完（最长 7s）。每天第一条消息时
 * SessionStart 与 UserPromptSubmit 几乎同时触发，两个 node 进程串行冷启动，
 * 再叠加写锁排队，很容易撞上宿主给整个 Hook 的 10s 预算而被杀。
 *
 * 现改为 **fire-and-forget**：spawn detached 子进程后立即 unref 并返回，
 * 本进程在几十毫秒内退出。即使宿主杀死本进程，子进程也已独立存活，
 * 会把 Activity 写完（写失败仍会进 spool 待重放，不丢数据）。
 */

/**
 * Hook 事件 → 处理策略
 *   refreshOnly: 工具/会话类事件只用于刷新当前事项，不新建、不入队（§3.1/§43）
 *   eventType  : 映射到 §3.1 的 event_type
 *   settle     : 是否同时触发「对话结束结算」（任务A，见 references/automation.md §5）
 *
 * 2026-09-22 补：settle 原先**完全没有接线** —— 五个 Hook 全部只调 hook-bridge，
 * 而 EVENT_PLAN 里没有任何动作会跑 settle-conversation.js；配置里
 * `settlement.auto_on_conversation_end: true` 因此只是一句声明，从未被执行。
 * 后果：会话只有在人工补算时才进日志，且**一旦补算就冻结在半路**（不会随对话继续刷新）。
 *
 * settle 挂在三个事件上（同一轮有多次机会，互不依赖）：
 *   · UserPromptSubmit —— 最稳的一跳：只要有下一轮用户输入，上一轮必然已结束
 *   · Stop             —— 宿主若触发本事件，可在本轮响应结束时立即结算
 *   · SessionEnd       —— 会话真正关闭时的兜底
 * 三者都做 settle 是**幂等**的（settleOne 无 skip 逻辑、按绝对值覆盖写，不累加）。
 */
const EVENT_PLAN = {
  SessionStart: { action: 'register-host' },
  UserPromptSubmit: { action: 'ingest', eventType: 'user_interaction', settle: true },
  PostToolUse: { action: 'ingest', eventType: 'tool_activity', refreshOnly: true },
  // §43：Stop 只代表主代理本轮响应结束，不代表 WorkItem 完成
  Stop: { action: 'ingest', eventType: 'tool_activity', refreshOnly: true, settle: true },
  // §43：SessionEnd 不直接结束 WorkItem
  SessionEnd: { action: 'ingest', eventType: 'session_end', refreshOnly: true, settle: true },
  SubagentStop: { action: 'ignore' },
  PreToolUse: { action: 'ignore' },
  Notification: { action: 'ignore' },
  PreCompact: { action: 'ignore' },
};

/** 从 hook 载荷中提取用于识别 WorkItem 的简短主题（§12：不落完整内容） */
function extractContent(payload) {
  const p = payload || {};
  const ev = p.hook_event_name;
  if (ev === 'UserPromptSubmit') return String(p.prompt || '');
  if (ev === 'PostToolUse' || ev === 'PreToolUse') {
    const tool = p.tool_name || '';
    const input = p.tool_input || {};
    const target = input.file_path || input.path || input.command;
    if (!tool) return '';
    if (target) {
      const base = String(target).replace(/\\/g, '/').split('/').filter(Boolean).pop();
      return base ? `${tool}：${base}` : tool;
    }
    return tool;
  }
  if (ev === 'SessionStart') return '会话开始';
  if (ev === 'SessionEnd') return '会话结束';
  return '';
}

/**
 * 异步读 stdin + 硬截止。
 *
 * 为什么不能再用 readSync 循环：Windows 管道写端未关闭时 `fs.readSync(0,…)`
 * 会一直阻塞到有数据/EOF —— 若宿主写完 payload 后不立刻关管道（等本进程
 * 退出才关），就是「我等 EOF、宿主等我退出」的死锁，10s 预算被白白耗尽。
 *
 * 现在：数据到齐（stdin 'end'）或截止时间到，二者取先；即使 payload 只到了
 * 一半也照常尝试解析（JSON.parse 失败就丢弃，与旧行为一致）。
 * 事件循环只在等待期间存活，resolve 后立即继续主流程。
 */
const STDIN_FIRST_BYTE_MS = 300;   // 连一个字节都收不到 → 本次无载荷，立刻返回
const STDIN_DEADLINE_MS = 1000;    // 已开始收数据后的整体收尾上限

function readStdinAsync() {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let sawData = false;
    let firstByteTimer = null;
    const finish = (text, mode) => {
      if (settled) return;
      settled = true;
      if (firstByteTimer) clearTimeout(firstByteTimer);
      try { process.stdin.destroy(); } catch (e) { /* 已关闭 */ }
      resolve({ text: text || '', mode, ms: Date.now() - startedAt });
    };
    const joinAndMaybeFinish = (early) => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!early) return text;
      // 提前收尾仅当「已能解析成带 hook_event_name 的完整对象」——
      // 这样宿主即使不关管道，payload 到齐即返回，无需干等截止时间。
      try {
        const probe = JSON.parse(text);
        if (probe && typeof probe === 'object' && probe.hook_event_name) return text;
      } catch (e) { /* 数据未到齐，继续等 */ }
      return null;
    };
    const chunks = [];
    const deadline = setTimeout(
      () => finish(Buffer.concat(chunks).toString('utf8'), 'deadline'),
      STDIN_DEADLINE_MS
    );
    // 首字节截止：宿主若压根不写 stdin（或写失败），不必空等整段截止时间。
    firstByteTimer = setTimeout(() => {
      if (!sawData) { clearTimeout(deadline); finish('', 'no-data'); }
    }, STDIN_FIRST_BYTE_MS);
    try {
      process.stdin.on('data', (c) => {
        sawData = true;
        if (firstByteTimer) { clearTimeout(firstByteTimer); firstByteTimer = null; }
        chunks.push(c);
        const early = joinAndMaybeFinish(true);
        if (early !== null) { clearTimeout(deadline); finish(early, 'early'); }
      });
      process.stdin.on('end', () => {
        const text = joinAndMaybeFinish(false);
        clearTimeout(deadline);
        finish(text !== null ? text : Buffer.concat(chunks).toString('utf8'), 'eof');
      });
      process.stdin.on('error', () => {
        clearTimeout(deadline);
        finish(Buffer.concat(chunks).toString('utf8'), 'error');
      });
      process.stdin.resume();
    } catch (e) {
      clearTimeout(deadline);
      finish('', 'error');
    }
  });
}

/**
 * 宽松解析：宿主载荷若被截断（只到达一半）导致 JSON.parse 失败，
 * 仍尝试用正则取出桥接所需的最小字段，避免静默丢事件。
 */
function lenientParse(raw) {
  const pick = (key) => {
    const m = new RegExp('"' + key + '"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"').exec(raw);
    if (!m) return null;
    try { return JSON.parse('"' + m[1] + '"'); } catch (e) { return m[1]; }
  };
  const ev = pick('hook_event_name');
  if (!ev) return null;
  return {
    hook_event_name: ev,
    session_id: pick('session_id'),
    cwd: pick('cwd'),
    prompt: pick('prompt'),
    tool_name: pick('tool_name'),
    _lenient: true,
  };
}

/**
 * 发射（而非等待）子进程：detached + stdio ignore + unref。
 * 父进程立即返回；子进程独立完成写入，失败会自行进 spool 待重放。
 */
function runQuiet(script, args) {
  try {
    const child = spawn(process.execPath, [script].concat(args), {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    child.on('error', () => {
      /* 发射失败也不得影响会话；op 丢失可由下次触发补齐 */
    });
    child.unref();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 快速前置判断：refresh-only 事件（PostToolUse 等）在「当前没有进行中事项」时
 * 完全没有记录价值。先读一次本地日志，可以省掉绝大多数子进程启动开销 ——
 * PostToolUse 会在每次工具调用触发，这个优化很关键。
 *
 * 2026-09-22：直接读 current.json，不再 require log-core（热路径减负）。
 */
/** 解析日志目录（环境变量优先，其次定位器文件）；解析不到返回空串 */
function logDir() {
  if (process.env.WORK_TIME_TRACKING_DIR) {
    return path.resolve(process.env.WORK_TIME_TRACKING_DIR);
  }
  for (const p of [
    path.join(os.homedir(), '.workbuddy', 'work-time-tracking.json'),
    path.join(os.homedir(), '.codex', 'work-time-tracking.json'),
  ]) {
    try {
      const loc = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (loc && loc.log_directory) return String(loc.log_directory);
    } catch (e) {
      /* 换个来源继续找 */
    }
  }
  return '';
}

/** 本地日期 YYYY-MM-DD（不依赖 log-core，热路径保持轻量） */
function localDate() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 维护对账的最小间隔（同一小时内最多一次；跨天必跑一次） */
const MAINTENANCE_MIN_INTERVAL_MS = 60 * 60 * 1000;
/** 对账窗口：默认补齐最近 3 天（Hook 失效期间的缺口靠它补回来） */
const MAINTENANCE_WINDOW_DAYS = 3;
const MAINTENANCE_STAMP = '.maintenance-state.json';

/**
 * V3.21（用户 2026-09-26）：**会话开始时的对账**。
 *
 * 为什么需要：
 *   即使 Hook 装好了，也存在「Hooks 段被宿主重写掉、用户当天没再开这个工具」
 *   的窗口 —— 那段时间的实时采集就是缺的。而会话原文（Codex rollout /
 *   WorkBuddy transcript）仍在本地，`settle-conversation.js --backfill` 能把
 *   会话、Token/Score/Skill 以及由 prompt 派生的候选事项重新读出来。
 *
 * 因此每次会话开始顺手对账一次：零 AI 调用、幂等、fire-and-forget。
 * 带 1 小时冷却标记，避免频繁开关会话时反复跑（跨天必跑一次）。
 *
 * @returns {boolean} 是否真的拉起了对账进程
 */
function maybeRunMaintenance() {
  try {
    const dir = logDir();
    if (!dir) return false;
    const stampPath = path.join(dir, MAINTENANCE_STAMP);
    const today = localDate();
    let stamp = null;
    try {
      stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8'));
    } catch (e) {
      stamp = null;
    }
    const now = Date.now();
    const last = stamp && stamp.at ? Date.parse(stamp.at) : NaN;
    const sameDay = Boolean(stamp && stamp.date === today);
    if (sameDay && Number.isFinite(last) && now - last < MAINTENANCE_MIN_INTERVAL_MS) {
      return false;
    }
    // 先落标记再起进程：同一时刻多个会话并发时，只有一个会真正开跑
    try {
      fs.writeFileSync(
        stampPath,
        JSON.stringify(
          {
            at: new Date(now).toISOString(),
            date: today,
            window_days: MAINTENANCE_WINDOW_DAYS,
            note: '会话开始时的对账标记（自愈 + 补算）。删除它不会丢数据，只会让下一次会话重新对账。',
          },
          null,
          2
        ),
        'utf8'
      );
    } catch (e) {
      /* 标记写不了也要继续对账 —— 宁可多跑一次，不可漏补 */
    }
    return runQuiet(MAINTENANCE, ['--days', String(MAINTENANCE_WINDOW_DAYS)]);
  } catch (e) {
    return false;
  }
}

function hasInProgressItem() {
  try {
    const dir = process.env.WORK_TIME_TRACKING_DIR
      ? path.resolve(process.env.WORK_TIME_TRACKING_DIR)
      : (() => {
          try {
            const loc = JSON.parse(
              fs.readFileSync(path.join(os.homedir(), '.workbuddy', 'work-time-tracking.json'), 'utf8')
            );
            return String(loc.log_directory || '');
          } catch (e) {
            return '';
          }
        })();
    if (!dir) return true; // 判断不了就交给下游处理，不在这里丢数据
    const cur = path.join(dir, 'current.json');
    if (!fs.existsSync(cur)) return false;
    const log = JSON.parse(fs.readFileSync(cur, 'utf8'));
    return Boolean(log && (log.records || []).some((r) => r.status === 'in_progress'));
  } catch (e) {
    return true; // 判断不了就交给下游处理，不在这里丢数据
  }
}

/**
 * 记录本次调用，便于诊断「Hook 到底有没有被宿主触发」。
 *
 * 桥接脚本必须静默（不能往 stdout 写），所以不能靠打印排查。
 * 这里把**最后一次**调用写进一个固定文件（有界、不增长），
 * 事后读它就能区分「宿主没触发」与「触发了但处理失败」。
 *
 * 2026-09-22：不再 require log-core（那会连带加载 security / role-profile
 * 两个模块并做一堆归一化，热路径上纯属浪费）；时间戳直接用本地时间生成。
 */
function writeTrace(payload, result, extra) {
  try {
    const dir = process.env.WORK_TIME_TRACKING_DIR
      ? path.resolve(process.env.WORK_TIME_TRACKING_DIR)
      : (() => {
          try {
            const loc = JSON.parse(
              fs.readFileSync(path.join(os.homedir(), '.workbuddy', 'work-time-tracking.json'), 'utf8')
            );
            return String(loc.log_directory || '');
          } catch (e) {
            return '';
          }
        })();
    if (!dir) return;
    const d = new Date();
    const pad2 = (n) => String(n).padStart(2, '0');
    const at =
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
      `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    const f = path.join(dir, 'pending', 'last-hook.json');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const body = {
      at: `${at}+08:00`,
      hook_event_name: payload.hook_event_name || null,
      session_id: payload.session_id || null,
      // 项目上下文线索：宿主是否提供了工作目录 / 会话转录路径
      cwd: payload.cwd || null,
      transcript_path: payload.transcript_path || null,
      payload_keys: Object.keys(payload).sort(),
      result,
    };
    // 诊断字段：宿主按「bash 包装进程存活时长」记账（日志 [HookExecutor] …
    // elapsed=…ms timedOut=…），本脚本只负责把自己的那一段如实记下来。
    if (extra) {
      body.stdin_mode = extra.stdin_mode || null;   // early / eof / deadline / no-data / error
      body.stdin_ms = extra.stdin_ms === undefined ? null : extra.stdin_ms;
      body.elapsed_ms = extra.elapsed_ms === undefined ? null : extra.elapsed_ms;
      if (extra.lenient) body.lenient_parse = true; // 载荷被截断、走了猜字段兜底
    }
    fs.writeFileSync(f, JSON.stringify(body, null, 2) + '\n', 'utf8');
  } catch (e) {
    /* 诊断失败不得影响会话 */
  }
}

function handle(payload) {
  const plan = EVENT_PLAN[payload.hook_event_name];
  if (!plan || plan.action === 'ignore') return { handled: false, action: 'not-mapped' };

  const session = payload.session_id ? String(payload.session_id) : null;

  if (plan.action === 'register-host') {
    // SessionStart 触发本身就证明宿主触发已就绪 —— 这正是「触发来源」的实证（§57）
    runQuiet(STATUS, [
      'host',
      '--host',
      HOST,
      '--mechanism',
      MECHANISM,
      '--available',
      'true',
      '--trigger-configured',
      'true',
      '--note',
      '由 Hook 自动登记：SessionStart 已触发',
    ]);

    // V3.21（用户 2026-09-26）：**Codex 侧 Hook 的自愈点**。
    //
    // 为什么必须放在这里：Codex 的 Hook 写在 ~/.codex/config.toml 里，而该文件
    // 由 Codex 应用自己维护 —— 实测 2026-09-24 22:18:43 的一次重写把整个 hooks
    // 段丢掉了（备份 09-23 23:15 里还有 5 个 Hook，当天就没了）。hooks 段一旦
    // 消失，Codex 侧**再也不会触发任何事件**，也就没有任何机会自我修复：
    // 用户只能每天手动发现、手动修 —— 这正是「每天第一条记录都失效」。
    //
    // WorkBuddy 的 Hook 写在 settings.json 里（由 WorkBuddy 维护，不会被 Codex
    // 重写），所以它是最可靠的「看门狗」：每次会话开始顺手把 Codex 的 hooks
    // 幂等补齐。零 AI 调用、幂等、fire-and-forget，失败不影响会话。
    const healSpawned = runQuiet(ENSURE_CODEX_HOOKS, [
      '--repair',
      '--no-trust-probe',
      '--quiet',
    ]);

    // 顺手对账：把「Hook 没覆盖到的那一段」用会话原文补回来（零 AI、幂等）
    const maintainSpawned = maybeRunMaintenance();

    return {
      handled: true,
      action: 'register-host',
      codex_hooks_heal_spawned: healSpawned,
      maintenance_spawned: maintainSpawned,
    };
  }

  // ⓪ 对话结束结算（任务A）—— **必须先于 Activity 采集，且不受 refreshOnly 限制**。
  //
  //   早期把结算挂在 refreshOnly 的闸门后面，会导致「当前没有进行中事项时连结算也被跳过」，
  //   而会话结算与「有没有进行中的工作事项」毫无关系。因此这里独立判定。
  //
  //   用 `--session <id>`（而不是 references/automation.md §5 里写的 `--latest`）：
  //   `--latest` 默认 limit=1，只取"最近有活动的会话"，多会话并发时会结算错对象
  //   （2026-09-22 实测：某个会话的 Hook 触发，结算却落在了另一个会话上）。
  let settleSpawned = false;
  if (plan.settle && session) {
    settleSpawned = runQuiet(SETTLE, ['--session', session, '--quiet', '--exit-zero']);
  }

  // 工具/会话类事件：无进行中事项时直接返回，不启动子进程
  if (plan.refreshOnly && !hasInProgressItem()) {
    return {
      handled: false,
      action: 'skipped',
      reason: 'no-active-work-item',
      settle_spawned: settleSpawned,
    };
  }

  const content = extractContent(payload);
  if (!content) {
    return {
      handled: false,
      action: 'skipped',
      reason: 'empty-content',
      settle_spawned: settleSpawned,
    };
  }

  const args = [
    'ingest',
    '--host',
    HOST,
    '--source',
    'auto',
    '--event',
    String(payload.hook_event_name),
    '--content',
    content,
    '--mechanism',
    MECHANISM,
    // 本脚本本身就是宿主 Hook 的入口，因此可以如实声明触发已配置（§57）
    '--trigger-configured',
    'true',
    // 跨日自动 rollover（decision=keep）：Hook 输出会被重定向丢弃，无人能看到
    // needs_rollover 提问，若不自动处理，跨日后所有活动都会被闸门静默丢弃。
    // keep 是非破坏性选择：旧日志转 pending/<date>.json 保留，工作事项先永久导出。
    '--rollover',
    'keep',
  ];
  if (session) args.push('--session', session);
  // §4.1 C：把宿主工作目录传给采集层，用于推导项目名称
  // （WorkBuddy 的"项目"即工作目录，是明确的项目上下文，不属于猜测）
  if (payload.cwd) args.push('--cwd', String(payload.cwd));
  if (plan.refreshOnly) args.push('--refresh-only');

  runQuiet(COLLECT, args);
  return {
    handled: true,
    action: 'ingest',
    refreshOnly: Boolean(plan.refreshOnly),
    settle_spawned: settleSpawned,
  };
}
/* ------------------------------------------------------------------ */

// 自检模式：验证事件映射与内容提取，不触碰日志
if (process.argv.includes('--self-test')) {
  const samples = [
    { hook_event_name: 'SessionStart', session_id: 's1' },
    { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: '继续完善GPU细粒度调度需求' },
    { hook_event_name: 'UserPromptSubmit', session_id: 's1', prompt: '你好' },
    { hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: { file_path: 'D:/x/y/需求.md' } },
    { hook_event_name: 'Stop', session_id: 's1' },
    { hook_event_name: 'SessionEnd', reason: 'other' },
    { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
  ];
  samples.forEach((s) => {
    const plan = EVENT_PLAN[s.hook_event_name] || { action: 'ignore' };
    const c = extractContent(s);
    process.stdout.write(
      `  host=${HOST.padEnd(9)} ${s.hook_event_name.padEnd(17)} → ${String(plan.action).padEnd(13)}` +
        ` ${plan.refreshOnly ? 'refresh-only' : '            '}` +
        ` ${plan.settle ? 'settle' : '      '}` +
        `  content=${c ? JSON.stringify(c) : '(空，忽略)'}\n`
    );
  });
  process.exit(0);
}

(async () => {
try {
  const t0 = Date.now();
  const stdin = await readStdinAsync();
  const raw = stdin.text;
  let parsed = null;
  let lenient = false;
  if (raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = lenientParse(raw);   // 载荷被截断时仍尽量取出最小字段
      lenient = Boolean(parsed);
    }
  }
  const meta = {
    stdin_mode: stdin.mode,
    stdin_ms: stdin.ms,
    elapsed_ms: Date.now() - t0,
    lenient,
  };
  if (parsed && parsed.hook_event_name) {
    const result = handle(parsed);
    if (process.env.WTT_HOOK_TRACE !== '0') {
      writeTrace(parsed, result, Object.assign(meta, { elapsed_ms: Date.now() - t0 }));
    }
  } else if (stdin.mode !== 'no-data') {
    // 收到了数据但认不出事件名：留痕便于排查宿主载荷格式变化
    if (process.env.WTT_HOOK_TRACE !== '0') {
      writeTrace({}, { handled: false, action: 'unparsable' },
        Object.assign(meta, { elapsed_ms: Date.now() - t0 }));
    }
  }
} catch (e) {
  /* 任何异常都不影响会话 */
}
// 始终静默、始终成功 —— exit 必须在 IIFE **内部**：
// 顶层同步的 process.exit(0) 会在 await 挂起时立即抢跑，
// 把进程杀死在 payload 处理之前（trace 不写、子进程不发射），hook 形同虚设。
// readStdinAsync 最坏 1s（首字节 300ms 内没数据则立刻返回），
// 加上 bash + node 冷启动仍稳稳低于宿主 10s 预算。
process.exit(0);
})();
