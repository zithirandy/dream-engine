'use strict';
/**
 * github.cjs —— GitHub 采集的编排层：日闸门 → 采集 → delta → 渲染 → 落盘。
 *
 * ── 与自动梦的关系（刻意解耦） ────────────────────────────────────────
 * 本模块**不复用** autoDream 的调度器，也不用它的偏移文件：
 *   · 自动梦由"会话结束"事件驱动，跑的是引擎内的本地数据；
 *   · 本模块由**墙上时钟**驱动（每早固定时刻），跑的是外部网络数据。
 * 两者的触发语义、失败重试语义、状态文件都不同，混用会互相踩
 * （这正是当初把 `autoOffsets` 与 `offsets` 分开的同一条理由）。
 *
 * 触发分两层，各司其职：
 *   1. **Windows 计划任务**（`schtasks` 模块）—— 保证"每早到点就跑"，
 *      即使守护进程没起来。这是唯一能保证时刻的一层。
 *   2. **本模块的 `decide()` 闸门** —— 保证"同一天不重复跑"，
 *      并让手动执行与补跑共用同一套判定（`--force` 可绕过）。
 *
 * ── 为什么闸门按"时间戳"而非"日期字符串"判定 ─────────────────────────
 * 只比较 `lastRunAt` 与**今天的应跑时刻**：
 *   · 今天 08:00 之前 → 不跑（还没到点）
 *   · 今天 08:00 之后且 lastRunAt < 今天 08:00 → 跑（含**补跑**：
 *     昨天关机错过，今天开机后第一次调用就会补上）
 *   · lastRunAt >= 今天 08:00 → 不跑（今天已经跑过）
 * 这套判定天然覆盖"错过补跑"与"当天去重"，不需要额外的日期簿记。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const configMod = require('./config.cjs');
const logMod = require('./log.cjs');
const apiMod = require('./github-api.cjs');
const collectMod = require('./github-collect.cjs');
const reportMod = require('./github-report.cjs');

// ------------------------------------------------------------------ 状态

function statePath() { return pathsMod.paths().githubState; }
function logPath() { return pathsMod.paths().githubLog; }

function readState() {
  const f = statePath();
  const empty = { version: 1, lastRunAt: null, lastRunOk: null, runs: 0, items: {}, lastReportPath: null, lastError: null };
  if (!fs.existsSync(f)) return empty;
  try {
    const raw = fs.readFileSync(f, 'utf8');
    const j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return { ...empty, ...j, items: (j && j.items) || {} };
  } catch (e) {
    return { ...empty, error: e.message };
  }
}

function writeState(st) {
  const f = statePath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
  fs.renameSync(tmp, f);          // 原子替换：避免断电/崩溃留下半个状态文件
  return f;
}

function appendLog(rec) {
  const f = logPath();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, JSON.stringify(rec) + '\n', 'utf8');
  return f;
}

function readLog(limit = 20) {
  const f = logPath();
  if (!fs.existsSync(f)) return [];
  try {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return { _unparsable: l.slice(0, 200) }; } });
  } catch { return []; }
}

// ------------------------------------------------------------------ 闸门

/** 把 `HH:MM` 解析成 `{h, m}`；非法返回 null */
function parseSchedule(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return { h, m: mi };
}

/** 今天（本地时区）的应跑时刻 */
function dueAtToday(schedule, nowMs) {
  const p = parseSchedule(schedule);
  if (!p) return null;
  const d = new Date(nowMs);
  d.setHours(p.h, p.m, 0, 0);
  return d.getTime();
}

/**
 * 纯判定：现在该不该跑。**任何异常都降级为"不跑"**（保守方向失败）。
 */
function decide({ cfg, state, nowMs, force = false } = {}) {
  const g = (cfg && cfg.github) || {};
  const c = g.collection || {};
  const reasons = [];

  if (force) return { pass: true, reasons: [], detail: { forced: true } };

  if (g.enabled !== true) return { pass: false, reasons: ['github-disabled'], detail: { hint: 'node cli.cjs config set github.enabled=true' } };

  const due = dueAtToday(c.schedule || '08:00', nowMs);
  if (due === null) return { pass: false, reasons: [`schedule-invalid:${c.schedule}`], detail: {} };

  const last = state && state.lastRunAt ? Date.parse(state.lastRunAt) : NaN;
  const hasLast = Number.isFinite(last);

  if (nowMs < due) {
    return { pass: false, reasons: [`before-schedule (${c.schedule})`], detail: { dueAt: new Date(due).toISOString(), now: new Date(nowMs).toISOString() } };
  }
  if (hasLast && last >= due) {
    return { pass: false, reasons: ['already-ran-today'], detail: { lastRunAt: state.lastRunAt, dueAt: new Date(due).toISOString() } };
  }
  const missedDays = hasLast ? Math.floor((due - last) / 86400000) : null;
  if (hasLast && missedDays >= 1) reasons.push(`catch-up (错过 ${missedDays} 天)`);
  else if (hasLast) reasons.push('due');          // 正常当天首次到点
  if (!hasLast) reasons.push('first-run');
  return { pass: true, reasons, detail: { dueAt: new Date(due).toISOString(), lastRunAt: state.lastRunAt || null, missedDays } };
}

// ------------------------------------------------------------------ 运行

function resolveRepos(cfg) {
  const g = (cfg && cfg.github) || {};
  const list = Array.isArray(g.repos) ? g.repos.filter(Boolean) : [];
  if (!list.length) {
    return { ok: false, error: 'no-repos', hint: 'node cli.cjs config set github.repos=["owner/name"]（或用 --repo 指定）' };
  }
  const bad = list.filter((r) => !/^[^/\s]+\/[^/\s]+$/.test(String(r)));
  if (bad.length) return { ok: false, error: 'bad-repo-format', detail: bad, hint: '应为 owner/name' };
  return { ok: true, repos: list.map(String) };
}

function reportDir(cfg) {
  const g = (cfg && cfg.github) || {};
  const d = g.report && g.report.dir;
  return d ? path.resolve(d) : pathsMod.paths().githubReports;
}

function reportFileName(nowMs, cfg) {
  const g = (cfg && cfg.github) || {};
  const prefix = (g.report && g.report.filePrefix) || 'GitHub日报';
  const d = new Date(nowMs);
  const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${prefix}-${s}.md`;
}

/**
 * 跑一轮采集。
 *
 * @param {object} o
 * @param {object} o.cfg       配置（缺省则 load）
 * @param {boolean} o.force    忽略闸门
 * @param {boolean} o.dry      干跑：照常采集与渲染，但不写报告/状态/日志
 * @param {string} o.sinceOverride  手动指定窗口起点（ISO）
 * @param {string[]} o.reposOverride
 * @returns {Promise<object>} 一轮的结构化结果
 */
async function runOnce({ cfg = null, force = false, dry = false, sinceOverride = null, reposOverride = null, deps = {} } = {}) {
  const t0 = Date.now();
  const conf = cfg || configMod.load().config;
  const nowMs = (deps.now ? deps.now() : Date.now());

  const st = readState();
  const verdict = decide({ cfg: conf, state: st, nowMs, force });
  if (!verdict.pass) {
    return { ok: true, skipped: true, verdict, reason: verdict.reasons.join('; '), durationMs: Date.now() - t0 };
  }

  const rr = reposOverride && reposOverride.length ? { ok: true, repos: reposOverride } : resolveRepos(conf);
  if (!rr.ok) {
    const rec = { at: new Date(nowMs).toISOString(), ok: false, error: rr.error, detail: rr.detail || null, hint: rr.hint || null, durationMs: Date.now() - t0 };
    if (!dry) { appendLog(rec); }
    return { ok: false, ...rec, verdict };
  }

  // 凭据：`gh` 传输其实由 gh 自己认证，但提前解析能给出**明确**的失败原因
  //（否则只会看到一堆 http-401，不知道是没登录还是 token 过期）。
  const cred = apiMod.resolveToken(conf, { deps });
  if (!cred.ok) {
    const rec = {
      at: new Date(nowMs).toISOString(), ok: false, error: 'credential-unavailable',
      reason: cred.reason, hint: cred.hint || null, detail: cred.detail || null, durationMs: Date.now() - t0,
    };
    if (!dry) appendLog(rec);
    return { ok: false, ...rec, verdict };
  }

  // 采集窗口：上一轮往前挪 overlapMinutes，兜住两次运行之间的边界
  const g = conf.github || {};
  const c = g.collection || {};
  const overlapMs = Math.max(0, Number(c.overlapMinutes) || 0) * 60000;
  let since;
  if (sinceOverride) since = new Date(Date.parse(sinceOverride)).toISOString();
  else if (st.lastRunAt) since = new Date(Date.parse(st.lastRunAt) - overlapMs).toISOString();
  else since = new Date(nowMs - Math.max(1, Number(c.maxAgeDays) || 30) * 86400000).toISOString();

  const collected = await collectMod.collectAll({ repos: rr.repos, cfg: conf, token: cred.token, since, deps });
  const delta = reportMod.diffItems({ items: collected.items, prev: st });

  const rendered = reportMod.renderReport({
    repos: rr.repos,
    delta,
    meta: { since, reason: force ? 'force' : (verdict.reasons.join('+') || 'scheduled') },
    prevRunAt: st.lastRunAt,
    nowMs,
    cfg: conf,
    collection: collected,
    errors: collected.errors,
    truncated: collected.truncated,
    dryRun: dry,
  });

  const dir = reportDir(conf);
  const file = path.join(dir, reportFileName(nowMs, conf));
  const latest = path.join(dir, '最新.md');
  const jsonPath = path.join(dir, 'latest.json');

  // ★ `report.writeUnchanged` 的真实语义（此前只在 DEFAULTS 里声明、无人读 ——
  //   被 `test/config.cjs` 的死键守卫抓到）。
  //   零变化日是否也落一份报告文件：关掉可避免一年堆 365 份"无变化"文件。
  //   两种情况下**必须照写**，否则会丢信息：
  //     · 首次运行 —— 那份就是基线快照；
  //     · dry 之外的任何有变化日 —— 无需解释。
  const emptyDelta = (delta.totals.added + delta.totals.updated + delta.totals.closed + delta.totals.reopened) === 0;
  const firstRun = !st.lastRunAt;
  const keepUnchanged = !(g.report && g.report.writeUnchanged === false);
  const willWrite = keepUnchanged || !emptyDelta || firstRun;

  const result = {
    ok: collected.errors.length === 0,
    skipped: false,
    at: new Date(nowMs).toISOString(),
    repos: rr.repos,
    since,
    durationMs: Date.now() - t0,
    credentialFrom: cred.from,
    verdict,
    delta: delta.totals,
    stats: rendered.stats,
    emptyDelta,
    firstRun,
    wroteReport: !dry && willWrite,
    reportPath: willWrite ? file : (st.lastReportPath || null),
    redactedHits: rendered.redactedHits,
    errors: collected.errors,
    truncated: collected.truncated,
    perRepo: collected.perRepo,
    rate: collected.rate,
  };

  if (dry) return { ...result, dry: true, markdown: rendered.markdown };

  if (willWrite) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, rendered.markdown, 'utf8');
    // 「最新.md」/latest.json 是便利副本，写失败不影响主产物
    try { fs.writeFileSync(latest, rendered.markdown, 'utf8'); } catch { /* ignore */ }
    try {
      fs.writeFileSync(jsonPath, JSON.stringify({
        generatedAt: result.at, repos: rr.repos, since, delta: delta.totals,
        stats: rendered.stats, errors: collected.errors, reportPath: file,
      }, null, 2), 'utf8');
    } catch { /* ignore */ }
  }

  const snap = reportMod.snapshot(collected.items, st);
  const next = {
    ...st,
    lastRunAt: result.at,
    lastRunOk: result.ok,
    runs: (st.runs || 0) + 1,
    items: snap.items,
    // 未落报告时**保留**上一次的报告路径，不要把指针清空
    lastReportPath: willWrite ? file : (st.lastReportPath || null),
    lastError: collected.errors.length ? collected.errors[0] : null,
    lastDelta: delta.totals,
  };
  writeState(next);
  appendLog({
    at: result.at, ok: result.ok, repos: rr.repos, since,
    delta: delta.totals, stats: rendered.stats, errors: collected.errors.length,
    durationMs: result.durationMs, reportPath: willWrite ? file : null,
    wroteReport: willWrite, items: Object.keys(snap.items).length,
  });

  return result;
}

/** 供 `github status` 用的汇总 */
function status(cfg = null, nowMs = Date.now()) {
  const conf = cfg || configMod.load().config;
  const st = readState();
  const g = conf.github || {};
  const dir = reportDir(conf);
  let latest = null;
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md')).sort();
      if (files.length) {
        const f = path.join(dir, files[files.length - 1]);
        const s = fs.statSync(f);
        latest = { file: f, bytes: s.size, mtime: s.mtime.toISOString() };
      }
    }
  } catch { /* ignore */ }

  return {
    enabled: g.enabled === true,
    transport: g.transport || 'gh',
    tokenSource: g.tokenSource || 'gh',
    schedule: (g.collection && g.collection.schedule) || '08:00',
    repos: g.repos || [],
    reportDir: dir,
    lastRunAt: st.lastRunAt,
    lastRunOk: st.lastRunOk,
    runs: st.runs || 0,
    trackedItems: Object.keys(st.items || {}).length,
    lastReportPath: st.lastReportPath,
    lastError: st.lastError,
    latestReport: latest,
    verdict: decide({ cfg: conf, state: st, nowMs }),
    recent: readLog(5),
  };
}

module.exports = {
  decide, parseSchedule, dueAtToday,
  readState, writeState, appendLog, readLog,
  statePath, logPath, reportDir, reportFileName, resolveRepos,
  runOnce, status,
};
