'use strict';
/**
 * proposal.cjs —— 手动梦提案的 schema 与校验器（V2 §5.2 ③）。
 *
 * 设计原则（V2 line 478）：**引擎当裁判、模型当选手、错了给结构化错误**。
 *   "写文件 + 校验重试" 比 "要求模型输出 JSON" 可靠得多 —— 跨宿主无法保证 JSON 模式，
 *   而这套循环在任何模型上都能收敛，且失败可诊断（`{path, expected, got}`）。
 *
 * 本模块**纯校验**：不发网络请求、不写文件、不含任何 LLM 客户端（决策 #6 / M5）。
 * 校验分两层：
 *   1. **形状**：字段是否存在、类型是否正确、枚举是否合法；
 *   2. **可行性/安全性**：源文件是否真的存在、目标路径是否越界（`..` / 绝对路径 /
 *      drive letter）、是否试图改写受保护文件（MEMORY.md 只能通过受控区块碰）。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');

const PROPOSAL_VERSION = 1;

/** 支持的原子操作。`note` 是 no-op，用于记录推理（不产生变更）。 */
const OP_TYPES = [
  'merge',            // 合并多条 → 一条新主题文件（去重 + 语义压缩）
  'dedupe',           // 保留 keep，删除 remove[]
  'resolve-conflict', // 同一主题下矛盾：留 winner，删 loser，并记录理由
  'compress-index',   // 压缩该项目 MEMORY.md 的受控区块（超限时）
  'promote-global',   // 把项目经验提升为全局经验
  'remove',           // 删除单条（慎用；需理由）
  'note',             // 仅记录，无变更
];

const OPS_NEEDING_PROJECT = ['merge', 'dedupe', 'resolve-conflict', 'compress-index', 'remove'];

const isStr = (v) => typeof v === 'string';
const nonEmpty = (v) => isStr(v) && v.trim().length > 0;

/**
 * 目标文件名的安全校验。
 * 拒绝：绝对路径、`..`、盘符、路径分隔符、非 .md、受保护文件名。
 */
function checkFileName(name) {
  if (!nonEmpty(name)) return { ok: false, expected: '非空字符串（.md 文件名，不带路径）', got: JSON.stringify(name) };
  // ⚠️ 顺序要紧：**先查安全性、再查格式**。否则 `../../etc/passwd` 会因为
  //    "不以 .md 结尾"被拒 —— 虽然也拒绝了，但报错指向不了真正的问题（路径穿越），
  //    而结构化错误的价值就在于**精确诊断**。
  if (path.isAbsolute(name)) return { ok: false, expected: '相对文件名（不得为绝对路径）', got: name };
  if (/^[A-Za-z]:/.test(name)) return { ok: false, expected: '非盘符路径', got: name };
  if (name === '.' || name === '..' || name.includes('..')) return { ok: false, expected: '文件名不含 ..（防路径穿越）', got: name };
  if (/[\\/]/.test(name)) return { ok: false, expected: '不含路径分隔符（只能是文件名）', got: name };
  if (name === 'MEMORY.md') return { ok: false, expected: '除 MEMORY.md 之外的文件名（受保护，只能通过受控区块碰）', got: name };
  if (!name.endsWith('.md')) return { ok: false, expected: '以 .md 结尾', got: name };
  return { ok: true };
}

/** 该项目记忆目录下某文件是否存在 */
function projectFileExists(project, name) {
  const p = pathsMod.paths();
  return fs.existsSync(path.join(p.projectsRoot, project, 'memory', name));
}

function globalFileExists(name) {
  const p = pathsMod.paths();
  return fs.existsSync(path.join(p.global, name));
}

/**
 * 校验一份提案。
 * @param {object} prop 提案对象（已 JSON.parse）
 * @param {{cfg?:object}} [opts]
 * @returns {{ok:boolean, errors:Array<{path:string,expected:string,got:string}>, warnings:string[], stats:object}}
 */
function validateProposal(prop, opts = {}) {
  const errors = [];
  const warnings = [];
  const E = (p, expected, got) => errors.push({ path: p, expected, got: String(got) });

  if (!prop || typeof prop !== 'object' || Array.isArray(prop)) {
    E('$', '提案应为对象', Array.isArray(prop) ? 'array' : typeof prop);
    return { ok: false, errors, warnings, stats: {} };
  }
  if (prop.version !== PROPOSAL_VERSION) E('$.version', `数字 ${PROPOSAL_VERSION}`, JSON.stringify(prop.version));
  if (!Array.isArray(prop.ops)) {
    E('$.ops', '数组', typeof prop.ops);
    return { ok: false, errors, warnings, stats: {} };
  }
  if (prop.ops.length === 0) E('$.ops', '至少一个操作', '空数组');
  if (prop.rationale !== undefined && !isStr(prop.rationale)) E('$.rationale', '字符串（可选）', typeof prop.rationale);

  const seenTargets = new Map();   // 防止两个 op 写同一目标
  const stats = { byType: {} };

  prop.ops.forEach((op, i) => {
    const at = `$.ops[${i}]`;
    if (!op || typeof op !== 'object') { E(at, '对象', typeof op); return; }
    if (!nonEmpty(op.op)) { E(`${at}.op`, `枚举 ${OP_TYPES.join('|')}`, JSON.stringify(op.op)); return; }
    if (!OP_TYPES.includes(op.op)) { E(`${at}.op`, `枚举 ${OP_TYPES.join('|')}`, op.op); return; }
    stats.byType[op.op] = (stats.byType[op.op] || 0) + 1;

    const needsProject = OPS_NEEDING_PROJECT.includes(op.op);
    if (needsProject) {
      if (!nonEmpty(op.project)) { E(`${at}.project`, '非空字符串（项目 slug）', JSON.stringify(op.project)); return; }
      const p = pathsMod.paths();
      if (!fs.existsSync(path.join(p.projectsRoot, op.project, 'memory'))) {
        E(`${at}.project`, '存在的项目记忆目录', op.project);
        return;
      }
    }

    if (op.op === 'note') {
      if (!nonEmpty(op.text)) E(`${at}.text`, '非空字符串', JSON.stringify(op.text));
      return;
    }

    if (op.op === 'compress-index') {
      const t = `${op.project}/MEMORY.md#dream`;
      if (seenTargets.has(t)) E(`${at}`, `目标 ${t} 已被 ops[${seenTargets.get(t)}] 占用`, '重复目标');
      else seenTargets.set(t, i);
      return;
    }

    if (op.op === 'remove') {
      const c = checkFileName(op.file);
      if (!c.ok) { E(`${at}.file`, c.expected, c.got); return; }
      if (!projectFileExists(op.project, op.file)) { E(`${at}.file`, '存在于该项目 memory/ 下', op.file); return; }
      if (!nonEmpty(op.why)) warnings.push(`${at}: remove 未给理由（建议补 why）`);
      const t = `${op.project}/${op.file}`;
      if (seenTargets.has(t)) E(`${at}`, `目标 ${t} 已被 ops[${seenTargets.get(t)}] 占用`, '重复目标');
      else seenTargets.set(t, i);
      return;
    }

    if (op.op === 'dedupe' || op.op === 'resolve-conflict') {
      const need = op.op === 'dedupe' ? '非空字符串（保留的文件名）' : '非空字符串（胜出的文件名）';
      const ck = checkFileName(op.keep);
      if (!ck.ok) { E(`${at}.keep`, need, ck.got); return; }
      if (!Array.isArray(op.remove) || op.remove.length === 0) { E(`${at}.remove`, '非空数组（要删除的文件名）', JSON.stringify(op.remove)); return; }
      op.remove.forEach((r, j) => {
        const c = checkFileName(r);
        if (!c.ok) { E(`${at}.remove[${j}]`, c.expected, c.got); return; }
        if (!projectFileExists(op.project, r)) { E(`${at}.remove[${j}]`, '存在于该项目 memory/ 下', r); return; }
        if (r === op.keep) E(`${at}.remove[${j}]`, '不得与 keep 相同', r);
      });
      if (!projectFileExists(op.project, op.keep)) E(`${at}.keep`, '存在于该项目 memory/ 下', op.keep);
      if (op.op === 'resolve-conflict' && !nonEmpty(op.why)) E(`${at}.why`, '非空字符串（矛盾如何裁决的理由，必填）', JSON.stringify(op.why));
      op.remove.forEach((r) => {
        const t = `${op.project}/${r}`;
        if (seenTargets.has(t)) E(`${at}`, `目标 ${t} 已被 ops[${seenTargets.get(t)}] 占用`, '重复目标');
        else seenTargets.set(t, i);
      });
      return;
    }

    if (op.op === 'merge') {
      const ck = checkFileName(op.name);
      if (!ck.ok) { E(`${at}.name`, '新文件名（.md，非 MEMORY.md）', ck.got); return; }
      if (!Array.isArray(op.sources) || op.sources.length < 2) { E(`${at}.sources`, '至少 2 个源文件（合并才有意义）', JSON.stringify(op.sources)); return; }
      op.sources.forEach((s, j) => {
        const c = checkFileName(s);
        if (!c.ok) { E(`${at}.sources[${j}]`, c.expected, c.got); return; }
        if (!projectFileExists(op.project, s)) E(`${at}.sources[${j}]`, '存在于该项目 memory/ 下', s);
      });
      if (op.sources.includes(op.name)) E(`${at}.name`, '不得与任一源文件同名（会自覆盖）', op.name);
      if (!nonEmpty(op.body)) E(`${at}.body`, '非空字符串（合并后的正文）', JSON.stringify(op.body));
      if (!nonEmpty(op.description)) E(`${at}.description`, '非空字符串（一行描述，进索引）', JSON.stringify(op.description));
      if (nonEmpty(op.body) && op.body.length > 8000) warnings.push(`${at}.body 过长（${op.body.length} 字符），建议压缩`);
      const t = `${op.project}/${op.name}`;
      if (seenTargets.has(t)) E(`${at}`, `目标 ${t} 已被 ops[${seenTargets.get(t)}] 占用`, '重复目标');
      else seenTargets.set(t, i);
      if (!new Set(op.sources).size || new Set(op.sources).size !== op.sources.length) warnings.push(`${at}.sources 有重复项`);
      return;
    }

    if (op.op === 'promote-global') {
      const ck = checkFileName(op.name);
      if (!ck.ok) { E(`${at}.name`, '全局文件名（.md）', ck.got); return; }
      if (globalFileExists(op.name)) E(`${at}.name`, '全局目录下尚不存在同名文件', op.name);
      if (!op.from || typeof op.from !== 'object') { E(`${at}.from`, '{project, file}', JSON.stringify(op.from)); return; }
      if (!nonEmpty(op.from.project)) E(`${at}.from.project`, '非空字符串', JSON.stringify(op.from.project));
      const cf = checkFileName(op.from.file);
      if (!cf.ok) { E(`${at}.from.file`, cf.expected, cf.got); return; }
      else if (!projectFileExists(op.from.project, op.from.file)) E(`${at}.from.file`, '存在于该项目 memory/ 下', op.from.file);
      if (!nonEmpty(op.body)) E(`${at}.body`, '非空字符串（全局经验正文）', JSON.stringify(op.body));
      if (!nonEmpty(op.description)) E(`${at}.description`, '非空字符串', JSON.stringify(op.description));
      const t = `global/${op.name}`;
      if (seenTargets.has(t)) E(`${at}`, `目标 ${t} 已被 ops[${seenTargets.get(t)}] 占用`, '重复目标');
      else seenTargets.set(t, i);
      return;
    }
  });

  return { ok: errors.length === 0, errors, warnings, stats };
}

module.exports = { PROPOSAL_VERSION, OP_TYPES, validateProposal, checkFileName };
