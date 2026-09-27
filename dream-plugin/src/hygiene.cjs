'use strict';
/**
 * hygiene.cjs —— 候选文本的**上游污染**检测与规范化。
 *
 * 起因（核验 N4 的溯源结论）：真实写入的记忆文件里发现 `\u5bfc\u5355`（"导单"的字面转义）
 * 与结尾 `",`。逐条回溯源转录后确认：**11/11 条在源 JSONL 里就是字面转义（双转义形态），
 * `导单` 出现 0 次** ⇒ 当时会话的作者把转义序列当文本写了出来，我们提取是**忠实的**，
 * 不是解析 bug。实测 153 条候选里 12 条（7.8%）带这类残留。
 *
 * 因此本模块做两件事，且**默认保守**：
 *   1. `scan()`     —— 只检测、只上报（供预览与候选标注使用），绝不改文本；
 *   2. `normalize()` —— 只做**语义安全**的清理：
 *        · 尾部 JSON 片段（`,",` / `]` 之类）⇒ 总是清理（纯属噪声）
 *        · `\uXXXX` ⇒ **可选**（`decodeUnicodeEscapes`，默认关）：`\u5bfc`→导 这类字符编码
 *          一般可以安全还原，但"讨论转义序列本身"的候选会被改坏，故需显式开启
 *        · `\n` / `\t` / `\"` ⇒ **一律不解码**：它们在候选里常是命令/代码的一部分
 *          （如 `printf "a\nb"` 的 `\n` 有语义），解码会**改掉命令含义**
 */
const configMod = require('./config.cjs');

const PATTERNS = [
  { re: /\\u[0-9a-fA-F]{4}/, label: 'unicode-escape', desc: 'JSON 转义残留 (\\uXXXX)' },
  { re: /\\[nt]|\\"/, label: 'control-escape', desc: 'JSON 转义残留 (\\n/\\t/\\")' },
  { re: /["'`]\s*,\s*$/, label: 'json-tail', desc: '结尾残留引号+逗号' },
  { re: /^\s*[{[]/, label: 'json-head', desc: '以 JSON 括号开头' },
  { re: /(先|帮我|帮|麻烦你|请你)(帮我)?(排查|看看|看下|查下|分析|确认)/, label: 'request-tail', desc: '对话请求残留' },
  { re: /^(Also|Additionally|Furthermore|Moreover)\b/i, label: 'transition-start', desc: '转折词开头' },
];

/** 只检测、只上报。返回命中的问题清单（空数组 = 干净）。 */
function scan(text) {
  const t = String(text == null ? '' : text);
  const issues = [];
  for (const p of PATTERNS) if (p.re.test(t)) issues.push({ label: p.label, desc: p.desc });
  return { polluted: issues.length > 0, issues, labels: issues.map((x) => x.label) };
}

/**
 * 清掉尾部的 JSON 片段。
 *
 * ⚠️ **只清无歧义的形态**：`引号/括号 + 逗号` 结尾（如 `only.",`、`text'],`）。
 *    此前还清"尾部孤立引号"，结果把 `printf "a\nb"` 的结束引号也删了 ——
 *    **破坏了合法命令**（测试 R8 抓到）。孤立尾引号有歧义（可能是正常代码），故不动。
 */
function trimJsonFragments(text) {
  return String(text == null ? '' : text)
    // 「引号/括号串 + 逗号」结尾。**逗号是关键标志**：它让"JSON 片段"无歧义，
    // 同时不会碰 `printf "a\nb"` 这类以引号正常结尾的代码（无逗号 ⇒ 不匹配）。
    // 用 `[...]+` 而非单字符，才能一次清掉 `values'],` 这种连续残渣。
    .replace(/["'`\]\}]+,\s*$/, '')
    .trim();
}

/** 还原 `\uXXXX` 为字符（可选；默认不在 normalize 里开启） */
function decodeUnicodeEscapes(text) {
  return String(text == null ? '' : text)
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => {
      const code = parseInt(h, 16);
      try { return String.fromCodePoint(code); } catch { return `\\u${h}`; }
    });
}

/**
 * 裁掉用户纠正句尾的**请求部分**（"…应该是 示例中心，先帮我排查下原因" ⇒ 只留前半句）。
 * 依据：`user-correction` 的经验本体是"被纠正的事实 + 正确答案"，请求语不是经验。
 */
const TAIL_CUT = /[，,；;]\s*(?:先|请|麻烦)?\s*(?:帮我|帮忙|麻烦你|请你)?\s*(?:排查|看看|看下|查下|分析|确认|检查|修一下|改一下|处理下)/;
function trimRequestTail(text) {
  const t = String(text == null ? '' : text);
  const m = TAIL_CUT.exec(t);
  if (!m || m.index < 8) return t;                 // 太靠前则不动，避免砍掉主体
  return t.slice(0, m.index).trim();
}

/**
 * 规范化候选文本。
 * @param {string} text
 * @param {{decodeUnicodeEscapes?:boolean, trimJsonFragments?:boolean, trimRequestTail?:boolean}} [opts]
 */
function normalize(text, opts = {}) {
  const o = { trimJsonFragments: true, decodeUnicodeEscapes: false, trimRequestTail: false, ...opts };
  let t = String(text == null ? '' : text);
  if (o.trimRequestTail) t = trimRequestTail(t);
  if (o.decodeUnicodeEscapes) t = decodeUnicodeEscapes(t);
  if (o.trimJsonFragments) t = trimJsonFragments(t);
  return t.trim();
}

/** 按配置规范化（默认从 config.textHygiene 读） */
function normalizeWithConfig(text, cfg, extra = {}) {
  const c = cfg || configMod.load().config;
  const th = c.textHygiene || {};
  return normalize(text, {
    decodeUnicodeEscapes: !!th.decodeUnicodeEscapes,
    trimJsonFragments: th.trimJsonFragments !== false,
    ...extra,
  });
}

/**
 * ★ 候选文本规范化的**统一入口**（策略集中在这里，避免各调用点各写一套）。
 *
 * 关键策略：**裁请求尾巴只对 `user-correction` 生效**。
 *   理由：请求语残留是"用户纠正句"特有的产物（用户把纠正和请求写在一句里）；
 *   而 `error-fix` 的 `修法：…先检查 X…`、`retry-then-success` 的叙述里
 *   完全可能合法地出现"先/检查/确认"等词，对它们裁尾会**误伤正文**。
 *   （此前 `normalizeWithConfig` 压根没把该开关传下去，导致配置项形同虚设。）
 */
function normalizeCandidate(text, cfg, signal) {
  const c = cfg || configMod.load().config;
  const th = c.textHygiene || {};
  return normalizeWithConfig(text, c, {
    trimRequestTail: th.trimRequestTail !== false && signal === 'user-correction',
  });
}

module.exports = {
  scan, normalize, normalizeWithConfig, normalizeCandidate,
  trimJsonFragments, decodeUnicodeEscapes, trimRequestTail,
  PATTERNS,
};
