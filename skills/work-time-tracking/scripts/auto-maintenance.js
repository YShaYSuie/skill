#!/usr/bin/env node
'use strict';

/**
 * Deterministic maintenance entry for host schedulers.
 *
 * It repairs the Codex hooks, settles the recent window (default: yesterday and
 * today, widen with `--days N`), exports classified WorkItems, then verifies the
 * collector/settlement configuration. Never invokes an LLM.
 */

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = __dirname;
const NODE = process.execPath;
const SETTLE = path.join(ROOT, 'settle-conversation.js');
const EXPORT = path.join(ROOT, 'export-work-activities.js');
const STATUS = path.join(ROOT, 'status.js');
const ENSURE_CODEX_HOOKS = path.join(ROOT, 'ensure-codex-hooks.js');

function localDate(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * `--days N` —— 结算回填的时间窗（默认 2 天：昨天到今天）。
 *
 * 为什么要能放宽：Hook 失效或宿主没被打开时，当天的实时采集会缺一段，
 * 但会话原文（Codex rollout / WorkBuddy transcript）还在 —— 结算能把它
 * 重新读出来，连同 prompt 派生的候选事项一起补齐。窗口越大，可补的越多，
 * 代价只是多读几个 rollout 文件（零 AI 调用）。
 */
function windowDays(argv) {
  const i = argv.indexOf('--days');
  const raw = i === -1 ? NaN : Number(argv[i + 1]);
  if (!Number.isFinite(raw) || raw < 1) return 2;
  return Math.min(Math.floor(raw), 30);
}

function run(label, script, args, timeoutMs) {
  const result = spawnSync(NODE, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });

  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`${label} exited with ${result.status}${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout || '';
}

function main() {
  const today = localDate(0);
  const days = windowDays(process.argv.slice(2));
  const since = localDate(-(days - 1));

  const hookEnsure = JSON.parse(
    run(
      'Codex hook ensure',
      ENSURE_CODEX_HOOKS,
      ['--repair', '--no-trust-probe', '--cwd', process.cwd()],
      30000
    )
  );

  run(
    'conversation settlement',
    SETTLE,
    [
      '--backfill',
      '--since',
      since,
      '--until',
      today,
      '--limit',
      '400',
      '--quiet',
    ],
    120000
  );

  run('work activity export', EXPORT, [], 30000);

  const statusText = run('status check', STATUS, ['--json'], 30000);
  const status = JSON.parse(statusText);
  const errors = [];

  if (status.overall && status.overall.level === 'error') errors.push('overall status is error');
  if (!status.host_trigger || status.host_trigger.configured !== true) {
    errors.push('host trigger is not configured');
  }
  if (!status.settlement || !status.settlement.trigger || status.settlement.trigger.configured !== true) {
    errors.push('settlement trigger is not configured');
  }
  if (!status.checks || status.checks.auto_tracking !== true) errors.push('auto tracking is disabled');
  if (!status.checks || Number(status.checks.spool_pending || 0) > 0) {
    errors.push(`spool has ${status.checks ? status.checks.spool_pending : 'unknown'} pending item(s)`);
  }

  if (errors.length) {
    throw new Error(`maintenance health check failed:\n- ${errors.join('\n- ')}`);
  }

  process.stdout.write(
    `work-time-tracking maintenance ok: ${since}..${today}, ` +
      `hooks=${hookEnsure.action}, conversations=${status.settlement.conversations}, ` +
      `activities=${status.settlement.activities}\n`
  );
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
