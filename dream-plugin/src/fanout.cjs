'use strict';
/**
 * fanout.cjs —— G2 全局分发（V2 §3.2.2 / §3.2.3）。
 *
 * 提升一条**全局**经验时，用 Jev 对每个已知项目问一道 `noul`
 * （"这条经验是否适用于 <项目>？"），命中者（`noul ≥ global.fanoutMinNoul`）往该项目
 * `MEMORY.md` 的 `dream:global` 受控区块追加**一行指针**，指向 `global/<slug>.md`。
 *
 * 为什么用多个 `noul` 而不是一个 `choice`：官方契约里 Choice 是**单选**，而
 * "与哪些项目相关"是**多选**。官方文档也建议 "use one per label when several may apply"。
 *
 * 为什么 G2 优于 G1：G2 只在**真正相关**的项目里出现，G1 是无差别广播
 * （token 成本恒定）。相关性定向优于无差别广播。
 *
 * 项目描述来源：项目的记忆 digest 派生（复用 jev.buildDigest），
 * 故 digest 在此处获得第二个真实消费者。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const configMod = require('./config.cjs');
const jev = require('./jev.cjs');
const redactMod = require('./redact.cjs');
const memoryMod = require('./memory.cjs');
const guardMod = require('./guard.cjs');

/**
 * 由项目记忆派生紧凑描述（供 G2 相关性判断使用）。
 *
 * ★ P2 实测修正：旧版取 MEMORY.md **前 8 条**标题拼成一句再按 320 字符硬截，
 *   结果是 ① 顺序偏置（取决于谁排在文件前面）② 断在句中（产出 `—…；` 这类残骸）
 *   ③ 丢掉技术栈信息。实测后果：`F--DemoApi`（C#/Dapper 项目）的描述里
 *   不含 "Dapper"，于是 G2 对一条 Dapper 经验只命中了唯一描述里写了 Dapper 的项目，
 *   看上去像 Jev 漏判，实际是**描述没把技术栈表达出来**。
 *
 *   新设计：`topics` 用记忆**文件名**切词 —— 文件名是人工命名的主题标签，
 *   技术词密度最高（`dapper-uniqueidentifier-string-gotcha` → dapper/uniqueidentifier/…）；
 *   再补少量条目标题作为中文领域线索。全部按 token 边界截断，不切碎词。
 */
function describeProject(slug, { maxChars = 300, maxTitles = 4, titleChars = 26 } = {}) {
  const p = pathsMod.paths();
  const memDir = path.join(p.projectsRoot, slug, 'memory');
  const idx = path.join(memDir, 'MEMORY.md');

  // 1) 主题词：来自记忆文件名（ASCII 切词）
  const freq = new Map();
  const bump = (w) => {
    const t = String(w).toLowerCase();
    if (t.length < 2) return;
    if (/^\d+$/.test(t)) return;
    freq.set(t, (freq.get(t) || 0) + 1);
  };
  let files = [];
  try {
    files = fs.readdirSync(memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
  } catch { /* 目录不存在 */ }
  for (const f of files) {
    for (const w of f.replace(/\.md$/, '').split(/[-_]+/)) bump(w);
  }

  // 2) 标题：既作中文线索，也补 ASCII 技术词
  const titles = [];
  try {
    for (const raw of fs.readFileSync(idx, 'utf8').split(/\r?\n/)) {
      const t = raw.trim();
      const m = /^\s*[-*]?\s*\[([^\]]+)\]/.exec(t);
      if (!m) continue;
      titles.push(m[1]);
      for (const w of m[1].split(/[^A-Za-z0-9+#.]+/)) bump(w);
      if (titles.length >= 40) break;
    }
  } catch { /* 索引读取失败 */ }

  if (!files.length && !titles.length) return '(无既有记忆)';

  // 频次降序（高频=反复出现的主题），同频保持首次出现序
  const topics = [...freq.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
  const topicStr = topics.join(' ');
  const head = `topics: ${topicStr.slice(0, Math.floor(maxChars * 0.6))}`;
  const titleStr = titles.slice(0, maxTitles).map((t) => (t.length > titleChars ? `${t.slice(0, titleChars)}…` : t)).join(' / ');
  const tail = titleStr ? `\nentries: ${titleStr}` : '';
  const out = `${head}${tail}\ncount: ${titles.length} memories`;
  return out.slice(0, maxChars);
}

/**
 * 列出**有实际记忆内容**的项目。
 *
 * 不加过滤会把大量空项目也拿去问相关性 —— 实测 39 个项目里只有 23 个有 MEMORY.md，
 * 对 "(无既有记忆)" 的项目问"这条经验是否适用"既浪费 token 又稀释判断质量。
 */
function listProjects({ maxProjects = 60 } = {}) {
  const p = pathsMod.paths();
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(p.projectsRoot, { withFileTypes: true }); } catch { return out; }
  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    const desc = describeProject(ent.name);
    if (!desc || desc.startsWith('(无既有记忆)')) continue;
    out.push({ slug: ent.name, description: desc });
    if (out.length >= maxProjects) break;
  }
  return out;
}

/**
 * 构造 G2 请求（零 LLM；纯契约构造）。
 * 凡进入 `state` 的文本一律过脱敏流水线（V2 §8.2）。
 */
function buildFanoutRequest(experience, projectSlugs, { cfg } = {}) {
  const c = cfg || configMod.load().config;
  const egressMode = jev.egressOf(c);
  const redactOpts = {
    sensitiveTerms: (c.redact && c.redact.sensitiveTerms) || [],
    extraPatterns: (c.redact && c.redact.extraPatterns) || [],
    redactPrivateIps: !(c.redact && c.redact.redactPrivateIps === false),
  };
  const maxChars = (c.jev && Number.isFinite(c.jev.egressMaxChars)) ? c.jev.egressMaxChars : 400;
  const hits = {};
  const red = (text, tag) => {
    if (egressMode === 'raw') return text;
    const r = redactMod.redactDeep({ text, project: tag, signal: tag }, redactOpts);
    for (const [k, v] of Object.entries(r.hits)) hits[k] = (hits[k] || 0) + v;
    return r.value.text;
  };

  const projects = {};
  for (const slug of projectSlugs) {
    projects[slug] = jev.sanitizeForEgress(red(describeProject(slug), 'fanout-project'), { maxChars });
  }

  const state = {
    experience: {
      text: jev.sanitizeForEgress(red(experience.text || '', 'fanout-exp'), { maxChars }),
      kind: experience.kind || null,
      durability: Number.isFinite(experience.durabilityRaw) ? experience.durabilityRaw : null,
    },
    projects,
  };

  const questions = {};
  for (const slug of projectSlugs) {
    questions[`rel.${slug}`] = {
      type: 'noul',
      instructions: `\`experience.text\` 描述的经验，是否适用于 \`projects.${slug}\` 描述的项目？（仅主题相近不算适用，须是该项目里真会用到的知识）`,
    };
  }
  return { payload: { model: c.jev.model, state, questions }, egressHits: hits, egressMode };
}

/** 契约预检（在花钱之前挡住 422），专用于 G2 形状 */
function validateFanout(payload) {
  const errs = [];
  if (!payload || typeof payload !== 'object') errs.push('payload 非对象');
  if (!payload.model) errs.push('缺 model');
  const st = payload.state || {};
  if (!st.experience || typeof st.experience.text !== 'string') errs.push('缺 state.experience.text');
  if (!st.projects || typeof st.projects !== 'object') errs.push('缺 state.projects');
  const q = payload.questions || {};
  const keys = Object.keys(q);
  if (!keys.length) errs.push('questions 为空');
  for (const k of keys) {
    if (q[k].type !== 'noul') errs.push(`${k}: type 必须是 noul`);
    if (typeof q[k].instructions !== 'string' || !q[k].instructions.trim()) errs.push(`${k}: 缺 instructions`);
    if ('question' in q[k]) errs.push(`${k}: 不应有 question 字段（官方契约用 instructions）`);
  }
  const targets = new Set(Object.keys(st.projects || {}));
  for (const k of keys) {
    const slug = k.replace(/^rel\./, '');
    if (!targets.has(slug)) errs.push(`${k}: 没有对应的 state.projects.${slug}`);
  }
  return { ok: errs.length === 0, errs, questionCount: keys.length };
}

/** 从响应抽出命中项目（按 noul 降序，取 top maxFanout） */
function parseFanout(resp, { cfg } = {}) {
  const c = cfg || configMod.load().config;
  const gc = c.global || {};
  const min = Number.isFinite(gc.fanoutMinNoul) ? gc.fanoutMinNoul : 0.75;
  const maxFanout = Number.isFinite(gc.maxFanout) ? gc.maxFanout : 5;
  const answers = (resp && resp.answers) || {};
  const all = [];
  for (const [key, a] of Object.entries(answers)) {
    if (!key.startsWith('rel.')) continue;
    const slug = key.slice(4);
    if (!a || a.type !== 'noul' || !Number.isFinite(a.noul)) continue;
    all.push({ project: slug, noul: a.noul });
  }
  all.sort((x, y) => y.noul - x.noul);
  const hits = all.filter((x) => x.noul >= min).slice(0, maxFanout);
  const below = all.filter((x) => x.noul < min);
  const overflow = all.filter((x) => x.noul >= min).slice(maxFanout);
  return { hits, below, overflow, min, maxFanout, evaluated: all.length };
}

/**
 * 把命中写成各项目的指针（受 guard 守门）。
 * @returns {{applied:Array, skipped:Array, reason?:string}}
 */
function applyFanout(experienceSlug, hits, { cfg, policy } = {}) {
  const c = cfg || configMod.load().config;
  const pol = policy || guardMod.decideWrite({ cfg: c });
  if (!pol.allow) return { applied: [], skipped: hits.map((h) => h.project), reason: pol.reason };

  const p = pathsMod.paths();
  const globalFile = path.join(p.global, `${experienceSlug}.md`);
  const applied = [];
  const skipped = [];
  for (const h of hits) {
    const target = path.join(p.projectsRoot, h.project, 'memory', 'MEMORY.md');
    if (!fs.existsSync(path.dirname(target))) { skipped.push(h.project); continue; }
    const r = memoryMod.applyPointer(target, 'global', {
      name: `global/${experienceSlug}`,
      target: `file:///${globalFile.replace(/\\/g, '/')}`,
      description: c.global && c.global.pointerDescription ? c.global.pointerDescription : '同类问题跨项目通用',
    });
    if (r.ok && r.changed) applied.push({ project: h.project, action: r.action, path: target });
    else skipped.push(h.project);
  }
  return { applied, skipped, reason: null };
}

module.exports = {
  describeProject, listProjects, buildFanoutRequest, validateFanout, parseFanout, applyFanout,
};
