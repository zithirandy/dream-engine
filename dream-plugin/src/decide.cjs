'use strict';
/**
 * decide.cjs —— 双层阈值的晋升决策（V2 §4.4 / §4.5）。
 *
 * 纯函数，无 IO、无时钟，便于穷举测试。
 *
 * 决策级联（自上而下，命中即停）：
 *   1. 打分失败                       → reject  scoring-failed
 *   2. 已被既有记忆覆盖（known ≥ 阈值） → reject  already-known
 *   3. 复合分 < hold                   → reject  below-hold        （V2 表格第 3 行）
 *   4. 硬门槛未过（still_true/reusable）→ hold    hard-gate-fail    （V2 表格第 2 行"略有偏差"）
 *   5. 逐维度死区（任一对数值落在 0.5±deadZone）→ hold  dead-zone
 *   6. 置信度过低（durability/kind）   → hold    low-confidence
 *   7. convention 且不可自动提升        → hold    convention-not-promotable
 *   8. 复合分 ≥ promote                → promote
 *   9. 其余（hold ≤ 分 < promote）      → hold    below-promote
 *
 * ★ 关于 deadZone 的语义（此前混淆过，务必按此理解）：
 *   V2 §4.4 line 368 原文是"**任一判断**落入 `[0.45, 0.55]` ⇒ 不提升"，
 *   指的是**逐维度**的模糊带（noul=0.5 即抛硬币），不是复合分附近的抖动带。
 *   `deadZone=0.05` 恰好使该带成为 0.5±0.05 = [0.45, 0.55]，与 V2 数字吻合。
 *   复合分的两档是 `hold` 与 `promote`，与 deadZone 无关。
 */
const configMod = require('./config.cjs');

const NOUL_DIMS = ['reusable', 'nontrivial', 'still_true'];

/**
 * 「片段 / 进度叙述」检测（把**已有**的标注标准编码进决策）。
 *
 * 依据 `labeling.cjs` 的 `CRITERIA_NOTE`（项目已确立的标准，非新发明）：
 *   · 好 = 自足、点名具体文件/符号/接口规则或定义；
 *   · **片段（转折词开头、分号结尾、悬空引用）即使为真也降为边缘**；
 *   · 进度/状态/计划类 = 噪声。
 *
 * 为什么必须单独检测：`reusable`/`still_true` 是 Jev 对**语义**的判断，它无法识别
 * "这条文本其实是提取器把**过程**写成了句子"。实测 13 条 promote 里有 5–6 条是
 * `文件 X 经 4 次修改后才通过，最终动作：…` 这类**过程叙述**（还常被截断），
 * 或者是 `Also …` 这类**转折词开头的片段** —— 写进记忆就是污染。
 */
const PROGRESS_PATTERNS = [
  /经\s*\d+\s*次(修改|编辑|调整)后才?通过/,      // "经 4 次修改后才通过"
  /最终动作\s*[:：]/,                              // 提取器的过程模板
  /^\s*(已|正在|待|下一步|接下来)\s*(完成|进行|处理|修改|验证)/, // 状态叙述
];
// ⚠️ `\b` 只对 ASCII 词字符有效 —— 中文不属于 `\w`，故 `二改先跳过\b` **永远不匹配**
//    （实测漏掉了 `二改先跳过。 此外…` 这条）。中英两分支必须分开写，中文分支不加 `\b`。
const FRAGMENT_START = /^\s*(?:(?:also|additionally|furthermore|moreover|and|but|then)\b|(?:此外|另外|同时|而且|但是|然后|二改先跳过|补充|综上))[\s,，。:：]/i;
const FRAGMENT_END = /[;；]\s*$/;                  // 分号结尾 = 悬空

function isFragmentOrProgress(text) {
  const t = String(text || '').trim();
  // 空文本**不算片段**：那是"候选无效"，不是"文本是片段"。
  // 若把空文本也判为片段，会让本闸门掩盖真正的失败原因（且合成 fixture 会集体误伤）。
  if (!t) return { fragment: false, why: null };
  for (const re of PROGRESS_PATTERNS) if (re.test(t)) return { fragment: true, why: 'progress-narrative' };
  if (FRAGMENT_START.test(t)) return { fragment: true, why: 'transition-word-start' };
  if (FRAGMENT_END.test(t)) return { fragment: true, why: 'dangling-semicolon' };
  return { fragment: false, why: null };
}

function decideOne(s, { cfg } = {}) {
  const c = cfg || configMod.load().config;
  const th = c.thresholds || {};
  const g = c.gates || {};
  const promote = Number.isFinite(th.promote) ? th.promote : 0.50;
  const hold = Number.isFinite(th.hold) ? th.hold : 0.35;
  const deadZone = Number.isFinite(th.deadZone) ? th.deadZone : 0.05;
  const minDurConf = Number.isFinite(th.minDurabilityConfidence) ? th.minDurabilityConfidence : 0.50;
  const conventionPromotable = !(c.signals && c.signals.conventionPromotable === false);

  const base = { candId: s.candId, signal: s.signal, score: s.score, kind: s.kind, n: s.n };

  if (!s.ok) return { ...base, decision: 'reject', reason: 'scoring-failed', detail: s.reason };

  if (s.alreadyKnown) {
    return { ...base, decision: 'reject', reason: 'already-known', detail: `known=${s.n.known} ≥ ${s.knownRejectMin}` };
  }

  if (!(s.score >= hold)) return { ...base, decision: 'reject', reason: 'below-hold', detail: `score ${s.score} < hold ${hold}` };

  if (!s.passHardGates) {
    return { ...base, decision: 'hold', reason: 'hard-gate-fail',
      detail: `still_true=${s.n.still_true} reusable=${s.n.reusable}` };
  }

  // 片段/进度叙述 ⇒ 进 candidates 待复核（按标注标准属"边缘"，不是"好"）。
  // 不判 reject：内容可能为真，只是表达不合格，人工整理后仍可用。
  if (g.fragmentHold !== false) {
    const frag = isFragmentOrProgress(s.text);
    if (frag.fragment) return { ...base, decision: 'hold', reason: 'fragment-or-progress', detail: frag.why };
  }

  // 逐维度死区：0.5 附近表示该维度 Jev 自己也没把握。
  // ★ 必须加 epsilon：`0.55 - 0.5 === 0.050000000000000044 > 0.05`，
  //   纯浮点比较会让恰好落在带边界（0.45/0.55）的值漏过死区 —— Jev 的答案
  //   以 0.01 为步长，边界值很常见，不是理论问题。（N6 测试抓到过。）
  const EPS = 1e-9;
  const ambiguous = NOUL_DIMS.filter((d) => Math.abs(s.n[d] - 0.5) <= deadZone + EPS);
  if (ambiguous.length) {
    return { ...base, decision: 'hold', reason: 'dead-zone',
      detail: `${ambiguous.join(',')} ∈ [${(0.5 - deadZone).toFixed(2)}, ${(0.5 + deadZone).toFixed(2)}]` };
  }

  // 置信度：Score/Choice 带 confidence，Noul 不带
  if (Number.isFinite(s.conf && s.conf.durability) && s.conf.durability < minDurConf) {
    return { ...base, decision: 'hold', reason: 'low-confidence', detail: `durability.conf=${s.conf.durability} < ${minDurConf}` };
  }

  if (!conventionPromotable && s.signal === 'convention') {
    return { ...base, decision: 'hold', reason: 'convention-not-promotable',
      detail: 'signals.conventionPromotable=false：约定类只累积待人工/手动梦复核' };
  }

  if (s.score >= promote) return { ...base, decision: 'promote', reason: 'ok', detail: `score ${s.score} ≥ ${promote}` };

  return { ...base, decision: 'hold', reason: 'below-promote', detail: `score ${s.score} < promote ${promote}` };
}

/**
 * 批量决策 + 配额。
 * @returns {{decisions:Array, summary:{promote:number,hold:number,reject:number,byReason:object,rateLimited:number}}}
 */
function decideAll(scored, { cfg } = {}) {
  const c = cfg || configMod.load().config;
  const maxProm = (c.limits && Number.isFinite(c.limits.maxPromotionsPerRun)) ? c.limits.maxPromotionsPerRun : 40;

  const decisions = scored.map((s) => decideOne(s, { cfg: c }));

  // 配额：超额时按分数保留最高的 N 条，其余降级为 hold（不丢，只降级）
  let rateLimited = 0;
  const promotes = decisions.filter((d) => d.decision === 'promote');
  if (promotes.length > maxProm) {
    const keep = new Set(promotes.slice().sort((a, b) => b.score - a.score).slice(0, maxProm).map((d) => d.candId));
    for (const d of decisions) {
      if (d.decision === 'promote' && !keep.has(d.candId)) {
        d.decision = 'hold'; d.reason = 'rate-limited'; d.detail = `超过 maxPromotionsPerRun=${maxProm}`;
        rateLimited++;
      }
    }
  }

  const byReason = {};
  for (const d of decisions) byReason[d.reason] = (byReason[d.reason] || 0) + 1;
  const count = (k) => decisions.filter((d) => d.decision === k).length;
  return {
    decisions,
    summary: { promote: count('promote'), hold: count('hold'), reject: count('reject'), byReason, rateLimited, maxPromotionsPerRun: maxProm },
  };
}

module.exports = { decideOne, decideAll, isFragmentOrProgress, NOUL_DIMS };
