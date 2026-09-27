'use strict';
/**
 * projects.cjs —— 扫描宿主记忆目录，为 state.projects 生成初始条目。
 *
 * 对应核验快报残余注意项 #2：「state.projects 的 24 条项目描述来源/维护未指定 → P0 手工初始化」。
 * 策略：自动播种（auto-seed），并标记 needsReview=true，等人工或手动梦时刷新。
 * 绝不覆盖已有人工/AI 描述（由 state.mergeProjects 保证）。
 *
 * 残余注意项 #6：命名区分 project slug 与 memory slug —— 本模块用 `project` 指前者。
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');

/** 把绝对路径转成宿主的 project-slug（非字母数字一律 → '-'） */
function slugFromPath(absPath) {
  return String(absPath).replace(/[^a-zA-Z0-9]/g, '-');
}

/** 从 transcript_path 反推 slug（最权威） */
function slugFromTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  const parts = String(transcriptPath).split(/[\\/]/);
  const i = parts.lastIndexOf('projects');
  if (i >= 0 && parts[i + 1]) return parts[i + 1];
  return null;
}

function readFrontmatterField(text, field) {
  const m = text.match(new RegExp(`^${field}:\\s*(.+)$`, 'm'));
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
}

/** 为一个 memory 目录播种描述：优先 index 首条链接，其次最大文件的 description */
function seedDescription(memoryDir, slug) {
  const idx = path.join(memoryDir, 'MEMORY.md');
  if (fs.existsSync(idx)) {
    const text = fs.readFileSync(idx, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('<!--') || t.startsWith('---')) continue;
      const link = t.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (link) return `索引首条：${link[1]}`;
      return t.replace(/^[-*]\s*/, '').slice(0, 120);
    }
  }
  // 退化：最大 .md 文件的 description
  try {
    const files = fs.readdirSync(memoryDir).filter((f) => f.endsWith('.md') && f !== 'MEMORY.md');
    let biggest = null;
    let size = -1;
    for (const f of files) {
      const s = fs.statSync(path.join(memoryDir, f)).size;
      if (s > size) { size = s; biggest = f; }
    }
    if (biggest) {
      const text = fs.readFileSync(path.join(memoryDir, biggest), 'utf8');
      const d = readFrontmatterField(text, 'description');
      if (d) return d.slice(0, 160);
      return `记忆文件：${biggest}`;
    }
  } catch { /* ignore */ }
  return `（待补充：${slug}）`;
}

// ------------------------------------------------------------------ 递归定策
/**
 * P1 定策（核验报告前置 #1）：memory 目录**递归 1 层**。
 *
 *   索引对象 = 仅顶层 .md      → 索引膨胀是 V2 §11 风险 6，子目录不产生索引行
 *   子目录 .md = **附属证据**   → 参与"这条经验我是不是已经知道了"的去重判断，
 *                                但不参与索引、不单独提升
 *   深度上限 = 1               → 有界、可预测；再深的内容价值密度不足
 *   可配置                     → scan.recursiveDepth / scan.auxiliarySubdirs，可回退
 */
function scanCfg(override) {
  const cfg = override || require('./config.cjs').load().config;
  const s = (cfg && cfg.scan) || {};
  return {
    recursiveDepth: Number.isFinite(s.recursiveDepth) ? s.recursiveDepth : 1,
    auxiliarySubdirs: s.auxiliarySubdirs !== false,
    maxAuxFiles: Number.isFinite(s.maxAuxFiles) ? s.maxAuxFiles : 200,
  };
}

/** 列出顶层 .md 与附属（子目录）.md */
function discoverFiles(memoryDir, { override } = {}) {
  const s = scanCfg(override);
  const topLevel = [];
  const auxiliary = [];
  let subs = [];
  try { subs = fs.readdirSync(memoryDir, { withFileTypes: true }); } catch { return { topLevel, auxiliary }; }

  for (const e of subs) {
    if (e.isFile() && e.name.endsWith('.md')) topLevel.push({ file: e.name, path: path.join(memoryDir, e.name) });
  }
  if (s.auxiliarySubdirs && s.recursiveDepth >= 1) {
    for (const e of subs) {
      if (!e.isDirectory()) continue;
      const sub = path.join(memoryDir, e.name);
      let inner = [];
      try { inner = fs.readdirSync(sub, { withFileTypes: true }); } catch { continue; }
      for (const f of inner) {
        if (!f.isFile() || !f.name.endsWith('.md')) continue;
        if (auxiliary.length >= s.maxAuxFiles) break;
        auxiliary.push({ file: `${e.name}/${f.name}`, path: path.join(sub, f.name) });
      }
      if (auxiliary.length >= s.maxAuxFiles) break;
    }
  }
  topLevel.sort((a, b) => a.file.localeCompare(b.file));
  auxiliary.sort((a, b) => a.file.localeCompare(b.file));
  return { topLevel, auxiliary };
}

/** 扫描全部有记忆的项目（顶层或附属任一非空即纳入） */
function scan(opts = {}) {
  const p = pathsMod.paths();
  const cfg = opts.cfg || require('./config.cjs').load().config;
  const out = [];
  if (!fs.existsSync(p.projectsRoot)) return out;

  for (const ent of fs.readdirSync(p.projectsRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const memoryDir = path.join(p.projectsRoot, ent.name, 'memory');
    if (!fs.existsSync(memoryDir)) continue;

    const { topLevel, auxiliary } = discoverFiles(memoryDir, { override: cfg });
    if (topLevel.length === 0 && auxiliary.length === 0) continue;

    const idx = path.join(memoryDir, 'MEMORY.md');
    let indexBytes = 0;
    let indexLines = 0;
    if (fs.existsSync(idx)) {
      const raw = fs.readFileSync(idx, 'utf8');
      indexBytes = Buffer.byteLength(raw, 'utf8');
      indexLines = raw.split(/\r?\n/).length;
    }

    out.push({
      slug: ent.name,
      memoryDir,
      description: seedDescription(memoryDir, ent.name),
      descriptionSource: 'auto-seed',
      memoryFiles: topLevel.length,
      auxiliaryFiles: auxiliary.length,
      auxOnly: topLevel.length === 0,
      indexBytes,
      indexLines,
    });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}

/**
 * 读取某项目的既有记忆文本，供提炼器做「已知」判断。
 * topLevel 计入索引（用于 dupOf 判定），auxiliary 作为附属证据（同样参与判定，
 * 但标注 scope='aux'，P2 可对它降权或不据此提升）。
 */
function loadMemoryTexts(slug, { cfg, maxBytesPerFile = 64 * 1024 } = {}) {
  const p = pathsMod.paths();
  const memoryDir = path.join(p.projectsRoot, slug, 'memory');
  const result = { topLevel: [], auxiliary: [] };
  if (!fs.existsSync(memoryDir)) return result;

  const { topLevel, auxiliary } = discoverFiles(memoryDir, { override: cfg });
  const readOne = (entry) => {
    try {
      let text = fs.readFileSync(entry.path, 'utf8');
      if (text.length > maxBytesPerFile) text = text.slice(0, maxBytesPerFile);
      return { file: entry.file, text };
    } catch { return null; }
  };
  for (const e of topLevel) { const r = readOne(e); if (r) result.topLevel.push(r); }
  for (const e of auxiliary) { const r = readOne(e); if (r) result.auxiliary.push(r); }
  return result;
}

module.exports = {
  scan, slugFromPath, slugFromTranscript, seedDescription,
  discoverFiles, loadMemoryTexts, scanCfg,
};
