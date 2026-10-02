'use strict';
/**
 * p2.cjs —— 自动梦闭环编排（V2 line 740「P2 打分」）。
 *
 * 流程：候选池 → 构造请求 → Jev 打分 → 决策（双层阈值）→ 提升（正文+指针+git）
 *       → G2 全局分发 → 运行日志 + ledger。
 *
 * 安全边界（三条硬约束，缺一不可）：
 *   1. `guard.decideWrite()` 否决时**只打分不落盘**（audit 模式）；
 *      打分结果仍写入候选池供人工/手动梦复核 —— 只读审计层不等于什么都不做。
 *   2. `dryRun` 时连 API 都不调（沿 P1 的"只看不写干跑"契约）。
 *   3. 任何一步失败都不得让已落盘的内容回滚（git 失败不回滚正文）。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const configMod = require('./config.cjs');
const store = require('./store.cjs');
const stateMod = require('./state.cjs');
const log = require('./log.cjs');
const jev = require('./jev.cjs');
const decideMod = require('./decide.cjs');
const promoteMod = require('./promote.cjs');
const fanoutMod = require('./fanout.cjs');
const guardMod = require('./guard.cjs');

/**
 * 对一批候选打分。
 * @returns {{ok, scored:Array, blocked:Array, calls, tokensIn, tokensOut, latencyMs, model, notes:Array, reason?}}
 */
async function scoreCandidates(candidates, { cfg, onNote = null } = {}) {
  const c = cfg || configMod.load().config;
  if (!candidates.length) return { ok: true, scored: [], blocked: [], calls: 0, tokensIn: 0, tokensOut: 0, latencyMs: 0, model: null, notes: [] };

  const notes = [];
  const byProject = new Map();
  for (const x of candidates) {
    if (!byProject.has(x.project)) byProject.set(x.project, []);
    byProject.get(x.project).push(x);
  }

  const scored = []; const blocked = []; const notesAll = [];
  let calls = 0; let tokensIn = 0; let tokensOut = 0; let latencyMs = 0; let model = null;

  for (const [project, list] of byProject) {
    // 同项目同批 ⇒ digest 相同，批内比较才成立。
    // 分块由 callAdaptive 按 cfg.jev.batchSize 负责（此前该配置是死的，已修）。
    const r = await jev.callAdaptive(list, {
      cfg: c, tag: `p2-${project}`,
      onNote: (m) => { notesAll.push(m); if (onNote) onNote(m); },
    });
    calls += r.calls; tokensIn += r.tokensIn; tokensOut += r.tokensOut;
    latencyMs += r.latencyMs; if (r.model) model = r.model;
    for (const s of r.results) scored.push({ ...s, project });
    for (const b of r.blocked) blocked.push({ ...b, project });
    for (const id of (r.deferred || [])) blocked.push({ id, project, reason: 'egress-off-deferred' });
    if (r.reason === 'egress-off') return { ok: false, reason: 'egress-off', scored, blocked, calls, tokensIn, tokensOut, latencyMs, model, notes: notesAll };
  }
  return { ok: true, scored, blocked, calls, tokensIn, tokensOut, latencyMs, model, notes: notesAll, notesRef: notes };
}

/**
 * 提升 + G2 分发。
 * @returns {{promoted:Array, fanout:Array, globalExperiences:Array, refused?:string}}
 */
function applyDecisions(decisions, candById, { cfg, policy, dryRun = false, runG2 = true, jevModel = null, now = new Date() } = {}) {
  const c = cfg || configMod.load().config;
  const pol = policy || guardMod.decideWrite({ cfg: c });

  const promotes = decisions.filter((d) => d.decision === 'promote');
  if (!pol.allow || dryRun) {
    return {
      promoted: promotes.map((d) => ({ candId: d.candId, wouldPromote: true, score: d.score, signal: d.signal })),
      fanout: [], globalExperiences: [], refused: pol.allow ? null : pol.reason, dryRun,
    };
  }

  const promoted = []; const fanout = []; const globalExperiences = [];
  for (const d of promotes) {
    const cand = candById.get(d.candId);
    if (!cand) { promoted.push({ candId: d.candId, ok: false, reason: 'candidate-not-found' }); continue; }
    // jevModel 来自评分结果（决策本身不带它）—— 否则 frontmatter 会写成 unknown
    const scored = { score: d.score, kind: d.kind, n: d.n, jevModel: jevModel || d.jevModel || null };
    const r = promoteMod.promoteOne(cand, scored, { cfg: c, policy: pol, now });
    promoted.push({ candId: d.candId, ...r });
    if (!r.ok) continue;

    // ★ 修正（2026-09-30）：`refreshed` = 目标文件已存在且**正文逐字相同**
    //   （由 `promote.writeBody` 判定）。那不是新知识，只是一次元数据重算 ——
    //   既不该再进 `globalExperiences`（否则下游 G2 会对一条**已经分发过**的
    //   global 条目重跑扇出，实测每轮白花 1 次调用），也不该被上游计成"提升"。
    if (r.refreshed) continue;

    if (r.kind === 'global') {
      globalExperiences.push({ name: r.name, candId: d.candId });
      if (runG2) fanout.push({ name: r.name, candId: d.candId, pending: true });
    }
  }
  return { promoted, fanout, globalExperiences, refused: null, dryRun: false };
}

/**
 * G2：对已写出的全局经验逐个做相关性判定并写指针。
 * 一次请求覆盖全部已知项目（零 LLM）。
 */
async function runG2(globalExperiences, candById, { cfg, policy, onNote = null } = {}) {
  const c = cfg || configMod.load().config;
  const pol = policy || guardMod.decideWrite({ cfg: c });
  const projects = fanoutMod.listProjects();
  const result = { evaluated: 0, hits: [], applied: [], skipped: [], calls: 0, reason: null };
  if (!globalExperiences.length) return result;
  if (!projects.length) { result.reason = 'no-projects-with-memory'; return result; }

  const slugs = projects.map((x) => x.slug);
  for (const g of globalExperiences) {
    const cand = candById.get(g.candId);
    const exp = { text: cand ? cand.text : '', kind: null, durabilityRaw: null };
    const { payload } = fanoutMod.buildFanoutRequest(exp, slugs, { cfg: c });
    const v = fanoutMod.validateFanout(payload);
    if (!v.ok) { result.reason = `fanout-shape-invalid: ${v.errs.slice(0, 2).join('; ')}`; continue; }

    const r = await jev.callJev(payload, { cfg: c, tag: `g2-${g.name}` });
    result.calls++;
    result.evaluated += slugs.length;
    if (!r.ok) { result.reason = r.error || `http-${r.status}`; continue; }

    const parsed = fanoutMod.parseFanout(r.body, { cfg: c });
    for (const h of parsed.hits) result.hits.push({ ...h, experience: g.name });
    if (onNote) onNote(`  G2 ${g.name}: 命中 ${parsed.hits.length}/${parsed.evaluated}（阈值 ${parsed.min}，上限 ${parsed.maxFanout}）`);
    if (!pol.allow) { result.skipped.push(...parsed.hits.map((h) => h.project)); continue; }
    const applied = fanoutMod.applyFanout(g.name, parsed.hits, { cfg: c, policy: pol });
    result.applied.push(...applied.applied);
    result.skipped.push(...applied.skipped);
  }
  return result;
}

/**
 * 完整自动梦一轮。
 * @param {{project?:string, limit?:number, dryRun?:boolean, runG2?:boolean, maxCandidates?:number}} opts
 */
async function autoDream(opts = {}) {
  const started = Date.now();
  const cfgRes = configMod.load();
  const cfg = cfgRes.config;
  const policy = guardMod.decideWrite({ cfg });
  const dryRun = !!opts.dryRun;

  const all = store.loadCandidates({ limit: opts.limit || 500 });
  const byIdAll = new Map(all.map((x) => [x.id, x]));
  const alreadyScored = store.loadScores();          // ★ 防重复花钱：跳过已打分的候选

  // ★ 评分与落盘**解耦**（`--from-results`）：用已保存的答案直接走决策与落盘，
  //   不再出网。必要性来自实测：audit 模式下候选已全部打完分，若只按"跳过已打分"
  //   筛选，切到 active 后新 run **什么都不会提升**（这正是本会话遇到的情形）。
  //   同时它让"先看再写"成为可能：`--from-results X --dry` 只预览要写什么。
  let pool; let preScored = null; let preScoredModel = null;
  if (opts.fromResults) {
    let j;
    try { j = JSON.parse(fs.readFileSync(opts.fromResults, 'utf8')); }
    catch (e) { return { ok: false, reason: 'from-results-read-failed', error: e.message, durationMs: Date.now() - started }; }
    preScoredModel = j.model || null;          // 结果文件里的模型名（写 frontmatter 用）
    preScored = (j.results || []).filter((r) => r.ok)
      .map((r) => ({ ...r, project: r.project || j.project || null }));
    pool = preScored.map((r) => byIdAll.get(r.candId)).filter(Boolean);
  } else {
    pool = (opts.project ? all.filter((x) => x.project === opts.project) : all)
      .filter((x) => !alreadyScored.has(x.id))
      .slice(0, Number.isFinite(opts.maxCandidates) ? opts.maxCandidates : 300);
  }

  const base = {
    phase: 'P2', dryRun, project: opts.project || null,
    fromResults: opts.fromResults || null,
    policy: { allow: policy.allow, mode: policy.mode, effectiveMode: policy.effectiveMode, reason: policy.reason, officialStatus: policy.officialStatus, conflict: policy.conflict },
    candidatesInPool: all.length, alreadyScored: alreadyScored.size, selected: pool.length,
    startedAt: new Date().toISOString(),
  };

  if (!pool.length) {
    return { ok: true, skipped: true, reason: opts.fromResults ? 'no-candidates-in-results' : 'no-unscored-candidates', ...base, durationMs: Date.now() - started };
  }
  // dryRun 且需要出网时直接返回（保证"干跑连 API 都不调"）；
  // 来自已保存答案时**继续**走决策，以便预览将要写入的内容。
  if (dryRun && !opts.fromResults) return { ok: true, skipped: true, reason: 'dry-run', ...base, durationMs: Date.now() - started };

  const scoring = preScored
    ? { ok: true, scored: preScored, blocked: [], calls: 0, tokensIn: 0, tokensOut: 0, latencyMs: 0, model: preScoredModel, notes: [], fromResults: true }
    : await scoreCandidates(pool, { cfg });
  if (scoring.reason === 'egress-off') {
    return { ok: true, skipped: true, reason: 'egress-off', ...base, durationMs: Date.now() - started };
  }

  const candById = new Map(pool.map((x) => [x.id, x]));
  // 决策需要候选**文本**（片段/进度叙述检测按文本判定），且必须用**规范化后**的文本 ——
  // 否则闸门看到的是带 `",` / 请求尾巴的脏文本，判定与最终入库内容不一致（N4）。
  const hygiene = require('./hygiene.cjs');
  const decisions = decideMod.decideAll(
    scoring.scored.map((s) => {
      const cand = byIdAll.get(s.candId) || {};
      return { ...s, text: hygiene.normalizeCandidate(cand.text, cfg, s.signal) };
    }),
    { cfg },
  );
  const applied = applyDecisions(decisions.decisions, candById, { cfg, policy, dryRun, runG2: opts.runG2 !== false, jevModel: scoring.model });
  const g2 = await runG2(applied.globalExperiences, candById, { cfg, policy });

  // 打分结果回写候选池（audit 模式下也要留下，供人工/手动梦复核）。
  // ★ 但 **dryRun 一律不落盘** —— 与 P1 的"只看不写干跑门禁"契约一致。
  //   此前漏了这个判断，`--dry` 会给 scores.jsonl 追加重复行（实测追加了 111 条）。
  let saved = null;
  if (!dryRun) {
    try {
      saved = store.markScored(scoring.scored.map((s) => ({
        id: s.candId, score: s.score, decision: decisions.decisions.find((d) => d.candId === s.candId),
      })));
    } catch (e) { saved = { ok: false, error: e.message }; }
  } else {
    saved = { ok: true, appended: 0, skipped: 'dry-run' };
  }

  // ★ 核验 N2 处置：P2 写入路径补 **state 计数**。
  //   此前 P2 从不调用 stateMod.update ⇒ ledger 记了 `promoted:8` 而
  //   `state.counters.promoted` 恒为 0，看板/门控引用 state 会拿到错误全景。
  //
  //   ⚠️ 刻意**不更新 `lastRunAt` / `lastScanAt`**：它们是 P1 采集节奏，
  //      门控的 `minHours` 据此判定"距上次自动运行多久"。P2 若推进它，
  //      会**抑制下一次 P1 采集**。故 P2 用自己的 `lastDreamAt` 与独立计数。
  let stateUpdate = null;
  if (!dryRun) {
    try {
      stateUpdate = stateMod.update((s) => {
        s.counters = s.counters || {};
        // ★ 修正（2026-09-30）：只把**真正新写入**的算作提升。
        //   `refreshed`（正文逐字相同、只重算元数据）此前也被计进来，
        //   于是"产出"指标虚增 —— 实测同一条目三次提升里有两次是刷新。
        s.counters.promoted = (s.counters.promoted || 0) + applied.promoted.filter((x) => x.ok && !x.refreshed).length;
        s.counters.promotedRefreshed = (s.counters.promotedRefreshed || 0) + applied.promoted.filter((x) => x.ok && x.refreshed).length;
        s.counters.globalPromoted = (s.counters.globalPromoted || 0) + applied.globalExperiences.length;
        s.counters.dreamRuns = (s.counters.dreamRuns || 0) + 1;
        s.counters.dreamHeld = (s.counters.dreamHeld || 0) + decisions.summary.hold;
        s.counters.dreamRejected = (s.counters.dreamRejected || 0) + decisions.summary.reject;
        // ★ 2026-09-29：补上 `state.jev` —— 此前它被定义、被展示、却**从未被写入**
        //   （死状态），于是永远显示 0 次调用 / 0 tokens，与 ledger 里的真实用量矛盾。
        //   这里 `scoring.model/calls/tokensIn/tokensOut` 与 `g2.calls` 都在作用域内，
        //   零额外开销。口径与 ledger 对齐：`requests`=Jev 调用数，`g2Requests`=G2 调用数，
        //   `requests + g2Requests` 即 ledger 的 `jevRequestsTotal`。
        s.jev = s.jev || {};
        s.jev.lastModel = scoring.model || s.jev.lastModel || null;
        s.jev.requests = (s.jev.requests || 0) + (scoring.calls || 0);
        s.jev.g2Requests = (s.jev.g2Requests || 0) + (g2.calls || 0);
        s.jev.tokensIn = (s.jev.tokensIn || 0) + (scoring.tokensIn || 0);
        s.jev.tokensOut = (s.jev.tokensOut || 0) + (scoring.tokensOut || 0);
        s.lastDreamAt = new Date().toISOString();
        return s;
      });
    } catch (e) { log.warn('state update failed', { error: e.message }); }
  }

  const entry = {
    ts: new Date().toISOString(), run: 'auto', host: 'cli',
    project: opts.project || null,
    candidates: pool.length,
    jevModel: scoring.model, jevRequests: scoring.calls,
    tokensIn: scoring.tokensIn, tokensOut: scoring.tokensOut,
    // ★ G2 的调用与 tokens 也必须入账 —— 否则 ledger 显示 jevRequests=0 而实际
    //   发了调用（实测真实写入时 G2 发了 2 次，账本却是 0，成本统计因此漏算）。
    g2Requests: g2.calls,
    jevRequestsTotal: scoring.calls + g2.calls,
    promoted: applied.promoted.filter((p) => p.ok && !p.refreshed).length,
    // ★ 2026-09-30 新增：正文未变、只重算元数据的条数。
    //   与 `promoted` **分开记**，否则 ledger 的"产出"口径会把刷新也当成新知识
    //   （这正是"同一条目三次提升"看起来像三次产出的原因）。
    refreshed: applied.promoted.filter((p) => p.ok && p.refreshed).length,
    globalPromoted: applied.globalExperiences.length,
    globalFanout: g2.applied.map((a) => a.project),
    toCandidates: decisions.summary.hold,
    rejected: decisions.summary.reject,
    byReason: decisions.summary.byReason,
    blocked: scoring.blocked.length,
    effectiveMode: policy.effectiveMode,
    fromResults: opts.fromResults ? path.basename(opts.fromResults) : null,
    durationMs: Date.now() - started,
    result: dryRun ? 'dry-run' : 'ok',
  };
  if (!dryRun) {
    try { log.ledger(entry); } catch (e) { log.warn('ledger append failed', { error: e.message }); }
  }

  // ★ 保存**完整**逐候选结果（含全部答案维度与决策）。
  //   `scores.jsonl` 只存 id/score/decision，答案向量（n / conf / kind）会丢失 ——
  //   后果是闸值复标与 P5 回放只能**重新花钱打分**。本文件与 jevtest 的结果文件同构，
  //   故 `_threshold-sweep.cjs` / `_decide-dryrun.cjs` 可直接消费。
  let resultsFile = null;
  if (!dryRun) {
    try {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      resultsFile = path.join(pathsMod.paths().reports, `p2-results-${stamp}.json`);
      fs.writeFileSync(resultsFile, JSON.stringify({
        ts: new Date().toISOString(),
        project: opts.project || null,
        model: scoring.model || null,
        source: 'autoDream',
        cfg: { weights: cfg.weights, gates: cfg.gates, thresholds: cfg.thresholds },
        results: scoring.scored.map((s) => {
          const d = decisions.decisions.find((x) => x.candId === s.candId) || {};
          return {
            candId: s.candId, qid: s.qid, ok: s.ok, score: s.score, passHardGates: s.passHardGates,
            alreadyKnown: s.alreadyKnown, n: s.n, kind: s.kind, conf: s.conf, signal: s.signal,
            project: s.project,
            decision: d.decision || null, reason: d.reason || null, detail: d.detail || null,
          };
        }),
      }, null, 2), 'utf8');
    } catch (e) { log.warn('p2 results save failed', { error: e.message }); }
  }

  return {
    ok: true, skipped: false, ...base,
    scoring: { calls: scoring.calls, tokensIn: scoring.tokensIn, tokensOut: scoring.tokensOut, latencyMs: scoring.latencyMs, model: scoring.model, blocked: scoring.blocked },
    decisions: decisions.summary,
    applied, g2: { evaluated: g2.evaluated, hits: g2.hits, applied: g2.applied, calls: g2.calls, reason: g2.reason },
    saved,
    stateUpdate: stateUpdate ? { ok: true } : null,
    resultsFile,
    ledgerEntry: entry,
    durationMs: Date.now() - started,
  };
}

module.exports = { autoDream, scoreCandidates, applyDecisions, runG2 };
