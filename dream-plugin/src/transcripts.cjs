'use strict';
/**
 * transcripts.cjs —— 转录增量解析（V2 §4.1，含 M1 全部修正）。
 *
 * 硬要求：
 *   1) 偏移只推进到「最后一个完整 \n」之后，未结尾字节留给下一轮（半行不消费）
 *   2) session-end 或尾巴超龄（tailSealAfterDays）时才封口解析残留尾巴
 *   3) 单行 > maxLineBytes 跳过并计数，不报错（工具原始输出是体积主因）
 *   4) size < offset 视为轮转/压缩 → offset 归零并标 rescan
 *   5) 全程流式分块，绝不整文件读入（最大单文件实测 12.41 MiB）
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const log = require('./log.cjs');

const CHUNK = 1 << 20; // 1MB

// ------------------------------------------------------------------ offsets
function readOffsets() {
  const p = pathsMod.paths();
  try {
    const raw = fs.readFileSync(p.offsets, 'utf8');
    const j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeOffsets(offsets) {
  const p = pathsMod.paths();
  fs.mkdirSync(p.raw, { recursive: true });
  const tmp = `${p.offsets}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(offsets, null, 2), 'utf8');
  fs.renameSync(tmp, p.offsets);
}

// ------------------------------------------------------------------ discovery
/** 列出转录文件；projectFilter 为 project-slug 时只列该项目 */
function listTranscripts({ projectFilter = null, sinceMs = null } = {}) {
  const p = pathsMod.paths();
  const out = [];
  if (!fs.existsSync(p.projectsRoot)) return out;

  for (const ent of fs.readdirSync(p.projectsRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    if (projectFilter && ent.name !== projectFilter) continue;
    const dir = path.join(p.projectsRoot, ent.name);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (sinceMs !== null && st.mtimeMs <= sinceMs) continue;
      out.push({ path: full, slug: ent.name, sessionId: f.replace(/\.jsonl$/, ''), size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

/**
 * 从 startOffset 读到 EOF，返回完整行 + 已消费字节数。
 * 关键：consumed 只覆盖到最后一个完整 \n；残留尾巴放回 events 之外。
 */
function readNewLines(filePath, startOffset, maxLineBytes) {
  const stats = { lines: [], consumed: 0, oversized: 0, parseErrors: 0, bytesRead: 0, tailBytes: 0, rescan: false };
  const fd = fs.openSync(filePath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < startOffset) { stats.rescan = true; startOffset = 0; }
    if (size <= startOffset) {
      // ★ F1 修复：文件未增长时**必须保留原偏移**，绝不能返回 0。
      // 返回 0 会让 ingest 把 offset 归零写回 → 下一轮全量重读 → 候选整套重复落盘。
      stats.consumed = startOffset;
      stats.sizeAtRead = size;
      return stats;
    }

    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = startOffset;
    let pending = Buffer.alloc(0);
    let consumedAbs = startOffset;
    let skippingOversize = false;

    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      const base = pos - pending.length;          // chunk[0] 的绝对偏移
      pos += n;
      stats.bytesRead += n;

      let chunk = pending.length ? Buffer.concat([pending, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      let lineStart = 0;
      let idx;

      while ((idx = chunk.indexOf(0x0A, lineStart)) !== -1) {
        const lineBuf = chunk.subarray(lineStart, idx);
        if (skippingOversize) {
          skippingOversize = false;               // 超长行到此结束
        } else if (lineBuf.length > maxLineBytes) {
          stats.oversized++;
        } else {
          const s = lineBuf.toString('utf8').trim();
          if (s) stats.lines.push(s);
        }
        lineStart = idx + 1;
        consumedAbs = base + lineStart;
      }

      pending = chunk.subarray(lineStart);
      // 单行超过上限且至今未见换行 → 进入跳过模式，丢弃已缓冲内容
      if (pending.length > maxLineBytes) {
        stats.oversized++;
        skippingOversize = true;
        pending = Buffer.alloc(0);
        consumedAbs = base + lineStart;           // 超长行的边界在下一个 \n 才能确定
      }
      if (skippingOversize) consumedAbs = base + chunk.length;
    }

    stats.consumed = consumedAbs;
    stats.tailBytes = Math.max(0, size - consumedAbs);
    return stats;
  } finally {
    fs.closeSync(fd);
  }
}

// ------------------------------------------------------------------ normalize
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const c of content) {
    if (!c) continue;
    if (typeof c === 'string') { parts.push(c); continue; }
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'tool_result') parts.push(contentToText(c.content));
  }
  return parts.join('\n');
}

/** 把一行转录 JSON 归一化成 0..n 个事件 */
function normalizeLine(line, meta) {
  let o;
  try { o = JSON.parse(line); } catch { return { parseError: true, events: [] }; }

  const events = [];
  const common = {
    sessionId: meta.sessionId,
    project: meta.slug,
    uuid: o.uuid || null,
    parentUuid: o.parentUuid || null,
    ts: o.timestamp || null,
    sidechain: !!o.isSidechain,
  };

  const msg = o.message || {};
  const role = msg.role || (o.type === 'user' ? 'user' : o.type === 'assistant' ? 'assistant' : null);
  const content = msg.content;

  if (Array.isArray(content)) {
    for (const c of content) {
      if (!c || typeof c !== 'object') continue;
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        events.push({ ...common, role, kind: 'text', text: c.text });
      } else if (c.type === 'tool_use') {
        const input = c.input || {};
        events.push({
          ...common, role, kind: 'tool_use', toolName: c.name || null,
          filePath: input.file_path || input.notebook_path || null,
          command: typeof input.command === 'string' ? input.command : null,
          inputKeys: Object.keys(input),
        });
      } else if (c.type === 'tool_result') {
        const text = contentToText(c.content);
        events.push({
          ...common, role, kind: 'tool_result',
          toolUseId: c.tool_use_id || null,
          isError: !!c.is_error,
          text: text.length > 4000 ? text.slice(0, 4000) : text,
        });
      }
    }
  } else if (typeof content === 'string' && content.trim()) {
    events.push({ ...common, role, kind: 'text', text: content });
  }

  // 顶层 error 标记（部分行直接带 isApiErrorMessage 之类）
  if (o.isApiErrorMessage) events.push({ ...common, role, kind: 'error', text: String(o.message || '') });

  return { parseError: false, events };
}

/**
 * 主入口：对一批转录做增量解析。
 * @param {{projectFilter?:string, sinceMs?:number, force?:boolean, sealAll?:boolean, config?:object, dryRun?:boolean}} opts
 *   dryRun=true 时**不写 offsets.json**（对应 V2 §10「只看不写」门禁）
 * @returns {{events:Array, perFile:Array, stats:object}}
 */
function ingest({ projectFilter = null, sinceMs = null, force = false, sealAll = false, config, dryRun = false } = {}) {
  const cfg = (config || require('./config.cjs').load().config);
  const maxLineBytes = cfg.limits.maxLineBytes;
  const sealDays = cfg.limits.tailSealAfterDays;
  // ★ F1 附带修复：maxBytesPerRun 此前在代码中零实施，预算兜底形同不存在
  const maxBytesPerRun = Number.isFinite(cfg.limits.maxBytesPerRun) ? cfg.limits.maxBytesPerRun : Infinity;

  const offsets = readOffsets();
  const files = listTranscripts({ projectFilter, sinceMs });
  const events = [];
  const perFile = [];
  const totals = { files: 0, bytesRead: 0, lines: 0, events: 0, oversized: 0, parseErrors: 0, rescans: 0, tailsLeft: 0, sealed: 0, budgetExhausted: false, filesSkippedByBudget: 0, offsetsPreserved: 0 };

  for (const f of files) {
    // 预算闸：已读够就不再读新文件（已读文件的 offsets 照常推进，剩余留给下轮）
    if (totals.bytesRead > 0 && totals.bytesRead + (f.size - (offsets[f.path]?.offset || 0)) > maxBytesPerRun) {
      totals.budgetExhausted = true;
      totals.filesSkippedByBudget++;
      continue;
    }
    const prev = force ? 0 : (offsets[f.path]?.offset || 0);
    const r = readNewLines(f.path, prev, maxLineBytes);

    let tailSealed = false;
    if (r.tailBytes > 0) {
      const ageDays = (Date.now() - f.mtimeMs) / 86400000;
      const shouldSeal = sealAll || ageDays >= sealDays;
      if (shouldSeal) {
        // 封口：把残尾当一行解析（可能不完整，失败即计 parseError）
        const fd = fs.openSync(f.path, 'r');
        try {
          const b = Buffer.allocUnsafe(r.tailBytes);
          fs.readSync(fd, b, 0, r.tailBytes, r.consumed);
          const s = b.toString('utf8').trim();
          if (s) r.lines.push(s);
          r.consumed += r.tailBytes;
          tailSealed = true;
          totals.sealed++;
        } finally { fs.closeSync(fd); }
      } else {
        totals.tailsLeft++;
      }
    }

    let fileEvents = 0;
    for (const line of r.lines) {
      const norm = normalizeLine(line, { slug: f.slug, sessionId: f.sessionId });
      if (norm.parseError) { totals.parseErrors++; continue; }
      for (const e of norm.events) events.push(e);
      fileEvents += norm.events.length;
    }

    offsets[f.path] = {
      offset: r.consumed,
      size: f.size,
      mtimeMs: f.mtimeMs,
      tailSealed,
      updatedAt: new Date().toISOString(),
    };

    perFile.push({
      slug: f.slug, sessionId: f.sessionId, bytesRead: r.bytesRead, lines: r.lines.length,
      events: fileEvents, oversized: r.oversized, parseErrors: r.parseErrors,
      rescan: r.rescan, tailBytes: r.tailBytes, tailSealed,
    });

    // ★ 核验遗留：offsetsPreserved 此前只声明未累加（死计数）
    if (r.bytesRead === 0 && r.lines.length === 0 && r.consumed === prev && prev > 0) totals.offsetsPreserved++;

    totals.files++;
    totals.bytesRead += r.bytesRead;
    totals.lines += r.lines.length;
    totals.events += fileEvents;
    totals.oversized += r.oversized;
    totals.parseErrors += r.parseErrors;
    if (r.rescan) totals.rescans++;
  }

  if (!dryRun) writeOffsets(offsets);

  // 事件按时间排序（跨文件合并后仍要有序，供"错误→修复"配对）
  events.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));

  log.info('ingest done', { ...totals, projectFilter, dryRun });
  return { events, perFile, stats: totals, offsetsWritten: !dryRun };
}

module.exports = { ingest, listTranscripts, readNewLines, normalizeLine, readOffsets, writeOffsets, contentToText };
