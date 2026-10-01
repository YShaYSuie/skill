#!/usr/bin/env node
'use strict';
/**
 * write-work-item.js — 安全新增 WorkItem / 登记待确认候选。
 *
 * 最低记录标准（§2.2 / §13）：content + start_time + source + status。
 * 无法可靠识别时不强行创建 WorkItem，改用 --park 进入 pending_items（§20）。
 *
 * 用法：
 *   write-work-item.js --content "GPU细粒度调度需求设计" --start 09:10 --end 10:30 --source codex
 *   write-work-item.js --content "设备管理页面交互方案" --start 10:30 --source workbuddy --switch
 *   write-work-item.js --content "项目会议" --start 14:00 --end 14:40 --source manual
 *   write-work-item.js --park --content "疑似与当前工作无关的输入" --source codex
 *
 * 语义：
 *   --start + --end   → 补录已完成事项（completed，actual_duration 自动计算）
 *   --start           → 开始进行中事项（in_progress，开放时段）
 *   --no-start        → start_time = null，status = needs_confirmation（§2.1 待确认）
 *
 * --switch：开始本事项的同时关闭其他事项的开放时段（顺序切换），
 *           但不改变其他事项的 status（§17）。
 */

const C = require('./lib/log-core');

const USAGE = `write-work-item.js — 安全新增 WorkItem

  --content <文本>        必填。支持内联写法：【项目】【工作类型】内容 / 【工作类型】内容 / 项目：内容
  --project <名称|auto>   项目名称；auto = 接受上下文继承建议（§16）
  --project-confidence <high|medium>         默认 high
  --work-type <名称|auto> 工作类型；auto = 本地关键词建议（§7）；枚举见 config.work.work_types
  --work-type-confidence <high|medium>       默认 high
  --category <分类|auto>  事项分类（工作/生活/个人成长/健康运动/休闲娱乐/其他）；
                          auto = 本地关键词建议。**不传则留空**（不猜）
  --project-stage <阶段|auto>
                          项目阶段（需求阶段/设计阶段/开发阶段/测试阶段/上线阶段/
                          运营/迭代阶段/其他）；auto = 本地关键词建议。仅工作分类写入
  --output <文本>         本次事项产生的**实际成果**（如「完成 GPU 调度 PRD」）；
                          工作与探索沉淀均可写；无法确认则不传（禁止虚构成果）
  --detail <文本>         结构化补充说明；不受 200 字展示日志限制，但仍会脱敏并受安全上限约束
  --ai-role <角色>        AI主导 / AI协作 / AI辅助 / AI查询 / AI排障 / 未知
  --segment-id <id>       关联 Work Segment（来自对话分段，人工事项可不填）
  --skill <名称>         关联 Skill（可重复）
  --model <名称>         关联模型（可重复）
  --start <HH:MM>         开始时间
  --end <HH:MM>           结束时间（与 --start 同时给出即补录已完成事项）
  --no-start              不提供开始时间 → needs_confirmation
  --time-unknown          声明「已完成 · 时间未知」（§14 扩展）；
                          与 --no-start --status completed 组合使用，时间字段保持为空
  --estimated <分钟>      仅在能可靠判断时给出（§14）
  --source <codex|workbuddy|manual|other>   默认 workbuddy
  --confidence <high|medium|low>            默认 high
  --status <状态>         覆盖默认状态
  --activity <id>         Activity 关联（可重复，§12 activities 字段）
  --mechanism <hooks|skill|manual>          显式上报采集机制（不传则沿用已登记值）
  --parent <id> --tag <t>（可重复） --notes <文本>
  --date <YYYY-MM-DD>     归属日期；只允许今天，遇到新日期会自动切换 current.json
  --switch                关闭其他事项的开放时段（不改变其状态）
  --park                  不创建 WorkItem，登记为待确认候选（§20）
  --dry-run               只预览，不写入
  --force                 忽略运行状态与内容守卫
  --dir <路径> --actor <标识>
`;

/** §23：这些不是工作事项 */
const NON_WORK = /^(你好|您好|hi|hello|hey|在吗|在么|谢谢|thanks|thank you|测试|test|ok|好的)$/i;

C.runMain(() => {
  const { flags } = C.parseArgs(process.argv.slice(2));
  if (C.flagBool(flags, 'help')) {
    C.emitText(USAGE);
    return C.EXIT.OK;
  }

  const dir = C.resolveDir(C.flagStr(flags, 'dir'));
  C.ensureWritable(dir);

  const force = C.flagBool(flags, 'force');
  const content = C.flagStr(flags, 'content');
  if (!content) throw new C.LogError('缺少 --content。');

  // §2.1 不编造任务内容：不是工作事项就不记录
  if (!force) {
    if (NON_WORK.test(content.trim())) {
      throw new C.LogError(`「${content}」不是工作事项，不得创建 WorkItem（§23）。`);
    }
    if (content.includes('\n') || content.includes('\r')) {
      throw new C.LogError(
        '--content 不允许多行。DailyLog 不是聊天记录备份，请把上下文压缩成一句工作事项摘要后再写入。'
      );
    }
    // 超长不再是错误：交给下方 Security Filter 调 AI 压缩为摘要（§2.1 / §12）。
    // 既不静默截断，也不拒绝写入 —— 用户要求「超过限制自动 AI 总结到 200 字以内」。
  }

  // §6/§12：任何进入日志的内容先过 Security Filter。
  // 超长内容由 AI 压缩为摘要（而不是静默截断，见 lib/llm.js）；AI 不可用时才截断。
  const secFiltered = C.security.filterContent(content, { security: C.readConfig(dir).security });
  if (!secFiltered.content) {
    throw new C.LogError('内容经安全过滤后为空，未写入。');
  }
  const safeContent = secFiltered.content;
  const redaction = {
    redacted: secFiltered.redacted,
    hits: secFiltered.hits,
    truncated: secFiltered.truncated,
    summarized: secFiltered.summarized,
  };
  const compression = C.security.compressionMeta(secFiltered);
  const detailRaw =
    C.flagStr(flags, 'detail') || (content.length > C.MAX_CONTENT_LENGTH ? content : null);
  const detailFiltered = detailRaw
    ? C.security.filterDetail(detailRaw, { security: C.readConfig(dir).security })
    : null;
  const detail = detailFiltered ? detailFiltered.detail : null;
  const detailCompression = C.security.detailMeta(detailFiltered);

  // §22：支持内联写法 —— 【项目】【工作类型】内容 / 【工作类型】内容 / 项目：内容
  const parsed = C.parseDisplayInput(safeContent);
  const config = C.readConfig(dir);

  let projectName = C.flagStr(flags, 'project');
  let projectConfidence = C.flagStr(flags, 'project-confidence') || 'high';
  let workType = C.flagStr(flags, 'work-type');
  let workTypeConfidence = C.flagStr(flags, 'work-type-confidence') || 'high';

  if (parsed.project_name) projectName = parsed.project_name;
  if (parsed.work_type) workType = parsed.work_type;
  const finalContent = parsed.content || safeContent;

  // §16：项目连续性。--project auto 表示接受上下文继承建议（medium）。
  // 此处独立读取当前日志做上下文判断，不依赖后续定义的 log 变量。
  const ctxLog = C.readJSON(C.currentPath(dir), null) || {};
  const projectSuggestion = C.suggestProject(ctxLog);
  if (projectName === 'auto') {
    if (projectSuggestion.project_name) {
      projectName = projectSuggestion.project_name;
      projectConfidence = projectSuggestion.confidence;
    } else {
      projectName = null;
      projectConfidence = null;
    }
  }
  if (projectName && !C.VALID_CONFIDENCE.includes(projectConfidence)) {
    throw new C.LogError(`--project-confidence 非法：${projectConfidence}`);
  }
  if (workType && !C.VALID_CONFIDENCE.includes(workTypeConfidence)) {
    throw new C.LogError(`--work-type-confidence 非法：${workTypeConfidence}`);
  }
  // §6：工作类型清单可扩展
  const workTypeSuggestion = C.suggestWorkType(finalContent, config.work_types);
  if (workType === 'auto') {
    if (workTypeSuggestion.work_type) {
      workType = workTypeSuggestion.work_type;
      workTypeConfidence = workTypeSuggestion.confidence;
    } else {
      workType = null;
      workTypeConfidence = null;
    }
  }

  // V3.3（用户 2026-09-22）：分类 / 项目阶段 / 成果 —— 可选归因维度与成果描述。
  //   `auto` 表示接受**本地关键词建议**（与 --work-type auto 同一套纪律）；
  //   不传则保持 null（不猜，非工作事项本就不需要项目阶段与成果）。
  let category = C.flagStr(flags, 'category');
  let projectStage = C.flagStr(flags, 'project-stage');
  const output = C.flagStr(flags, 'output');
  const categorySuggestion = C.suggestCategory(
    [finalContent, workType || ''].filter(Boolean).join(' '),
    config.work.categories
  );
  if (category === 'auto') category = categorySuggestion.category || null;
  const projectStageSuggestion = C.suggestProjectStage(
    [finalContent, workType || ''].filter(Boolean).join(' '),
    config.work.project_stages
  );
  if (projectStage === 'auto') projectStage = projectStageSuggestion.project_stage || null;
  const categoryFinal = category && String(category).trim() ? String(category).trim() : null;
  // 枚举校验：分类 / 项目阶段必须是 config.work 里的合法取值。
  // 写错一个不存在的分类会污染后续所有按分类的统计，宁可当场报错也不静默落盘。
  const allowedCats = (config.work && config.work.categories) || [];
  if (categoryFinal && allowedCats.length && !allowedCats.includes(categoryFinal)) {
    throw new C.LogError(
      `--category 非法：${categoryFinal}（允许：${allowedCats.join(' / ')}）；` +
        '如需新增分类，请先改 config.work.categories。'
    );
  }
  // 项目阶段只写工作；探索沉淀允许保存成果（Skill 能力变化）。
  const isWorkCat = !categoryFinal || categoryFinal === '工作';
  const allowsOutput = isWorkCat || categoryFinal === '探索沉淀';
  const projectStageFinal =
    isWorkCat && projectStage && String(projectStage).trim() ? String(projectStage).trim() : null;
  const allowedStages = (config.work && config.work.project_stages) || [];
  if (projectStageFinal && allowedStages.length && !allowedStages.includes(projectStageFinal)) {
    throw new C.LogError(
      `--project-stage 非法：${projectStageFinal}（允许：${allowedStages.join(' / ')}）；` +
        '如需新增阶段，请先改 config.work.project_stages。'
    );
  }
  const outputFinal =
    allowsOutput && output && String(output).trim() ? String(output).trim() : null;
  const aiRoleRaw = C.flagStr(flags, 'ai-role');
  if (aiRoleRaw && !C.VALID_AI_ROLE.includes(aiRoleRaw)) {
    throw new C.LogError(`--ai-role 非法：${aiRoleRaw}（允许：${C.VALID_AI_ROLE.join(' / ')}）`);
  }
  const segmentId = C.flagStr(flags, 'segment-id');
  const skills = C.flagList(flags, 'skill');
  const models = C.flagList(flags, 'model');

  const source = C.flagStr(flags, 'source') || 'workbuddy';
  if (!C.VALID_SOURCE.includes(source)) {
    throw new C.LogError(`--source 非法：${source}（允许：${C.VALID_SOURCE.join(', ')}）`);
  }
  const confidence = C.flagStr(flags, 'confidence') || 'high';
  if (!C.VALID_CONFIDENCE.includes(confidence)) {
    throw new C.LogError(`--confidence 非法：${confidence}`);
  }
  // 仅在显式指定时上报 mechanism；否则沿用已登记值（只升不降，§65/§69）
  const mechanismRaw = C.flagStr(flags, 'mechanism');
  if (mechanismRaw && !C.VALID_MECHANISM.includes(mechanismRaw)) {
    throw new C.LogError(`--mechanism 非法：${mechanismRaw}`);
  }

  const park = C.flagBool(flags, 'park');

  // §2.3/§56：自动采集在 paused/disabled 或 auto_tracking=false 时跳过；park 亦属自动采集
  if (source !== 'manual') {
    const skip = C.shouldSkipAuto(dir, source, force);
    if (skip) {
      C.emit({
        action: 'skipped',
        reason: skip,
        message: '当前未处于自动记录状态，不创建 WorkItem。可用 status.js 查看原因。',
        content,
        source,
      });
      return C.EXIT.OK;
    }
  }

  const decision = C.flagStr(flags, 'decision');
  if (decision && decision !== 'keep') {
    throw new C.LogError('--decision 只允许 keep（archive 已于 2026-09-21 废弃）');
  }

  // 新日期记录到达时自动跨日，再创建/暂存本次事项。dry-run 只报告计划，
  // 不触碰 current.json，也不创建 pending/。
  const dryRun = C.flagBool(flags, 'dry-run');
  let rollover = null;
  if (!dryRun) {
    rollover = C.ensureCurrentDate(dir, source);
  } else {
    const snapshot = C.readJSON(C.currentPath(dir), null) || {};
    if (snapshot.date && snapshot.date !== C.today()) {
      rollover = {
        action: 'would_roll_over',
        current_date: snapshot.date,
        new_date: C.today(),
        previous_synced: ((snapshot.sync || {}).status || 'pending') === 'success',
      };
    }
  }

  // ---- park：低置信度候选，不创建 WorkItem（§20） ----
  if (park) {
    const log0 = C.readJSON(C.currentPath(dir), null) || {};
    const candidate = {
      id: `cand_${C.today().replace(/-/g, '')}_${C.nowHHMM().replace(':', '')}_${C.randomHex(4, true)}`,
      content: finalContent,
      // §41：项目/工作类型无法确定时保持 null，不为了格式完整而编造
      project_name: projectName || null,
      project_confidence: projectName ? projectConfidence : null,
      work_type: workType || null,
      work_type_confidence: workType ? workTypeConfidence : null,
      // V3.3：分类 / 项目阶段 / 成果（没有就留空）
      category: categoryFinal,
      project_stage: projectStageFinal,
      output: outputFinal,
      detail,
      detail_compression: detailCompression,
      ai_role: aiRoleRaw || null,
      segment_id: segmentId || null,
      skills,
      models,
      source,
      confidence: confidence === 'high' ? 'low' : confidence,
      detected_at: C.nowIso(),
      reason: C.flagStr(flags, 'reason') || '置信度不足，未自动创建工作事项',
      start_time: null,
      content_compression: compression,
    };
    if (dryRun) {
      C.emit({ action: 'dry_run', pending_item: candidate, date: C.today(), rollover });
      return C.EXIT.OK;
    }
    const result = C.runMutation(
      dir,
      source,
      [
        { kind: 'park', item: candidate },
        {
          kind: 'host',
          registry: Object.assign(
            {
              host: source,
              tool: source,
              available: true,
              trigger_configured: false,
              last_activity_at: C.nowIso(),
              activity_delta: 1,
            },
            mechanismRaw ? { mechanism: mechanismRaw } : {}
          ),
        },
      ],
      { enforceDate: true, autoRollover: true, decision }
    );
    C.emit({
      action: 'parked',
      version: result.log.version,
      pending_item: candidate,
      pending_count: (result.log.pending_items || []).length,
      rollover,
      note: '未创建 WorkItem。确认后可用 update-work-item.js promote 转为正式记录（§20）。',
    });
    return C.EXIT.OK;
  }

  const log = C.readJSON(C.currentPath(dir), null) || {};
  const dateStr = C.flagStr(flags, 'date') || C.today();
  if (dateStr !== C.today()) {
    throw new C.LogError(
      `--date ${dateStr} 不是今天（${C.today()}）。` +
        '一个 WorkItem 只能归属当天的 DailyLog（§34）；历史补录请使用 pending/ 或人工流程。'
    );
  }
  if (!dryRun && log.date !== dateStr) {
    throw new C.LogError(
      `自动跨日后 current.json 日期仍为 ${log.date}，与 ${dateStr} 不一致，未写入。`
    );
  }

  const startRaw = C.flagStr(flags, 'start');
  const endRaw = C.flagStr(flags, 'end');
  const noStart = C.flagBool(flags, 'no-start');
  const startHHMM = startRaw ? C.fmtHHMM(C.parseHHMM(startRaw)) : null;
  const endHHMM = endRaw ? C.fmtHHMM(C.parseHHMM(endRaw)) : null;
  if (endHHMM && !startHHMM) throw new C.LogError('--end 必须与 --start 同时给出。');
  if (endHHMM && C.parseHHMM(endHHMM) <= C.parseHHMM(startHHMM)) {
    throw new C.LogError(`结束时间必须晚于开始时间：${startHHMM}-${endHHMM}`);
  }
  if (noStart && startHHMM) throw new C.LogError('--no-start 与 --start 不能同时使用。');

  const estimated = C.flagNum(flags, 'estimated');
  if (estimated !== null && estimated <= 0) {
    throw new C.LogError('--estimated 必须为正数；不能可靠判断时不要给出该参数（§14）。');
  }

  const switchMode = C.flagBool(flags, 'switch');
  const switchAt = startHHMM || C.nowHHMM();
  const activities = C.flagList(flags, 'activity');

  let status;
  if (C.flagStr(flags, 'status')) {
    status = C.flagStr(flags, 'status');
    if (!C.VALID_STATUS.includes(status)) throw new C.LogError(`--status 非法：${status}`);
  } else if (endHHMM) status = 'completed';
  else if (startHHMM) status = 'in_progress';
  else status = 'needs_confirmation';

  // §14 扩展（2026-09-20）：--no-start 且显式声明已完成 → 「已完成 · 时间未知」。
  // 也支持单独传 --time-unknown 显式声明；未声明时仍按原规则要求 needs_confirmation，
  // 避免把「漏填时间」默认当成合法状态。
  const timeUnknown =
    C.flagBool(flags, 'time-unknown') || (noStart && status === 'completed');

  let segments;
  if (endHHMM) segments = [{ start: startHHMM, end: endHHMM }];
  else if (startHHMM) segments = [{ start: startHHMM, end: null }];
  else segments = [];

  const item = {
    time_unknown: timeUnknown,
    id: C.makeId(),
    date: dateStr,
    project_name: projectName || null,
    project_confidence: projectName ? projectConfidence : null,
    work_type: workType || null,
    work_type_confidence: workType ? workTypeConfidence : null,
    // V3.3：分类 / 项目阶段 / 成果（可选，没有就 null）
    category: categoryFinal,
    project_stage: projectStageFinal,
    output: outputFinal,
    detail,
    detail_compression: detailCompression,
    ai_role: aiRoleRaw || null,
    segment_id: segmentId || null,
    skills,
    models,
    content: finalContent,
    start_time: startHHMM,
    end_time: endHHMM,
    estimated_duration: estimated,
    actual_duration: null,
    status,
    source,
    confidence,
    time_segments: segments,
    activities,
    parent_id: C.flagStr(flags, 'parent'),
    tags: C.flagList(flags, 'tag'),
    notes: C.flagStr(flags, 'notes'),
    // 超长内容的处理留痕：压缩成功记 summarized，降级截断记 truncated（§12）
    content_compression: compression,
  };
  C.normalizeItem(item); // 预演也必须与落盘结果一致，否则 dry-run 输出会缺 display_content
  C.recalc(item, undefined, false);

  if (dryRun) {
    C.emit({ action: 'dry_run', work_item: item, rollover });
    return C.EXIT.OK;
  }

  const ops = [];
  if (switchMode) {
    // 关闭其他事项的开放时段；status 不变（§17：B 开始不得结束 A）
    for (const rec of log.records || []) {
      if ((rec.time_segments || []).some((s) => !s.end)) {
        ops.push({ kind: 'patch', id: rec.id, segmentsClose: [switchAt] });
      }
    }
  }
  ops.push({ kind: 'add', item });
  // 宿主活跃上报，/status 据此判断真实链路而非 auto_tracking
  const registry = {
    host: source,
    tool: source,
    available: true,
    last_activity_at: C.nowIso(),
    activity_delta: 1,
  };
  if (mechanismRaw) registry.mechanism = mechanismRaw;
  ops.push({ kind: 'host', registry });

  const result = C.runMutation(dir, C.flagStr(flags, 'actor') || source, ops, {
    enforceDate: true,
    autoRollover: true,
    decision,
  });
  const stored =
    (result.log.records || []).find((r) => r.id === item.id) || result.log.records.slice(-1)[0];
  C.emit({
    action: 'written',
    version: result.log.version,
    work_item: stored,
    display_content: stored.display_content,
    project_suggestion: projectSuggestion,
    work_type_suggestion: workTypeSuggestion,
    // V3.3：分类与项目阶段的本地建议（仅建议，未确认时不写入）
    category_suggestion: categorySuggestion,
    project_stage_suggestion: projectStageSuggestion,
    switched_closed: switchMode ? ops.length - 2 : 0,
    active_count: (result.log.records || []).filter((r) => r.status === 'in_progress').length,
    rollover,
    security: redaction,
    notes: [
      switchMode
        ? '已按顺序切换语义关闭其他事项的开放时段；其他事项 status 未改变（§2.5）。'
        : '开始新事项不会自动结束其他事项（§2.5）；顺序切换请使用 --switch。',
      status === 'needs_confirmation'
        ? '未提供开始时间，按「不编造」原则置为 needs_confirmation（§2.1）。'
        : null,
      estimated === null ? 'estimated_duration 保持 null（不可靠的预估必须为空，§2.4）。' : null,
      redaction.redacted ? `内容已脱敏：${redaction.hits.join('、')}（§6）` : null,
    ].filter(Boolean),
  });
  return C.EXIT.OK;
});
