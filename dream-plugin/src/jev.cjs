'use strict';
/**
 * jev.cjs —— Jev（TypeSafe System One）客户端。
 *
 * 契约要点（来自用户实测笔记 + 官方 API 文档核对）：
 *   · POST https://api.typesafe.ai/v1/systemone，Authorization: Bearer <key>
 *   · body: { model, state(顶层共享), questions: { qid: {type, instructions, criteria} } }
 *   · questions 是**字典 keyed by qid**（不是数组）；每个 question 必须有 `type`
 *   · 问题文本放 `instructions` —— **没有独立的 question 字段**
 *   · **Score 的 criteria 是有序数组（2–10 级）；Choice 的 criteria 是字典**
 *   · 响应 noul 无 confidence（字段名就是 `noul`）；Choice/Score 有 confidence
 *   · 编码：用 Node fetch + Buffer(utf8)，**绝不经 shell/curl**（避免 GBK 损坏）
 *
 * 出网前置（V2 §8.2）：payload 先过 redactDeep，再写审计到 logs/redacted/。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const configMod = require('./config.cjs');
const redactMod = require('./redact.cjs');

// ------------------------------------------------------------------ 密钥
function readApiKey(cfg) {
  const src = (cfg.jev && cfg.jev.keySource) || 'settings:TYPESAFE_API_KEY';
  const [where, name] = src.split(':');
  if (where === 'settings') {
    const f = path.join(pathsMod.claudeHome(), 'settings.json');
    try {
      const raw = fs.readFileSync(f, 'utf8');
      const j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      const v = (j.env || {})[name];
      if (v) return { ok: true, key: String(v), from: `${f}#env.${name}` };
    } catch (e) { return { ok: false, reason: 'settings-read-failed', error: e.message }; }
    return { ok: false, reason: `not-found: ${name}` };
  }
  if (where === 'env') {
    const v = process.env[name];
    return v ? { ok: true, key: v, from: `env:${name}` } : { ok: false, reason: `env ${name} 未设置` };
  }
  return { ok: false, reason: `未知 keySource: ${src}` };
}

// ------------------------------------------------------------------ 请求构造
const QUESTIONS = (qid, text) => ({
  [`${qid}.reusable`]: {
    type: 'noul',
    instructions: `\`candidates.${qid}.text\` 描述的经验，是否可复用于未来任务（而非只在当时那一次成立）？`,
  },
  [`${qid}.nontrivial`]: {
    type: 'noul',
    instructions: `这条经验（\`candidates.${qid}.text\`）是否无法通过重新阅读代码库或公开文档直接推导出来？`,
  },
  // ★ 实测修复（P2 前置）：原 `still_true` 问的是"是否与 state.codebaseDigest 一致"，
  //   但 digest 目前只是项目的记忆索引（不含代码现状）⇒ 该问题不具可答性，
  //   实测 112 条答案全部钉在 0.52（抛硬币），硬门槛恒不通过。
  //   改为**自足**问法：只看候选本身能否判断它是"稳定事实"还是"时效性细节"。
  //   语义仍对应"这条还站得住吗"，但不再依赖外部 digest。
  //   TODO(P2)：真正的 still_true 需要构建真实 codebaseDigest（扫仓库结构+近期变更）。
  [`${qid}.still_true`]: {
    type: 'noul',
    instructions: `\`candidates.${qid}.text\` 描述的是否是一个**稳定的事实或规则**（而不是依赖具体日期、一次性单号、临时环境状态等时效性细节，因而很快就会失效）？`,
  },
  [`${qid}.durability`]: {
    type: 'score',
    instructions: `\`candidates.${qid}.text\` 这条经验的适用范围如何？`,
    // ★ 有序数组，2–10 级，从低到高；级别描述必须是**情境**而非程度，且不写序号
    criteria: [
      '只在遇到它的那一次任务中成立',
      '在同一个项目中反复成立',
      '在同类项目之间通用',
      '跨技术领域通用',
    ],
  },
  [`${qid}.kind`]: {
    type: 'choice',
    instructions: `\`candidates.${qid}.text\` 这条经验属于哪一类？`,
    // ★ 字典：选项 → 描述
    criteria: {
      gotcha: '踩坑与陷阱',
      convention: '约定与风格',
      arch: '架构与设计决定',
      command: '可复用命令',
      env: '环境事实',
      none: '都不属于',
    },
  },
  // ★ P2：给 `codebaseDigest` 一个**真正的消费者**。
  //   此前 digest 出现在每个请求里却没有任何问题引用它 —— 纯 token 成本、零作用。
  //   `dupOverlap` 只能查**字面**重复，查不出"同一事实换了说法"，本问题补这一层**语义**查重。
  //   注意：与 `still_true` 不同，本问题**故意**依赖 digest，故 digest 必须真实可用
  //   （见 buildDigest）。
  [`${qid}.known`]: {
    type: 'noul',
    instructions: `\`candidates.${qid}.text\` 描述的经验，是否**已经**被 \`codebaseDigest\` 中列出的既有记忆覆盖？（同一事实／同一约定／同一个坑即算覆盖，仅仅主题相近不算）`,
  },
});

/**
 * 构造项目的极简 digest —— `known`（语义查重）问题的**唯一依据**。
 *
 * ⚠️ 本函数**不脱敏**，脱敏由 `buildRequest` 统一执行。
 *    此前注释误写"（会脱敏）"而实现里没有 —— 后果是 digest 以**明文**出网，
 *    实测 23 个项目中 3 个含需脱敏内容（`password: 123456` 明文凭据、
 *    `192.168.1.99` 内网 IP、2 个绝对路径）。V2 §8.2 line 666 明文要求
 *    "凡进入 `state` 的字符串无一例外过此流水线"，digest 同样出网。
 *
 * ★ P2 重建：旧版只截取 MEMORY.md 前 20 个非空行（900 字符），信息量不足以判断
 *   "这条经验是否已被覆盖"。新版给出三部分：
 *     1) `existing-memory`：MEMORY.md 的全部条目行（标题 + 描述），这是查重的主依据
 *     2) `memory-files`：memory/ 目录下的主题文件名（去扩展名），作为主题线索
 *     3) 条目/文件计数，帮助 Jev 感知项目记忆规模
 *   全部内容按 `maxChars` 截断；截断时保留头部（条目行比文件列表更有信息量）。
 */
function buildDigest(projectSlug, { maxChars = 1400, maxEntries = 60, entryMaxChars = 110 } = {}) {
  const p = pathsMod.paths();
  const memDir = path.join(p.projectsRoot, projectSlug, 'memory');
  const idx = path.join(memDir, 'MEMORY.md');

  // 1) 条目行：去掉原有的列表前缀（索引行本身就是 `- [..](..) — ..`，
  //    若再拼一个 `- ` 会得到 `- - [..]`），压平空白，单条限长
  const entryLines = [];
  if (fs.existsSync(idx)) {
    try {
      for (const raw of fs.readFileSync(idx, 'utf8').split(/\r?\n/)) {
        let t = raw.trim();
        if (!t || t.startsWith('#') || /^<!--/.test(t)) continue;
        t = t.replace(/^[-*]\s+/, '').replace(/\s+/g, ' ').trim();
        if (!t) continue;
        if (t.length > entryMaxChars) t = `${t.slice(0, entryMaxChars)}…`;
        entryLines.push(`- ${t}`);
        if (entryLines.length >= maxEntries) break;
      }
    } catch { /* 索引读取失败时降级为仅文件列表 */ }
  }

  // 2) 主题文件名
  let files = [];
  try {
    files = fs.readdirSync(memDir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md')
      .map((f) => f.replace(/\.md$/, ''));
  } catch { /* 目录不存在 */ }

  if (!entryLines.length && !files.length) return `project: ${projectSlug}\n(无既有记忆)`;

  // 3) 在预算内贪心装入条目；文件列表只用**剩余**预算，故先给条目保底
  const head = `project: ${projectSlug}`;
  const filesLine = files.length ? `memory-files (${files.length}): ${files.join(', ')}` : '';
  const reserveForFiles = Math.min(260, Math.floor(maxChars * 0.2));
  const entryBudget = maxChars - head.length - reserveForFiles - 80;   // 80 = 表头/换行余量

  const shown = [];
  let used = 0;
  for (const e of entryLines) {
    if (used + e.length + 1 > entryBudget) break;
    shown.push(e); used += e.length + 1;
  }

  const parts = [head];
  const truncatedNote = shown.length < entryLines.length
    ? `（共 ${entryLines.length} 条，此处显示前 ${shown.length} 条）` : '';
  parts.push(`existing-memory (${entryLines.length})${truncatedNote}:`);
  parts.push(...shown);

  if (filesLine) {
    const left = maxChars - parts.join('\n').length - 1;
    if (left > 20) parts.push(filesLine.length <= left ? filesLine : `${filesLine.slice(0, left - 1)}…`);
  }
  return parts.join('\n').slice(0, maxChars);
}

/**
 * 归一化 egress 三档（V2 §8.2）：`off` | `redacted` | `raw`。
 * 未知值/缺失一律降级为**最保守**的 `redacted`（绝不因配置写错而放宽）。
 */
function egressOf(cfg) {
  const v = cfg && cfg.egress;
  return (v === 'off' || v === 'raw') ? v : 'redacted';
}

/**
 * 构造 Jev 请求。candidates 与 codebaseDigest 都会被脱敏
 * （防御性：候选入库时已脱敏一次；digest 此前完全没脱敏）。
 * @returns {{payload:object, idMap:object, egressHits:object, egressMode:string}}
 */
function buildRequest(candidates, { project = null, cfg, noDigest = false } = {}) {
  const c = cfg || configMod.load().config;
  const egressMode = egressOf(c);
  const redactOpts = {
    sensitiveTerms: (c.redact && c.redact.sensitiveTerms) || [],
    extraPatterns: (c.redact && c.redact.extraPatterns) || [],
    redactPrivateIps: !(c.redact && c.redact.redactPrivateIps === false),
  };

  const state = { candidates: {} };
  const idMap = {};
  const egressHits = {};
  const maxChars = (c.jev && Number.isFinite(c.jev.egressMaxChars)) ? c.jev.egressMaxChars : 400;
  candidates.forEach((cand, i) => {
    const qid = `c${i}`;
    idMap[qid] = cand.id;
    // raw：显式放弃脱敏（危险档，仅用于排障）
    const r = egressMode === 'raw'
      ? { value: { text: cand.text, project: cand.project, signal: cand.signal }, hits: {} }
      : redactMod.redactDeep({
        text: cand.text,
        project: cand.project,
        signal: cand.signal,
      }, redactOpts);
    for (const [k, v] of Object.entries(r.hits)) egressHits[k] = (egressHits[k] || 0) + v;
    // ★ 出网净化：脱敏之后再折叠 heredoc/内联脚本/长管道，并截断
    state.candidates[qid] = { text: sanitizeForEgress(r.value.text, { maxChars }), signal: r.value.signal };
  });

  // ★ V2 §8.2：digest 与候选同属 `state`，必须过同一条流水线。
  //   它含 MEMORY.md 的索引行（标题 + 文件名 + 摘要），实测会夹带明文凭据与内网 IP。
  //   `noDigest` 是 403 兜底路径：digest 出现在**每个**请求里（含 n=1），
  //   若它含 WAF 指纹则该项目全部评分被拦，拆批绕不过 —— 清空它重试可区分
  //   "digest 触发"与"候选内容触发"。
  const digestProject = project || (candidates[0] && candidates[0].project) || '(unknown)';
  let digest = noDigest ? '' : buildDigest(digestProject, {
    maxChars: (c.jev && Number.isFinite(c.jev.digestMaxChars)) ? c.jev.digestMaxChars : 2600,
    entryMaxChars: (c.jev && Number.isFinite(c.jev.digestEntryMaxChars)) ? c.jev.digestEntryMaxChars : 120,
  });
  if (egressMode !== 'raw') {
    const dr = redactMod.redactDeep({ text: digest, project: digestProject, signal: 'codebaseDigest' }, redactOpts);
    for (const [k, v] of Object.entries(dr.hits)) egressHits[k] = (egressHits[k] || 0) + v;
    digest = dr.value.text;
  }
  state.codebaseDigest = digest;

  const questions = {};
  candidates.forEach((_, i) => Object.assign(questions, QUESTIONS(`c${i}`)));

  return {
    payload: { model: c.jev.model, state, questions },
    idMap, egressHits, egressMode,
  };
}

// ------------------------------------------------------------------ 调用
function auditPayload(payload, tag) {
  const p = pathsMod.paths();
  try {
    fs.mkdirSync(p.redacted, { recursive: true });
    const f = path.join(p.redacted, `${tag}.json`);
    fs.writeFileSync(f, JSON.stringify(payload, null, 2), 'utf8');
    return f;
  } catch { return null; }
}

/**
 * 调用 Jev。429/529 指数退避；超时用 AbortController。
 * @returns {{ok:boolean, status:number, latencyMs:number, body:object|null, tokensIn:number, tokensOut:number, model:string|null, error?:string, attempts:number}}
 */
async function callJev(payload, { cfg, tag = 'jev' } = {}) {
  const c = cfg || configMod.load().config;
  // ★ 硬开关（V2 §8.2）：`off` 时只采集不评分。放在**唯一的 fetch 点**上，
  //   任何调用路径（含未来新接线）都无法绕过。此前该开关零 enforcement ——
  //   配置成 off 仍会把候选发往 api.typesafe.ai。
  if (egressOf(c) === 'off') {
    return {
      ok: false, status: 0, error: 'egress-off', blockedByEgress: true,
      attempts: 0, latencyMs: 0, body: null, tokensIn: 0, tokensOut: 0, model: null,
    };
  }
  const keyInfo = readApiKey(c);
  if (!keyInfo.ok) return { ok: false, status: 0, error: keyInfo.reason, attempts: 0, latencyMs: 0, body: null, tokensIn: 0, tokensOut: 0, model: null };

  const endpoint = c.jev.endpoint;
  const retryOn = (c.jev.retry && c.jev.retry.on) || [429, 529];
  const maxRetry = (c.jev.retry && c.jev.retry.max) || 3;
  const baseDelay = (c.jev.retry && c.jev.retry.baseDelayMs) || 800;
  const timeoutMs = c.jev.timeoutMs || 10000;

  const body = Buffer.from(JSON.stringify(payload), 'utf8');   // ★ 显式 UTF-8，不经 shell
  let attempts = 0;
  let lastErr = null;
  const t0 = Date.now();

  while (attempts <= maxRetry) {
    attempts++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keyInfo.key}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body,
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* 非 JSON */ }

      if (retryOn.includes(res.status) && attempts <= maxRetry) {
        const wait = baseDelay * Math.pow(2, attempts - 1);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      return {
        ok: res.status === 200 && !!parsed && !!parsed.answers,
        status: res.status,
        latencyMs: Date.now() - t0,
        body: parsed,
        raw: res.status === 200 ? undefined : text.slice(0, 400),
        tokensIn: (parsed && parsed.usage && parsed.usage.input_tokens) || 0,
        tokensOut: (parsed && parsed.usage && parsed.usage.output_tokens) || 0,
        model: (parsed && parsed.model) || null,
        attempts,
        keyFrom: keyInfo.from,
      };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? `timeout(${timeoutMs}ms)` : e.message;
      if (attempts <= maxRetry) { await new Promise((r) => setTimeout(r, baseDelay * attempts)); continue; }
    }
  }
  return { ok: false, status: 0, latencyMs: Date.now() - t0, body: null, tokensIn: 0, tokensOut: 0, model: null, attempts, error: lastErr };
}

// ------------------------------------------------------------------ 打分
const WEIGHTS_DEFAULT = { reusable: 0.30, nontrivial: 0.25, still_true: 0.25, durability: 0.20, noneKindPenalty: 0.15 };

/**
 * 由 Jev answers 计算复合分数（V2 §4.4；归一化 = 官方 `len(criteria)-1`）。
 * @returns {{ok:boolean, score:number, n:{}, kind:string, passHardGates:boolean, reason?:string}}
 */
function compositeScore(answers, qid, { cfg } = {}) {
  const c = cfg || configMod.load().config;
  const cw = { ...WEIGHTS_DEFAULT, ...(c.weights || {}) };
  const g = (k) => answers && answers[`${qid}.${k}`];
  const reusable = g('reusable');
  const nontrivial = g('nontrivial');
  const stillTrue = g('still_true');
  const dur = g('durability');
  const kind = g('kind');
  if (!reusable || !nontrivial || !stillTrue || !dur || !kind) return { ok: false, reason: 'missing-answer', score: 0 };
  if (reusable.type !== 'noul' || dur.type !== 'score' || kind.type !== 'choice') return { ok: false, reason: 'unexpected-answer-type', score: 0 };

  const nReusable = reusable.noul;
  const nNontrivial = nontrivial.noul;
  const nStillTrue = stillTrue.noul;
  const durTop = 3;                                  // criteria 4 级 → /3
  const nDur = Math.min(1, Math.max(0, dur.score / durTop));
  const noneKind = kind.choice === 'none' ? 1 : 0;

  // ★ P2 新增 `known`（语义查重）。刻意**不**列入上面的 missing-answer 检查：
  //   这是 P2 才加的问题，P2 之前保存的结果文件里没有该答案，若计入缺失检查
  //   会让全部历史结果瞬间失效（诊断脚本、标定数据全会崩）。
  //   缺失时 nKnown = null ⇒ 闸门跳过（向后兼容），并在返回值里如实标注。
  const known = g('known');
  const nKnown = (known && known.type === 'noul' && Number.isFinite(known.noul)) ? known.noul : null;

  let score = cw.reusable * nReusable + cw.nontrivial * nNontrivial + cw.still_true * nStillTrue
    + cw.durability * nDur - cw.noneKindPenalty * noneKind;

  const gates = c.gates || { stillTrueMin: 0.8, reusableMin: 0.7 };
  const passHardGates = nStillTrue >= gates.stillTrueMin && nReusable >= gates.reusableMin;

  // 已被既有记忆覆盖 ⇒ 不得作为"新经验"提升。用**闸门**而不是扣分：
  // 扣分会平移全部分数、使刚标定好的阈值分布失效；闸门只筛掉重复项。
  const knownRejectMin = Number.isFinite(gates.knownRejectMin) ? gates.knownRejectMin : 0.75;
  const knownEnabled = gates.knownReject !== false;
  const alreadyKnown = knownEnabled && nKnown !== null && nKnown >= knownRejectMin;

  return {
    ok: true, score: Number(score.toFixed(4)), passHardGates, alreadyKnown,
    n: {
      reusable: nReusable, nontrivial: nNontrivial, still_true: nStillTrue,
      durability: Number(nDur.toFixed(3)), durabilityRaw: dur.score, known: nKnown,
    },
    kind: kind.choice,
    conf: { durability: dur.confidence, kind: kind.confidence, known: known ? known.confidence : null },
    knownRejectMin,
  };
}

/** 从响应抽出逐候选结果 */
function parseAnswers(resp, idMap, { cfg } = {}) {
  const out = [];
  if (!resp || !resp.answers) return out;
  for (const [qid, candId] of Object.entries(idMap)) {
    const s = compositeScore(resp.answers, qid, { cfg });
    out.push({ qid, candId, ...s });
  }
  return out;
}

/**
 * 请求形状预检（在花钱之前挡住 422）。
 * 逐条核对官方契约：questions 为字典 / 每题有 type / Score.criteria 是数组 /
 * Choice.criteria 是字典 / 无多余 question 字段 / state 在顶层。
 */
function validateShape(payload) {
  const errs = [];
  const warns = [];
  if (!payload || typeof payload !== 'object') return { ok: false, errs: ['payload 非对象'], warns };
  if (typeof payload.model !== 'string' || !payload.model) errs.push('model 缺失');
  if (!payload.state || typeof payload.state !== 'object') errs.push('state 缺失或非对象');
  if (!payload.questions || typeof payload.questions !== 'object' || Array.isArray(payload.questions)) {
    errs.push('questions 必须是**字典**（非数组）');
    return { ok: false, errs, warns };
  }

  let n = 0;
  for (const [qid, q] of Object.entries(payload.questions)) {
    n++;
    if (!q || typeof q !== 'object') { errs.push(`${qid}: question 非对象`); continue; }
    if (!['noul', 'choice', 'score'].includes(q.type)) errs.push(`${qid}: type 非法或缺失 (${q.type})`);
    if (typeof q.instructions !== 'string' && typeof q.instructions !== 'object') errs.push(`${qid}: instructions 缺失`);
    if ('question' in q) errs.push(`${qid}: 出现多余的 question 字段（问题文本应放 instructions）`);
    if (q.type === 'score') {
      if (!Array.isArray(q.criteria)) errs.push(`${qid}: Score.criteria 必须是**有序数组**`);
      else if (q.criteria.length < 2 || q.criteria.length > 10) errs.push(`${qid}: Score.criteria 级数=${q.criteria.length}（须 2–10）`);
    }
    if (q.type === 'choice') {
      if (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria)) errs.push(`${qid}: Choice.criteria 必须是**字典**`);
    }
    if (q.type === 'noul' && q.criteria !== undefined) {
      if (typeof q.criteria !== 'object' || Array.isArray(q.criteria)) errs.push(`${qid}: Noul.criteria 必须是对象 {true,false}`);
    }
  }
  if (n === 0) warns.push('questions 为空');
  return { ok: errs.length === 0, errs, warns, questionCount: n };
}

// ------------------------------------------------------------------ 出网净化
/**
 * 出网净化（实测驱动）。
 *
 * 背景：真实调用曾稳定 403（Cloudflare 拦截页）。二分定位结论：
 *   · 与体积无关（17.5KB 无害中文 200；300 个问题 29.5KB 200）
 *   · 与题量无关（10/40/100/300 题全部 200）
 *   · 单条候选即可触发 ⇒ **内容签名**
 *   · 精确触发点是形如 `; python -X utf8 - <<'PYEOF'` 的组合
 *     （`;` + `python -X utf8` + heredoc）—— 属 WAF 的**命令注入/利用指纹**类规则
 *
 * 不能靠"猜规则"规避（候选里满是 shell 命令，签名会反复出现）。
 * 故本函数只做**低成本、不伤语义**的归一化，真正的兜底是 callAdaptive 的 403 自适应拆批。
 */
function sanitizeForEgress(text, { maxChars = 400 } = {}) {
  let t = String(text == null ? '' : text);
  // 1) ★ 整个内联脚本构造 → 中性标记。
  //    此前只折叠 heredoc **体**，却把 `python -X utf8 <<'EOF'` 这个**指纹本身**
  //    完好保留（实测 cand-108 净化后仍是 `环境事实：`python -X utf8 <<'EOF' …EOF`，
  //    n=1 仍被 403）。根本修法是把 `解释器 + 选项 + <<` 整段抹掉。
  t = t.replace(
    /\b(python[0-9.]*|perl|ruby|node|sh|bash|zsh|powershell|pwsh)\s+(?:-[A-Za-z]+\s+\S+\s+)*(?:-\s+)?<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[\s\S]*?(?:\n\3\b|$)/gi,
    '[内联脚本]',
  );
  // 2) 残留的 `<<'EOF'` / `<<EOF`（无解释器前缀，或规则 1 未匹配到的形态）：
  //    **连同 heredoc 体一起**抹掉 —— 只换标记而留下体，等于把脚本正文原样出网
  //    （L16 测试抓到过：`python3 -X utf8 - <<'PYEOF'` 的体被留在了明文里）。
  t = t.replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[\s\S]*?(?:\n\2\b|$)/g, '<<…');
  // 3) 折叠内联脚本调用（python/perl/ruby + 选项 + 从 stdin 读）
  t = t.replace(/\b(python[0-9.]*|perl|ruby|node)\s+(?:-[XW]\s+\S+\s+)?-\s*<</gi, '$1 … <<');
  // 4) ★ 凭据赋值形态折叠：`password=…` / `user=…` 这类 `关键词=` 是注入类指纹的常见标记，
  //    且脱敏占位符 `[REDACTED]` 的方括号会让它更像 payload（实测 cand-056）。
  t = t.replace(/\b(password|passwd|pwd|secret|token|apikey|api_key)\s*=\s*\S*/gi, '$1=***');
  // 5) 折叠长管道链（保留首个命令）
  t = t.replace(/(\|\s*(?:head|tail|grep|awk|sed|sort|uniq|wc|cut|xargs)\b[^|;\n]*)(\s*[;|]\s*(?:head|tail|grep|awk|sed|sort|uniq|wc|cut|xargs)\b[^|;\n]*)+/gi, '$1 | …');
  // 6) 截断
  if (t.length > maxChars) t = `${t.slice(0, maxChars)}…`;
  return t;
}

/**
 * 自适应调用：按 `jev.batchSize` **分块**，每块内遇可拆状态码就对半拆批重试；
 * n=1 仍失败则判该条 blocked（记档，不静默丢）。
 *
 * ★ P2 实测修的两个真 bug（由端到端运行暴露，代价是一次全量打分丢失 126/153）：
 *   1. `jev.batchSize` 此前是**死配置** —— 全库无人读它，整个候选列表被一次性发出。
 *      实测 n=111 直接返回 **HTTP 400**，一次性废掉全部 111 条。
 *   2. 拆分只在 `status === 403` 时触发，而实测触发的是 **400**（网关体积/请求类），
 *      于是"非 403 不拆批"的分支把整批判死。现改为可配置的 `jev.splitOn` 集合。
 *
 * @returns {{ok, results:Array, blocked:Array, batches:Array, tokensIn, tokensOut, latencyMs, calls, model}}
 */
async function callAdaptive(candidates, { cfg, tag = 'jev', onNote = null, maxDepth = 8 } = {}) {
  const results = [];
  const blocked = [];
  const batches = [];
  let tokensIn = 0; let tokensOut = 0; let calls = 0; let model = null;
  const t0 = Date.now();
  const c = cfg || configMod.load().config;

  const note = (m) => { if (typeof onNote === 'function') onNote(m); };

  // ★ egress=off：只采集不评分（V2 §8.2）。候选记为 **deferred（留在池中）**
  //   而不是 blocked —— 否则会被误记成"评分不通过"，污染 P5 回放数据。
  if (egressOf(c) === 'off') {
    note('  egress=off → 跳过评分（本地攒候选，不发起任何出网请求）');
    return {
      ok: false, reason: 'egress-off', results: [], blocked: [],
      deferred: candidates.map((x) => x.id),
      batches: [], tokensIn: 0, tokensOut: 0, latencyMs: 0, calls: 0, model: null,
    };
  }

  const batchSize = (c.jev && Number.isFinite(c.jev.batchSize) && c.jev.batchSize > 0) ? c.jev.batchSize : 32;
  // 可拆（而非直接判死）的状态码。400 是实测的网关体积类响应，必须可拆。
  const SPLIT_DEFAULT = [400, 403, 413, 414, 431, 500, 502, 503, 504];
  const splitOn = new Set((c.jev && Array.isArray(c.jev.splitOn)) ? c.jev.splitOn : SPLIT_DEFAULT);
  const maxBatches = (c.limits && Number.isFinite(c.limits.maxJevBatchesPerRun)) ? c.limits.maxJevBatchesPerRun : Infinity;
  // ★ 关于 403 成因的实测结论（勿再走弯路）：
  //   曾假设"连续大请求触发限流"，加块间/拆批延时 —— **实测完全无效**：
  //   两次运行调用次数与失败条目逐字一致，故失败是**内容确定性**的。
  //   延时键位默认 0，仅在将来确有限流证据时再启用。
  const chunkDelayMs = (c.jev && Number.isFinite(c.jev.chunkDelayMs)) ? c.jev.chunkDelayMs : 0;
  const splitDelayMs = (c.jev && Number.isFinite(c.jev.splitDelayMs)) ? c.jev.splitDelayMs : 0;
  const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

  async function attempt(list, depth, { noDigest = false } = {}) {
    if (!list.length) return;
    const { payload, idMap } = buildRequest(list, { project: list[0].project, cfg: c, noDigest });
    const shape = validateShape(payload);
    if (!shape.ok) { for (const x of list) blocked.push({ id: x.id, reason: 'shape-invalid', errs: shape.errs }); return; }

    const r = await callJev(payload, { cfg: c, tag: `${tag}-n${list.length}${noDigest ? '-nodigest' : ''}` });
    calls++;
    tokensIn += r.tokensIn; tokensOut += r.tokensOut;
    if (r.model) model = r.model;

    if (r.ok) {
      const per = parseAnswers(r.body, idMap, { cfg: c })
        .map((x) => ({ ...x, signal: (list.find((y) => y.id === x.candId) || {}).signal }));
      results.push(...per);
      batches.push({ n: list.length, status: r.status, noDigest, latencyMs: r.latencyMs, tokensIn: r.tokensIn, answers: per.filter((x) => x.ok).length });
      note(`  n=${String(list.length).padStart(3)} ✓ ${r.latencyMs}ms in=${r.tokensIn} 答案=${per.filter((x) => x.ok).length}${noDigest ? '（清空 digest 后成功）' : ''}`);
      return;
    }

    // 不可拆的状态（鉴权/形状类）：整批记 blocked，拆了也没用
    if (!splitOn.has(r.status)) {
      batches.push({ n: list.length, status: r.status, error: r.error || (r.raw || '').slice(0, 80) });
      note(`  n=${String(list.length).padStart(3)} ✗ status=${r.status} ${(r.error || '').slice(0, 60)}（不可拆）`);
      for (const x of list) blocked.push({ id: x.id, reason: `http-${r.status}` });
      return;
    }

    const isWaf = r.status === 403;

    // ★ 单条兜底（核验清单 #7）：digest 出现在每个请求里（含 n=1），若它是触发源，
    //   拆批永远绕不过。故单条失败时**清空 digest 重试一次**，既可能救回候选，
    //   又能把"digest 触发"与"候选内容触发"区分开（诊断价值）。
    if (list.length === 1 && !noDigest && r.status === 403) {
      note(`  n=  1 ☁️ 403 → 清空 digest 重试（区分 digest 与候选内容）`);
      await attempt(list, depth, { noDigest: true });
      return;
    }

    if (list.length === 1 || depth >= maxDepth) {
      blocked.push({ id: list[0].id, reason: isWaf ? 'waf-403-single' : `http-${r.status}-single`, signal: list[0].signal });
      batches.push({ n: list.length, status: r.status, blocked: list.map((x) => x.id) });
      note(`  n=${String(list.length).padStart(3)} ${isWaf ? '☁️' : '✗'} ${r.status} → 单条仍失败（含清空 digest 后），记 blocked（不静默丢）`);
      return;
    }
    const mid = Math.floor(list.length / 2);
    note(`  n=${String(list.length).padStart(3)} ${isWaf ? '☁️' : '✗'} ${r.status} → 拆为 ${mid} + ${list.length - mid}${splitDelayMs ? `（先等 ${splitDelayMs}ms）` : ''}`);
    batches.push({ n: list.length, status: r.status, splitInto: [mid, list.length - mid] });
    await sleep(splitDelayMs);
    await attempt(list.slice(0, mid), depth + 1, { noDigest });
    await attempt(list.slice(mid), depth + 1, { noDigest });
  }

  // ★ 分块：`batchSize` 是**实测标定过的**安全批大小（配置里默认 32），此前完全没生效。
  //   `maxJevBatchesPerRun` 只约束**主动分块**数，不含错误恢复引发的拆批
  //   （否则一次 WAF 抖动就会耗尽预算、把剩余候选全部判死）。
  //
  // ★ 另按**请求体积**分块（实测驱动）：n=96 → payload 161,982 B 单次 200；
  //   n=112 → 188,447 B 单次 **400**。即网关限制是**体积**（约 165–188 KB）而非候选个数，
  //   故个数上限不足以保证安全（长候选会让体积爆掉）。用实测二元点标定：
  //   bytes ≈ 3200 + 1654×n（每候选约 1.65 KB，主要是 6 道题的题面开销）。
  const maxBatchBytes = (c.jev && Number.isFinite(c.jev.maxBatchBytes)) ? c.jev.maxBatchBytes : 150000;
  const estBytesPerCand = 1700;   // 略高于实测 1654，留余量
  const estFixedBytes = 3600;

  let chunks = 0;
  let i = 0;
  while (i < candidates.length) {
    if (chunks >= maxBatches) {
      const rest = candidates.slice(i);
      note(`  ⚠️ 已达 maxJevBatchesPerRun=${maxBatches}，剩余 ${rest.length} 条本轮不打分（下一轮继续）`);
      for (const x of rest) blocked.push({ id: x.id, reason: 'batch-budget-exhausted' });
      break;
    }
    // 按个数与**估算体积**双重约束决定本块大小
    let take = Math.min(batchSize, candidates.length - i);
    const budgetByBytes = Math.max(1, Math.floor((maxBatchBytes - estFixedBytes) / estBytesPerCand));
    take = Math.min(take, budgetByBytes);
    chunks++;
    if (chunks > 1) await sleep(chunkDelayMs);   // 避免连续大请求触发限流
    await attempt(candidates.slice(i, i + take), 0);
    i += take;
  }

  return { ok: results.length > 0, results, blocked, batches, tokensIn, tokensOut, latencyMs: Date.now() - t0, calls, model, chunks };
}

module.exports = {
  readApiKey, buildRequest, callJev, auditPayload, validateShape,
  sanitizeForEgress, callAdaptive, egressOf,
  compositeScore, parseAnswers, buildDigest, QUESTIONS, WEIGHTS_DEFAULT,
};
