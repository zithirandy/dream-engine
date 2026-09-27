'use strict';
/**
 * extract.cjs —— 候选经验提炼（V2 §4.2）。**纯代码，零 LLM。**
 *
 * v2（P1 质量修复）：干跑暴露 5 类噪声后收紧，见 §「质量闸」。
 *
 * 五条规则：
 *   R1 用户纠正   R2 错误→修复（要求因果链）   R3 反复试错后成功
 *   R4 环境事实   R5 约定/决定
 *
 * 质量闸：
 *   a0 编码闸：含 U+FFFD（替换字符）→ 丢（源数据是 GBK 被当 UTF-8 读坏）
 *   a1 样板闸：命中注入模板/skill 指令文本 → 丢
 *   a2 内容闸：过短、纯路径、纯代码块残片、纯 JSON 数组、无实质词 → 丢
 *   a3 语义闸：纠正句必须是陈述/祈使，且真的在纠正（词边界 + 否定语境）
 *   a4 因果闸：error→fix 必须有共同关键 token（文件/符号/错误码）
 *   b  已知闸：与既有记忆的**重叠系数**（非 Jaccard）超阈值 → 标 dupOf
 *   c  自去重闸：候选之间近似 → 合并
 */
const redactMod = require('./redact.cjs');

// ------------------------------------------------------------------ 语料工具
const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'has', 'had', 'was', 'were', 'are', 'but', 'not', 'you', 'your', 'can', 'will', 'would', 'should', 'could', 'there', 'then', 'than', 'them', 'they', 'what', 'when', 'which', 'while', 'into', 'out', 'over', 'only', 'also', 'just', 'like', 'some', 'any', 'all', 'use', 'using', 'used', 'make', 'made', 'get', 'got', 'see', 'need', 'want', 'about', 'after', 'before', 'because', 'been', 'being', 'does', 'did', 'doing', 'each', 'more', 'most', 'other', 'same', 'such', 'very', 'well', 'where', 'who', 'why', 'how', 'error', 'failed', 'failure']);

function tokenize(text) {
  const out = new Set();
  if (!text) return out;
  const ascii = String(text).toLowerCase().match(/[a-z_][a-z0-9_]{3,}/g) || [];
  for (const w of ascii) if (!STOP.has(w)) out.add(w);
  const cjk = String(text).match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const run of cjk) for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  return out;
}

/** 重叠系数：|A∩B| / min(|A|,|B|)。比 Jaccard 更适合「短候选 vs 长记忆文件」 */
function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / Math.min(a.size, b.size);
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function sentences(text) {
  return String(text || '')
    .split(/(?<=[。！？!?；;\n])|(?<=\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function sentenceWith(text, re, { withPrev = true } = {}) {
  const arr = sentences(text);
  for (let i = 0; i < arr.length; i++) {
    if (re.test(arr[i])) {
      const prev = withPrev && i > 0 && arr[i - 1].length < 120 ? arr[i - 1] + ' ' : '';
      return (prev + arr[i]).trim();
    }
  }
  return null;
}

const clip = (s, n = 400) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');

/** 编码损坏：替换字符出现说明源数据是 GBK 被当 UTF-8 读坏 */
function hasMojibake(s) { return typeof s === 'string' && s.includes('\uFFFD'); }

/** 从文本里抽「关键 token」：文件名、标识符、错误码 —— 用于因果链判定 */
function keyTokens(text) {
  const out = new Set();
  if (!text) return out;
  const s = String(text);
  for (const m of s.matchAll(/[A-Za-z0-9_\-.]+\.(?:cs|ts|js|jsx|tsx|py|java|go|rs|sql|json|xml|yml|yaml|md|txt|csproj|sln|aspx|html|css)\b/gi)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/\b[A-Z]{2,}[0-9]{2,6}\b/g)) out.add(m[0].toLowerCase());          // MSB3277 / CS0168
  for (const m of s.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) out.add(m[0].toLowerCase()); // PascalCase 符号
  for (const m of s.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) out.add(m[0].toLowerCase());     // snake_case
  for (const m of s.matchAll(/\b(?:ORA|SQLSTATE)-?\d{3,5}\b/gi)) out.add(m[0].toLowerCase());
  for (const m of s.matchAll(/\b(?:ERR|E)[A-Z_]{3,}\b/g)) out.add(m[0].toLowerCase());          // ENOENT / ECONNREFUSED
  return out;
}

// ------------------------------------------------------------------ 模式
// 纠正：中英分词边界化，去掉「错了」这类会误命中「报错了」的裸子串
const CORRECTION = /(不对(?![。，,])|不是这|应该(?:是|用|改成)|改成|别用|不要用|而不是|记住|以后都|注意这|其实应|\bactually\b|\binstead\b|\bshould be\b|\bdon'?t use\b|\bnever use\b|\bremember to\b)/i;
const DECISION = /(约定|决定|规范|公约|统一用|以后都|定为|我们采用|建议统一|\bconvention\b|\bstandardi[sz]e\b|\balways use\b|\bnever use\b)/i;
// ★ F3 修复：convention 桶精度仅 1/3–1/2（核验补抽 18 条实测）。
// 收紧为「陈述句 + 锚点/强约定词」，并排除行动计划句与记忆编辑 meta。
const CONV_PLAN = /^\s*(?:看|查|查看|确认|补查|先|现在|接下来|然后|接着|下一步|让我|我来|我看看|先看|需要|准备|是否|要不要|待|稍后|继续)/;
const CONV_META = /(MEMORY\.md|§\s*\d|追加|按惯例|惯例上|摘要|总结如下|待办|\btodo\b|如上|以下|已记录|写入索引)/i;
const CONV_STRONG = /(约定|规范|公约|统一用|禁止|不得|必须|一律|统一走|统一使用|定为|\bstandard\b|\bmust not\b|\bmust always\b|\bshall\b)/i;
// ★ F3 第二轮：抽样发现真正区分特征是「定义/规范句 vs 进度叙述」。
// 进度/状态叙述一律丢——它们描述"这次会话做到哪了"，没有跨会话复用价值。
const CONV_PROGRESS = /(完成|通过\s*[（(✅]|全链路|收到[，,（(]|明白[，,—\-—]|已更正|已修复|已确认|决定性|证据到手|关键岔口|还差|先探|有没有值|第\s*\d+\s*题|进度|状态[:：]|待验证|下一步计划)/;
// 必须是**规范性**表述（定义、等价、必须、统一），而不是"我刚才做了什么"
const CONV_NORM = /(规范|约定|术语|统一(?:用|改|叫|走|使用|为)|须|一律|禁止|不得|必须|定义为|口径|等同|即|＝|=)/;

// 真错误（排除警告）
const ERROR_SIG = /(?:^|\b)(ERROR|FATAL|Exception|Unhandled|Traceback|panic:|failed|failure|失败|异常|报错)(?:\b|：|:)/i;
const WARNING_SIG = /(\bwarning\b|\b警告\b|CS0168|CS0219|warning\s+[A-Z]{2}\d{3,})/i;
// 真错误码：只认**明确的**错误码，不用 `E[A-Z]{3,}` 这类过宽模式（会把普通大写词也吞进来）
const ERROR_CODE = /\b(MSB\d{4}|error\s+(?:CS|BC|CA)\d{4}|ORA-\d{4,5}|SQLSTATE\s*\w+|ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|EEXIST|ENOTDIR|EISDIR|ENOSPC|ERR_[A-Z_]{3,})\b/i;
// 警告码：必须显式排除，否则 CS#### 会同时命中
const WARNING_CODE = /\bwarning\s+(?:CS|MSB|BC|CA)\d{4}\b/i;
// 严格错误行：必须同时出现「error 语境」或「明确错误码」，杜绝把日志分隔行当错误
const STRICT_ERR_LINE = /(\berror\b[^\n]{0,40}(?:CS|MSB|BC|CA)\d{4}|MSB\d{4}|ORA-\d{4,5}|SQLSTATE\s*\w+|ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|ERR_[A-Z_]{3,}|\bException\b|\bFATAL\b|Traceback \(most recent call last\)|\bpanic:|\b失败\b|\b报错\b|\b异常[:：])/i;
const SUCCESS_SIG = /(\bOK\b|\bsuccess|succeeded|passed|\bpassed!|✓|\bdone\b|已完成|成功|通过|Build succeeded|0 failures|0 Error\(s\)|Query OK)/i;
const PROBE_CMD = /(\-\-version|\bnode -v\b|\bwhere\s+\w|\bwhich\s+\w|\bnetstat\b|Get-Command|Get-CimInstance|whoami|\bhostname\b|\bpython -V\b|\bdotnet --list)/i;

// 注入样板 / skill 指令文本：这些进了 user 角色但不是用户的话
const BOILERPLATE = [
  /Do not duplicate content already captured/i,
  /PRDs?, plans?, ADRs?, issues?, commits?, diffs/i,
  /Reference them by path or URL instead/i,
  /<system-reminder>|<command-name>|<command-message>|<local-command/i,
  /^Caveat: The messages below/i,
  /Reply with OK only/i,
  /No other tests broken\?/i,
  /Issue actually resolved\?/i,
  /\bYou are an? (?:AI|assistant)\b/i,
  /^\s*(?:Step \d+|##\s+Step)/im,
];

function isBoilerplate(s) {
  if (!s) return true;
  return BOILERPLATE.some((re) => re.test(s));
}

// ------------------------------------------------------------------ E3：user 文本来源纯度闸
/**
 * E3（评审修订）：转录里的 user 角色**不等于纯人话**——混有 `!` 命令输出、
 * 粘贴的文档、local-command 展开、system-reminder。
 * S1（convention 改从 user 发言提取）落地前必须先过这道闸。
 */
const USER_INJECT = [
  /<system-reminder>|<command-name>|<command-message>|<local-command|<user-prompt-submit-hook/i,
  /^\s*Caveat: The messages below/i,
  /\bstdout\b[\s\S]{0,40}\bstderr\b/i,              // 命令输出信封
  /^\s*![\w./-]+\s/m,                                // `!cmd` 形式的注入
  /^\s*(?:diff --git|index [0-9a-f]{7}\.\.[0-9a-f]{7})/m,  // 粘贴的 diff
  /^\s*```/m,                                        // 粘贴的代码块
];

/** 行数/结构判定：粘贴文档通常很长且带大量 markdown 结构 */
function looksLikePastedDoc(s) {
  if (!s) return false;
  const lines = s.split(/\r?\n/);
  if (lines.length < 12) return false;
  const structural = lines.filter((l) => /^\s*(?:#{1,6}\s|[-*]\s|\d+\.\s|\|)/.test(l)).length;
  return structural / lines.length > 0.5 && s.length > 800;
}

/**
 * user 文本是否"够纯"，可当作人的发言来提取约定。
 * @returns {{pure:boolean, reason?:string}}
 */
function userTextPurity(s) {
  if (!s || s.length < 6) return { pure: false, reason: 'too-short' };
  if (hasMojibake(s)) return { pure: false, reason: 'mojibake' };
  for (const re of USER_INJECT) if (re.test(s)) return { pure: false, reason: 'injected' };
  if (isBoilerplate(s)) return { pure: false, reason: 'boilerplate' };
  if (looksLikePastedDoc(s)) return { pure: false, reason: 'pasted-doc' };
  return { pure: true };
}

/** 纠正候选要真的在纠正：是陈述/祈使，不是纯疑问句；且有足够实质内容 */
function looksLikeCorrection(s) {
  if (!s) return false;
  const q = (s.match(/[?？]/g) || []).length;
  const declarative = /[。.！!]|应该|请|要|别|不要|记住/.test(s);
  if (q >= 2 && !declarative) return false;                       // 纯问题清单
  if (/- No |\?\s*-/.test(s)) return false;                       // 检查清单形态
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (s.match(/[A-Za-z]{3,}/g) || []).length;
  return cjk >= 6 || words >= 5;
}

/**
 * ★ F3：约定候选要像「真约定/真事实」。
 * 第二轮收紧（核验 + 自测抽样后）：光有"陈述句 + 锚点"不够——进度叙述也满足这两条。
 * 现要求：规范性表述（CONV_NORM）且非进度叙述（CONV_PROGRESS）。
 */
function looksLikeConvention(s) {
  if (!s || s.length < 12) return false;
  if (CONV_PLAN.test(s)) return false;
  if (CONV_META.test(s)) return false;
  if (CONV_PROGRESS.test(s)) return false;
  if (/[?？]\s*$/.test(s) && !CONV_STRONG.test(s)) return false;
  if (!CONV_NORM.test(s)) return false;                 // 必须是规范/定义式表述
  const anchors = keyTokens(s);
  return CONV_STRONG.test(s) || anchors.size >= 1;       // 且点名了具体东西
}

function makeId(project, index, dateStr) {
  const p = String(project || 'global').replace(/[^A-Za-z0-9]/g, '').slice(0, 10) || 'g';
  return `cand-${dateStr}-${p}-${String(index).padStart(3, '0')}`;
}

// ------------------------------------------------------------------ 主流程
function extract(events, opts = {}) {
  const cfg = opts.cfg || require('./config.cjs').load().config;
  const project = opts.project || null;
  const existing = opts.existing || { topLevel: [], auxiliary: [] };
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const out = [];
  const seen = new Set();
  const dropped = { mojibake: 0, boilerplate: 0, content: 0, correction: 0, noCausal: 0, warningOnly: 0 };

  const ev = events.filter((e) => !e.sidechain);
  const bySession = new Map();
  for (const e of ev) {
    if (!bySession.has(e.sessionId)) bySession.set(e.sessionId, []);
    bySession.get(e.sessionId).push(e);
  }

  for (const [sessionId, list] of bySession) {
    const sid = sessionId.slice(0, 8);

    const resultAfter = new Map();
    for (let i = 0; i < list.length; i++) {
      if (list[i].kind !== 'tool_use') continue;
      for (let j = i + 1; j < Math.min(i + 6, list.length); j++) {
        if (list[j].kind === 'tool_result') { resultAfter.set(i, list[j]); break; }
        if (list[j].kind === 'tool_use') break;
      }
    }

    // ---------- R1 用户纠正 ----------
    for (const e of list) {
      if (e.role !== 'user' || e.kind !== 'text') continue;
      const pur = userTextPurity(e.text);                       // ★ E3 来源纯度闸
      if (!pur.pure) { dropped.userImpure = (dropped.userImpure || 0) + 1; continue; }
      const s = sentenceWith(e.text, CORRECTION);
      if (!s || s.length < 8) continue;
      if (!looksLikeCorrection(s)) { dropped.correction++; continue; }
      // ★ N4：裁掉句尾**请求语**（"…应该是 示例中心，先帮我排查下原因" ⇒ 只留经验本体），
      //   并清掉 JSON 尾部残留。经验本体是"被纠正的事实 + 正确答案"，请求语不是经验。
      const hy = require('./hygiene.cjs');
      const cleaned = hy.normalizeCandidate(s, cfg, 'user-correction');
      if (cleaned.length < 8) continue;
      out.push({ signal: 'user-correction', kind: 'correction', weight: 1.0, text: clip(cleaned, 500), evidence: [{ type: 'user', sessionId: sid, ts: e.ts }] });
    }

    // ---------- R2 错误 → 修复（要求因果链）----------
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.kind !== 'tool_result' || !e.text) continue;
      if (hasMojibake(e.text)) { dropped.mojibake++; continue; }
      const head = e.text.slice(0, 1200);
      const urlErr = /<tool_use_error>/.test(head);
      // 警告闸优先：显式 warning + 无显式 error → 直接丢弃（CS#### 会同时命中两类码）
      const isWarningOnly = WARNING_CODE.test(head) && !/\berror\s+(?:CS|BC|CA)\d{4}\b/i.test(head) && !/\bMSB\d{4}\b/.test(head);
      if (isWarningOnly) { dropped.warningOnly++; continue; }
      const hasErr = e.isError || ERROR_SIG.test(head) || ERROR_CODE.test(head);
      if (!hasErr) continue;

      const lines = e.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      // 严格错误行：必须真的像一条错误。取不到就整条放弃——
      // 宁可漏，也不要把 "=== past 6th PAY evidence ===" 这类日志分隔行当错误。
      const errLine = lines.find((l) => STRICT_ERR_LINE.test(l)) || null;
      if (!errLine || hasMojibake(errLine) || errLine.length < 8) { dropped.notAnError = (dropped.notAnError || 0) + 1; continue; }

      const errKeys = keyTokens(errLine);
      // 次要来源：仅当错误行一个关键 token 都取不到时，才退到整段错误文本
      const errKeysAll = errKeys.size === 0 ? keyTokens(e.text.slice(0, 2000)) : new Set();
      const isFileish = (k) => /\.[a-z0-9]{1,6}$/.test(k);
      let fix = null;
      for (let j = i + 1; j < Math.min(i + 14, list.length); j++) {
        const c = list[j];
        if (c.kind !== 'tool_use' || !(c.command || c.filePath)) continue;
        const res = resultAfter.get(j);
        // 判定一个 tool_result 是否"成功"：
        // 先看成功特征（"0 Error(s)" / "Build succeeded" 这类成功消息里也含 Error 字样），
        // 再退回错误特征 —— 否则 .NET 构建成功消息会被误判为失败。
        const resText = res && res.text ? res.text.slice(0, 400) : '';
        const looksSuccess = !!res && !res.isError && SUCCESS_SIG.test(resText);
        const looksError = !!res && (res.isError || (!looksSuccess && (ERROR_SIG.test(resText) || ERROR_CODE.test(resText))));
        const ok = !!res && !looksError;
        if (!ok) continue;
        // ---- 因果闸：修法必须与错误有共同关键 token ----
        const fixKeys = keyTokens(`${c.command || ''} ${c.filePath || ''}`);
        let linked = false;
        for (const k of fixKeys) if (errKeys.has(k)) { linked = true; break; }
        // 次要来源只在「文件名或错误码」级别才算数，避免被 DemoSky 这类领域词连成一片
        if (!linked) for (const k of fixKeys) if (errKeysAll.has(k) && (isFileish(k) || /^(msb|cs|bc|ca)\d{4}$|^ora-|^sqlstate|^e[a-z]{3,}$/.test(k))) { linked = true; break; }
        if (!linked) {
          // 唯一退路：明确的错误码 + 构建/测试类命令 → 认作同一条排查链
          const buildish = /\b(dotnet|msbuild|npm|pnpm|yarn|mvn|gradle|pytest|go build|cargo|make|mysql|psql|mongo)\b/i.test(c.command || '');
          if (ERROR_CODE.test(errLine) && buildish) linked = true;
        }
        if (!linked) { dropped.noCausal++; continue; }
        fix = { action: c.command || `编辑 ${c.filePath}`, path: c.filePath, ts: c.ts };
        break;
      }
      if (!fix) continue;
      out.push({
        signal: 'error-fix', kind: 'gotcha', weight: 1.0,
        text: clip(`遇到：${clip(errLine, 260)}\n修法：${clip(fix.action, 260)}`, 600),
        evidence: [
          { type: 'error', sessionId: sid, ts: e.ts, sample: clip(errLine, 200), keys: [...errKeys].slice(0, 8) },
          { type: 'fix', sessionId: sid, ts: fix.ts, sample: clip(fix.action, 200) },
        ],
      });
    }

    // ---------- R3 反复试错后成功 ----------
    const editCount = new Map();
    for (const e of list) if (e.kind === 'tool_use' && e.filePath && !hasMojibake(e.filePath)) editCount.set(e.filePath, (editCount.get(e.filePath) || 0) + 1);
    for (const [filePath, n] of editCount) {
      if (n < 3) continue;
      let lastIdx = -1;
      for (let i = 0; i < list.length; i++) if (list[i].kind === 'tool_use' && list[i].filePath === filePath) lastIdx = i;
      let okEvidence = null;
      for (let j = lastIdx + 1; j < Math.min(lastIdx + 12, list.length); j++) {
        const c = list[j];
        if (c.kind === 'tool_result' && !c.isError && c.text && !hasMojibake(c.text) && SUCCESS_SIG.test(c.text.slice(0, 400))) { okEvidence = c; break; }
        if (c.kind === 'tool_use' && c.command && !/\b(grep|cat|head|tail|ls|find|echo)\b/.test(c.command)) { okEvidence = c; break; }
      }
      if (!okEvidence) continue;
      out.push({
        signal: 'retry-then-success', kind: 'gotcha', weight: 0.85,
        text: clip(`文件 ${filePath} 经 ${n} 次修改后才通过，最终动作：${clip(okEvidence.command || okEvidence.text, 240)}`, 500),
        evidence: [{ type: 'retry', sessionId: sid, edits: n, path: filePath, sample: clip(okEvidence.command || okEvidence.text || '', 200) }],
      });
    }

    // ---------- R4 环境事实（收紧：结果必须像版本/数值/路径）----------
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (e.kind !== 'tool_use' || !e.command || !PROBE_CMD.test(e.command)) continue;
      const res = resultAfter.get(i);
      if (!res || !res.text || hasMojibake(res.text)) continue;
      const firstLine = res.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
      if (!firstLine || firstLine.length < 2 || firstLine.length > 200) continue;
      if (!/^(?:v?\d[\w.\-+]*|\/|[A-Za-z]:\\|\d{1,3}(?:\.\d{1,3}){1,3}|[A-Za-z0-9_.\-]+\\[A-Za-z0-9_.\-\\]+)$/.test(firstLine)) continue;
      out.push({
        signal: 'env-fact', kind: 'env', weight: 0.6,
        text: clip(`环境事实：\`${clip(e.command, 120)}\` → ${clip(firstLine, 200)}`, 400),
        evidence: [{ type: 'probe', sessionId: sid, ts: e.ts, cmd: clip(e.command, 200) }],
      });
    }

    // ---------- R5 约定/决定 ----------
    // ★ S2+S1：两个来源开关**互相独立**，不能用单一主开关表达。
    //   conventionFromAssistant=false（S2 停用）：助手散文来源——标注基线实测严格精度 23–33% < 40%
    //   conventionFromUser=true（S1 启用）：用户发言来源——用户才是约定的权威，且须过 userTextPurity
    //   若两者都关 → 该信号产出 0 条（主开关 conventionEnabled=false 亦同）
    const sig = cfg.signals || {};
    const convMaster = sig.conventionEnabled !== false;
    const fromAssistant = convMaster && sig.conventionFromAssistant !== false;
    const fromUser = convMaster && !!sig.conventionFromUser;

    if (fromAssistant || fromUser) {
      for (const e of list) {
        if (e.kind !== 'text') continue;
        if (hasMojibake(e.text)) continue;
        const isUser = e.role === 'user';
        const isAssistant = e.role === 'assistant';
        if (!isUser && !isAssistant) continue;
        if (isUser && !fromUser) continue;
        if (isAssistant && !fromAssistant) continue;
        if (isUser) {
          const pur = userTextPurity(e.text);                 // ★ E3 来源纯度闸
          if (!pur.pure) { dropped.userImpure = (dropped.userImpure || 0) + 1; continue; }
        }
        const s = sentenceWith(e.text, DECISION, { withPrev: false });
        if (!s) continue;
        if (!looksLikeConvention(s)) { dropped.conventionNoise = (dropped.conventionNoise || 0) + 1; continue; }
        const convWeight = (cfg.weights && Number.isFinite(cfg.weights.convention)) ? cfg.weights.convention : 0.2;
        out.push({
          signal: 'convention', kind: 'convention', weight: convWeight, text: clip(s, 500),
          evidence: [{ type: isUser ? 'user' : 'assistant', sessionId: sid, ts: e.ts }],
        });
      }
    }
  }

  // ------------------------------------------------------------------ 闸 a0–a2
  const kept = [];
  for (const c of out) {
    const t = c.text || '';
    if (hasMojibake(t)) { dropped.mojibake++; continue; }
    if (isBoilerplate(t)) { dropped.boilerplate++; continue; }
    if (t.length < 12) { dropped.content++; continue; }
    if (/^[\s\\/A-Za-z0-9:._-]+$/.test(t) && t.length < 40) { dropped.content++; continue; }
    if (/^[\[{]/.test(t) && !/[\u4e00-\u9fff]/.test(t)) { dropped.content++; continue; }   // 纯 JSON
    if (/^\s*(```|\{|\[)/.test(t) && t.length < 60) { dropped.content++; continue; }
    if (!/[\u4e00-\u9fff]/.test(t) && !/[a-zA-Z]{4,}/.test(t)) { dropped.content++; continue; }
    const key = t.slice(0, 80);
    if (seen.has(key)) { dropped.content++; continue; }
    seen.add(key);
    kept.push(c);
  }

  // ------------------------------------------------------------------ 闸 b（已知，用重叠系数）
  const existingTokens = [
    ...existing.topLevel.map((f) => ({ file: f.file, scope: 'index', toks: tokenize(f.text) })),
    ...existing.auxiliary.map((f) => ({ file: f.file, scope: 'aux', toks: tokenize(f.text) })),
  ];
  const dupThreshold = (cfg.thresholds && cfg.thresholds.dupOverlap) || 0.60;
  for (const c of kept) {
    const toks = tokenize(c.text);
    c.tokens = toks.size;
    let best = null;
    for (const ex of existingTokens) {
      const ov = overlap(toks, ex.toks);
      if (ov >= dupThreshold && (!best || ov > best.ov)) best = { ov, file: ex.file, scope: ex.scope };
    }
    c.dupOf = best ? { file: best.file, scope: best.scope, overlap: Number(best.ov.toFixed(3)) } : null;
  }

  // ------------------------------------------------------------------ 闸 c（自去重）
  const selfTh = (cfg.thresholds && cfg.thresholds.selfDupJaccard) || 0.75;
  const final = [];
  for (const c of kept) {
    const toks = tokenize(c.text);
    let merged = false;
    for (const f of final) {
      if (f.tokens && f.tokens.size && jaccard(toks, f.tokens) >= selfTh) {
        const richer = c.text.length > f.text.length ? c : f;
        richer.weight = Math.max(c.weight, f.weight);
        richer.evidence = [...f.evidence, ...c.evidence];
        if (richer !== f) Object.assign(f, richer, { tokens: f.tokens });
        merged = true;
        break;
      }
    }
    if (!merged) final.push({ ...c, tokens: toks });
  }

  // ------------------------------------------------------------------ 单类上限（防某一类淹没）
  const caps = (cfg.limits && cfg.limits.maxCandidatesPerSignal) || { 'error-fix': 120, 'env-fact': 60, convention: 60, 'user-correction': 80, 'retry-then-success': 60 };
  const perSignal = {};
  const capped = [];
  for (const c of final.sort((a, b) => b.weight - a.weight)) {
    perSignal[c.signal] = (perSignal[c.signal] || 0) + 1;
    if (caps[c.signal] && perSignal[c.signal] > caps[c.signal]) { dropped.content++; continue; }
    capped.push(c);
  }

  // ------------------------------------------------------------------ 脱敏（整条，含 evidence）+ 编号
  // ★ F2 修复：此前只脱敏 c.text，evidence[].sample 原样落盘
  const redactOpts = {
    sensitiveTerms: (cfg.redact && cfg.redact.sensitiveTerms) || [],
    extraPatterns: (cfg.redact && cfg.redact.extraPatterns) || [],
    redactPrivateIps: !(cfg.redact && cfg.redact.redactPrivateIps === false),
  };
  const result = capped.map((c, i) => {
    // ★ N4：统一清理 JSON 尾部残留（`",` 之类纯噪声），并可选择性还原 `\uXXXX`。
    //   放在脱敏**之前**，保证送去评分的文本与最终入库文本一致。
    const hy = require('./hygiene.cjs');
    const cleanedText = hy.normalizeCandidate(c.text, cfg, c.signal);
    const draft = {
      id: makeId(project, i + 1, dateStr),
      project, signal: c.signal, kind: c.kind, weight: c.weight,
      text: cleanedText, evidence: c.evidence, dupOf: c.dupOf,
      extractedAt: new Date().toISOString(), tokens: c.tokens,
      // 如实标注上游污染（只上报，不改写）——供预览/报告与人工复核使用
      hygiene: hy.scan(cleanedText).polluted ? hy.scan(cleanedText).labels : undefined,
    };
    const r = redactMod.redactDeep(draft, redactOpts);
    return { ...r.value, redactHits: r.hits };
  });
  result.dropped = dropped;
  return result;
}

module.exports = {
  extract, tokenize, jaccard, overlap, keyTokens, hasMojibake, isBoilerplate,
  looksLikeCorrection, looksLikeConvention, userTextPurity, looksLikePastedDoc,
  CORRECTION, DECISION, ERROR_SIG, WARNING_SIG, ERROR_CODE, WARNING_CODE, SUCCESS_SIG, PROBE_CMD,
  CONV_PLAN, CONV_META, CONV_STRONG, CONV_PROGRESS, CONV_NORM, USER_INJECT,
};
