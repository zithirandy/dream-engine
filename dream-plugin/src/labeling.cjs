'use strict';
/**
 * labeling.cjs —— 精度标注与计算（P1 精度处置的前置基础设施）。
 *
 * 背景：对**同一批 18 条样本**，实施方自评 ≈28–44%，独立核验读作 ≈55%。
 * 两者相差近一倍 ⇒ 真正缺的不是"更多规则"，而是**标注基线**。
 * 没有基线，任何"精度提升"都无法证伪。
 *
 * 流程：dreamctl label → 人工在生成的表格里填判定 → dreamctl precision 算指标。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const store = require('./store.cjs');

const LABELS = { '好': 'good', '边缘': 'marginal', '噪声': 'noise', good: 'good', marginal: 'marginal', noise: 'noise', g: 'good', m: 'marginal', n: 'noise' };

/**
 * ★ E5（评审修订）：锚定样例。
 *
 * 三档定义只是口径的一半——28% vs 55% 的分歧本源是**判定直觉差**。
 * 标注者必须先对锚再标，否则 60 条标完两个人仍可能差一倍。
 * 以下锚定例均取自真实候选，且属**双方判读无争议**的类型。
 */
const ANCHORS = {
  good: [
    '斜杠格式的来历与去除：源码里 姓/名 的斜杠格式只对护照乘客是页面约定（明确按 / 拆分），对其他证件类型不适用',
    '后续所有交流和文档统一用规范名词：五代（接口5）、六代（接口6）、四代（接口4）——不要再用内部代号',
    '**spec-kit** 是 GitHub 官方的规范驱动开发工具包；',
  ],
  marginal: [
    '环境记录：本地调试须用 IDE 直接启动（某地址是生产分支）、报价上午抖动、构建工具占用端口的处理、术语规范',
    '这是典型的"上游换了方言，下游没跟上"：旧链路由扫描管线产出，新通道由新版本直接写对象序列化',
    // ★ 口径补充的代表例：内容为真，但**句子残缺**（转折词开头 / 分号结尾 / 指代悬空）⇒ 降为边缘
    '也就是说：**该拦的场景照拦，该放的场景放行**——该规则作为独立项没有存在价值，规范里已从总账删除。',
    '但按页面自身对这类乘客的行为（去斜杠），中文名应填 `张伟` 无斜杠全名，这与页面约定一致',
  ],
  noise: [
    '决定性证据到手：那个文件里字段结构在、值全空（Prices=[]、Tax=0、SubTotal=0、type=None）',
    '已全部修正，抱歉又犯了——这次把规范刻牢了：',
    '还差两个关键点：那个列表在哪构建（决定第 102 处修复的落点）',
    // 索引行：是记账，不是判断 —— 典型噪声
    '记忆库：channel-split.md（新建）、schema-fix.md（口径定案）',
  ],
};

/**
 * ★ 口径补充（第 0 步标注基线结论 §5.2，核验 §4.2 要求写入）：
 * 两条相邻边界（好/边缘、边缘/噪声）的分歧可归为**同一条标准**。
 * 不写进口径，后续标注（label-all、S1 换来源后复测）会重演同类分歧。
 */
const CRITERIA_NOTE = [
  '**好 = 自足 + 锚定**：脱离上下文即可读懂的、且点名了具体文件/符号/接口的**规则或定义**。',
  '**残缺句降到边缘**：以转折词开头（也就是说／但按…）、以分号结尾、指代悬空（这类…）的句子，',
  '即便内容为真，也判「边缘」——它需要上下文才能被后来者用起来。',
  '**边缘 = 内容真但需整理**：含指针/结构类信息（记忆文件清单、topic 枚举、命令清单），或夹带真事实的叙述。',
  '**噪声 = 只在本次会话成立的句子**：进度汇报、状态播报、行动计划、寒暄道歉、记忆编辑 meta。',
].join('\n');

/**
 * ★ E6（评审修订）：三档门槛收紧。
 * 零复现意味着每条 convention 都是**单点断言**——即便精度 70%，
 * 单点断言的先验可信度仍低于跨会话复现过的条目。
 */
const TIERS = [
  { cond: '严格精度 < 40%', action: '删信号（S2）+ S1 换来源补召回' },
  { cond: '严格精度 40–70%', action: '只进 candidates（现状），不进自动路径' },
  { cond: '严格精度 ≥ 70% 且语义 support ≥ 2（S3 之后可用）', action: '才放开自动提升' },
  { cond: '严格精度 ≥ 70% 但 support < 2', action: '仍只进 candidates —— 单点断言不自动提升' },
];

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

/** 文本安全化：管道符会破坏 markdown 表格列索引（曾导致 6/60 行被静默丢弃） */
function safeCell(s) {
  return String(s == null ? '' : s).replace(/\r?\n/g, ' ').replace(/\|/g, '¦');
}

/**
 * 解析标注表（score 与 compare 共用）。
 * 标签列**从尾部定位**（cells[len-3]），以容忍文本中残留的未转义管道符。
 */
function parseSheet(file) {
  const rows = [];
  if (!fs.existsSync(file)) return rows;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((s) => s.trim());
    if (cells.length < 7) continue;
    if (cells[1] === '#' || /^-+$/.test(cells[1]) || /^-+$/.test(cells[2] || '')) continue;
    const labelCell = cells[cells.length - 3];      // 尾部：| 判定 | 备注 | → '' 
    const label = LABELS[labelCell];
    if (!label) continue;
    rows.push({ n: cells[1], signal: cells[2], id: cells[3], label, note: cells[cells.length - 2] || '' });
  }
  return rows;
}

/**
 * 生成标注表（markdown 表格，可直接编辑）。
 * 抽样策略：按 weight 降序 + 均匀覆盖，避免只看头部。
 */
function makeSheet({ signal = null, n = 60, seed = 1 } = {}) {
  let pool = store.loadCandidates({ limit: 50 });
  if (signal) pool = pool.filter((c) => c.signal === signal);
  if (!pool.length) return { ok: false, reason: 'no-candidates' };

  // 确定性"均匀抽样"：按 id 排序后等距取样，保证可复现
  const sorted = pool.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const step = Math.max(1, Math.floor(sorted.length / n));
  const picked = [];
  for (let i = 0; i < sorted.length && picked.length < n; i += step) picked.push(sorted[i]);

  const p = pathsMod.paths();
  ensureDir(path.join(p.reports));
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(p.reports, `label-${signal || 'all'}-${ts}.md`);

  const lines = [];
  lines.push(`# 精度标注表（${signal || '全部信号'}）`);
  lines.push('');
  lines.push('> 在「判定」列填 **好** / **边缘** / **噪声**（也接受 good/marginal/noise 或 g/m/n）。');
  lines.push('> 填完执行：`node src/cli.cjs precision --file "<本文件路径>"`');
  lines.push('');
  lines.push('判定口径（请先统一，否则指标无意义）：');
  lines.push('');
  lines.push(CRITERIA_NOTE);
  lines.push('');
  lines.push('## ★ 先对锚（E5）：下面每条都已判定，请先读一遍再开始标');
  lines.push('');
  lines.push('| 档位 | 真实样例 |');
  lines.push('|---|---|');
  for (const [tier, examples] of Object.entries(ANCHORS)) {
    const zh = tier === 'good' ? '好' : tier === 'marginal' ? '边缘' : '噪声';
    for (const ex of examples) lines.push(`| **${zh}** | ${safeCell(ex)} |`);
  }
  lines.push('');
  lines.push('> 对锚要点：**好**必须**自足**（脱离上下文可读）且点名了具体文件/符号/接口；');
  lines.push('> **残缺句**（转折词开头／分号结尾／指代悬空）即便内容为真也判**边缘**；');
  lines.push('> **噪声** = 只在本次会话成立的句子（进度、状态、计划、寒暄、meta）。');
  lines.push('');
  lines.push(`池规模 ${pool.length}，等距抽取 ${picked.length} 条（step=${step}）`);
  lines.push('');
  lines.push('| # | 信号 | id | 文本 | 判定 | 备注 |');
  lines.push('|---:|---|---|---|---|---|');
  picked.forEach((c, i) => {
    lines.push(`| ${i + 1} | ${c.signal} | ${c.id} | ${safeCell(String(c.text || '').slice(0, 220))} |  |  |`);
  });
  lines.push('');
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return { ok: true, file, picked: picked.length, pool: pool.length, step };
}

/** 解析标注表并计算指标 */
function score({ file }) {
  if (!fs.existsSync(file)) return { ok: false, reason: 'file-not-found', file };
  const rows = parseSheet(file);
  if (!rows.length) return { ok: false, reason: 'no-labels-filled', file };

  const tally = (rs) => {
    const t = { good: 0, marginal: 0, noise: 0, total: rs.length };
    for (const r of rs) t[r.label]++;
    t.precisionStrict = t.total ? t.good / t.total : 0;
    t.precisionInclusive = t.total ? (t.good + t.marginal) / t.total : 0;
    return t;
  };

  const bySignal = {};
  for (const r of rows) {
    bySignal[r.signal] = bySignal[r.signal] || [];
    bySignal[r.signal].push(r);
  }
  const out = { ok: true, file, overall: tally(rows), bySignal: {} };
  for (const [s, rs] of Object.entries(bySignal)) out.bySignal[s] = tally(rs);
  return out;
}

function renderScore(r) {
  if (!r.ok) return `标注计算失败：${r.reason}${r.file ? ' (' + r.file + ')' : ''}`;
  const pct = (x) => (x * 100).toFixed(1) + '%';
  const L = [];
  L.push('=== 精度指标 ===');
  L.push(`文件  ${r.file}`);
  L.push('');
  L.push(`总体  n=${r.overall.total}  好=${r.overall.good} 边缘=${r.overall.marginal} 噪声=${r.overall.noise}`);
  L.push(`      严格精度(good/total)      ${pct(r.overall.precisionStrict)}`);
  L.push(`      宽松精度(good+marginal)/n ${pct(r.overall.precisionInclusive)}`);
  L.push('');
  L.push('按信号：');
  L.push('  信号               n   好  边缘  噪声   严格    宽松');
  for (const [s, t] of Object.entries(r.bySignal)) {
    L.push(`  ${s.padEnd(17)} ${String(t.total).padStart(3)} ${String(t.good).padStart(4)} ${String(t.marginal).padStart(5)} ${String(t.noise).padStart(5)}  ${pct(t.precisionStrict).padStart(6)}  ${pct(t.precisionInclusive).padStart(6)}`);
  }
  L.push('');
  L.push('判读门槛（★ E6 收紧版——零复现即单点断言，不自动提升）：');
  for (const t of TIERS) L.push(`  ${t.cond.padEnd(44)} → ${t.action}`);
  return L.join('\n');
}

/**
 * ★ 对比两份标注（评审 §5：实施方预标 vs 用户标注）。
 * 分歧率本身是信噪指标——若两人对同一批仍差一倍，说明口径未定，指标不可用。
 */
function compare({ a, b }) {
  const ra = score({ file: a });
  const rb = score({ file: b });
  if (!ra.ok) return { ok: false, reason: 'a-not-scored', detail: ra };
  if (!rb.ok) return { ok: false, reason: 'b-not-scored', detail: rb };

  const readRows = (file) => parseSheet(file).map((r) => ({ id: r.id, label: r.label }));
  const A = readRows(a);
  const B = readRows(b);
  const mapB = new Map(B.map((r) => [r.id, r.label]));
  const pairs = A.filter((r) => mapB.has(r.id)).map((r) => ({ id: r.id, a: r.label, b: mapB.get(r.id) }));
  const agree = pairs.filter((p) => p.a === p.b).length;
  const matrix = {};
  for (const p of pairs) {
    matrix[p.a] = matrix[p.a] || { good: 0, marginal: 0, noise: 0 };
    matrix[p.a][p.b]++;
  }
  return {
    ok: true,
    aFile: a, bFile: b,
    a: ra.overall, b: rb.overall,
    pairs: pairs.length,
    agree,
    agreementRate: pairs.length ? agree / pairs.length : 0,
    /** 宽松度差：一方把对方判为噪声的条目读作好/边缘的比例 */
    matrix,
    disagreements: pairs.filter((p) => p.a !== p.b),
  };
}

function renderCompare(r) {
  if (!r.ok) return `对比失败：${r.reason}`;
  const pct = (x) => (x * 100).toFixed(1) + '%';
  const L = [];
  L.push('=== 标注一致性对比 ===');
  L.push(`A（实施方预标）  n=${r.a.total}  严格 ${pct(r.a.precisionStrict)}  宽松 ${pct(r.a.precisionInclusive)}`);
  L.push(`B（用户标注）    n=${r.b.total}  严格 ${pct(r.b.precisionStrict)}  宽松 ${pct(r.b.precisionInclusive)}`);
  L.push('');
  L.push(`可比条目 ${r.pairs}，完全一致 ${r.agree}（一致率 ${pct(r.agreementRate)}）`);
  L.push('');
  L.push('混淆矩阵（行=A 判定，列=B 判定）：');
  L.push('        B好  B边缘  B噪声');
  for (const [k, v] of Object.entries(r.matrix)) {
    const zh = k === 'good' ? 'A好  ' : k === 'marginal' ? 'A边缘' : 'A噪声';
    L.push(`  ${zh}  ${String(v.good).padStart(4)} ${String(v.marginal).padStart(6)} ${String(v.noise).padStart(6)}`);
  }
  L.push('');
  if (r.agreementRate >= 0.8) L.push('判读：一致率 ≥80% ⇒ 口径已对齐，指标可用于分支决策。');
  else if (r.agreementRate >= 0.6) L.push('判读：一致率 60–80% ⇒ 需回到 E5 锚定例再对齐一轮。');
  else L.push('判读：一致率 <60% ⇒ **口径未定**，指标不可用于决策；先扩锚定例或统一"以严格还是宽松为准"。');
  if (r.disagreements.length) {
    L.push('');
    L.push(`分歧明细（前 12 / 共 ${r.disagreements.length}）：`);
    for (const d of r.disagreements.slice(0, 12)) L.push(`  ${d.id}  A=${d.a}  B=${d.b}`);
  }
  return L.join('\n');
}

module.exports = { makeSheet, score, renderScore, compare, renderCompare, parseSheet, safeCell, LABELS, ANCHORS, TIERS, CRITERIA_NOTE };
