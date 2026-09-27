'use strict';
/**
 * inbox.cjs —— 手动梦的 `prepare`：把"需要模型做语义判断的东西"汇总成一份可读的 inbox
 * （V2 §5.2 ① / line 462：「全局经验 + 项目经验 + 索引 + 待决候选 + 冲突检测」）。
 *
 * ★ 职责边界（决策 #6 / M5）：引擎**不含任何 LLM 客户端**。它只做**机械检测** ——
 *   词面重叠、索引溢出、孤儿指针、未索引文件、待决候选清点；**语义合并由宿主当前会话
 *   的模型完成**。这份 inbox 的任务就是把"该看什么"摆清楚，而不是代替模型下判断。
 *
 * 因此这里报告的是**线索**（"这两条词面重叠 0.82，可能是同一件事"），
 * 而不是结论（"这两条重复，删一条"）。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const configMod = require('./config.cjs');
const extractMod = require('./extract.cjs');
const memoryMod = require('./memory.cjs');
const store = require('./store.cjs');
const jev = require('./jev.cjs');

const INDEX_LIMITS = { maxLines: 200, maxBytes: 25 * 1024 };
const OVERLAP_HINT = 0.55;        // 词面重叠达到此值即列为"疑似重复/冲突"，交模型判断
const CLUSTER_HINT = 0.30;        // 同主题聚类的下限（比"疑似重复"宽松，用于配对矛盾检测）

/**
 * 「替换 / 废弃」类措辞 —— 机械矛盾线索的判据。
 *
 * 为什么这不是"重复检测"就够：两条经验**可以词面不重叠但内容矛盾**
 * （"X 应该用 A" vs "X 已改为 B"）。引擎无 LLM，无法判断语义矛盾，但可以机械地
 * 检出**"某条宣称取代/废弃了某个做法"**这一措辞特征 —— 那正是矛盾最可能的位置。
 *
 * ⚠️ 这是**线索不是结论**：出现"改为"也可能只是描述历史，不与任何条目矛盾。
 *    inbox 必须如实这样标注（否则等于让引擎替模型下判断）。
 */
const SUPERSEDE_MARKERS = [
  /已废弃|已弃用|弃用/, /作废/, /不再使用|不再用|不再走|不再读/,
  /改为|改成|换成|替换为|替换成|修正为/, /推翻|纠正了/,
  /而非|而不是/,
  // 英文侧：`rather than` 等价于"而非"，实测语料里英文件占比不小（测试 S10 抓到漏项）
  /deprecated|superseded|no longer|instead of|rather than|replaced? (?:by|with)/i,
];
function supersedeMarkers(text) {
  const hits = [];
  for (const re of SUPERSEDE_MARKERS) { const m = re.exec(text); if (m) hits.push(m[0]); }
  return hits;
}

function listProjects() {
  const p = pathsMod.paths();
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(p.projectsRoot, { withFileTypes: true }); } catch { return out; }
  for (const ent of dirs) {
    if (!ent.isDirectory()) continue;
    const memDir = path.join(p.projectsRoot, ent.name, 'memory');
    if (!fs.existsSync(path.join(memDir, 'MEMORY.md'))) continue;
    out.push({ slug: ent.name, memDir });
  }
  return out;
}

/** 解析 MEMORY.md 的指针行（含所属区块），并返回受控区块状态 */
function readIndexState(memDir) {
  const f = path.join(memDir, 'MEMORY.md');
  const text = fs.readFileSync(f, 'utf8');
  const parsed = memoryMod.parseBlocks(text);
  const pointers = new Map();       // 文件名 → { block, name, target, desc, line }
  const lines = text.split(/\r?\n/);
  let curBlock = 'manual';
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === memoryMod.MARKERS.dream.begin) { curBlock = 'dream'; continue; }
    if (t === memoryMod.MARKERS.dream.end) { curBlock = 'manual'; continue; }
    if (t === memoryMod.MARKERS.global.begin) { curBlock = 'global'; continue; }
    if (t === memoryMod.MARKERS.global.end) { curBlock = 'manual'; continue; }
    const target = memoryMod.linkTargetOf(lines[i]);
    if (!target) continue;
    const name = /^\s*-\s*\[([^\]]*)\]/.exec(lines[i]);
    const desc = /—\s*(.*)$/.exec(lines[i]);
    if (!pointers.has(target)) {
      pointers.set(target, {
        block: curBlock, target,
        name: name ? name[1] : '', desc: desc ? desc[1] : '', line: i + 1,
      });
    }
  }
  return {
    file: f, text, pointers, parsed,
    lines: lines.length,
    bytes: Buffer.byteLength(text, 'utf8'),
    blockLines: (parsed.blocks.dream.lines || []).length,
    blockBytes: Buffer.byteLength((parsed.blocks.dream.lines || []).join('\n'), 'utf8'),
    malformed: parsed.malformed,
  };
}

/** 读一条记忆文件的正文（去 frontmatter）与 frontmatter 的 description */
function readExperience(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  const desc = fm ? (/^description:\s*(.*)$/m.exec(fm[1]) || [])[1] : undefined;
  const name = fm ? (/^name:\s*(.*)$/m.exec(fm[1]) || [])[1] : undefined;
  const body = fm ? text.slice(fm[0].length) : text;
  return { body: body.trim(), description: (desc || '').trim(), fmName: (name || '').trim(), raw: text };
}

/**
 * 构建 inbox（纯函数式汇总，除读取外无副作用）。
 * @returns {{markdown:string, stats:object, findings:object}}
 */
function buildInbox({ mode = 'manual', cfg } = {}) {
  const c = cfg || configMod.load().config;
  const p = pathsMod.paths();
  const now = new Date();
  const stats = { projects: 0, experiences: 0, global: 0, pendingCandidates: 0 };
  const findings = {
    nearDuplicates: [],      // 同一项目/全局内词面高度重叠的两条
    contradictionHints: [],  // 替换/废弃类措辞（**矛盾最可能出现的位置**，线索而非结论）
    topicClusters: [],       // 词面中度相近的成对（供你成组阅读，而非逐条读）
    indexOverflow: [],       // 受控区块超限
    malformedIndex: [],      // 界标不配对
    orphanPointers: [],      // 指针指向不存在的文件
    unindexed: [],           // 文件存在但索引里没有指针
    globalNotFanout: [],     // 全局经验未被任何项目引用（G2 未命中或未跑）
  };
  const P = [];

  P.push(`# AutoDream 手动梦 inbox`);
  P.push('');
  P.push(`- 生成时间：${now.toISOString()}`);
  P.push(`- 模式：\`${mode}\``);
  P.push(`- 目标：读本文件 → 产出提案 → 写 \`proposals/proposal-<ts>.json\` → 交给 \`dreamctl validate\` 校验`);
  P.push('');
  P.push('> 本文件由**引擎机械生成**：只列线索，不下结论。语义判断（哪两条其实是同一件事、');
  P.push('> 哪条该合并/删除、索引怎么压缩）由**你**（宿主当前会话的模型）完成。');
  P.push('> 提案必须严格符合 schema；校验失败会返回 `{path, expected, got}`，据此修正重试（最多 3 轮）。');
  P.push('');

  // ---------------- 全局经验 ----------------
  P.push('## 1. 全局经验（`.dream/global/`）');
  P.push('');
  const globalFiles = (() => {
    try { return fs.readdirSync(p.global).filter((f) => f.endsWith('.md')); } catch { return []; }
  })();
  stats.global = globalFiles.length;
  if (!globalFiles.length) P.push('_（无）_');
  for (const f of globalFiles) {
    const e = readExperience(path.join(p.global, f));
    if (!e) continue;
    P.push(`### \`${f}\``);
    P.push(`- description: ${e.description || '(缺)'}`);
    if (e.fmName && e.fmName !== f.replace(/\.md$/, '')) P.push(`- ⚠️ frontmatter name(${e.fmName}) 与文件名不一致`);
    P.push(`- 正文 ${e.body.length} 字符`);
    P.push('');
  }
  // 全局经验是否被任何项目引用（G2 分发痕迹）
  const allReferencedGlobal = new Set();
  for (const pr of listProjects()) {
    const st = readIndexState(pr.memDir);
    for (const [, ptr] of st.pointers) {
      if (ptr.block === 'global') allReferencedGlobal.add(path.basename(ptr.target.replace(/^file:\/\/\//, '')));
    }
  }
  for (const f of globalFiles) if (!allReferencedGlobal.has(f)) findings.globalNotFanout.push(f);
  if (findings.globalNotFanout.length) {
    P.push(`> 未被任何项目索引引用的全局经验 ${findings.globalNotFanout.length} 条：${findings.globalNotFanout.join(', ')}`);
    P.push('> （G2 判定的正常结果之一：通用原则确实可能不属于任何单个项目。是否处理由你判断。）');
    P.push('');
  }

  // ---------------- 逐项目 ----------------
  P.push('## 2. 项目经验与索引状态');
  P.push('');
  const perProjectTexts = new Map();
  for (const pr of listProjects()) {
    stats.projects++;
    const st = readIndexState(pr.memDir);
    const files = fs.readdirSync(pr.memDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    stats.experiences += files.length;
    P.push(`### \`${pr.slug}\`（${files.length} 条经验）`);
    P.push('');
    P.push(`- 索引：全文 ${st.lines} 行 / ${st.bytes} B；dream 区块 ${st.blockLines} 行 / ${st.blockBytes} B（上限 ${INDEX_LIMITS.maxLines} 行 / ${INDEX_LIMITS.maxBytes} B）`);
    if (st.malformed.length) {
      findings.malformedIndex.push({ project: pr.slug, detail: st.malformed });
      P.push(`- 🔴 **界标不配对**：${st.malformed.join('; ')} —— 受控区块写入会被拒绝，必须先人工修复`);
    }
    if (st.blockLines > INDEX_LIMITS.maxLines || st.blockBytes > INDEX_LIMITS.maxBytes) {
      findings.indexOverflow.push({ project: pr.slug, lines: st.blockLines, bytes: st.blockBytes });
      P.push(`- ⚠️ **受控区块超限** ⇒ 建议 \`compress-index\` 操作`);
    }
    const texts = [];
    for (const f of files) {
      const e = readExperience(path.join(pr.memDir, f));
      if (!e) continue;
      const ptr = st.pointers.get(f) || st.pointers.get(`file:///${path.join(pr.memDir, f).replace(/\\/g, '/')}`);
      P.push(`- \`${f}\`${ptr ? ` [block=${ptr.block}]` : ' ⚠️ 无索引指针'} — ${e.description || '(缺 description)'}`);
      texts.push({ file: f, text: `${e.description} ${e.body}` });
      if (!ptr) findings.unindexed.push({ project: pr.slug, file: f });
    }
    perProjectTexts.set(pr.slug, texts);
    if (!files.length) P.push('_（无经验文件）_');
    P.push('');
  }

  // ---------------- 机械冲突/重复线索 ----------------
  P.push('## 3. 重复 / 冲突线索（机械检测，仅供你判断）');
  P.push('');
  P.push(`> 引擎只算**词面重叠**（token Jaccard/overlap ≥ ${OVERLAP_HINT} 列为疑似重复）。`);
  P.push('> 词面重叠**不等于**内容重复，也**不等于**矛盾 —— 它只是"值得你读一眼"的线索。');
  P.push('');
  let hintCount = 0;
  const scanPairs = (label, items) => {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i]; const b = items[j];
        const ov = extractMod.overlap(extractMod.tokenize(a.text), extractMod.tokenize(b.text));
        const jc = extractMod.jaccard(extractMod.tokenize(a.text), extractMod.tokenize(b.text));
        if (ov >= OVERLAP_HINT || jc >= OVERLAP_HINT) {
          hintCount++;
          findings.nearDuplicates.push({ scope: label, a: a.file, b: b.file, overlap: Number(ov.toFixed(3)), jaccard: Number(jc.toFixed(3)) });
          P.push(`- \`${label}\`：\`${a.file}\` ↔ \`${b.file}\`  overlap=${ov.toFixed(3)} jaccard=${jc.toFixed(3)}`);
        } else if (ov >= CLUSTER_HINT || jc >= CLUSTER_HINT) {
          findings.topicClusters.push({ scope: label, a: a.file, b: b.file, overlap: Number(ov.toFixed(3)), jaccard: Number(jc.toFixed(3)) });
        }
      }
    }
  };
  for (const [slug, texts] of perProjectTexts) scanPairs(slug, texts);
  if (!hintCount) P.push('_（无词面高度重叠的条目）_');
  P.push('');

  // ---------------- 矛盾线索（替换/废弃类措辞）----------------
  P.push('### 3b. 矛盾线索：替换 / 废弃类措辞');
  P.push('');
  P.push('> **这不是结论，只是位置线索**：两条经验可以词面完全不重叠却互相矛盾');
  P.push('> （"X 应该用 A" vs "X 已改为 B"）。引擎无 LLM，判不了语义矛盾，但能机械检出');
  P.push('> "某条宣称取代/废弃了某做法"这一措辞特征 —— 矛盾最可能就在这里。');
  P.push('> 出现"改为"也可能只是在描述历史，**不与任何条目矛盾**。');
  P.push('');
  for (const [slug, texts] of perProjectTexts) {
    for (const it of texts) {
      const markers = supersedeMarkers(it.text);
      if (!markers.length) continue;
      findings.contradictionHints.push({ project: slug, file: it.file, markers });
      const cluster = findings.topicClusters.filter((c) => c.scope === slug && (c.a === it.file || c.b === it.file));
      const peers = cluster.map((c) => (c.a === it.file ? c.b : c.a));
      P.push(`- \`${slug}/${it.file}\`  措辞：${markers.join(' / ')}${peers.length ? `  ·  同主题待一起读：${peers.join('、')}` : ''}`);
    }
  }
  if (!findings.contradictionHints.length) P.push('_（无替换/废弃类措辞）_');
  P.push('');
  if (findings.topicClusters.length) {
    P.push(`> 另有 ${findings.topicClusters.length} 对**同主题**（重叠 ${CLUSTER_HINT}–${OVERLAP_HINT}）条目，`)
    P.push('> 建议成组阅读以判断是否重复或矛盾（逐条读会看不出关系）：');
    for (const c of findings.topicClusters.slice(0, 20)) {
      P.push(`>   \`${c.scope}\`：\`${c.a}\` ↔ \`${c.b}\`  overlap=${c.overlap}`);
    }
    if (findings.topicClusters.length > 20) P.push(`>   …另有 ${findings.topicClusters.length - 20} 对`);
    P.push('');
  }

  // ---------------- 待决候选 ----------------
  P.push('## 4. 待决候选（`hold`，等你复核）');
  P.push('');
  const scores = store.loadScores();
  const cands = store.loadCandidates({ limit: 500 });
  const held = cands.filter((cd) => {
    const s = scores.get(cd.id);
    return s && s.decision === 'hold';
  });
  stats.pendingCandidates = held.length;
  if (!held.length) P.push('_（无待决候选）_');
  else {
    P.push(`共 ${held.length} 条。按理由分组：`);
    P.push('');
    const byReason = {};
    for (const cd of held) {
      const r = (scores.get(cd.id) || {}).reason || 'unknown';
      (byReason[r] = byReason[r] || []).push(cd);
    }
    for (const [reason, list] of Object.entries(byReason).sort((a, b) => b[1].length - a[1].length)) {
      P.push(`- **${reason}**（${list.length} 条）：`);
      for (const cd of list.slice(0, 12)) {
        P.push(`  - \`${cd.id}\` [${cd.signal}] ${String(cd.text).slice(0, 100)}`);
      }
      if (list.length > 12) P.push(`  - …另有 ${list.length - 12} 条`);
    }
    P.push('');
    P.push('> 候选**不在**手动梦的写范围内：提案的 op 只作用于 `memory/` 下**已存在**的文件');
    P.push('> 与全局经验。若要提升某条候选，需走自动梦（`dream`）或人工先落成文件。');
  }
  P.push('');

  // ---------------- 可用操作与 schema 摘要 ----------------
  P.push('## 5. 可用的提案操作（schema 摘要）');
  P.push('');
  P.push('```jsonc');
  P.push('{');
  P.push(`  "version": 1,`);
  P.push(`  "rationale": "整体意图（可选，但建议写）",`);
  P.push(`  "ops": [`);
  P.push(`    { "op": "merge", "project": "<slug>", "sources": ["a.md","b.md"],`);
  P.push(`      "name": "new-name.md", "description": "一行描述", "body": "合并后的正文" },`);
  P.push(`    { "op": "dedupe", "project": "<slug>", "keep": "a.md", "remove": ["b.md"] },`);
  P.push(`    { "op": "resolve-conflict", "project": "<slug>", "keep": "a.md", "remove": ["b.md"], "why": "裁决理由（必填）" },`);
  P.push(`    { "op": "compress-index", "project": "<slug>" },`);
  P.push(`    { "op": "promote-global", "name": "g.md", "from": { "project": "<slug>", "file": "a.md" },`);
  P.push(`      "description": "一行描述", "body": "全局经验正文" },`);
  P.push(`    { "op": "remove", "project": "<slug>", "file": "a.md", "why": "理由" },`);
  P.push(`    { "op": "note", "text": "只记录，无变更" }`);
  P.push(`  ]`);
  P.push('}');
  P.push('```');
  P.push('');
  P.push('**硬约束（校验器会拒绝）**：');
  P.push('- 文件名只能是 `.md` 文件名，**不含路径**；禁止 `MEMORY.md`（受保护）、`..`、绝对路径、盘符');
  P.push('- `merge.sources` 至少 2 个且都必须真实存在；`name` 不得与任一源同名');
  P.push('- `remove` 的每个文件都必须真实存在；`resolve-conflict` 必填 `why`');
  P.push('- `promote-global` 的目标必须在全局目录**尚不存在**');
  P.push('- 同一目标不得被两个 op 同时写');
  P.push('');
  P.push('---');
  P.push('');
  P.push(`线索统计：疑似重复 ${findings.nearDuplicates.length} · 同主题成对 ${findings.topicClusters.length} · **矛盾线索 ${findings.contradictionHints.length}** · 索引超限 ${findings.indexOverflow.length} · 界标异常 ${findings.malformedIndex.length} · 孤儿指针 ${findings.orphanPointers.length} · 未索引文件 ${findings.unindexed.length} · 全局未分发 ${findings.globalNotFanout.length}`);

  return { markdown: P.join('\n'), stats, findings, generatedAt: now.toISOString() };
}

/** 写出 inbox 文件（namespaced by ts） */
function writeInbox({ mode = 'manual', cfg } = {}) {
  const p = pathsMod.paths();
  fs.mkdirSync(p.proposals, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = `inbox-${stamp}.md`;
  const file = path.join(p.proposals, name);
  const r = buildInbox({ mode, cfg });
  fs.writeFileSync(file, r.markdown, 'utf8');
  return { ok: true, file, name, stats: r.stats, findings: r.findings, generatedAt: r.generatedAt };
}

/** 列出提案目录（inbox / proposal / applied） */
function listProposals() {
  const p = pathsMod.paths();
  const out = { inbox: [], proposal: [], applied: [] };
  try {
    for (const f of fs.readdirSync(p.proposals)) {
      if (/^inbox-.*\.md$/.test(f)) out.inbox.push(f);
      else if (/^proposal-.*\.json$/.test(f)) out.proposal.push(f);
    }
  } catch { /* 目录不存在 */ }
  const appliedDir = path.join(p.proposals, 'applied');
  try { out.applied = fs.readdirSync(appliedDir); } catch { /* ignore */ }
  return out;
}

/**
 * 清理过期归档（V2 §9 `retentionDays.appliedProposals = 30`）。
 * 只删 `proposals/applied/` 里的文件，按 mtime；**不碰** inbox 与未处理的提案。
 */
function pruneApplied({ cfg } = {}) {
  const c = cfg || configMod.load().config;
  const days = (c.retentionDays && Number.isFinite(c.retentionDays.appliedProposals)) ? c.retentionDays.appliedProposals : 30;
  if (!(days > 0)) return { ok: true, removed: 0, skipped: 'disabled' };
  const dir = path.join(pathsMod.paths().proposals, 'applied');
  if (!fs.existsSync(dir)) return { ok: true, removed: 0 };
  const cutoff = Date.now() - days * 86400000;
  let removed = 0;
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (st.mtimeMs < cutoff) { fs.unlinkSync(full); removed++; }
    } catch { /* 单文件失败不影响其余 */ }
  }
  return { ok: true, removed, days, dir };
}

void jev;   // 显式声明：inbox 构建**不调用 Jev**（引擎零 LLM / 零评分）

module.exports = {
  buildInbox, writeInbox, listProposals, pruneApplied, listProjects, readIndexState, readExperience,
  supersedeMarkers, INDEX_LIMITS, OVERLAP_HINT, CLUSTER_HINT,
};
