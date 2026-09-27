'use strict';
/**
 * support.cjs —— 候选的「跨会话复现度」聚合（convention 精度处置的核心机制）。
 *
 * 假设：噪声多为**单次会话叙述**（"决定性证据到手""已完成"），
 *       真约定会**跨会话反复出现**（同一决定被多次复述）。
 * 做法：按文本相似度聚类 → 统计**不同 sessionId 数**作为 support。
 * 纯代码、零 LLM、零网络。
 */
const extractMod = require('./extract.cjs');

/**
 * support 的度量口径（★ E1 澄清，防将来重构引入盲区）：
 *
 *   support = 簇内**所有成员**的 evidence[].sessionId 并集大小
 *           = 「候选内部的多会话证据」∪「簇间各候选的会话」
 *
 * 两者**在构造上已合并**——因为 evidence 是逐成员、逐条累加的。
 * 为避免该性质被误读（评审 E1 曾判定此处存在盲区，实测证伪：
 * 含 7 会话 evidence 的候选读数 support=27，非 1），
 * 现额外显式输出 `multiSessionMembers` 与 `sessionsFromMembers`，
 * 并有单测 support-inclusive 固化该性质。
 */
function cluster(cands, { threshold = 0.6 } = {}) {
  const clusters = [];
  for (const c of cands) {
    const toks = extractMod.tokenize(c.text || '');
    let placed = false;
    for (const cl of clusters) {
      if (extractMod.overlap(toks, cl.tokens) >= threshold) {
        cl.members.push(c);
        placed = true;
        break;
      }
    }
    if (!placed) {
      clusters.push({ rep: c, tokens: toks, members: [c] });
    }
  }

  return clusters.map((cl) => {
    const sessions = new Set();          // 全簇并集（含候选内部多会话）
    const projects = new Set();
    let multiSessionMembers = 0;
    for (const m of cl.members) {
      const own = new Set();
      for (const e of m.evidence || []) if (e.sessionId) { sessions.add(e.sessionId); own.add(e.sessionId); }
      if (own.size >= 2) multiSessionMembers++;
      if (m.project) projects.add(m.project);
    }
    const weights = cl.members.map((m) => m.weight || 0);
    return {
      repId: cl.rep.id,
      signal: cl.rep.signal,
      project: cl.rep.project,
      text: cl.rep.text,
      members: cl.members.length,
      support: sessions.size,               // 不同会话数（口径见上）
      sessionsFromMembers: sessions.size,   // 与 support 同值，显式暴露以自证无盲区
      multiSessionMembers,                  // 自身 evidence 含 ≥2 会话的成员数
      projects: projects.size,
      maxWeight: Math.max(...weights),
      sessionIds: [...sessions],
      alreadyKnown: cl.members.some((m) => m.dupOf),
    };
  });
}

/**
 * @param {Array} cands 候选（store.loadCandidates 的输出）
 * @param {{threshold?:number, minSupport?:number, signal?:string, minWeight?:number}} opts
 */
function analyze(cands, opts = {}) {
  const { threshold = 0.6, minSupport = 1, signal = null, minWeight = 0 } = opts;
  let pool = cands;
  if (signal) pool = pool.filter((c) => c.signal === signal);
  if (minWeight) pool = pool.filter((c) => (c.weight || 0) >= minWeight);

  const clusters = cluster(pool, { threshold });
  const filtered = clusters
    .filter((c) => c.support >= minSupport)
    .sort((a, b) => (b.support - a.support) || (b.maxWeight - a.maxWeight));

  const bySignal = {};
  for (const c of clusters) {
    bySignal[c.signal] = bySignal[c.signal] || { clusters: 0, members: 0, support2plus: 0 };
    bySignal[c.signal].clusters++;
    bySignal[c.signal].members += c.members;
    if (c.support >= 2) bySignal[c.signal].support2plus++;
  }

  return {
    input: pool.length,
    clusters: clusters.length,
    kept: filtered.length,
    bySignal,
    filtered,
  };
}

module.exports = { cluster, analyze };
