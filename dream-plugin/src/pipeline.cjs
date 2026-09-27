'use strict';
/**
 * pipeline.cjs —— P1 管线：门控 → 采集 → 提炼 → 落盘。
 *
 * P1 边界：**不调 Jev**、**不写记忆**。打分与提升属 P2。
 * dryRun 时全程只读（不写 offsets、不写 candidates、不写 state）——
 * 对应 V2 §10 的「只看不写干跑门禁」。
 */
const pathsMod = require('./paths.cjs');
const configMod = require('./config.cjs');
const stateMod = require('./state.cjs');
const lockMod = require('./lock.cjs');
const transcripts = require('./transcripts.cjs');
const extractMod = require('./extract.cjs');
const store = require('./store.cjs');
const log = require('./log.cjs');
const projectsMod = require('./projects.cjs');

/**
 * 五重门控（V2 §6.4）；dryRun 时跳过时间/节流/锁，只保留 enabled。
 *
 * ★ P5：新增 `ignoreMinHours` —— **只绕过 `minHours`，其余闸照旧**。
 *
 * 为什么需要它（而不是用 `ignoreGate`）：`minHours: 24` 是**采集**节奏，按
 * `state.lastRunAt` 判定。自动梦的触发点是"会话刚结束"，如果被 24h 采集中枢挡住，
 * dream 阶段就只能对**旧候选池**打分 —— 新会话的内容进不来，自动梦的价值大打折扣。
 * 但 `ignoreGate` 会把**全部**闸都绕过（含锁与 scan-throttle），粒度太粗、太危险：
 * `scanThrottleMinutes: 10` 是防止"连续两个会话结束 → 连续两次全量采集"的抖动保护，
 * **必须保留**。故这里要的是"精准绕过一道闸"，不是"关掉门控"。
 */
function gate({ cfg, state, dryRun, ignoreGate = false, ignoreMinHours = false }) {
  const reasons = [];
  if (ignoreGate) return { pass: true, reasons: ['gate-bypassed-by-operator'], detail: { minHoursBypassed: false } };
  if (!cfg.enabled && !dryRun) reasons.push('disabled');
  if (dryRun) return { pass: true, reasons: ['dry-run-bypass'], detail: { minHoursBypassed: false } };

  const now = Date.now();
  const last = state.lastRunAt ? Date.parse(state.lastRunAt) : 0;
  const hours = (now - last) / 3600000;
  // ⚠️ 被绕过时**不**往 reasons 里塞东西 —— reasons 是"为什么没通过"的判据
  //    （pass === (reasons.length === 0)），塞进去会把绕过变成"拒绝"。
  //    绕过事实记在 detail 里，供审计。
  if (!ignoreMinHours && last && hours < cfg.minHours) reasons.push(`min-hours (${hours.toFixed(2)}h < ${cfg.minHours}h)`);

  const lastScan = state.lastScanAt ? Date.parse(state.lastScanAt) : 0;
  const sinceScanMin = (now - lastScan) / 60000;
  if (lastScan && sinceScanMin < cfg.scanThrottleMinutes) reasons.push(`scan-throttle (${sinceScanMin.toFixed(1)}min)`);

  const lk = lockMod.readLock();
  if (lk.exists && lk.alive && lk.pid !== process.pid) reasons.push(`lock (pid ${lk.pid})`);

  return {
    pass: reasons.length === 0,
    reasons,
    detail: {
      hoursSinceLastRun: Number(hours.toFixed(2)),
      sinceScanMinutes: Number(sinceScanMin.toFixed(2)),
      minHoursBypassed: !!ignoreMinHours,
      lock: lk,
    },
  };
}

/**
 * @param {{project?:string, dryRun?:boolean, force?:boolean, sealAll?:boolean, sinceMs?:number,
 *          limit?:number, ignoreGate?:boolean, ignoreMinHours?:boolean}} opts
 *   `ignoreGate`     全绕过（操作员手动/验证用）
 *   `ignoreMinHours` ★P5 只绕过 24h 采集中枢，保留 scan-throttle 与锁（自动梦路径用）
 */
function run(opts = {}) {
  const started = Date.now();
  const { config: cfg, source } = configMod.load();
  // 操作员显式覆盖：--ignore-gate 绕过门控；--max-bytes 覆盖单轮字节预算
  if (Number.isFinite(opts.maxBytesPerRun)) {
    cfg.limits = { ...cfg.limits, maxBytesPerRun: opts.maxBytesPerRun };
  }
  const dryRun = !!opts.dryRun;
  const state = stateMod.read();

  const g = gate({ cfg, state, dryRun, ignoreGate: !!opts.ignoreGate, ignoreMinHours: !!opts.ignoreMinHours });
  const base = {
    phase: 'P1', dryRun, project: opts.project || null, configSource: source,
    gate: g, startedAt: new Date().toISOString(),
    maxBytesPerRun: Number.isFinite(cfg.limits.maxBytesPerRun) ? cfg.limits.maxBytesPerRun : null,
  };

  if (!g.pass) {
    log.info('pipeline skipped by gate', { reasons: g.reasons });
    return { ok: true, skipped: true, ...base, durationMs: Date.now() - started };
  }

  // ---- 采集 ----
  // ★ P4 宿主适配接缝：宿主适配层（如 DSH）可以直接把**已归一化的事件**交进来，
  //   从而绕开 Claude Code 的转录读取。这是"引擎只有一份、宿主各挂薄适配"的落点 ——
  //   引擎不需要知道 DSH 的会话格式，适配层负责把宿主记录转成**同一套事件形状**：
  //     { sessionId, project, ts, role, kind: text|tool_use|tool_result|error, text, toolName? }
  const ing = Array.isArray(opts.events)
    ? {
      events: opts.events,
      stats: {
        files: 0, filesScanned: 0, bytesRead: 0, lines: opts.events.length,
        injected: true, hostSource: opts.hostSource || 'external',
      },
      perFile: [],
    }
    : transcripts.ingest({
      projectFilter: opts.project || null,
      sinceMs: opts.sinceMs !== undefined ? opts.sinceMs : null,
      force: !!opts.force,
      sealAll: !!opts.sealAll,
      config: cfg,
      dryRun,
    });

  // ---- 按项目分组提炼（提炼需要该项目的既有记忆做"已知"判断）----
  const byProject = new Map();
  for (const e of ing.events) {
    if (!e.project) continue;
    if (!byProject.has(e.project)) byProject.set(e.project, []);
    byProject.get(e.project).push(e);
  }

  const allCandidates = [];
  const perProject = [];
  for (const [slug, events] of byProject) {
    const existing = projectsMod.loadMemoryTexts(slug, { cfg });
    const cands = extractMod.extract(events, { project: slug, existing, cfg });
    const dup = cands.filter((c) => c.dupOf).length;
    allCandidates.push(...cands);
    perProject.push({
      project: slug, events: events.length, candidates: cands.length, alreadyKnown: dup,
      existingIndexFiles: existing.topLevel.length, existingAuxFiles: existing.auxiliary.length,
    });
  }

  // ---- 全局预算：maxCandidatesPerRun（★ F1 附带修复：此前零实施）----
  const cap = Number.isFinite(cfg.limits.maxCandidatesPerRun) ? cfg.limits.maxCandidatesPerRun : Infinity;
  let truncated = 0;
  let selected = allCandidates;
  if (allCandidates.length > cap) {
    selected = allCandidates.slice().sort((a, b) => b.weight - a.weight).slice(0, cap);
    truncated = allCandidates.length - selected.length;
  }

  // 被闸掉的不单独留档（闸内已计数），此处只记汇总
  const rejectedSummary = {
    bySignal: selected.reduce((m, c) => { m[c.signal] = (m[c.signal] || 0) + 1; return m; }, {}),
    truncated,
  };

  const meta = {
    host: 'cli', project: opts.project || null,
    ingest: ing.stats, projects: perProject,
    alreadyKnown: selected.filter((c) => c.dupOf).length,
    truncated,
  };

  // ---- 落盘（dryRun 跳过；无候选时不写空文件污染索引，但时间戳照常推进）----
  const saved = (selected.length === 0)
    ? { saved: false, reason: 'no-candidates', candidates: 0, rejected: 0 }
    : store.saveRun({ candidates: selected, rejected: [], meta, dryRun });

  if (!dryRun) {
    stateMod.update((s) => {
      s.lastRunAt = new Date().toISOString();
      s.lastScanAt = s.lastRunAt;
      // 只有真正产出候选时才计入 runs，避免空转刷计数
      if (selected.length > 0) {
        s.counters.runs = (s.counters.runs || 0) + 1;
        s.counters.candidates = (s.counters.candidates || 0) + selected.length;
      }
      return s;
    });
  }

  return {
    ok: true, skipped: false, ...base,
    ingest: ing.stats,
    perFile: opts.verbose ? ing.perFile : undefined,
    perProject,
    candidates: selected.length,
    candidatesBeforeCap: allCandidates.length,
    truncated,
    alreadyKnown: meta.alreadyKnown,
    bySignal: rejectedSummary.bySignal,
    saved,
    durationMs: Date.now() - started,
    sample: selected.slice(0, opts.limit || 12),
  };
}

module.exports = { run, gate };
