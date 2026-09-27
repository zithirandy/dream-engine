'use strict';
/**
 * memory.cjs —— 受控区块写入器（V2 §3.3 / §4.5）。
 *
 * 本模块是**唯一**会改写用户记忆文件的模块，故设计原则是"宁可不动，不可猜"：
 *
 *   · 只改 `<!-- dream:begin -->…<!-- dream:end -->` 与
 *     `<!-- dream:global:begin -->…<!-- dream:global:end -->` 两个区块内部；
 *     界标之外**一个字节都不动**（用户手写内容受保护）。
 *   · 界标缺失 ⇒ 追加区块（不动既有内容）；界标**不配对/重复** ⇒ 判定 malformed
 *     并**拒绝写入**，绝不猜哪个是真界标。
 *   · 原地更新按链接目标匹配，天然幂等（重复提升同一经验不会产生重复行）。
 *   · 索引区块超限（≤200 行 / ≤25KB）时从**顶部**淘汰最旧条目并如实报告淘汰项。
 *   · 写入原子（临时文件 + rename），并保留原文件的 EOL 风格（CRLF/LF）。
 *
 * 注意 `audit` 模式下本模块**不应被调用** —— 调用方须先过 `guard.decideWrite()`。
 */
const fs = require('fs');
const path = require('path');

const MARKERS = {
  dream: { begin: '<!-- dream:begin -->', end: '<!-- dream:end -->' },
  global: { begin: '<!-- dream:global:begin -->', end: '<!-- dream:global:end -->' },
};
const KINDS = Object.keys(MARKERS);

const LIMITS = { maxLines: 200, maxBytes: 25 * 1024 };

/** 推断并保留原文件的换行风格 */
function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(^|[^\r])\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * 解析受控区块（纯函数）。
 * @returns {{blocks:object, malformed:Array<string>, eol:string}}
 */
function parseBlocks(text) {
  const eol = detectEol(text);
  const lines = String(text).split(/\r?\n/);
  const blocks = {};
  const malformed = [];

  for (const kind of KINDS) {
    const { begin, end } = MARKERS[kind];
    const bIdx = [];
    const eIdx = [];
    lines.forEach((l, i) => {
      if (l.trim() === begin) bIdx.push(i);
      if (l.trim() === end) eIdx.push(i);
    });
    if (bIdx.length === 0 && eIdx.length === 0) { blocks[kind] = { present: false, start: -1, end: -1, lines: [] }; continue; }
    if (bIdx.length !== 1 || eIdx.length !== 1) {
      malformed.push(`${kind}: 界标数量异常（begin×${bIdx.length}, end×${eIdx.length}）`);
      blocks[kind] = { present: false, start: -1, end: -1, lines: [], broken: true };
      continue;
    }
    if (eIdx[0] < bIdx[0]) {
      malformed.push(`${kind}: end 在 begin 之前`);
      blocks[kind] = { present: false, start: -1, end: -1, lines: [], broken: true };
      continue;
    }
    blocks[kind] = { present: true, start: bIdx[0], end: eIdx[0], lines: lines.slice(bIdx[0] + 1, eIdx[0]) };
  }
  return { blocks, malformed, eol, lines };
}

/** 生成指针行（V2 §3.3 格式） */
function pointerLine(kind, name, target, description) {
  const desc = String(description || '').replace(/\s+/g, ' ').trim();
  return `- [${name}](${target})${desc ? ' — ' + desc : ''}`;
}

/** 从一行里取出链接目标（用于幂等匹配）；不是指针行则返回 null */
function linkTargetOf(line) {
  const m = /^\s*-\s*\[[^\]]*\]\(([^)]+)\)/.exec(line);
  return m ? m[1] : null;
}

/**
 * 在指定区块内 upsert 一条指针（纯函数）。
 * @returns {{text:string, changed:boolean, action:string, dropped:Array<string>}}
 */
function upsertPointer(text, kind, entry, { limits = LIMITS } = {}) {
  if (!MARKERS[kind]) throw new Error(`unknown block kind: ${kind}`);
  const { blocks, malformed, eol, lines } = parseBlocks(text);
  if (malformed.length) {
    return { text, changed: false, action: 'refused-malformed', dropped: [], malformed };
  }
  const b = blocks[kind];
  const line = pointerLine(kind, entry.name, entry.target, entry.description);

  let blockLines = b.present ? [...b.lines] : [];
  // 清掉区块内的空行（重排），但保留排序稳定
  const idx = blockLines.findIndex((l) => linkTargetOf(l) === entry.target);
  let action;
  if (idx >= 0) {
    if (blockLines[idx] === line) return { text, changed: false, action: 'noop-identical', dropped: [] };
    blockLines[idx] = line;
    action = 'updated';
  } else {
    blockLines.push(line);
    action = 'appended';
  }

  // 淘汰：行数或字节超限时从**顶部**丢最旧条目
  const dropped = [];
  const build = (bl) => {
    if (b.present) return [...lines.slice(0, b.start + 1), ...bl, ...lines.slice(b.end)];
    // 界标缺失 → 追加区块，不动既有内容
    const tail = lines.length && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
    return [...tail, '', MARKERS[kind].begin, ...bl, MARKERS[kind].end, ''];
  };
  while (blockLines.length > limits.maxLines
      || (blockLines.length > 1 && Buffer.byteLength(build(blockLines).join(eol), 'utf8') > limits.maxBytes)) {
    dropped.push(blockLines.shift());
  }
  const out = build(blockLines);
  const result = out.join(eol);
  if (dropped.length) action = `${action}+dropped${dropped.length}`;
  return { text: result, changed: true, action, dropped };
}

/**
 * 从**受控区块内**移除一条指针（按链接目标匹配）。
 *
 * ★ 只动指定区块内部。若目标指针位于**界标之外**（用户手写的索引区），本函数
 *   **拒绝并返回 `outside-controlled-block`** —— 手动梦合并/删除文件后，那条手写
 *   索引行会变成孤儿，但清理它是**用户的事**，不是我们该静默改的
 *   （V2 §3.3「界标之外一律不动」）。
 */
function removePointer(text, kind, target) {
  if (!MARKERS[kind]) throw new Error(`unknown block kind: ${kind}`);
  const { blocks, malformed, eol, lines } = parseBlocks(text);
  if (malformed.length) return { text, changed: false, action: 'refused-malformed', malformed };
  const b = blocks[kind];
  if (!b.present) return { text, changed: false, action: 'no-block' };
  const idx = b.lines.findIndex((l) => linkTargetOf(l) === target);
  if (idx < 0) {
    // 不在受控区块内 —— 判断它是否存在于文件中（那就是手写区）
    const anywhere = lines.findIndex((l) => linkTargetOf(l) === target);
    return { text, changed: false, action: anywhere >= 0 ? 'outside-controlled-block' : 'not-found' };
  }
  const blockLines = b.lines.filter((_, i) => i !== idx);
  const out = [...lines.slice(0, b.start + 1), ...blockLines, ...lines.slice(b.end)];
  return { text: out.join(eol), changed: true, action: 'removed' };
}

/** 原子写：临时文件 + rename */
function writeAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

function readIndex(file) {
  if (!fs.existsSync(file)) return { exists: false, text: '' };
  return { exists: true, text: fs.readFileSync(file, 'utf8') };
}

/**
 * 对一个 MEMORY.md 施加一条指针（IO 封装）。
 * @returns {{ok:boolean, changed:boolean, action:string, path:string, dropped:Array, reason?:string}}
 */
function applyPointer(file, kind, entry, opts = {}) {
  const { exists, text } = readIndex(file);
  const base = exists ? text : '';
  const r = upsertPointer(base, kind, entry, opts);
  if (r.action === 'refused-malformed') {
    return { ok: false, changed: false, action: r.action, path: file, dropped: [], reason: r.malformed.join('; ') };
  }
  if (!r.changed) return { ok: true, changed: false, action: r.action, path: file, dropped: [] };
  writeAtomic(file, r.text);
  return { ok: true, changed: true, action: r.action, path: file, dropped: r.dropped };
}

/** 对 MEMORY.md 施加一次**移除**（IO 封装） */
function applyRemovePointer(file, kind, target) {
  const { exists, text } = readIndex(file);
  if (!exists) return { ok: true, changed: false, action: 'no-file', path: file };
  const r = removePointer(text, kind, target);
  if (!r.changed) return { ok: r.action !== 'refused-malformed', changed: false, action: r.action, path: file, reason: (r.malformed || []).join('; ') };
  writeAtomic(file, r.text);
  return { ok: true, changed: true, action: r.action, path: file };
}

module.exports = {
  MARKERS, KINDS, LIMITS,
  detectEol, parseBlocks, pointerLine, linkTargetOf,
  upsertPointer, applyPointer, removePointer, applyRemovePointer, writeAtomic, readIndex,
};
