'use strict';
/**
 * promote.cjs —— 把决策为 promote 的候选**落成记忆**（V2 §4.5）。
 *
 * 项目级经验：正文 → `projects/<slug>/memory/<name>.md`，指针 → MEMORY.md 的 dream 区块
 * 全局经验  ：正文 → `.dream/global/<name>.md`，指针经 G2 分发到相关项目
 *
 * frontmatter 必须符合**宿主契约**（V2 §4.5 M2 修正）：
 *   `name` / `description` / `metadata.node_type` / `metadata.type` 是宿主识别记忆的
 *   标准字段，缺了则归不了类；dream 自用元数据全部嵌在 `metadata.dream` 下，
 *   不污染宿主字段。
 *
 * 所有写入都必须先过 `guard.decideWrite()` —— 本模块自身**不做**策略判断，
 * 但会在 policy.allow=false 时拒绝写入（防御性二次检查）。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const configMod = require('./config.cjs');
const memoryMod = require('./memory.cjs');
const gitops = require('./gitops.cjs');
const guardMod = require('./guard.cjs');

/** 全局经验的 durability 门槛：≥2（"同类项目之间通用"）才值得跨项目分发 */
const GLOBAL_DURABILITY_MIN = 2;

/** 从文本里提取 ASCII 词做 slug；中文文本拿不到足够词时回退到候选 id */
function slugify(text, fallback) {
  const words = String(text || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter((w) => w.length >= 3 && w.length <= 20)
    .slice(0, 6);
  // ★ 核验 N4：**单个够长的 ASCII 词也可用作 slug**。此前要求 ≥2 个词，
  //   于是 "改期单的DemoSkyOrderID字段应该是…" 这种"中文 + 一个技术词"的候选
  //   直接退化成裸 `cand-2026...-047`（可追溯但不可读）。实测 6 条里有 1 条如此。
  if (words.length >= 2) return words.join('-').slice(0, 60);
  if (words.length === 1 && words[0].length >= 6) return words[0].slice(0, 60);
  return String(fallback || 'experience').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
}

/** 单行化描述（frontmatter 的 description 不能含换行） */
function oneLine(text, max = 160) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 生成记忆正文（含宿主契约 frontmatter） */
function bodyFor(cand, scored, { name, originSessionId = null, now = new Date() } = {}) {
  const iso = now.toISOString();
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${oneLine(cand.text)}`,
    'metadata:',
    '  node_type: memory',
    '  type: reference',
    `  originSessionId: ${originSessionId || 'unknown'}`,
    `  modified: ${iso}`,
    '  dream:',
    `    score: ${scored.score}`,
    `    jevModel: ${scored.jevModel || 'unknown'}`,
    `    durability: ${scored.n.durabilityRaw}`,
    `    signal: ${cand.signal || 'unknown'}`,
    `    kind: ${scored.kind || 'unknown'}`,
    `    promotedAt: ${iso}`,
    `    stillTrueCheckedAt: ${iso}`,
    '---',
    '',
  ].join('\n');
  return `${fm}${String(cand.text || '').trim()}\n`;
}

/**
 * 写入一条经验正文（项目级或全局）。
 * @returns {{ok:boolean, file?:string, created?:boolean, reason?:string}}
 */
function writeBody(kind, slug, name, content, { policy } = {}) {
  const pol = policy || guardMod.decideWrite();
  if (!pol.allow) return { ok: false, reason: `guard: ${pol.reason}` };
  const p = pathsMod.paths();
  const file = kind === 'global'
    ? path.join(p.global, `${name}.md`)
    : path.join(p.projectsRoot, slug, 'memory', `${name}.md`);
  const created = !fs.existsSync(file);
  if (!created) {
    const prev = fs.readFileSync(file, 'utf8');
    if (prev === content) return { ok: true, file, created: false, unchanged: true };
  }
  memoryMod.writeAtomic(file, content);
  return { ok: true, file, created };
}

/**
 * 取出候选的**来源会话 id**。
 * ⚠️ 它在 `candidate.evidence[].sessionId`，**不在** `candidate.sessionId` ——
 *    后者不存在，直接读会得到 `unknown`（实测首次真实写入就是这样，frontmatter 里
 *    写成 `originSessionId: unknown`，丢掉了 V2 §4.5 要求的可追溯性）。
 */
function originSessionOf(cand) {
  const ev = (cand && Array.isArray(cand.evidence)) ? cand.evidence : [];
  const withSid = ev.find((e) => e && e.sessionId);
  return (withSid && withSid.sessionId) || null;
}

/**
 * 提升一条经验：写正文 + 写指针 + git commit。
 * @returns {{ok, kind, name, file, pointer, commit, reason?}}
 */
function promoteOne(cand, scored, { cfg, policy, now = new Date() } = {}) {
  const c = cfg || configMod.load().config;
  const pol = policy || guardMod.decideWrite({ cfg: c });
  if (!pol.allow) return { ok: false, reason: `guard: ${pol.reason}` };

  const isGlobal = Number.isFinite(scored.n.durabilityRaw) && scored.n.durabilityRaw >= GLOBAL_DURABILITY_MIN;
  // ★ 核验 N4：写入前**再**做一次文本规范化（纵深防御，`normalize` 幂等）。
  //   关键顺序：先规范化、再用规范化后的文本算 slug 与正文 —— 否则名字与内容不一致。
  //   放在这里而不是只放在提取器，是为了让**任何来源**的候选（含 `--from-results` 重放
  //   的旧候选）都无法把已知污染写进记忆。
  const hygiene = require('./hygiene.cjs');
  const cleanText = hygiene.normalizeCandidate(cand.text, c, cand.signal);
  const name = slugify(cleanText, cand.id);
  const content = bodyFor({ ...cand, text: cleanText }, scored, { name, originSessionId: originSessionOf(cand), now });
  const p = pathsMod.paths();

  const body = writeBody(isGlobal ? 'global' : 'project', cand.project, name, content, { policy: pol });
  if (!body.ok) return { ok: false, reason: body.reason };

  // 指针：项目级 → 本项目 MEMORY.md 的 dream 区块
  let pointer = null;
  if (!isGlobal) {
    const idx = path.join(p.projectsRoot, cand.project, 'memory', 'MEMORY.md');
    pointer = memoryMod.applyPointer(idx, 'dream', {
      name, target: `${name}.md`, description: oneLine(cleanText, 110),
    });
  }

  const dir = isGlobal ? p.global : path.join(p.projectsRoot, cand.project, 'memory');
  let commit = null;
  try { commit = gitops.commitAll(dir, `dream(${isGlobal ? 'global' : cand.project}): ${name}`); }
  catch (e) { commit = { ok: false, error: e.message }; }   // git 失败不得让已写入的正文回滚

  return { ok: true, kind: isGlobal ? 'global' : 'project', name, file: body.file, created: body.created, pointer, commit };
}

module.exports = { slugify, oneLine, bodyFor, writeBody, promoteOne, originSessionOf, GLOBAL_DURABILITY_MIN };
