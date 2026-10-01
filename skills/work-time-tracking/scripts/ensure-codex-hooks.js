#!/usr/bin/env node
'use strict';

/**
 * Deterministically check or repair the Codex lifecycle hooks used by this skill.
 *
 * The hook command intentionally points at codex-hook-launcher.ps1. The launcher
 * is stable across Codex runtime updates and can be replaced without changing the
 * hook trust hash.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SCRIPT_DIR = __dirname;
const LAUNCHER = path.join(SCRIPT_DIR, 'codex-hook-launcher.ps1');
const BRIDGE = path.join(SCRIPT_DIR, 'hook-bridge.js');
const MANAGED_START = '# >>> work-time-tracking codex hooks (managed) >>>';
const MANAGED_END = '# <<< work-time-tracking codex hooks (managed) <<<';
const EVENTS = [
  { name: 'SessionStart', snake: 'session_start', camel: 'sessionStart', timeout: 10 },
  { name: 'UserPromptSubmit', snake: 'user_prompt_submit', camel: 'userPromptSubmit', timeout: 10 },
  { name: 'PostToolUse', snake: 'post_tool_use', camel: 'postToolUse', timeout: 10 },
  { name: 'Stop', snake: 'stop', camel: 'stop', timeout: 10 },
  { name: 'SessionEnd', snake: 'session_end', camel: 'sessionEnd', timeout: 3 },
];

function parseArgs(argv) {
  const out = { flags: new Set(), values: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out.values[key] = next;
      i += 1;
    } else {
      out.flags.add(key);
    }
  }
  return out;
}

function argValue(args, name, fallback) {
  return Object.prototype.hasOwnProperty.call(args.values, name) ? args.values[name] : fallback;
}

function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function codexHome(args) {
  return path.resolve(
    argValue(args, 'codex-home', process.env.CODEX_HOME || path.join(homeDir(), '.codex'))
  );
}

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
}

function resolveCodexBin(args) {
  const explicit = argValue(args, 'codex-bin', process.env.CODEX_BIN || process.env.CODEX_CLI_PATH);
  if (explicit && fs.existsSync(explicit)) return path.resolve(explicit);

  const local = process.env.LOCALAPPDATA || path.join(homeDir(), 'AppData', 'Local');
  const binRoot = path.join(local, 'OpenAI', 'Codex', 'bin');
  const versions = listFiles(binRoot)
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(binRoot, entry.name, 'codex.exe'))
    .filter((candidate) => fs.existsSync(candidate))
    .sort()
    .reverse();
  return versions[0] || null;
}

function toPosixPath(value) {
  return String(value).replace(/\\/g, '/');
}

/* ------------------------------------------------------------------ *
 * V3.21：launcher 的 node 解析自检
 *
 * 背景（2026-09-26 事故）：codex-hook-launcher.ps1 找不到 node 时会静默
 * `exit 0`。表现出来是「Hook 触发了却没有记录」，而状态页、日志、退出码
 * 全都是正常的 —— 用户只能每天手动排查。
 *
 * 因此把 launcher 的候选清单在脚本侧复算一遍，让「找不到 node」这件事
 * 直接出现在自检输出里，而不是变成一个静默的空转。
 * 两边的候选顺序必须保持一致（见 codex-hook-launcher.ps1）。
 * ------------------------------------------------------------------ */

/** 递归收集目录下的 node.exe（带深度上限，避免误扫大盘） */
function findNodeExe(root, depth) {
  const out = [];
  const maxDepth = Number.isFinite(depth) ? depth : 6;
  const walk = (dir, level) => {
    if (level > maxDepth) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, level + 1);
      } else if (String(entry.name).toLowerCase() === 'node.exe') {
        out.push(abs);
      }
    }
  };
  walk(root, 0);
  return out;
}

/** launcher 会依次尝试的 node 路径（与 .ps1 保持同序） */
function nodeCandidates() {
  const home = homeDir();
  const list = [];
  const add = (p) => {
    const v = p ? String(p).trim() : '';
    if (v && !list.includes(v)) list.push(v);
  };

  add(process.env.WTT_NODE_BIN);

  // 上一次成功解析并缓存的路径
  try {
    add(fs.readFileSync(path.join(home, '.work-time-tracking', 'node-path.txt'), 'utf8').trim());
  } catch (e) {
    /* 没有缓存是正常的 */
  }

  // Codex 托管 runtime / Codex 应用自带 runtime
  const roots = [path.join(home, '.cache', 'codex-runtimes')];
  if (process.env.LOCALAPPDATA) {
    roots.push(path.join(process.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'runtimes'));
  }
  for (const root of roots) {
    for (const f of findNodeExe(root, 6)) add(f);
  }

  // WorkBuddy 自带 node（版本号倒序）
  const wbVersions = path.join(home, '.workbuddy', 'binaries', 'node', 'versions');
  try {
    for (const dir of fs.readdirSync(wbVersions).sort().reverse()) {
      add(path.join(wbVersions, dir, 'node.exe'));
    }
  } catch (e) {
    /* 未安装 WorkBuddy 时跳过 */
  }

  // PATH
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) add(path.join(dir, 'node.exe'));
  }

  // 常见安装位置
  add(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe'));
  add(path.join(process.env['ProgramFiles(x86)'] || '', 'nodejs', 'node.exe'));
  if (process.env.LOCALAPPDATA) {
    add(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'));
  }
  if (process.env.APPDATA) add(path.join(process.env.APPDATA, 'npm', 'node.exe'));
  add('D:\\appSoft\\nodejs\\node.exe');

  return list;
}

/** 第一个真实存在的 node.exe；找不到返回 null */
function resolveNode() {
  for (const candidate of nodeCandidates()) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate;
    } catch (e) {
      /* 继续下一个候选 */
    }
  }
  return null;
}

function tomlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function expectedCommand() {
  if (process.platform !== 'win32') {
    return `"${toPosixPath(process.execPath)}" "${toPosixPath(BRIDGE)}" --host codex`;
  }
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  return (
    `& "${toPosixPath(powershell)}" -NoProfile -ExecutionPolicy Bypass ` +
    `-File "${toPosixPath(LAUNCHER)}" --host codex`
  );
}

function hookBlock(event, command) {
  const lines = [
    `[[hooks.${event.name}]]`,
    `[[hooks.${event.name}.hooks]]`,
    'type = "command"',
    `command = ${tomlLiteral(command)}`,
  ];
  if (process.platform === 'win32') {
    lines.push(`command_windows = ${tomlLiteral(command)}`);
  }
  lines.push(`timeout = ${event.timeout}`);
  return lines.join('\n');
}

function managedBlock(events, command) {
  return [MANAGED_START, ...events.map((event) => hookBlock(event, command)), MANAGED_END].join(
    '\n\n'
  );
}

function stripManagedBlock(text) {
  const start = text.indexOf(MANAGED_START);
  if (start === -1) return text;
  const end = text.indexOf(MANAGED_END, start);
  if (end === -1) return text;
  const after = end + MANAGED_END.length;
  return `${text.slice(0, start)}${text.slice(after)}`.replace(/\n{3,}/g, '\n\n');
}

function hasEvent(text, event) {
  return new RegExp(`^\\[\\[hooks\\.${event.name}(?:\\.|\\]\\])`, 'm').test(text);
}

function relevantCommandLines(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(command|commandWindows|command_windows)\s*=/.test(line))
    .filter((line) => /hook-bridge\.js|codex-hook-launcher\.ps1/.test(line));
}

function commandLooksPowerShellSafe(commandLine) {
  if (process.platform !== 'win32') return true;
  if (/codex-hook-launcher\.ps1/.test(commandLine)) {
    return /powershell(?:\.exe)?/i.test(commandLine) && /-File\b/i.test(commandLine);
  }
  return /=\s*'&\s/.test(commandLine) || /=\s*"&\s/.test(commandLine);
}

function replaceRelevantCommands(text, command) {
  let changes = 0;
  const output = text.replace(
    /^(command|commandWindows|command_windows)(\s*=\s*)(['"])([^\n]*(?:hook-bridge\.js|codex-hook-launcher\.ps1)[^\n]*?)\3\s*$/gm,
    (match, key) => {
      // V3.21：已经在用 launcher 且 PowerShell 安全的行**保持原样**。
      //
      // 为什么：同一个技能可以从三个路径被调用（中央库 / .codex\skills /
      // .workbuddy\skills，后两者是指向中央库的链接），__dirname 不同就会
      // 生成不同字面量的命令。若无条件改写，每次会话开始的自愈都会把
      // config.toml 再写一遍（还会多出一个备份文件）—— 那不叫自愈，叫抖动。
      // 只要「用的是 launcher + PowerShell 安全」，任何等价路径都算合格。
      if (
        match.includes('codex-hook-launcher.ps1') &&
        commandLooksPowerShellSafe(match)
      ) {
        return match;
      }
      const next = `${key} = ${tomlLiteral(command)}`;
      if (next !== match) changes += 1;
      return next;
    }
  );
  return { output, changes };
}

function insertBeforeHooksState(text, block) {
  const marker = /^\[hooks\.state\]/m;
  if (marker.test(text)) return text.replace(marker, `${block}\n\n$&`);
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

function inspectConfig(text, command) {
  const issues = [];
  const missing = EVENTS.filter((event) => !hasEvent(text, event));
  if (missing.length) {
    issues.push(`missing events: ${missing.map((event) => event.name).join(', ')}`);
  }

  const relevant = relevantCommandLines(text);
  if (!relevant.length) {
    issues.push('no work-time-tracking hook command found');
  }
  for (const line of relevant) {
    if (![commandLooksPowerShellSafe(line)]) {
      issues.push(`unsafe PowerShell hook command: ${line}`);
    }
    if (!line.includes(toPosixPath(LAUNCHER)) && !line.includes('codex-hook-launcher.ps1')) {
      issues.push('hook command does not use the stable launcher');
    }
  }
  return issues;
}

function repairConfig(text, command) {
  let output = stripManagedBlock(text).replace(/\n{3,}/g, '\n\n');
  const replaced = replaceRelevantCommands(output, command);
  output = replaced.output;
  let changes = replaced.changes;

  const missing = EVENTS.filter((event) => !hasEvent(output, event));
  if (missing.length) {
    const block = managedBlock(missing, command);
    output = insertBeforeHooksState(output, block);
    changes += missing.length;
  }

  return { output: output.replace(/\n{3,}/g, '\n\n'), changes };
}

function updateTrustHashes(text, configPath, hooks) {
  let output = text;
  let changes = 0;
  for (const event of EVENTS) {
    const metadata = hooks.find((entry) => entry.eventName === event.camel);
    if (!metadata || !metadata.currentHash) continue;
    const section = `[hooks.state.'${configPath}:${event.snake}:0:0']`;
    const lines = output.split(/\r?\n/);
    const index = lines.findIndex((line) => line.trim() === section);
    if (index !== -1) {
      const hashIndex = lines.findIndex(
        (line, i) => i > index && /^trusted_hash\s*=/.test(line.trim())
      );
      if (hashIndex !== -1) {
        const next = `trusted_hash = "${metadata.currentHash}"`;
        if (lines[hashIndex] !== next) {
          lines[hashIndex] = next;
          changes += 1;
        }
        output = lines.join('\n');
        continue;
      }
    }
    output = `${output.replace(/\s*$/, '')}\n\n${section}\ntrusted_hash = "${metadata.currentHash}"\n`;
    changes += 1;
  }
  return { output, changes };
}

function probeHooks(codexBin, codexHomePath, cwd, timeoutMs) {
  return new Promise((resolve) => {
    if (!codexBin) {
      resolve({ ok: false, reason: 'codex binary not found' });
      return;
    }

    const child = spawn(codexBin, ['app-server', '--stdio'], {
      cwd,
      env: Object.assign({}, process.env, {
        CODEX_HOME: codexHomePath,
        USERPROFILE: homeDir(),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let buffer = '';
    let settled = false;
    const timer = setTimeout(() => finish({ ok: false, reason: 'hooks/list timed out' }), timeoutMs);

    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch (e) {
        /* best effort */
      }
      resolve(Object.assign({ stderr: stderr.trim() }, result));
    }

    function send(message) {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (e) {
        finish({ ok: false, reason: `failed to write app-server request: ${e.message}` });
      }
    }

    child.on('error', (error) => finish({ ok: false, reason: error.message }));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch (e) {
          continue;
        }
        if (message.id === 1) {
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          send({
            jsonrpc: '2.0',
            id: 2,
            method: 'hooks/list',
            params: { cwds: [cwd] },
          });
        } else if (message.id === 2) {
          const first = message.result && Array.isArray(message.result.data) && message.result.data[0];
          if (!first) {
            finish({ ok: false, reason: 'hooks/list returned no entries' });
          } else {
            finish({ ok: true, hooks: first.hooks || [], warnings: first.warnings || [], errors: first.errors || [] });
          }
        }
      }
    });

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'work-time-tracking-hook-ensure', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      },
    });
  });
}

function trustIssues(hooks) {
  const issues = [];
  for (const event of EVENTS) {
    const metadata = hooks.find((entry) => entry.eventName === event.camel);
    if (!metadata) {
      issues.push(`trust probe missing event: ${event.name}`);
      continue;
    }
    if (metadata.enabled !== true) issues.push(`hook disabled: ${event.name}`);
    if (metadata.trustStatus !== 'trusted') {
      issues.push(`hook trust status is ${metadata.trustStatus}: ${event.name}`);
    }
  }
  return issues;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repair = args.flags.has('repair');
  const quiet = args.flags.has('quiet');
  const skipTrustProbe = args.flags.has('no-trust-probe');
  const home = codexHome(args);
  const configPath = path.join(home, 'config.toml');
  const cwd = argValue(args, 'cwd', process.cwd());
  const codexBin = resolveCodexBin(args);

  if (!fs.existsSync(configPath)) {
    const result = { action: 'skipped', reason: 'Codex config.toml not found', configPath };
    if (!quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const command = expectedCommand();
  let text = fs.readFileSync(configPath, 'utf8').replace(/\r\n/g, '\n');
  const initialIssues = inspectConfig(text, command);
  let changed = false;
  let backupPath = null;

  if (repair && initialIssues.length) {
    const repaired = repairConfig(text, command);
    if (repaired.output !== text) {
      backupPath = `${configPath}.bak-wtt-auto`;
      fs.copyFileSync(configPath, backupPath);
      fs.writeFileSync(configPath, repaired.output, 'utf8');
      text = repaired.output;
      changed = true;
    }
  }

  let probe = { ok: false, reason: 'trust probe skipped' };
  let trustFixed = false;
  if (!skipTrustProbe) {
    probe = await probeHooks(codexBin, home, cwd, 15000);
  }

  let probeIssues = [];
  if (probe.ok) probeIssues = trustIssues(probe.hooks);

  if (repair && probe.ok && probeIssues.length) {
    const updated = updateTrustHashes(text, configPath, probe.hooks);
    if (updated.output !== text) {
      if (!backupPath) {
        backupPath = `${configPath}.bak-wtt-auto`;
        fs.copyFileSync(configPath, backupPath);
      }
      fs.writeFileSync(configPath, updated.output, 'utf8');
      text = updated.output;
      trustFixed = true;
      changed = true;
    }
    probe = await probeHooks(codexBin, home, cwd, 15000);
    probeIssues = probe.ok ? trustIssues(probe.hooks) : [];
  }

  const finalConfigIssues = inspectConfig(text, command);
  // V3.21：Hook 装好但 launcher 解析不到 node，等于没装 ——
  // 这正是「每天第一条记录都失效」的成因，必须显式报出来而不是绿灯通过。
  const nodePath = resolveNode();
  const nodeIssues = [];
  if (!nodePath) {
    nodeIssues.push(
      'Codex hook launcher cannot resolve node.exe; ' +
        'set WTT_NODE_BIN or add node.exe to PATH (otherwise the hook fires and records nothing)'
    );
  }
  const issues = finalConfigIssues.concat(probe.ok ? probeIssues : [], nodeIssues);
  const warnings = [];
  if (!skipTrustProbe && !probe.ok) {
    const message = `trust probe unavailable: ${probe.reason || 'unknown error'}`;
    if (repair && finalConfigIssues.length === 0) {
      warnings.push(message);
    } else {
      issues.push(message);
    }
  }

  const result = {
    action: issues.length
      ? repair
        ? 'repair_failed'
        : 'needs_repair'
      : changed
      ? 'repaired'
      : warnings.length
      ? 'ok_unverified'
      : 'ok',
    configPath,
    codexBin,
    changed,
    trustFixed,
    backupPath,
    // V3.21：把 launcher 实际会用的 node 一并报出来，排查时一眼可见
    node: {
      resolved: nodePath,
      candidate_count: nodeCandidates().length,
      hint: nodePath
        ? null
        : 'Set the WTT_NODE_BIN environment variable to a node.exe path, then re-run --repair.',
    },
    probe: probe.ok
      ? {
          ok: true,
          hooks: probe.hooks.map((entry) => ({
            eventName: entry.eventName,
            enabled: entry.enabled,
            trustStatus: entry.trustStatus,
          })),
        }
      : { ok: false, reason: probe.reason || 'skipped' },
    issues,
    warnings,
  };

  if (!quiet) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return issues.length ? 2 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
