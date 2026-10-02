'use strict';
/**
 * state.cjs —— state.json 的原子读写。
 * 对应 V2 §3 / §6.4，以及核验快报残余注意项 #2（state.projects 需初始化）。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');

const STATE_VERSION = 1;

function emptyState() {
  const now = new Date().toISOString();
  return {
    version: STATE_VERSION,
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    lastScanAt: null,
    lastSpawnAt: null,
    lastConsolidatedAt: null,
    // ★ P2 写入路径的独立时间戳。**不与 `lastRunAt` 合并** —— 后者是 P1 采集节奏，
    //   门控的 `minHours` 用它判定"距上次自动运行多久"；若 P2 推进它，会抑制下次采集。
    lastDreamAt: null,
    counters: {
      runs: 0, promoted: 0, globalPromoted: 0, candidates: 0, rejected: 0, degraded: 0,
      // P2 自有计数（与 P1 的 runs/candidates/rejected 语义分开，避免混用歧义）
      dreamRuns: 0, dreamHeld: 0, dreamRejected: 0,
      // ★ 2026-09-30 新增：`promoted` **只计真正新写入的记忆**；
      //   正文逐字相同、只重算元数据的那些记在这里。
      //   分开的理由：合成一个数会让"同一条目反复提升"看起来像持续产出 ——
      //   实测同一 global 条目三次提升里有两次只是刷新。
      promotedRefreshed: 0,
    },
    // ★ 修正（2026-09-29）：此前 `jev` 是**死状态** —— 这里定义、`read()` 归一化，
    //   然后**全代码库没有任何一处读或写它**，于是它永远停在
    //   `{lastModel:null, requests:0, tokensIn:0}`。
    //   危害不是"没用"，而是**它在骗人**：每日审查读到它会得出
    //   "计数器与实际用量不符"，而实际上它是"从来没被写过"。
    //   现在由 `p2.cjs` 在既有的 state 更新点累加（那里 `scoring.model/calls/
    //   tokensIn/tokensOut` 与 `g2.calls` 都在作用域内，零额外开销）。
    //   ⚠️ `requests` 只计 **Jev** 调用；G2 单独计 `g2Requests` —— 两者混在一个
    //      字段里就无法与 `ledger.jevRequestsTotal` 对账了。
    jev: { lastModel: null, requests: 0, g2Requests: 0, tokensIn: 0, tokensOut: 0 },
    projects: {},
  };
}

function read() {
  const p = pathsMod.paths();
  if (!fs.existsSync(p.state)) return emptyState();
  try {
    const raw = fs.readFileSync(p.state, 'utf8');
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    // 补齐可能缺失的顶层键，避免旧 state 让下游读 undefined
    const base = emptyState();
    return {
      ...base,
      ...parsed,
      counters: { ...base.counters, ...(parsed.counters || {}) },
      jev: { ...base.jev, ...(parsed.jev || {}) },
      projects: parsed.projects || {},
    };
  } catch {
    return emptyState();
  }
}

/** 原子写：先写同目录 .tmp 再 rename，避免半截 JSON */
function write(state) {
  const p = pathsMod.paths();
  fs.mkdirSync(p.home, { recursive: true });
  const next = { ...state, version: STATE_VERSION, updatedAt: new Date().toISOString() };
  const tmp = path.join(p.home, `.state.json.tmp.${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  fs.renameSync(tmp, p.state);
  return next;
}

/** 读-改-写；mutator 直接改传入对象并返回之 */
function update(mutator) {
  const s = read();
  const out = mutator(s) || s;
  return write(out);
}

/** 供 CLI 使用：由扫描结果补齐 projects 映射（保留已有的人工描述） */
function mergeProjects(state, discovered) {
  const next = { ...state, projects: { ...(state.projects || {}) } };
  let added = 0;
  let refreshed = 0;
  for (const d of discovered) {
    const prev = next.projects[d.slug];
    if (!prev) {
      next.projects[d.slug] = {
        memoryDir: d.memoryDir,
        description: d.description,
        descriptionSource: d.descriptionSource || 'auto-seed',
        needsReview: true,
        memoryFiles: d.memoryFiles,
        indexBytes: d.indexBytes,
        indexLines: d.indexLines,
        lastSeenAt: new Date().toISOString(),
      };
      added++;
    } else {
      // 只刷新统计字段；description 与 needsReview 保留人工/AI 的成果
      next.projects[d.slug] = {
        ...prev,
        memoryDir: d.memoryDir,
        memoryFiles: d.memoryFiles,
        indexBytes: d.indexBytes,
        indexLines: d.indexLines,
        lastSeenAt: new Date().toISOString(),
      };
      refreshed++;
    }
  }
  return { state: next, added, refreshed };
}

module.exports = { STATE_VERSION, emptyState, read, write, update, mergeProjects };
