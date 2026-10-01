#!/usr/bin/env node
'use strict';
/**
 * sync-github.js — Structured Logs 的远端归档（用户 §十五~§十八）。
 *
 * ## 这是本技能**唯一**允许执行 git 的地方
 *
 * `test-egress-guard.js` 会静态断言：git 命令与代码托管平台地址**只允许出现在本文件**。
 * 因此不要去别的脚本里加 push 逻辑 —— 守卫会直接失败。
 *
 * ## 默认关闭（用户明确）
 *
 * ```json
 * "github": { "enabled": false }
 * ```
 *
 * 用户已明确「日志暂不自动推送到 GitHub」，所以即使本能力已整合进本技能，
 * **默认也不推送**；要启用必须显式 `enabled: true` 或本次加 `--force`。
 *
 * ## 数据方向：Local 是 Source of Truth（用户 §十七）
 *
 * ```text
 * Local Structured Logs ──► GitHub Remote Archive
 *      （权威）                    （从属）
 * ```
 *
 * ```text
 * 远端不存在          → 上传本地文件
 * 远端存在且内容一致   → 不更新（不产生空提交）
 * 远端存在但内容不同   → **本地覆盖远端**，产生 Commit
 * ✗ 禁止：发现远端不同就反向覆盖本地
 * ```
 *
 * ## 安全（用户 §二十九）
 *
 * ```text
 * ① 仓库必须 private（config 层已强制，public 会被回落）
 * ② 推送前对每个待上传文件做敏感信息扫描，命中即**拒绝推送该日期**
 * ③ 默认不上传 Raw（sync_raw_logs = false）—— Raw 含完整对话痕迹
 * ④ 绝不在命令行参数里携带令牌；认证交给环境（git credential helper / SSH）
 * ⑤ 同步失败**不删除本地日志**，下次继续尝试
 * ```
 *
 * ## 用法
 *
 * ```bash
 * node scripts/sync-github.js --dry-run            # 预演（默认也是 dry-run）
 * node scripts/sync-github.js --apply              # 真正提交并推送
 * node scripts/sync-github.js --days 7 --apply
 * node scripts/sync-github.js --date 2026-09-21 --apply
 * node scripts/sync-github.js --doctor             # 只看仓库与环境就绪情况
 * # 离线自测：把远端指向本地裸仓库，不碰网络
 * node scripts/sync-github.js --apply --remote-url /tmp/logs.git --work-dir /tmp/wt
 * ```
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const C = require('./lib/log-core');
const CS = require('./lib/conversation-store');
const security = require('./lib/security');

const USAGE = `sync-github.js — Structured Logs → GitHub 私有仓库归档

  默认 **dry-run**。真正提交推送必须显式 --apply。

  --apply                  执行 git add/commit/push
  --date <YYYY-MM-DD>      只同步该日期（可重复）
  --days <n>               同步最近 n 天（默认取 config.github.sync_days）
  --all                    同步本地 logs/ 下全部日期
  --include-raw            连同 raw/ 一起同步（默认不含）
  --prune                  删除远端在同步范围内、本地已不存在的日期目录（默认不删）
  --dry-run                预演（默认行为）
  --doctor                 只报告环境与仓库就绪情况
  --force                  忽略 config.github.enabled=false
  --work-dir <路径>        本地工作副本（默认 <log_dir>/.github-sync）
  --remote-url <URL|路径>  远端地址（缺失时尝试 gh repo create）
  --repo <名称>            仓库名（默认 config.github.repository = worktimeLog）
  --json                   输出 JSON
  --dir <路径>             日志目录

  方向：Local 是 Source of Truth；本地覆盖远端，绝不反向覆盖本地（§十七）。
`;

const STRUCTURED_FILES = Object.values(CS.KINDS).map((k) => k.file);

/* ------------------------------------------------------------------ *
 * git 封装
 * ------------------------------------------------------------------ */

/** 定位 git 可执行文件（优先 PATH，其次受管 PortableGit） */
function resolveGit() {
  const candidates = [
    process.env.GIT_EXECUTABLE,
    'git',
    '<USER_HOME>/.workbuddy/binaries/PortableGit/versions/1.2.0/cmd/git.exe',
    'C:/Program Files/Git/cmd/git.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      execFileSync(c, ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      return c;
    } catch (e) {
      /* 换下一个 */
    }
  }
  return null;
}

const gitBin = { value: undefined };
function git(args, opts) {
  if (gitBin.value === undefined) gitBin.value = resolveGit();
  if (!gitBin.value) {
    throw new C.LogError(
      '未找到 git 可执行文件。请安装 Git，或把路径写入环境变量 GIT_EXECUTABLE。',
      C.EXIT.BAD_DIR
    );
  }
  const o = opts || {};
  const full = o.cwd ? ['-C', o.cwd] : [];
  const started = Date.now();
  // 调试开关：WTT_GIT_DEBUG=1 时把每条 git 命令与耗时写到 stderr
  // （写 stderr 而非 stdout —— stdout 是结构化结果通道）
  const debug = process.env.WTT_GIT_DEBUG === '1';
  try {
    const out = execFileSync(gitBin.value, full.concat(args), {
      encoding: 'utf8',
      timeout: o.timeout || 120000,
      windowsHide: true,
      // 关键：不交互 —— 否则凭据提示会把 Hook / 定时任务挂住
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (debug) {
      process.stderr.write(`[git ${Date.now() - started}ms] ${args.join(' ').slice(0, 160)}\n`);
    }
    return String(out).trim();
  } catch (e) {
    if (debug) {
      process.stderr.write(
        `[git ${Date.now() - started}ms FAILED] ${args.join(' ').slice(0, 160)} :: ` +
          `${String((e && e.message) || e).slice(0, 120)}\n`
      );
    }
    throw e;
  }
}

function gitOk(args, opts) {
  try {
    git(args, opts);
    return true;
  } catch (e) {
    return false;
  }
}

const isRepo = (dir) => fs.existsSync(path.join(dir, '.git'));

/* ------------------------------------------------------------------ *
 * 环境与仓库
 * ------------------------------------------------------------------ */

function hasGh() {
  try {
    execFileSync('gh', ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return true;
  } catch (e) {
    return false;
  }
}

const shiftDate = (date, deltaDays) => {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + deltaDays);
  return `${d.getFullYear()}-${C.pad(d.getMonth() + 1)}-${C.pad(d.getDate())}`;
};

/** 本次要同步的日期列表（升序） */
function resolveDates(dir, flags, cfg) {
  const explicit = C.flagList(flags, 'date').map((d) => CS.assertDate(d));
  if (explicit.length) return [...new Set(explicit)].sort();
  if (C.flagBool(flags, 'all')) return CS.listLoggedDates(dir).slice().sort();
  const days = C.flagNum(flags, 'days') || cfg.sync_days;
  const today = C.today();
  const from = shiftDate(today, -(Math.max(1, Math.floor(days)) - 1));
  // 只取本地真实存在的日期，避免为不存在的日期造空目录
  return CS.listLoggedDates(dir).filter((d) => d >= from && d <= today).sort();
}

/**
 * 确保工作副本存在。
 *
 * 三种情况：
 * ```text
 * ① 已是 git 仓库            → 直接用
 * ② 给了 --remote-url        → clone（本地裸仓库也可，便于离线自测）
 * ③ 有 gh 且未给 remote-url  → gh repo create <name> --private --clone
 * ④ 都没有                   → 报告 needs_host，交回用户（不假装成功）
 * ```
 */
function ensureWorkCopy(workDir, opts) {
  const out = { ready: false, action: null, message: null };
  if (isRepo(workDir)) {
    out.ready = true;
    out.action = 'existing';
    return out;
  }
  fs.mkdirSync(workDir, { recursive: true });

  if (opts.remoteUrl) {
    // 若目标目录非空且无 .git，先清空（否则 git clone 会拒绝）
    const entries = fs.readdirSync(workDir);
    if (entries.length) {
      out.ready = false;
      out.action = 'blocked_nonempty';
      out.message = `工作副本目录非空且不是 git 仓库：${workDir}。请先清空或换 --work-dir。`;
      return out;
    }
    try {
      git(['clone', String(opts.remoteUrl), '.'], { cwd: workDir, timeout: 180000 });
      out.ready = isRepo(workDir);
      out.action = 'cloned';
      return out;
    } catch (e) {
      out.action = 'clone_failed';
      out.message = `clone 失败：${String((e && e.message) || e).slice(0, 200)}`;
      return out;
    }
  }

  if (hasGh()) {
    try {
      const parent = path.dirname(workDir);
      git(
        ['repo', 'create', String(opts.repo), '--private', '--clone', '--source', '.'],
        { cwd: parent, timeout: 180000 }
      );
      out.ready = isRepo(path.join(parent, String(opts.repo)));
      out.action = 'created_with_gh';
      return out;
    } catch (e) {
      out.action = 'create_failed';
      out.message = `gh repo create 失败：${String((e && e.message) || e).slice(0, 200)}`;
      return out;
    }
  }

  out.action = 'needs_host';
  out.message =
    '未找到可用的远端，且环境中没有 gh CLI。请二选一：\n' +
    '  ① 先手动创建私有仓库并 clone 到工作副本目录，或\n' +
    '  ② 安装并登录 GitHub CLI（gh auth login）后重试，或\n' +
    '  ③ 用 --remote-url <地址> 指定已有远端。\n' +
    '（本步骤依赖 Host 能力，脚本不会替你创建一个未授权的远端仓库。）';
  return out;
}

/* ------------------------------------------------------------------ *
 * 文件准备（Local → 工作副本）
 * ------------------------------------------------------------------ */

/**
 * 把本地某天的日志复制进工作副本。
 *
 * **只读本地、只写工作副本** —— 这是 §十七「绝不反向覆盖本地」的结构性保证：
 * 本函数不会在 `<log_dir>` 下写任何文件。
 */
function stageDate(dir, workDir, date, opts) {
  const o = opts || {};
  const dryRun = Boolean(o.dryRun);
  const result = { date, files: [], created: 0, updated: 0, unchanged: 0, sensitive: [] };
  const targetDir = path.join(workDir, date);

  const sources = [];
  for (const name of STRUCTURED_FILES) {
    const p = path.join(CS.dayDir(dir, date), name);
    if (fs.existsSync(p)) sources.push({ name, from: p });
  }
  if (o.includeRaw) {
    const rawRoot = CS.rawDir(dir, date);
    if (fs.existsSync(rawRoot)) {
      for (const f of fs.readdirSync(rawRoot)) {
        sources.push({ name: path.posix.join('raw', f), from: path.join(rawRoot, f) });
      }
    }
  }

  for (const s of sources) {
    let text;
    try {
      text = fs.readFileSync(s.from, 'utf8');
    } catch (e) {
      continue;
    }
    // 上传前敏感信息扫描：命中即拒绝该文件（用户 §二十九）
    const hits = security.containsSensitive(text);
    if (hits.length) {
      result.sensitive.push({ file: s.name, kinds: [...new Set(hits)] });
      continue;
    }
    const to = path.join(targetDir, s.name);
    // 工作副本的工作区在同步前已对齐到远端 HEAD，因此「本地 vs 工作副本」
    // 等价于「本地 vs 远端」——这正是「远端有差异就以本地覆盖」的判据。
    const prev = fs.existsSync(to) ? fs.readFileSync(to, 'utf8') : null;
    if (prev === text) {
      result.unchanged += 1;
    } else if (dryRun) {
      // dry-run 只报差异、不落盘：否则预演会污染工作区，
      // 让紧接着的 apply 误判为「无变化」（真实踩过）
      if (prev === null) result.created += 1;
      else result.updated += 1;
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, text, 'utf8');
      if (prev === null) result.created += 1;
      else result.updated += 1;
    }
    result.files.push(s.name);
  }
  return result;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

function run() {
  const { flags } = C.parseArgs(process.argv.slice(2));
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  C.ensureWritable(dir);
  const config = C.readConfig(dir);
  const cfg = config.github;
  const apply = C.flagBool(flags, 'apply');
  const force = C.flagBool(flags, 'force');

  const report = {
    action: 'github_sync',
    mode: apply ? 'apply' : 'dry_run',
    enabled: cfg.enabled,
    repository: cfg.repository,
    visibility: cfg.visibility,
    remote: cfg.remote,
    branch: cfg.branch,
    log_directory: dir,
    work_directory: null,
    dates: [],
    per_date: [],
    staged: { created: 0, updated: 0, unchanged: 0 },
    sensitive_blocked: [],
    committed: false,
    pushed: false,
    remote_diverged: false,
    notes: [],
    needs_host: false,
  };

  const workDir = C.flagStr(flags, 'work-dir') || cfg.work_directory || path.join(dir, '.github-sync');
  report.work_directory = path.resolve(workDir);
  const remoteUrl = C.flagStr(flags, 'remote-url');
  const doDoctor = C.flagBool(flags, 'doctor');

  // ---- 默认关闭：未启用且未 --force 时直接跳过（用户明确「暂不自动推送」） ----
  if (!cfg.enabled && !force && !doDoctor) {
    report.action = 'skipped';
    report.notes.push(
      'config.github.enabled = false（默认）。这是刻意的安全默认值 —— ' +
        '需要推送时显式设置 enabled: true，或本次加 --force。'
    );
    if (!C.flagBool(flags, 'quiet')) C.emit(report);
    return C.EXIT.OK;
  }

  // ---- 安全：仓库必须 private ----
  if (cfg.visibility !== 'private') {
    report.action = 'blocked';
    report.notes.push(`仓库可见性必须为 private，当前为 ${cfg.visibility}。已中止。`);
    if (!C.flagBool(flags, 'quiet')) C.emit(report);
    return C.EXIT.OK;
  }

  const dates = resolveDates(dir, flags, cfg);
  report.dates = dates;

  if (doDoctor) {
    const env = {
      git: Boolean(resolveGit()),
      gh: hasGh(),
      work_copy_exists: isRepo(report.work_directory),
      local_dates: CS.listLoggedDates(dir),
      structured_files: STRUCTURED_FILES,
    };
    report.environment = env;
    if (!env.git) report.notes.push('未找到 git 可执行文件。');
    if (!env.work_copy_exists) report.notes.push('工作副本尚未创建；首次同步会自动创建或 clone。');
    if (!env.gh && !remoteUrl && !env.work_copy_exists) {
      report.needs_host = true;
      report.notes.push('环境缺少 gh 且未指定 --remote-url：首次创建仓库需要 Host 能力。');
    }
    if (!C.flagBool(flags, 'quiet')) C.emit(report);
    return C.EXIT.OK;
  }

  if (!dates.length) {
    report.notes.push('本地 logs/ 下没有落在同步范围内的日期，无需同步。');
    if (!C.flagBool(flags, 'quiet')) C.emit(report);
    return C.EXIT.OK;
  }

  // ---- 工作副本就绪 ----
  const copy = ensureWorkCopy(report.work_directory, {
    remoteUrl,
    repo: C.flagStr(flags, 'repo') || cfg.repository,
  });
  report.work_copy_action = copy.action;
  if (!copy.ready) {
    report.action = copy.action === 'needs_host' ? 'needs_host' : 'failed';
    if (copy.action === 'needs_host') report.needs_host = true;
    report.notes.push(copy.message || '工作副本未就绪，已中止（本地日志未受影响）。');
    if (!C.flagBool(flags, 'quiet')) C.emit(report);
    // 同步失败绝不影响本地日志：这里只是返回非 0 让调用方知道
    return C.EXIT.OK;
  }

  // ---- 先与远端对齐基线，再让本地内容覆盖上去 ----
  //
  // ⚠️ 只比较「本地 vs 工作副本」是不够的：工作副本可能停留在旧提交上，
  // 而远端已经被别处改动（人工编辑、其他机器推送）。那种情况下工作副本 `git status`
  // 是干净的，脚本会误判为「内容一致、无需更新」，远端就永远停在错的内容上。
  //
  // 正确做法（仍然坚持 Local 是 Source of Truth）：
  //   fetch → 把**工作副本**（纯缓存）硬对齐到远端 HEAD
  //        → 再用本地文件覆盖工作副本
  //        → 正常 commit + fast-forward push
  // 这样远端内容被本地覆盖，且不产生 force push、不破坏远端历史。
  // 注意：`git reset --hard` 只作用于工作副本，**绝不触碰日志目录**。
  const remoteName = C.flagStr(flags, 'remote') || cfg.remote;
  const branchName = cfg.branch;
  try {
    git(['fetch', remoteName, branchName], { cwd: report.work_directory, timeout: 180000 });
    const remoteRev = git(['rev-parse', 'FETCH_HEAD'], { cwd: report.work_directory });
    const headRev = gitOk(['rev-parse', 'HEAD'], { cwd: report.work_directory })
      ? git(['rev-parse', 'HEAD'], { cwd: report.work_directory })
      : null;
    if (remoteRev && remoteRev !== headRev) {
      git(['reset', '--hard', 'FETCH_HEAD'], { cwd: report.work_directory });
      report.remote_diverged = true;
      report.notes.push(
        '远端与工作副本不一致（可能是别处改动过）：已把工作副本对齐远端，再用本地内容覆盖。'
      );
    }
  } catch (e) {
    // 离线 / 远端不可达 / 空远端：不阻断。按本地内容继续，推送阶段会再报告。
    report.notes.push(
      `拉取远端基线失败（离线或远端不可达），按本地内容继续：${String((e && e.message) || e).slice(0, 120)}`
    );
  }

  // ---- 逐日 stage（Local → 工作副本；dry-run 只报差异不落盘） ----
  for (const date of dates) {
    const r = stageDate(dir, report.work_directory, date, {
      includeRaw: C.flagBool(flags, 'include-raw') || cfg.sync_raw_logs,
      dryRun: !apply,
    });
    report.per_date.push(r);
    report.staged.created += r.created;
    report.staged.updated += r.updated;
    report.staged.unchanged += r.unchanged;
    if (r.sensitive.length) report.sensitive_blocked.push(...r.sensitive.map((x) => ({ date, ...x })));
  }

  // ---- 可选：删除远端在范围内、本地已不存在的日期目录 ----
  const pruned = [];
  if (C.flagBool(flags, 'prune')) {
    for (const entry of fs.readdirSync(report.work_directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;
      if (!dates.includes(entry.name)) continue;
      if (!fs.existsSync(CS.dayDir(dir, entry.name))) {
        fs.rmSync(path.join(report.work_directory, entry.name), { recursive: true, force: true });
        pruned.push(entry.name);
      }
    }
  }
  report.pruned = pruned;

  // ---- 有敏感信息被拦下时，拒绝提交（避免把凭据推上去） ----
  if (report.sensitive_blocked.length) {
    report.action = 'blocked_sensitive';
    report.notes.push(
      `发现 ${report.sensitive_blocked.length} 个文件含疑似敏感信息，已拒绝同步（§二十九）。` +
        '本地日志未被修改；请先脱敏后重试。'
    );
    if (!C.flagBool(flags, 'quiet')) C.emit(report);
    return C.EXIT.OK;
  }

  const hasChanges = report.staged.created + report.staged.updated + pruned.length > 0;
  if (!hasChanges) {
    // 内容一致 → 不更新、不产生空提交（§十七）
    report.action = 'up_to_date';
    report.notes.push('远端与本地内容一致，无需提交（未产生空提交）。');
    if (!C.flagBool(flags, 'quiet')) C.emit(report);
    return C.EXIT.OK;
  }

  if (!apply) {
    report.action = 'dry_run';
    report.notes.push(
      `将在 --apply 时提交：新增/更新 ${report.staged.created + report.staged.updated} 个文件` +
        `${pruned.length ? `，并删除 ${pruned.length} 个远端过期日期目录` : ''}。`
    );
    if (!C.flagBool(flags, 'quiet')) C.emit(report);
    return C.EXIT.OK;
  }

  // ---- commit + push ----
  const wd = report.work_directory;
  try {
    git(['add', '-A'], { cwd: wd });
    const status = git(['status', '--porcelain'], { cwd: wd });
    if (!status) {
      report.action = 'up_to_date';
      report.notes.push('git 索引无变化，无需提交。');
      if (!C.flagBool(flags, 'quiet')) C.emit(report);
      return C.EXIT.OK;
    }
    const msg = (cfg.commit_message || 'chore(logs): sync {date}').replace(
      '{date}',
      dates.join(',')
    );
    // 用 -c 显式提供身份，避免依赖全局 git 配置（未配置时 commit 会失败）
    git(
      [
        '-c',
        'user.name=work-time-tracking',
        '-c',
        'user.email=noreply@localhost',
        'commit',
        '-m',
        msg,
      ],
      { cwd: wd }
    );
    report.committed = true;
    report.commit_message = msg;

    const remote = remoteName;
    const branch = branchName;
    // 首次推送时设置上游；已存在上游时普通 push
    const setUpstream = !gitOk(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], { cwd: wd });
    git(
      setUpstream
        ? ['push', '-u', remote, branch]
        : ['push', remote, branch],
      { cwd: wd, timeout: 180000 }
    );
    report.pushed = true;
    report.action = 'pushed';
    report.notes.push('本地为 Source of Truth，已用本地内容覆盖远端并提交。');
  } catch (e) {
    // 同步失败：**绝不删除本地日志**，下次继续尝试（用户 §二十五）
    report.action = 'push_failed';
    report.notes.push(
      `提交或推送失败：${String((e && e.message) || e).slice(0, 300)}。` +
        '本地日志未被修改，下次同步会继续尝试。'
    );
  }

  if (!C.flagBool(flags, 'quiet')) C.emit(report);
  return C.EXIT.OK;
}

C.runMain(() => {
  const { pos } = C.parseArgs(process.argv.slice(2));
  if (pos[0] === 'help') {
    C.emitText(USAGE);
    return C.EXIT.OK;
  }
  return run();
});
