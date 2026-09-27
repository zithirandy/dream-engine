'use strict';
/**
 * store.cjs —— 候选/被拒/账本的持久化（V2 §3 / §4.5）。
 *
 * 布局：
 *   candidates/<runId>.ndjson     一次运行的全部候选（一行一条，append-only 友好）
 *   candidates/index.json         运行索引（供 P2 取待打分集合）
 *   rejected/<runId>.ndjson       被闸掉的候选 + 理由
 *   ledger.jsonl                  全量轨迹（P5 回放调参的原料）
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const log = require('./log.cjs');

function runId(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function writeNdjson(file, rows) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
  fs.renameSync(tmp, file);
  return rows.length;
}

function readIndex() {
  const p = pathsMod.paths();
  const f = path.join(p.candidates, 'index.json');
  try {
    const raw = fs.readFileSync(f, 'utf8');
    const j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return Array.isArray(j.runs) ? j : { runs: [] };
  } catch {
    return { runs: [] };
  }
}

function writeIndex(idx) {
  const p = pathsMod.paths();
  const f = path.join(p.candidates, 'index.json');
  ensureDir(p.candidates);
  const tmp = `${f}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

/**
 * 保存一次提炼运行。
 * @param {{candidates:Array, rejected:Array, meta:object, dryRun?:boolean}} args
 */
function saveRun({ candidates = [], rejected = [], meta = {}, dryRun = false }) {
  const p = pathsMod.paths();
  if (dryRun) return { saved: false, dryRun: true, candidates: candidates.length, rejected: rejected.length };

  const rid = runId();
  const cFile = path.join(p.candidates, `${rid}.ndjson`);
  const rFile = path.join(p.rejected, `${rid}.ndjson`);

  const nC = writeNdjson(cFile, candidates);
  const nR = writeNdjson(rFile, rejected);

  const idx = readIndex();
  idx.runs.unshift({
    runId: rid,
    ts: new Date().toISOString(),
    candidates: nC,
    rejected: nR,
    ...meta,
  });
  idx.runs = idx.runs.slice(0, 200); // 索引本身也要有界
  writeIndex(idx);

  log.ledger({ kind: 'extract-run', runId: rid, candidates: nC, rejected: nR, ...meta });
  log.run({ run: 'extract', runId: rid, candidates: nC, rejected: nR, ...meta, result: 'ok' });

  return { saved: true, runId: rid, candidates: nC, rejected: nR, candidateFile: cFile, rejectedFile: rFile };
}

function listRuns() {
  return readIndex().runs;
}

/** 读取最近 n 次运行的全部候选（P2 的输入） */
function loadCandidates({ limit = 5, includeDup = true } = {}) {
  const p = pathsMod.paths();
  const runs = listRuns().slice(0, limit);
  const out = [];
  for (const r of runs) {
    const f = path.join(p.candidates, `${r.runId}.ndjson`);
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const c = JSON.parse(line);
        if (!includeDup && c.dupOf) continue;
        out.push(c);
      } catch { /* 跳过坏行 */ }
    }
  }
  return out;
}

/**
 * ★ P2：记录"已打分"的候选，避免每轮重复给同一批候选**花钱**。
 *
 * 追加式（`scores.jsonl`）而非改写候选文件：候选文件是 P1 的运行快照，
 * 不应被 P2 改写；打分结果另立一条只增不改的轨迹，兼作 P5 回放的原料。
 *
 * ★ 核验 N1 处置：**必须幂等**。此前无条件 append 所有条目，而
 *   `dream --from-results` 重放会再次传入同一批 id ⇒ 每重放一次就叠一层重复
 *   （实测 484 行 / 151 唯一 id，重复 333 = 恰好 3×111）。一次性去重治不了根，
 *   因为下一次重放又会污染，故在写入侧跳过"已存在且判定未变"的条目。
 *   若分数或判定**变了**仍会追加（那是一次真实的更新，`loadScores` 后写覆盖先写）。
 */
function markScored(entries) {
  const p = pathsMod.paths();
  const existing = loadScores();
  const lines = [];
  let skipped = 0;
  const ts = new Date().toISOString();
  for (const e of entries) {
    if (!e || !e.id) continue;
    const decision = (e.decision && e.decision.decision) || null;
    const reason = (e.decision && e.decision.reason) || null;
    const prev = existing.get(e.id);
    if (prev && prev.score === (e.score ?? null) && prev.decision === decision && prev.reason === reason) {
      skipped++;
      continue;                                   // 同一判定重复记入 ⇒ 跳过
    }
    lines.push(JSON.stringify({ ts, id: e.id, score: e.score ?? null, decision, reason }));
  }
  if (!lines.length) return { ok: true, appended: 0, skipped, path: p.scores };
  try {
    fs.mkdirSync(p.home, { recursive: true });
    fs.appendFileSync(p.scores, lines.join('\n') + '\n', 'utf8');
    return { ok: true, appended: lines.length, skipped, path: p.scores };
  } catch (e) { return { ok: false, error: e.message }; }
}

/** 已打分的候选 id 集合（含最后一次决策，后写覆盖先写） */
function loadScores() {
  const p = pathsMod.paths();
  const out = new Map();
  if (!fs.existsSync(p.scores)) return out;
  for (const line of fs.readFileSync(p.scores, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (r.id) out.set(r.id, r); } catch { /* 跳过坏行 */ }
  }
  return out;
}

/** 压缩 `scores.jsonl`（每个 id 只保留最后一条）。幂等写入侧的补救 + 历史存量清理。 */
function compactScores() {
  const p = pathsMod.paths();
  if (!fs.existsSync(p.scores)) return { ok: true, before: 0, after: 0, removed: 0 };
  const raw = fs.readFileSync(p.scores, 'utf8').split('\n').filter((l) => l.trim());
  const best = new Map();
  let bad = 0;
  for (const l of raw) {
    try { const r = JSON.parse(l); if (r.id) best.set(r.id, l); else bad++; } catch { bad++; }
  }
  fs.writeFileSync(p.scores, [...best.values()].join('\n') + '\n', 'utf8');
  return { ok: true, before: raw.length, after: best.size, removed: raw.length - best.size, badLines: bad };
}

module.exports = {
  runId, saveRun, listRuns, loadCandidates, readIndex, writeIndex, writeNdjson,
  markScored, loadScores, compactScores,
};
