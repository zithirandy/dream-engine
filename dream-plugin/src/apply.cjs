'use strict';
/**
 * apply.cjs —— 手动梦提案的**计划与执行**（V2 §5.2 ④）。
 *
 * 严格两段式：`plan()` 只计算**将要发生什么**（不写任何文件），`applyProposal()` 才落盘。
 * 这样"展示 diff 后落盘"是结构保证，而不是靠调用方自觉。
 *
 * 安全分类（供 CLI 展示与守门）：
 *   · `destructive`    —— 有删除操作（文件删除）
 *   · `touchesUserFiles` —— 被删文件在 MEMORY.md 的**手写区**有索引行 ⇒ 那条索引会变孤儿，
 *                        引擎**不会**去改手写区（V2 §3.3），只能告警要求人工清理
 *   · `outsideControlledBlock` —— 同上，逐条列出
 *
 * 仍受 `guard.decideWrite()` 守门：audit 模式下**拒绝任何写入**。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const configMod = require('./config.cjs');
const memoryMod = require('./memory.cjs');
const gitops = require('./gitops.cjs');
const guardMod = require('./guard.cjs');
const log = require('./log.cjs');

const DREAM_DIR = 'dream';

/** 生成带宿主契约 frontmatter 的正文 */
function bodyWithFrontmatter({ name, description, body, signal = 'manual-dream', score = null, jevModel = null, now = new Date() }) {
  const iso = now.toISOString();
  const fm = [
    '---',
    `name: ${name}`,
    `description: ${String(description).replace(/\s+/g, ' ').trim().slice(0, 200)}`,
    'metadata:',
    '  node_type: memory',
    '  type: reference',
    '  originSessionId: manual-dream',
    `  modified: ${iso}`,
    '  dream:',
    `    score: ${score === null ? 'null' : score}`,
    `    jevModel: ${jevModel || 'n/a'}`,
    `    signal: ${signal}`,
    `    promotedAt: ${iso}`,
    '---',
    '',
  ].join('\n');
  return `${fm}${String(body).trim()}\n`;
}

function projMem(slug) { return path.join(pathsMod.paths().projectsRoot, slug, 'memory'); }
function globalDir() { return pathsMod.paths().global; }

/**
 * 计算执行计划（**不写任何文件**）。
 * @returns {{ok:boolean, steps:Array, summary:object, warnings:string[], errors:Array, blocked?:string}}
 */
function plan(prop, { cfg } = {}) {
  const p = pathsMod.paths();
  const steps = [];
  const warnings = [];
  const errors = [];
  const summary = { creates: 0, updates: 0, deletes: 0, pointerAdds: 0, pointerRemoves: 0, notes: 0, destructive: false, touchesUserFiles: false, outsideControlledBlock: [] };

  // 读一次索引状态，用于判断"指针在哪个区块"
  const indexCache = new Map();
  const indexOf = (slug) => {
    if (indexCache.has(slug)) return indexCache.get(slug);
    const f = path.join(projMem(slug), 'MEMORY.md');
    if (!fs.existsSync(f)) { indexCache.set(slug, null); return null; }
    const text = fs.readFileSync(f, 'utf8');
    const parsed = memoryMod.parseBlocks(text);
    const blockOf = new Map();
    let cur = 'manual';
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (t === memoryMod.MARKERS.dream.begin) { cur = 'dream'; continue; }
      if (t === memoryMod.MARKERS.dream.end) { cur = 'manual'; continue; }
      if (t === memoryMod.MARKERS.global.begin) { cur = 'global'; continue; }
      if (t === memoryMod.MARKERS.global.end) { cur = 'manual'; continue; }
      const tgt = memoryMod.linkTargetOf(line);
      if (tgt && !blockOf.has(tgt)) blockOf.set(tgt, cur);
    }
    const v = { file: f, text, blockOf, malformed: parsed.malformed };
    indexCache.set(slug, v);
    return v;
  };

  for (const [i, op] of prop.ops.entries()) {
    const at = `ops[${i}]`;
    if (op.op === 'note') { steps.push({ op: 'note', kind: 'note', detail: op.text }); summary.notes++; continue; }

    if (op.op === 'merge') {
      const newFile = path.join(projMem(op.project), op.name);
      steps.push({ op: 'merge', kind: 'create', path: newFile, detail: `新文件 ${op.name}（合并 ${op.sources.length} 条）` });
      summary.creates++;
      const idx = indexOf(op.project);
      for (const s of op.sources) {
        const src = path.join(projMem(op.project), s);
        const block = idx ? idx.blockOf.get(s) : undefined;
        if (block === 'manual' || block === undefined) {
          summary.touchesUserFiles = true;
          summary.outsideControlledBlock.push(`${op.project}/${s}`);
          warnings.push(`${at}: \`${s}\` 的索引行在**手写区**（或不存在）⇒ 删除文件后该行会成孤儿，引擎不会改手写区，请你手动清理`);
        }
        steps.push({ op: 'merge', kind: 'delete', path: src, detail: `删除源文件 ${s}` });
        summary.deletes++; summary.destructive = true;
        if (block === 'dream') {
          steps.push({ op: 'merge', kind: 'pointer-remove', path: idx.file, target: s, detail: `移除受控区块指针 ${s}` });
          summary.pointerRemoves++;
        }
      }
      const target = path.join(projMem(op.project), 'MEMORY.md');
      steps.push({ op: 'merge', kind: 'pointer-add', path: target, block: DREAM_DIR, name: op.name.replace(/\.md$/, ''), targetFile: op.name, description: op.description, detail: `新增指针 → ${op.name}` });
      summary.pointerAdds++;
      continue;
    }

    if (op.op === 'dedupe' || op.op === 'resolve-conflict') {
      const idx = indexOf(op.project);
      for (const r of op.remove) {
        const block = idx ? idx.blockOf.get(r) : undefined;
        if (block === 'manual' || block === undefined) {
          summary.touchesUserFiles = true;
          summary.outsideControlledBlock.push(`${op.project}/${r}`);
          warnings.push(`${at}: \`${r}\` 的索引行在**手写区** ⇒ 删除后成孤儿，需你手动清理`);
        }
        steps.push({ op: op.op, kind: 'delete', path: path.join(projMem(op.project), r), detail: `删除 ${r}（保留 ${op.keep}）` });
        summary.deletes++; summary.destructive = true;
        if (block === 'dream') {
          steps.push({ op: op.op, kind: 'pointer-remove', path: idx.file, target: r, detail: `移除受控区块指针 ${r}` });
          summary.pointerRemoves++;
        }
      }
      if (op.op === 'resolve-conflict') steps.push({ op: op.op, kind: 'note', detail: `裁决理由：${op.why}` });
      continue;
    }

    if (op.op === 'compress-index') {
      steps.push({ op: 'compress-index', kind: 'update', path: path.join(projMem(op.project), 'MEMORY.md'), block: DREAM_DIR, detail: '压缩受控区块描述（截断至 80 字符）' });
      summary.updates++;
      continue;
    }

    if (op.op === 'promote-global') {
      steps.push({ op: 'promote-global', kind: 'create', path: path.join(globalDir(), op.name), detail: `新建全局经验 ${op.name}` });
      summary.creates++;
      steps.push({ op: 'promote-global', kind: 'note', detail: `源项目文件 \`${op.from.project}/${op.from.file}\` **保留**（不删除，避免不可逆损失）` });
      continue;
    }

    if (op.op === 'remove') {
      const idx = indexOf(op.project);
      const block = idx ? idx.blockOf.get(op.file) : undefined;
      if (block === 'manual' || block === undefined) {
        summary.touchesUserFiles = true;
        summary.outsideControlledBlock.push(`${op.project}/${op.file}`);
        warnings.push(`${at}: \`${op.file}\` 的索引行在**手写区** ⇒ 删除后成孤儿，需你手动清理`);
      }
      steps.push({ op: 'remove', kind: 'delete', path: path.join(projMem(op.project), op.file), detail: `删除 ${op.file}（理由：${op.why || '未给'}）` });
      summary.deletes++; summary.destructive = true;
      if (block === 'dream') {
        steps.push({ op: 'remove', kind: 'pointer-remove', path: idx.file, target: op.file, detail: `移除受控区块指针 ${op.file}` });
        summary.pointerRemoves++;
      }
      continue;
    }

    errors.push({ path: at, expected: '已知 op', got: op.op });
  }

  // 存在性预检：create 目标不得已存在；delete 目标必须存在
  for (const s of steps) {
    if (s.kind === 'create' && fs.existsSync(s.path)) errors.push({ path: s.detail, expected: '目标尚不存在', got: '已存在' });
    if (s.kind === 'delete' && !fs.existsSync(s.path)) errors.push({ path: s.detail, expected: '待删文件存在', got: '不存在' });
  }
  void p;
  return { ok: errors.length === 0, steps, summary, warnings, errors };
}

/**
 * 执行提案。
 * @param {{confirm?:boolean, dryRun?:boolean, cfg?:object, policy?:object}} opts
 *   `confirm` 为 false 时**只返回计划**（展示用），不写盘。
 */
function applyProposal(prop, { confirm = false, dryRun = false, cfg, policy, proposalName = null } = {}) {
  const c = cfg || configMod.load().config;
  const pol = policy || guardMod.decideWrite({ cfg: c });
  const planned = plan(prop, { cfg: c });

  if (!planned.ok) return { ok: false, phase: 'plan', errors: planned.errors, planned };
  if (!pol.allow) return { ok: false, phase: 'guard', reason: pol.reason, planned };
  if (dryRun || !confirm) return { ok: true, phase: 'preview', planned, applied: [], reason: dryRun ? 'dry-run' : 'awaiting-confirm' };

  const executed = [];
  const errors = [];
  const touchedRepos = new Set();

  const stepApply = (fn, step) => {
    try {
      const r = fn();
      executed.push({ ...step, result: r });
      return r;
    } catch (e) {
      errors.push({ step: step.detail, error: e.message });
      return null;
    }
  };

  // 1) 创建类
  for (const s of planned.steps) {
    if (s.kind !== 'create') continue;
    if (s.op === 'merge') {
      const op = prop.ops.find((o) => o.op === 'merge' && path.join(projMem(o.project), o.name) === s.path);
      const content = bodyWithFrontmatter({ name: op.name.replace(/\.md$/, ''), description: op.description, body: op.body, signal: 'manual-merge' });
      stepApply(() => { memoryMod.writeAtomic(s.path, content); touchedRepos.add(projMem(op.project)); return { wrote: s.path }; }, s);
    } else if (s.op === 'promote-global') {
      const op = prop.ops.find((o) => o.op === 'promote-global' && path.join(globalDir(), o.name) === s.path);
      const content = bodyWithFrontmatter({ name: op.name.replace(/\.md$/, ''), description: op.description, body: op.body, signal: 'manual-global' });
      stepApply(() => { memoryMod.writeAtomic(s.path, content); touchedRepos.add(globalDir()); return { wrote: s.path }; }, s);
    }
  }

  // 2) 指针增删
  for (const s of planned.steps) {
    if (s.kind === 'pointer-add') {
      stepApply(() => memoryMod.applyPointer(s.path, s.block, { name: s.name, target: s.targetFile, description: s.description }), s);
    } else if (s.kind === 'pointer-remove') {
      stepApply(() => memoryMod.applyRemovePointer(s.path, DREAM_DIR, s.target), s);
    }
  }

  // 3) 压缩索引（机械：截断受控区块内的描述）
  for (const s of planned.steps) {
    if (s.op !== 'compress-index') continue;
    stepApply(() => {
      const text = fs.readFileSync(s.path, 'utf8');
      const parsed = memoryMod.parseBlocks(text);
      const b = parsed.blocks.dream;
      if (!b.present) return { changed: false, reason: 'no-dream-block' };
      const shortened = b.lines.map((l) => {
        const tgt = memoryMod.linkTargetOf(l);
        if (!tgt) return l;
        const nm = (/^\s*-\s*\[([^\]]*)\]/.exec(l) || [])[1] || '';
        const desc = (/—\s*(.*)$/.exec(l) || [])[1] || '';
        return memoryMod.pointerLine('dream', nm, tgt, desc.slice(0, 80));
      });
      const out = [...parsed.lines.slice(0, b.start + 1), ...shortened, ...parsed.lines.slice(b.end)].join(parsed.eol);
      memoryMod.writeAtomic(s.path, out);
      return { compressed: shortened.length };
    }, s);
  }

  // 4) 删除（**最后**做，且逐个 commit 前先完成所有写入）
  for (const s of planned.steps) {
    if (s.kind !== 'delete') continue;
    stepApply(() => {
      fs.unlinkSync(s.path);
      const memDir = path.dirname(s.path);
      if (memDir !== globalDir()) touchedRepos.add(memDir);
      return { deleted: s.path };
    }, s);
  }

  // 5) git commit（每个受影响仓库一次）
  const commits = [];
  for (const dir of touchedRepos) {
    try { commits.push({ dir, ...gitops.commitAll(dir, `dream(manual): ${proposalName || 'proposal'}`) }); }
    catch (e) { commits.push({ dir, ok: false, error: e.message }); }
  }

  // 6) 归档提案
  let archived = null;
  try {
    const p = pathsMod.paths();
    const appliedDir = path.join(p.proposals, 'applied');
    fs.mkdirSync(appliedDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(appliedDir, `applied-${stamp}.json`);
    fs.writeFileSync(dest, JSON.stringify({ ts: new Date().toISOString(), proposalName, plan: planned.summary, executedCount: executed.length, errors, proposal: prop }, null, 2), 'utf8');
    archived = dest;
  } catch (e) { log.warn('proposal archive failed', { error: e.message }); }

  try {
    log.ledger({ kind: 'manual-dream-apply', proposal: proposalName, summary: planned.summary, executed: executed.length, errors: errors.length, archived });
  } catch { /* ignore */ }

  return { ok: errors.length === 0, phase: 'applied', planned, executed, errors, commits, archived };
}

module.exports = { plan, applyProposal, bodyWithFrontmatter, DREAM_DIR };
