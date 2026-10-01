#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SCRIPT = path.join(__dirname, 'ensure-codex-hooks.js');
const NODE = process.execPath;

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wtt-codex-hooks-'));
}

/** 本次运行创建的临时目录（结束时统一清理，不留在 %TEMP% 等人收拾） */
const cleanupDirs = [];

function run(args) {
  const result = spawnSync(NODE, [SCRIPT, ...args], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.strictEqual(result.error, undefined);
  return result;
}

const home = tempHome();
cleanupDirs.push(home);
const config = path.join(home, 'config.toml');
fs.writeFileSync(
  config,
  [
    '[[hooks.SessionStart]]',
    '[[hooks.SessionStart.hooks]]',
    'type = "command"',
    `command = '"C:/node.exe" "C:/hook-bridge.js" --host codex'`,
    'timeout = 10',
    '',
    '[hooks.state]',
    '',
  ].join('\n'),
  'utf8'
);

const before = run(['--codex-home', home, '--no-trust-probe']);
assert.strictEqual(before.status, 2, before.stdout + before.stderr);
assert.ok(before.stdout.includes('needs_repair'), before.stdout);

const repaired = run(['--codex-home', home, '--repair', '--no-trust-probe']);
assert.strictEqual(repaired.status, 0, repaired.stdout + repaired.stderr);
const repairedJson = JSON.parse(repaired.stdout);
assert.strictEqual(repairedJson.changed, true);
assert.ok(fs.existsSync(`${config}.bak-wtt-auto`));

const text = fs.readFileSync(config, 'utf8');
assert.ok(text.includes('codex-hook-launcher.ps1'));
assert.ok(text.includes('[[hooks.Stop]]'));
assert.ok(text.includes('[[hooks.SessionEnd]]'));
assert.ok(!/[^-]command = '"C:/.test(text), 'unsafe bare quoted command remains');
assert.ok(
  !/^commandWindows\s*=\s*'".*hook-bridge\.js/m.test(text),
  'commandWindows still bypasses the stable launcher'
);

const after = run(['--codex-home', home, '--no-trust-probe']);
assert.strictEqual(after.status, 0, after.stdout + after.stderr);
const afterJson = JSON.parse(after.stdout);
assert.deepStrictEqual(afterJson.issues, []);

/* ------------------------------------------------------------------ *
 * V3.21（用户 2026-09-26）：修复「每天第一条记录都失效、每天手动排查」
 * 之后新增的回归防线
 * ------------------------------------------------------------------ */

const LAUNCHER = path.join(__dirname, 'codex-hook-launcher.ps1');

// ① launcher 必须能被 Windows PowerShell 5.1 正确解析。
//    该版本把**无 BOM 的 UTF-8 当 ANSI**读，任何非 ASCII 字符都会让脚本
//    报 "Unexpected token '}'" 并整段失效 —— 这正是当初写中文注释踩到的坑。
{
  const bytes = fs.readFileSync(LAUNCHER);
  const nonAscii = [...bytes].filter((b) => b > 127);
  assert.strictEqual(
    nonAscii.length,
    0,
    `codex-hook-launcher.ps1 必须保持纯 ASCII（发现 ${nonAscii.length} 个非 ASCII 字节）`
  );
}

// ② node 解析不能再只认「WTT_NODE_BIN / Codex 托管 runtime / PATH」这三处。
//    真实事故就是这三处全都不存在 → launcher 静默 exit 0 → Codex 记录全丢。
{
  const text = fs.readFileSync(LAUNCHER, 'utf8');
  assert.ok(text.includes('.workbuddy'), 'launcher 未包含 WorkBuddy 自带 node 的候选路径');
  assert.ok(text.includes('codex-runtimes'), 'launcher 未包含 Codex 托管 runtime 候选路径');
  assert.ok(text.includes('node-path.txt'), 'launcher 未缓存已解析的 node 路径');
  assert.ok(
    text.includes('launcher-trace.jsonl'),
    'launcher 缺少失败留痕（找不到 node 时不能静默）'
  );
}

// ③ ensure-codex-hooks 必须把 launcher 实际能用的 node 报出来；
//    找不到时要以 issue 形式暴露，而不是绿灯通过。
{
  const probed = run(['--codex-home', home, '--no-trust-probe']);
  const probedJson = JSON.parse(probed.stdout);
  assert.ok(probedJson.node, '输出缺少 node 解析结果');
  if (probedJson.node.resolved) {
    assert.ok(
      fs.existsSync(probedJson.node.resolved),
      `node.resolved 指向不存在的路径：${probedJson.node.resolved}`
    );
  } else {
    assert.ok(
      probedJson.issues.some((i) => /cannot resolve node\.exe/.test(i)),
      '解析不到 node 时必须在 issues 中显式报出'
    );
  }
}

// ④ 已在用 launcher 的命令行不得被重复改写（否则每次会话开始的自愈都会
//    重写 config.toml，还会多出一个备份文件 —— 那不叫自愈，叫抖动）。
{
  const stableHome = tempHome();
  cleanupDirs.push(stableHome);
  const stableConfig = path.join(stableHome, 'config.toml');
  const stableCommand =
    '& "C:/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe" -NoProfile ' +
    '-ExecutionPolicy Bypass -File "C:/some/other/place/codex-hook-launcher.ps1" --host codex';
  const events = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd'];
  const lines = [];
  for (const event of events) {
    lines.push(`[[hooks.${event}]]`, '', `[[hooks.${event}.hooks]]`);
    lines.push('type = "command"', `command = '${stableCommand}'`);
    lines.push(`command_windows = '${stableCommand}'`, 'timeout = 10', '');
  }
  fs.writeFileSync(stableConfig, `${lines.join('\n')}\n`, 'utf8');

  const noChurn = run(['--codex-home', stableHome, '--repair', '--no-trust-probe']);
  assert.strictEqual(noChurn.status, 0, noChurn.stdout + noChurn.stderr);
  const noChurnJson = JSON.parse(noChurn.stdout);
  assert.strictEqual(
    noChurnJson.changed,
    false,
    '等价 launcher 命令被重复改写了（会造成每次会话都抖动配置）'
  );
  assert.ok(
    !fs.existsSync(`${stableConfig}.bak-wtt-auto`),
    '没有实际变更时不应产生备份文件'
  );
}

// 自清理：测试不得把临时目录留在 %TEMP% 里等人手动收拾
for (const dir of cleanupDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    /* 清理失败不影响结论 */
  }
}

console.log('test-codex-hooks.js ok');
