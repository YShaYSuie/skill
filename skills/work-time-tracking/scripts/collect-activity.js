#!/usr/bin/env node
'use strict';
/**
 * collect-activity.js — Activity 采集入口（§3.1 / §12 / §32-§37）。
 *
 * 处理链（§37）：
 *   宿主事件 → Host Adapter → Security Filter → Activity
 *            → 本地规则匹配 → 已有 WorkItem / 新建 / Pending → 写入 current.json
 *
 * 本脚本是「本地规则优先 + 必要时批量 AI」的落地点，也是 §43 的核心体现：
 * **它只负责"被调用后做什么"。何时被调用由宿主工具决定，脚本内没有任何定时器。**
 *
 * 用法：
 *   collect-activity.js ingest --host codex --event UserPromptSubmit --content "继续设计显存隔离方案"
 *   collect-activity.js pending [--json]            待判断事项与批量建议
 *   collect-activity.js batch-context [--json]      批量分析所需的最小上下文（§36）
 *   collect-activity.js analyze [--json]            手动批量分析入口（/analyze）
 *   collect-activity.js apply --hash <h> --work-item <id> [--trigger auto_analysis|manual]
 *   collect-activity.js apply --hash <h> --new [--content "..."] [--start 10:00]
 *   collect-activity.js apply --hash <h> --dismiss
 *   collect-activity.js budget [--kind auto_analysis|manual] [--consume "原因"]
 *   collect-activity.js cache [--clear]
 */

const fs = require('fs');
const path = require('path');
const C = require('./lib/log-core');
const engine = require('./lib/activity-engine');
const SP = require('./lib/space-projects');
const PR = require('./lib/project-resolver');
const CPR = require('./lib/codex-project-resolver');

const USAGE = `collect-activity.js — Activity 采集与本地判定

  ingest --content <文本> [--host codex|workbuddy|generic] [--source <名称>]
         [--event <Hook/事件名>] [--timestamp <ISO>] [--session <id>]
         [--cwd <宿主工作目录>]    宿主项目上下文，用于推导项目名称（§4.1 C）
         [--mechanism hooks|skill|manual] [--force]
         [--refresh-only]          仅刷新当前事项，无匹配时忽略（工具类事件用）
         [--rollover keep]         兼容旧 Hook 参数；新日期记录默认已自动跨日，
                                   无需显式传入（§49）
         [--skip-work-filter]      跳过「是否属于工作活动」判定（命令通道用）
      采集一次宿主活动：安全过滤 → 工作活动判定 → 本地匹配
      → 命中则直接记录，否则进入 pending_items。

  project --list                  已检测到的 WorkBuddy 空间项目与命名状态
  project --id p_xxx --name 名称   命名一个空间项目（写 config 并回填待判断项）
      空间项目名称由服务端下发、本地拿不到，因此需要用户告知一次；
      命名后自动生效，新会话无需再维护。

  pending [--json]            查看待判断事项与批量分析建议
  batch-context [--json]      输出批量 AI 的最小上下文（§36）
  analyze [--json]            手动批量分析入口（/analyze，不受安全熔断限制，§35）
  apply --hash <h> --work-item <id> | --new | --dismiss
         [--content ...] [--start HH:MM] [--status ...] [--confidence ...]
         [--project <名称>] [--work-type <名称>]
         [--category <分类>] [--project-stage <阶段>] [--output <成果>]
         [--ai-role <角色>] [--segment-id <id>] [--skill <名称>] [--model <名称>]
         [--project-confidence high|medium] [--work-type-confidence high|medium]
         [--trigger auto_analysis|manual]   判断来源，默认 manual
         分类与项目阶段的合法取值见 config.work.*；不传即留空（不猜，§11）
  budget [--kind auto_analysis|manual] [--consume <原因>]
  cache [--clear]             查看或清空判断缓存（§32）

  --dir <路径>
`;

const ADAPTER_DIR = path.join(__dirname, '..', 'adapters');

/** §41：按宿主名加载适配器，缺失时回落到 generic */
function loadAdapter(name) {
  const candidates = [name, name === 'other' ? 'generic' : null, 'generic'].filter(Boolean);
  for (const cand of candidates) {
    const file = path.join(ADAPTER_DIR, cand, 'index.js');
    if (fs.existsSync(file)) return require(file);
  }
  throw new C.LogError(`未找到适配器：adapters/${name}/index.js`);
}

/** §44：host_events 开关决定是否采集该类事件 */
function captureSwitch(config, eventType) {
  const h = config.host_events;
  if (h.enabled === false) return { ok: false, reason: 'host_events.enabled=false' };
  if (eventType === 'manual_input') return { ok: true };
  if (eventType === 'user_interaction') {
    return h.capture_user_interaction
      ? { ok: true }
      : { ok: false, reason: 'capture_user_interaction=false' };
  }
  if (eventType === 'tool_activity' || eventType === 'command') {
    return h.capture_tool_activity
      ? { ok: true }
      : { ok: false, reason: 'capture_tool_activity=false' };
  }
  if (eventType === 'file_operation') {
    return h.capture_file_activity
      ? { ok: true }
      : { ok: false, reason: 'capture_file_activity=false' };
  }
  if (['session_start', 'session_end', 'interrupt'].includes(eventType)) {
    return h.capture_session_lifecycle
      ? { ok: true }
      : { ok: false, reason: 'capture_session_lifecycle=false' };
  }
  return { ok: true };
}

/** 宿主上报 op，供 /status 判断「宿主触发状态」（§57） */
function hostOp(host, mechanism, triggerConfigured) {
  return {
    kind: 'host',
    registry: Object.assign(
      {
        host,
        tool: host,
        available: true,
        // §57：只有调用方明确声明「我是宿主 Hook 触发的」才标记为已配置，避免谎报
        trigger_configured: triggerConfigured === true,
        last_activity_at: C.nowIso(),
        activity_delta: 1,
      },
      mechanism ? { mechanism } : {}
    ),
  };
}

/* ------------------------------------------------------------------ *
 * ingest
 * ------------------------------------------------------------------ */

function doIngest(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  C.ensureWritable(dir);

  const host = C.flagStr(flags, 'host') || C.flagStr(flags, 'adapter') || 'workbuddy';
  const adapter = loadAdapter(host);
  const content = C.flagStr(flags, 'content');
  if (!content) throw new C.LogError('ingest 需要 --content。');

  const config = C.readConfig(dir);

  // ---- §12 Security Filter：任何内容在入库前先脱敏；超长则 AI 压缩，失败才截断 ----
  const filtered = C.security.filterContent(content, { security: config.security });
  if (!filtered.content) throw new C.LogError('内容经安全过滤后为空，未采集。');
  const detailFiltered = C.security.filterDetail(content, { security: config.security });

  const activity = adapter.toActivity({
    content: filtered.content,
    hook: C.flagStr(flags, 'event'),
    event: C.flagStr(flags, 'event'),
    timestamp: C.flagStr(flags, 'timestamp'),
    session_id: C.flagStr(flags, 'session'),
    activity_id: C.flagStr(flags, 'activity-id'),
  });
  activity.content = filtered.content;
  activity.detail = detailFiltered.detail;
  const forcedSource = C.flagStr(flags, 'source');
  if (forcedSource && C.VALID_SOURCE.includes(forcedSource)) activity.source = forcedSource;
  activity.redaction = filtered.hits;
  activity.truncated = filtered.truncated;
  activity.hash = engine.activityHash(activity);

  // ---- 采集开关（§44）----
  const cap = captureSwitch(config, activity.event_type);
  if (!cap.ok) {
    C.emit({
      action: 'skipped',
      reason: cap.reason,
      host,
      activity_hash: activity.hash,
      message: '该事件类型未在 host_events 中开启采集。',
    });
    return C.EXIT.OK;
  }

  // ---- 运行状态闸门 ----
  const skip = C.shouldSkipAuto(dir, activity.source, C.flagBool(flags, 'force'));
  if (skip) {
    C.emit({
      action: 'skipped',
      reason: skip,
      source: activity.source,
      activity_hash: activity.hash,
      message: '当前未处于自动记录状态，不采集 Activity。可用 status.js 查看原因。',
    });
    return C.EXIT.OK;
  }

  // ---- 新日期记录：先非破坏性跨日，再继续采集（§49） ----
  // Hook 无人值守，不能把日志切换到人工确认；旧 WorkItem 先永久导出，
  // 未同步旧日志转 pending/<date>.json，随后在当日日志中继续记录。
  const rolloverMode = C.flagStr(flags, 'rollover');
  if (rolloverMode && rolloverMode !== 'keep') {
    throw new C.LogError(`--rollover 只允许 keep（收到：${rolloverMode}）`);
  }
  let rollover = null;
  try {
    rollover = C.ensureCurrentDate(dir, activity.source);
  } catch (e) {
    C.emit({
      action: 'needs_rollover',
      current_date: (C.readJSON(C.currentPath(dir), null) || {}).date || null,
      today: C.today(),
      error: String((e && e.message) || e),
      message: '新日期记录到达，但自动跨日失败；本次活动未采集（§49）。',
      activity_preview: { hash: activity.hash, content: activity.content, time: activity.time },
    });
    return C.EXIT.NEED_DECISION;
  }
  const log = C.readJSON(C.currentPath(dir), null) || C.emptyDailyLog();

  const aiCfg = engine.aiConfigOf(config);

  // ---- §3.1 第 5 步：判断是否属于工作活动 ----
  // 宿主 Hook 会在每条消息上触发，必须先挡掉寒暄/确认/命令等噪声，否则 pending_items 会被灌满
  if (!C.flagBool(flags, 'skip-work-filter')) {
    const verdict = engine.isWorkActivity(activity.content);
    if (!verdict.work) {
      C.emit({
        action: 'ignored',
        reason: verdict.reason,
        event_type: activity.event_type,
        source: activity.source,
        version: null,
        ai_calls: 0,
        note: '未记录（§3.1 工作活动判定）。不写入 DailyLog，也不进入 pending_items。',
      });
      return C.EXIT.OK;
    }
  }

  const match = engine.localMatch(log, activity, aiCfg);
  // 宿主条目用「宿主机具名」（--host / 适配器名），与 Activity 的 source 分开：
  // 例如 WorkBuddy 的 Hook 触发，host=workbuddy，source=auto。
  const hop = hostOp(
    C.VALID_SOURCE.includes(host) ? host : activity.source,
    C.flagStr(flags, 'mechanism'),
    C.flagBool(flags, 'trigger-configured')
  );

  // ---- 仅刷新模式：工具类事件只用于延长当前事项，不新建、不入队 ----
  if (C.flagBool(flags, 'refresh-only') && match.decision !== 'attach') {
    C.emit({
      action: 'ignored',
      reason: '工具类活动仅用于刷新当前事项；当前无匹配事项，忽略',
      event_type: activity.event_type,
      source: activity.source,
      version: null,
      ai_calls: 0,
      note: '未记录（§3.1：工具活动用于判断是否仍在进行当前事项）。',
    });
    return C.EXIT.OK;
  }

  // §4.1 C：项目以**宿主已建的项目**为准，不解析对话内容。
  //   Codex：优先读本地 state_5.sqlite 的 projects / project_roots。
  //   WorkBuddy：session_id -> 空间 project_id -> 在线缓存 / project_map。
  //   最后才回退到宿主项目目录；命中不了保持 null，不猜。
  //   热路径只读本地缓存或 SQLite，不发起网络请求。
  const cwd = C.flagStr(flags, 'cwd');
  const sessionForProject = C.flagStr(flags, 'session');
  let projCtx;
  if (host === 'codex') {
    const resolved = PR.resolveProjectContext(
      { codexSessionId: sessionForProject, cwd },
      {
        config,
        dir,
        codexResolver: (src) => CPR.resolveCodexProject(src),
        cwdResolver: (dir0) => C.projectFromCwd(dir0, { config }),
      }
    );
    projCtx = {
      project_name: resolved.project_name,
      project_confidence: resolved.project_confidence,
      source: resolved.project_source,
      reason: resolved.reason,
      project_id: resolved.project_id,
    };
  } else {
    projCtx = C.projectFromSession(sessionForProject, { config });
    if (projCtx.project_id) {
      const nm = SP.resolveName(projCtx.project_id, {
        cache: SP.readCache(dir).map,
        project_map: config.project_map,
      });
      if (nm && nm !== projCtx.project_name) {
        projCtx = {
          project_name: nm,
          project_confidence: 'high',
          source: 'space_project',
          reason: '空间项目名称（在线缓存或显式覆盖）',
          project_id: projCtx.project_id,
        };
      }
    }
    if (!projCtx.project_id && !projCtx.project_name) {
      const byCwd = C.projectFromCwd(cwd, { config, log });
      if (byCwd.project_name) projCtx = byCwd;
    }
  }

  // §4-§7/§11：项目与工作类型只给建议，不自动落盘（禁止猜测）
  const projectSuggestion = C.suggestProject(log);
  const workTypeSuggestion = C.suggestWorkType(activity.content, config.work_types);
  // V3.3：分类与项目阶段同样**只建议不落盘**（用户 2026-09-22）
  const categorySuggestion = C.suggestCategory(activity.content, config.work.categories);
  const projectStageSuggestion = C.suggestProjectStage(activity.content, config.work.project_stages);

  if (match.decision === 'attach') {
    const rec = (log.records || []).find((r) => r.id === match.work_item_id);
    const op = { kind: 'patch', id: match.work_item_id, activitiesAdd: [activity.id] };
    if (match.resume) {
      op.set = { status: 'in_progress' };
      op.segmentsAdd = [{ start: activity.time, end: null }];
    } else if (rec && rec.status === 'in_progress') {
      op.openSegmentAt = activity.time;
    }
    // 已有事项缺项目时，用宿主目录上下文补全（仅在 high 置信度下自动写入）
    let projectFilled = null;
    if (rec && !rec.project_name && projCtx.project_name && projCtx.project_confidence === 'high') {
      op.set = Object.assign({}, op.set, {
        project_name: projCtx.project_name,
        project_confidence: projCtx.project_confidence,
      });
      projectFilled = projCtx.project_name;
    }
    // V3.4：顺手补上关联证据（会话 id / 空间项目 id）—— 只在缺失时补，不覆盖已有值
    if (rec) {
      const evidence = {};
      if (sessionForProject && !rec.session_id) evidence.session_id = String(sessionForProject);
      if (projCtx.project_id && !rec.project_id) evidence.project_id = String(projCtx.project_id);
      if (Object.keys(evidence).length) op.set = Object.assign({}, op.set, evidence);
    }
    const result = C.runMutation(dir, activity.source, [op, hop], {});
    const target = result.log.records.find((r) => r.id === match.work_item_id) || {};
    C.emit({
      action: 'attached',
      via: match.via,
      confidence: match.confidence,
      work_item_id: match.work_item_id,
      work_item_content: target.content,
      display_content: target.display_content,
      project_name: target.project_name || null,
      work_type: target.work_type || null,
      project_filled: projectFilled,
      project_context: cwd || null,
      reason: match.reason,
      version: result.log.version,
      ai_calls: 0,
      rollover,
      project_suggestion: projectSuggestion,
      work_type_suggestion: workTypeSuggestion,
      security: { redacted: filtered.redacted, hits: filtered.hits, truncated: filtered.truncated },
      note: '本地规则命中，未调用 AI（§32）。',
    });
    return C.EXIT.OK;
  }

  // ---- 低置信度 → pending_items（§20）；此处不消耗 Token ----
  // 内容级去重：同一句话在不同时刻到达会生成不同 hash，但内容重复不应重复入队
  const normContent = String(activity.content || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const dup = (log.pending_items || []).some(
    (p) => String(p.content || '').replace(/\s+/g, ' ').trim().toLowerCase() === normContent
  );
  if (dup) {
    C.emit({
      action: 'ignored',
      reason: 'duplicate-content',
      event_type: activity.event_type,
      source: activity.source,
      version: null,
      ai_calls: 0,
      pending_items: (log.pending_items || []).length,
      note: '待判断队列中已有相同内容，未重复入队。',
    });
    return C.EXIT.OK;
  }

  // §20 安全阀：队列达到上限时停止入队，避免宿主高频触发导致无界增长
  if ((log.pending_items || []).length >= engine.PENDING_HARD_CAP) {
    C.emit({
      action: 'ignored',
      reason: `待判断队列已达上限 ${engine.PENDING_HARD_CAP} 条，停止入队`,
      event_type: activity.event_type,
      source: activity.source,
      version: null,
      ai_calls: 0,
      pending_items: (log.pending_items || []).length,
      note: '请先执行 /analyze 处理积压的待判断事项，队列清空后会自动恢复入队。',
    });
    return C.EXIT.OK;
  }

  const queued = {
    id: activity.id,
    hash: activity.hash,
    timestamp: activity.timestamp,
    time: activity.time,
    source: activity.source,
    event_type: activity.event_type,
    content: activity.content,
    detail: activity.detail,
    detail_compression: C.security.detailMeta(detailFiltered),
    session_id: activity.session_id,
    confidence: match.confidence || 'low',
    detected_at: C.nowIso(),
    suspected_new_topic: Boolean(match.suspected_new_topic),
    candidate_work_item: match.candidate_work_item || null,
    ambiguous_work_items: match.ambiguous_work_items || [],
    local_reason: match.reason,
    redaction: filtered.hits,
    // 超长内容的处理留痕（§12）：截断必须可见，否则 Hook 路径下用户无感、
    // 尾部内容会永久丢失。AI 压缩成功记 summarized，降级截断记 truncated。
    content_compression: C.security.compressionMeta(filtered),
    // §4.1 C：保留宿主项目上下文。project_name 仅在可确认时写入（§5/§11），
    // project_context 始终保留原始工作目录，便于后续归类时不丢失线索。
    project_name: projCtx.project_name,
    project_confidence: projCtx.project_confidence,
    project_context: cwd || null,
    project_source: projCtx.source,
    project_id: projCtx.project_id || null,
    // V3.3：分类与项目阶段的**建议**（不写入正式字段，等 AI/用户确认后再落盘）
    category_suggestion: categorySuggestion.category,
    project_stage_suggestion: projectStageSuggestion.project_stage,
  };
  const ops = [{ kind: 'queue_item', item: queued }, hop];
  // §4.1 C：关联到空间项目但尚未命名 → 登记，供 /status 提示用户补名称
  if (projCtx.project_id) {
    ops.push({
      kind: 'space_project',
      project_id: projCtx.project_id,
      cwd: cwd || null,
      named: Boolean(projCtx.project_name),
      last_seen: C.nowIso(),
    });
  }
  const result = C.runMutation(dir, activity.source, ops, {});
  const flush = engine.shouldFlush(result.log, aiCfg);
  C.emit({
    action: 'queued',
    activity_hash: activity.hash,
    reason: match.reason,
    pending_items: (result.log.pending_items || []).length,
    version: result.log.version,
    ai_calls: 0,
    rollover,
    should_analyze: flush.should,
    analyze_reasons: flush.reasons,
    project_name: projCtx.project_name,
    project_confidence: projCtx.project_confidence,
    project_source: projCtx.source,
    project_context: cwd || null,
    project_suggestion: projectSuggestion,
    work_type_suggestion: workTypeSuggestion,
    category_suggestion: categorySuggestion,
    project_stage_suggestion: projectStageSuggestion,
    security: { redacted: filtered.redacted, hits: filtered.hits, truncated: filtered.truncated },
    note: flush.should
      ? '已满足批量分析条件，可执行 batch-context 后一次判定（§33）。'
      : '等待累计后再一次判定，避免逐条调用 AI（§32）。',
  });
  return C.EXIT.OK;
}

/* ------------------------------------------------------------------ *
 * pending / batch-context / analyze
 * ------------------------------------------------------------------ */

function doPending(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const log = C.readJSON(C.currentPath(dir), null) || {};
  const config = C.readConfig(dir);
  const pending = log.pending_items || [];
  const flush = engine.shouldFlush(log, engine.aiConfigOf(config));
  const auto = C.aiUsage(dir, 'auto_analysis');
  const manual = C.aiUsage(dir, 'manual');
  const payload = {
    log_directory: dir,
    date: log.date,
    pending_items: pending,
    pending_count: pending.length,
    should_analyze: flush.should,
    analyze_reasons: flush.reasons,
    ai: auto,
    manual_ai: manual,
    judgments_cached: Object.keys(log.judgments || {}).length,
  };
  if (C.flagBool(flags, 'json')) {
    C.emit(payload);
    return C.EXIT.OK;
  }
  const L = [`${log.date || '(未初始化)'} 待判断事项`, ''];
  if (!pending.length) L.push('（无，本地规则已全部处理）');
  pending.forEach((p, i) => {
    L.push(`${i + 1}. [${p.time || p.timestamp || '--:--'}] ${p.content}`);
    L.push(
      `   source=${p.source} ${p.hash ? `hash=${String(p.hash).slice(0, 8)}` : ''}${
        p.suspected_new_topic ? ' 疑似新主题' : ''
      } confidence=${p.confidence || 'low'}`
    );
    if (p.local_reason) L.push(`   原因：${p.local_reason}`);
  });
  L.push('');
  L.push(`批量分析建议：${flush.should ? '是' : '否'}`);
  flush.reasons.forEach((r) => L.push(`  - ${r}`));
  L.push(
    `自动 AI：今日 ${auto.automatic_calls_today}/${auto.safety_max_calls_per_day}` +
      (auto.blocked ? `（${auto.block_reason}）` : '')
  );
  L.push(`手动 AI：今日 ${manual.manual_calls_today} 次（不受安全熔断限制，§35）`);
  C.emitText(L.join('\n'));
  return C.EXIT.OK;
}

function doBatchContext(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const log = C.readJSON(C.currentPath(dir), null) || {};
  const config = C.readConfig(dir);
  const ctx = engine.buildBatchContext(log, engine.aiConfigOf(config));
  ctx.context_hash = engine.contextHash(ctx);
  ctx.ai = C.aiUsage(dir, 'auto_analysis');
  ctx.manual_ai = C.aiUsage(dir, 'manual');
  ctx.instructions =
    '对每条 pending_item 判定：归属哪个现有 WorkItem，或是否需要新建；' +
    '结果用 collect-activity.js apply 回写。不得发送完整 DailyLog（§36）。';
  if (C.flagBool(flags, 'json')) {
    C.emit(ctx);
    return C.EXIT.OK;
  }
  C.emitText(
    [
      '批量 AI 最小上下文（§36）',
      '',
      'recent_work_items:',
      ...(ctx.recent_work_items.length
        ? ctx.recent_work_items.map(
            (i) =>
              `  - ${i.id}  ${i.content}  [${C.STATUS_LABEL[i.status] || i.status}]` +
              `  项目=${i.project_name || '(未识别)'}  类型=${i.work_type || '(未识别)'}`
          )
        : ['  （无）']),
      '',
      'pending_items:',
      ...(ctx.pending_items.length
        ? ctx.pending_items.map(
            (a) => `  - ${String(a.hash).slice(0, 8)}  [${a.timestamp || '--:--'}]  ${a.content}`
          )
        : ['  （无）']),
      '',
      `context_hash: ${ctx.context_hash}`,
      `待判断：${ctx.pending_items.length} 条`,
    ].join('\n')
  );
  return C.EXIT.OK;
}

/** §5/§35：/analyze —— 用户手动触发的批量分析，不受安全熔断限制 */
function doAnalyze(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const log = C.readJSON(C.currentPath(dir), null) || {};
  const config = C.readConfig(dir);
  const pending = log.pending_items || [];
  const auto = C.aiUsage(dir, 'auto_analysis');
  const manual = C.aiUsage(dir, 'manual');
  const ctx = engine.buildBatchContext(log, engine.aiConfigOf(config));
  ctx.context_hash = engine.contextHash(ctx);

  const payload = {
    action: 'analyze',
    trigger: 'manual',
    unlimited: manual.unlimited_manual,
    safety_blocked: auto.blocked,
    safety_note: auto.blocked
      ? `自动 AI 已受安全熔断限制（${auto.block_reason}），但手动分析不受影响（§35）`
      : '自动 AI 未触发熔断',
    pending_count: pending.length,
    pending_items: pending,
    batch_context: ctx,
    ai: auto,
    manual_ai: manual,
    next_steps: [
      '对每条 pending_item 判定归属或新建',
      '同时判定 project_name 与 work_type（无法可靠判断时留空，§11）',
      'apply --hash <h> --work-item <id> --trigger manual [--project <名称>] [--work-type <名称>]',
      'apply --hash <h> --new --start HH:MM --trigger manual [--project <名称>] [--work-type <名称>]',
      'apply --hash <h> --dismiss --trigger manual',
    ],
  };
  if (C.flagBool(flags, 'json')) {
    C.emit(payload);
    return C.EXIT.OK;
  }
  const L = ['手动批量分析（/analyze）', ''];
  L.push(`待判断事项：${pending.length} 条`);
  L.push(`自动 AI：${auto.blocked ? `已受限制（${auto.block_reason}）` : '正常'}`);
  L.push('手动 AI 不受 safety_max_calls_per_day 限制（§35）。');
  L.push('');
  if (!pending.length) {
    L.push('（无待判断事项）');
  } else {
    pending.forEach((p, i) => {
      L.push(`${i + 1}. [${p.time || '--:--'}] ${p.content}`);
      L.push(`   hash=${String(p.hash || p.id).slice(0, 8)} source=${p.source}`);
    });
    L.push('');
    L.push('最小上下文已生成，可用 --json 获取完整结构。');
    L.push('判定后用 apply --hash <h> --work-item <id>|--new|--dismiss 回写。');
  }
  C.emitText(L.join('\n'));
  return C.EXIT.OK;
}

/* ------------------------------------------------------------------ *
 * apply
 * ------------------------------------------------------------------ */

function doApply(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  C.ensureWritable(dir);
  const hash = C.flagStr(flags, 'hash');
  if (!hash) throw new C.LogError('apply 需要 --hash <activity hash>。');
  const workItem = C.flagStr(flags, 'work-item');
  const isNew = C.flagBool(flags, 'new');
  const dismiss = C.flagBool(flags, 'dismiss');
  if (!workItem && !isNew && !dismiss) {
    throw new C.LogError('apply 需要 --work-item <id>、--new 或 --dismiss。');
  }

  const log = C.readJSON(C.currentPath(dir), null) || {};
  const queued = (log.pending_items || []).find(
    (p) => p.hash === hash || p.id === hash || String(p.hash || '').startsWith(hash)
  );
  if (!queued) throw new C.LogError(`未找到待判断事项：${hash}`);
  const key = queued.hash || queued.id;

  // §35：判断来源决定是否占用安全熔断额度（manual 不受限）
  const trigger = C.flagStr(flags, 'trigger') === 'auto_analysis' ? 'auto_analysis' : 'manual';
  const consumed = C.consumeAiCall(dir, `${trigger}:${isNew ? 'new' : 'match'}`, trigger);
  if (!consumed.allowed) {
    C.emit({
      action: 'blocked',
      reason: consumed.usage.block_reason,
      activity_hash: key,
      message:
        '未能获得 AI 额度，本次判断未写入。事项仍保留在 pending_items，记录不受影响（§35/§40）。',
      ai: consumed.usage,
    });
    return C.EXIT.OK;
  }

  if (dismiss) {
    const result = C.runMutation(dir, 'workbuddy', [{ kind: 'dequeue', hashes: [key] }], {});
    C.emit({
      action: 'dismissed',
      activity_hash: key,
      pending_items: (result.log.pending_items || []).length,
      ai: consumed.usage,
      trigger,
    });
    return C.EXIT.OK;
  }

  const confidence = C.flagStr(flags, 'confidence') || 'high';
  if (!C.VALID_CONFIDENCE.includes(confidence)) {
    throw new C.LogError(`--confidence 非法：${confidence}`);
  }
  const ops = [];
  let matchedId;

  // §4-§11：项目与工作类型由 AI 判断后回写；不得凭格式需要而编造
  const projectArg = C.flagStr(flags, 'project');
  const workTypeArg = C.flagStr(flags, 'work-type');
  const projectConfArg = C.flagStr(flags, 'project-confidence') || 'high';
  const workTypeConfArg = C.flagStr(flags, 'work-type-confidence') || 'high';
  if (projectArg && !C.VALID_CONFIDENCE.includes(projectConfArg)) {
    throw new C.LogError(`--project-confidence 非法：${projectConfArg}`);
  }
  if (workTypeArg && !C.VALID_CONFIDENCE.includes(workTypeConfArg)) {
    throw new C.LogError(`--work-type-confidence 非法：${workTypeConfArg}`);
  }
  const projectPatch = {};
  if (projectArg) {
    projectPatch.project_name = projectArg;
    projectPatch.project_confidence = projectConfArg;
  }
  if (workTypeArg) {
    projectPatch.work_type = workTypeArg;
    projectPatch.work_type_confidence = workTypeConfArg;
  }
  // V3.3：分类 / 项目阶段 / 成果（可选回写）。枚举取自 config.work.*，
  // 传了就必须是合法取值 —— 避免把「需求阶段」写成「需求」这类脏数据。
  const cfgForEnums = C.readConfig(dir);
  const categoryArg = C.flagStr(flags, 'category');
  if (categoryArg) {
    const cats = cfgForEnums.work.categories;
    if (!cats.includes(categoryArg)) {
      throw new C.LogError(
        `--category 非法：${categoryArg}（允许：${cats.join(', ')}；可在 config.work.categories 扩展）`
      );
    }
    projectPatch.category = categoryArg;
  }
  const stageArg = C.flagStr(flags, 'project-stage');
  if (stageArg) {
    const stages = cfgForEnums.work.project_stages;
    if (!stages.includes(stageArg)) {
      throw new C.LogError(
        `--project-stage 非法：${stageArg}（允许：${stages.join(', ')}；可在 config.work.project_stages 扩展）`
      );
    }
    projectPatch.project_stage = stageArg;
  }
  const outputArg = C.flagStr(flags, 'output');
  if (outputArg && String(outputArg).trim()) projectPatch.output = String(outputArg).trim();
  const aiRoleArg = C.flagStr(flags, 'ai-role');
  if (aiRoleArg) {
    if (!C.VALID_AI_ROLE.includes(aiRoleArg)) {
      throw new C.LogError(`--ai-role 非法：${aiRoleArg}（允许：${C.VALID_AI_ROLE.join(', ')}）`);
    }
    projectPatch.ai_role = aiRoleArg;
  }
  const segmentArg = C.flagStr(flags, 'segment-id');
  if (segmentArg) projectPatch.segment_id = segmentArg;
  const skillArgs = C.flagList(flags, 'skill');
  if (skillArgs.length) projectPatch.skills = skillArgs;
  const modelArgs = C.flagList(flags, 'model');
  if (modelArgs.length) projectPatch.models = modelArgs;

  // V3.6（用户 2026-09-24）：归属二次确认与幂等。
  //
  // 用户明确：「已经总结过的 message，若无明确要求重复总结时无需重复验证」。
  // 因此只要这一次 `apply` 对归属做出了实质决定（项目/工作类型/分类/阶段），
  // 就把该事项标成 `confirmed` —— 之后的总结默认跳过它。
  // 需要重验时用 `--recheck` 显式打回 `pending_review`。
  const classified =
    Boolean(projectArg) ||
    Boolean(workTypeArg) ||
    Boolean(projectPatch.category) ||
    Boolean(projectPatch.project_stage);
  if (C.flagBool(flags, 'recheck')) {
    projectPatch.classification_status = 'pending_review';
    projectPatch.confirmed_at = null;
    projectPatch.confirmed_by = null;
  } else if (classified && !C.flagBool(flags, 'pending')) {
    projectPatch.classification_status = 'confirmed';
    projectPatch.confirmed_at = C.nowIso();
    projectPatch.confirmed_by = C.flagStr(flags, 'actor') || 'user';
  }

  if (isNew) {
    const rawContent = C.flagStr(flags, 'content') || queued.content;
    const sec = C.security.filterContent(rawContent, {
      security: C.readConfig(dir).security,
    });
    // 也允许在内联写法中直接给出项目/工作类型
    const parsed = C.parseDisplayInput(sec.content);
    const inlineProject = parsed.project_name || null;
    const inlineWorkType = parsed.work_type || null;
    const startRaw = C.flagStr(flags, 'start');
    const start = startRaw ? C.fmtHHMM(C.parseHHMM(startRaw)) : queued.time;
    const status = C.flagStr(flags, 'status') || (start ? 'in_progress' : 'needs_confirmation');
    if (!C.VALID_STATUS.includes(status)) throw new C.LogError(`--status 非法：${status}`);
    matchedId = C.makeId();
    const item = {
      id: matchedId,
      date: log.date || C.today(),
      content: parsed.content || sec.content,
      detail: queued.detail || null,
      detail_compression: queued.detail_compression || null,
      ai_role: C.flagStr(flags, 'ai-role') || queued.ai_role || null,
      segment_id: C.flagStr(flags, 'segment-id') || queued.segment_id || null,
      skills: C.flagList(flags, 'skill'),
      models: C.flagList(flags, 'model'),
      start_time: start || null,
      end_time: null,
      estimated_duration: null,
      actual_duration: null,
      status,
      source: queued.source || 'auto',
      confidence,
      time_segments: start ? [{ start, end: null }] : [],
      activities: [key],
      parent_id: null,
      tags: [],
      notes: `由批量判定新建（activity ${String(key).slice(0, 8)}）`,
    };
    // V3.4：把「这条事项来自哪个会话」的证据带到 WorkItem 上。
    //   队列里本来就有（queue_item 写入的 session_id / project_id），此前没往下传 ——
    //   结果导出成 Work Activity 时 conversation_id 只能写 null，AI 成本归因整条断链。
    //   注意：这里存的是**宿主原生键**（证据），不是推断出来的关联；
    //   真正的 conversation_id 由导出/结算阶段按「会话日志中确实存在」来确认。
    if (queued.session_id) item.session_id = String(queued.session_id);
    if (queued.project_id) item.project_id = String(queued.project_id);
    if (!item.detail && queued.detail) item.detail = queued.detail;
    if (!item.detail_compression && queued.detail_compression) {
      item.detail_compression = queued.detail_compression;
    }
    if (inlineProject) {
      item.project_name = inlineProject;
      item.project_confidence = 'high';
    }
    if (inlineWorkType) {
      item.work_type = inlineWorkType;
      item.work_type_confidence = 'high';
    }
    // §4.1 C：继承采集时保留的宿主项目上下文（cwd 推导结果）
    if (!item.project_name && queued.project_name) {
      item.project_name = queued.project_name;
      item.project_confidence = queued.project_confidence || 'medium';
    }
    if (queued.project_context) item.project_context = queued.project_context;
    Object.assign(item, projectPatch);
    C.normalizeItem(item);
    ops.push({ kind: 'add', item });
  } else {
    const target = C.resolveOne(log, workItem, null, false);
    matchedId = target.id;
    const op = {
      kind: 'patch',
      id: target.id,
      activitiesAdd: [key],
      openSegmentAt: target.status === 'in_progress' ? queued.time : undefined,
    };
    // V3.4：把队列里的会话/空间项目证据补写到已存在的事项上（缺失才补）
    const evidence = {};
    if (queued.session_id && !target.session_id) evidence.session_id = String(queued.session_id);
    if (queued.project_id && !target.project_id) evidence.project_id = String(queued.project_id);
    if (queued.detail && !target.detail) evidence.detail = queued.detail;
    if (queued.detail_compression && !target.detail_compression) {
      evidence.detail_compression = queued.detail_compression;
    }
    if (Object.keys(projectPatch).length || Object.keys(evidence).length) {
      op.set = Object.assign({}, projectPatch, evidence);
    }
    ops.push(op);
  }

  ops.push({
    kind: 'judgment',
    entry: {
      activity_hash: key,
      matched_work_item: matchedId,
      confidence,
      analyzed_at: C.nowIso(),
      trigger,
      source: queued.source,
      content: queued.content,
    },
  });
  ops.push({ kind: 'dequeue', hashes: [key] });

  const result = C.runMutation(dir, 'workbuddy', ops, {});
  const stored = (result.log.records || []).find((r) => r.id === matchedId) || {};
  C.emit({
    action: isNew ? 'created' : 'matched',
    activity_hash: key,
    work_item_id: matchedId,
    display_content: stored.display_content || null,
    project_name: stored.project_name || null,
    work_type: stored.work_type || null,
    confidence,
    trigger,
    version: result.log.version,
    pending_items: (result.log.pending_items || []).length,
    ai: consumed.usage,
    note: '判断结果已缓存，相同 Activity 再次出现时直接复用（§32）。',
  });
  return C.EXIT.OK;
}

/* ------------------------------------------------------------------ *
 * budget / cache
 * ------------------------------------------------------------------ */

function doBudget(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const kind = C.flagStr(flags, 'kind') === 'manual' ? 'manual' : 'auto_analysis';
  const reason = C.flagStr(flags, 'consume');
  if (reason) {
    C.ensureWritable(dir);
    const r = C.consumeAiCall(dir, reason, kind);
    C.emit({
      action: r.allowed ? 'consumed' : 'blocked',
      kind,
      reason,
      allowed: r.allowed,
      block_reason: r.allowed ? null : r.usage.block_reason,
      ai: r.usage,
    });
    return C.EXIT.OK;
  }
  C.emit({
    action: 'budget',
    auto_analysis: C.aiUsage(dir, 'auto_analysis'),
    manual: C.aiUsage(dir, 'manual'),
  });
  return C.EXIT.OK;
}

function doCache(flags) {
  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  const log = C.readJSON(C.currentPath(dir), null) || {};
  const entries = Object.values(log.judgments || {});
  if (C.flagBool(flags, 'clear')) {
    C.ensureWritable(dir);
    const result = C.runMutation(dir, 'workbuddy', [{ kind: 'clear_judgments' }], {});
    C.emit({ action: 'cleared', cleared: result.applied[0].cleared, version: result.log.version });
    return C.EXIT.OK;
  }
  if (C.flagBool(flags, 'json')) {
    C.emit({ date: log.date, judgments: log.judgments || {}, count: entries.length });
    return C.EXIT.OK;
  }
  const L = [`${log.date || '(未初始化)'} 判断缓存（§32）`, ''];
  if (!entries.length) L.push('（空）');
  entries
    .sort((a, b) => String(b.analyzed_at).localeCompare(String(a.analyzed_at)))
    .forEach((e) => {
      L.push(
        `- ${String(e.activity_hash).slice(0, 8)}  → ${e.matched_work_item}  [${e.confidence}]`
      );
      L.push(`  ${e.content}`);
      L.push(`  分析于 ${e.analyzed_at}（${e.trigger || 'manual'}）`);
    });
  C.emitText(L.join('\n'));
  return C.EXIT.OK;
}

/**
 * 空间项目登记与命名（§4.1 C）。
 *
 * WorkBuddy 空间项目的名称由服务端下发、本地拿不到，因此需要用户告知一次，
 * 之后写入 config.project_map 即永久生效 —— 不需要反复维护。
 *
 *   project --list                 列出检测到的空间项目与命名状态
 *   project --id p_xxx --name 名称  命名一个空间项目（同时回填待判断项）
 */
function doProject(flags) {
  const dir = C.flagStr(flags, 'dir') || C.resolveDir(null);
  const config = C.readConfig(dir);
  const id = C.flagStr(flags, 'id');
  const name = C.flagStr(flags, 'name');

  // --sync：在线拉取空间项目 id→name，写缓存并回填待判断项
  if (C.flagBool(flags, 'sync')) {
    const creds = SP.findCredentials();
    if (!creds.ok) {
      const msg = '无法从宿主日志提取凭据：' + (creds.error || '未知原因');
      if (C.flagBool(flags, 'json')) C.emit({ action: 'project_sync', ok: false, error: msg });
      else C.emitText('✗ ' + msg);
      return C.EXIT.OK;
    }
    const r = SP.fetchProjectMap(creds);
    if (!r.ok) {
      const cached = SP.readCache(dir);
      const msg = '在线拉取失败：' + r.error + '（沿用缓存 ' + Object.keys(cached.map).length + ' 条，获取于 ' + (cached.fetched_at || '未知') + '）';
      if (C.flagBool(flags, 'json')) C.emit({ action: 'project_sync', ok: false, error: msg });
      else C.emitText('✗ ' + msg);
      return C.EXIT.OK;
    }
    SP.writeCache(dir, r.map);
    // 回填待判断项：按 project_id 匹配，刷新名称（只改名称相关字段）
    let backfilled = 0;
    const current = C.readJSON(C.currentPath(dir));
    const pending = (current.pending_items || []).map((p) => {
      if (!p.project_id) return p;
      const nm = SP.resolveName(p.project_id, { cache: r.map, project_map: config.project_map });
      if (nm && nm !== p.project_name) {
        backfilled += 1;
        return Object.assign({}, p, {
          project_name: nm,
          project_confidence: 'high',
          project_source: 'space_project',
        });
      }
      return p;
    });
    const res = C.runMutation(dir, 'workbuddy', [{ kind: 'patch_pending_batch', items: pending }], {});
    // 标记这些空间项目为已命名
    const markOps = Object.keys(r.map).map((pid) => ({ kind: 'space_project', project_id: pid, named: true }));
    C.runMutation(dir, 'workbuddy', markOps, {});
    const payload = {
      action: 'project_sync',
      ok: true,
      projects: Object.keys(r.map).length,
      backfilled,
      version: res.log.version,
      fetched_at: new Date().toISOString(),
    };
    if (C.flagBool(flags, 'json')) C.emit(payload);
    else
      C.emitText(
        [
          '✓ 已同步空间项目 ' + payload.projects + ' 个，回填待判断项 ' + backfilled + ' 条',
          '缓存文件：' + SP.cachePath(dir),
        ].join('\n')
      );
    return C.EXIT.OK;
  }

  if (!id) {
    // --list：从 state 汇总检测到的空间项目
    const state = C.readState(dir);
    const spaceProjects = state.space_projects || {};
    const map = config.project_map || {};
    const entries = Object.entries(spaceProjects);
    const named = entries.filter(([k]) => map[k]);
    const unnamed = entries.filter(([k]) => !map[k]);
    const payload = {
      space_projects: entries.map(([pid, meta]) => ({
        project_id: pid,
        name: map[pid] || null,
        named: Boolean(map[pid]),
        cwds: meta.cwds || [],
        seen_count: meta.seen_count || 0,
        first_seen: meta.first_seen,
        last_seen: meta.last_seen,
      })),
      named_count: named.length,
      unnamed_count: unnamed.length,
    };
    if (C.flagBool(flags, 'json')) {
      C.emit(payload);
      return C.EXIT.OK;
    }
    const L = ['WorkBuddy 空间项目', ''];
    if (!entries.length) {
      L.push('  （尚未检测到空间项目 —— Hook 触发后会自动登记）');
    }
    for (const [pid, meta] of entries) {
      const nm = map[pid];
      L.push(
        `  ${nm ? '✔' : '⚠'} ${pid}  ${nm ? '→ ' + nm : '（未命名）'}　出现 ${meta.seen_count || 0} 次`
      );
      (meta.cwds || []).forEach((c) => L.push(`       目录: ${c}`));
    }
    if (unnamed.length) {
      L.push('');
      L.push('  ⚠ 有 ' + unnamed.length + ' 个空间项目未命名，请告知名称：');
      unnamed.forEach(([pid, meta]) =>
        L.push(
          `     collect-activity.js project --id ${pid} --name <名称>   （目录：${
            (meta.cwds || [])[0] || '-'
          }）`
        )
      );
    }
    C.emitText(L.join('\n'));
    return C.EXIT.OK;
  }

  // --id --name：命名 + 回填
  if (!name) throw new C.LogError('缺少 --name');
  const pid = id.trim();
  const nm = name.trim();
  if (!/^p_[0-9a-f]+$/i.test(pid)) {
    throw new C.LogError(`project_id 形如 p_<hex>，收到：${pid}`);
  }

  // ① 写 config.project_map（持久生效）
  const cfgPath = path.join(dir, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.project_map = Object.assign({}, cfg.project_map, { [pid]: nm });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

  // ② 回填待判断项（按 project_id 精确匹配）
  let backfilled = 0;
  const result = C.runMutation(dir, 'workbuddy', [], {});
  const log = result.log;
  const pending = (log.pending_items || []).map((p) => {
    if (p.project_id === pid && p.project_name !== nm) {
      backfilled += 1;
      return Object.assign({}, p, {
        project_name: nm,
        project_confidence: 'high',
        project_source: 'space_project',
      });
    }
    return p;
  });
  C.runMutation(dir, 'workbuddy', [{ kind: 'patch_pending_batch', items: pending }], {});

  // ③ 标记为已命名
  C.runMutation(dir, 'workbuddy', [{ kind: 'space_project', project_id: pid, named: true }], {});

  C.emit({
    action: 'project_named',
    project_id: pid,
    project_name: nm,
    backfilled,
    version: log.version + 2,
    note: '已写入 config.project_map；此后该空间项目自动带名称，无需再维护。',
  });
  return C.EXIT.OK;
}

C.runMain(() => {
  const { pos, flags } = C.parseArgs(process.argv.slice(2));
  const cmd = pos[0] || 'pending';
  if (cmd === 'help' || C.flagBool(flags, 'help')) {
    C.emitText(USAGE);
    return C.EXIT.OK;
  }
  switch (cmd) {
    case 'ingest':
      return doIngest(flags);
    case 'pending':
      return doPending(flags);
    case 'batch-context':
      return doBatchContext(flags);
    case 'analyze':
      return doAnalyze(flags);
    case 'apply':
      return doApply(flags);
    case 'project':
      return doProject(flags);
    case 'budget':
      return doBudget(flags);
    case 'cache':
      return doCache(flags);
    default:
      C.emitText(USAGE);
      throw new C.LogError(`未知子命令：${cmd}`);
  }
});
