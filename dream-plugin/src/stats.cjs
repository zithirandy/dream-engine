'use strict';
/**
 * stats.cjs —— 报告数字的唯一产出点（F4 流程根治）。
 *
 * 三次核验都因「报告数字手抄、取数时点早于代码定稿」失准（P0 → P1 → P1修复）。
 * 现在报告里的统计数字必须来自本模块的输出，禁止手抄。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const pathsMod = require('./paths.cjs');
const store = require('./store.cjs');

function countLines(files) {
  let wc = 0;
  let nonBlank = 0;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    // 与 wc -l 对齐：末尾换行不额外计一行
    const raw = fs.readFileSync(f, 'utf8');
    wc += raw.endsWith('\n') ? lines.length - 1 : lines.length;
    nonBlank += lines.filter((l) => l.trim() !== '').length;
  }
  return { wc, nonBlank };
}

function collect(root) {
  const r = root || path.resolve(__dirname, '..');
  const srcDir = path.join(r, 'src');
  const testDir = path.join(r, 'test');

  const listCjs = (dir) => (fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.cjs')).map((f) => path.join(dir, f)).sort()
    : []);

  const srcAll = listCjs(srcDir);
  const testAll = listCjs(testDir);
  const testEffective = testAll.filter((f) => !path.basename(f).startsWith('_'));

  const src = countLines(srcAll);
  const test = countLines(testEffective);

  // 候选与脱敏
  const cands = store.loadCandidates({ limit: 50 });
  const bySignal = {};
  const redact = {};
  for (const c of cands) {
    bySignal[c.signal] = (bySignal[c.signal] || 0) + 1;
    for (const [k, v] of Object.entries(c.redactHits || {})) redact[k] = (redact[k] || 0) + v;
  }

  // offsets 健康度
  let offsets = { entries: 0, zeroed: 0, sizeDrift: 0 };
  try {
    const off = JSON.parse(fs.readFileSync(pathsMod.paths().offsets, 'utf8'));
    const entries = Object.entries(off);
    offsets.entries = entries.length;
    offsets.zeroed = entries.filter(([, v]) => v.offset === 0).length;
    offsets.sizeDrift = entries.filter(([p, v]) => {
      try { return fs.statSync(p).size !== v.size; } catch { return false; }
    }).length;
  } catch { /* 无 offsets */ }

  // 运行索引
  const runs = store.listRuns();

  return {
    root: r,
    generatedAt: new Date().toISOString(),
    platform: `${process.platform} node ${process.versions.node}`,
    files: {
      src: srcAll.length,
      test: testEffective.length,
      testAll: testAll.length,
      total: srcAll.length + testEffective.length,
    },
    lines: {
      wcMinusL: src.wc + test.wc,
      nonBlank: src.nonBlank + test.nonBlank,
      src: { wcMinusL: src.wc, nonBlank: src.nonBlank },
      test: { wcMinusL: test.wc, nonBlank: test.nonBlank },
    },
    fileList: {
      src: srcAll.map((f) => path.basename(f)),
      test: testEffective.map((f) => path.basename(f)),
    },
    dreamHome: pathsMod.paths().home,
    candidates: { total: cands.length, bySignal, redact },
    offsets,
    runs: runs.length,
    latestRun: runs[0] || null,
  };
}

function render(s) {
  const L = [];
  L.push('=== AutoDream 统计（脚本产出，请勿手抄）===');
  L.push(`生成时间      ${s.generatedAt}`);
  L.push(`运行环境      ${s.platform}`);
  L.push(`DREAM_HOME    ${s.dreamHome}`);
  L.push('');
  L.push('--- 代码规模 ---');
  L.push(`有效文件      ${s.files.total}（src ${s.files.src} + test ${s.files.test}）`);
  if (s.files.testAll !== s.files.test) L.push(`              （另有 ${s.files.testAll - s.files.test} 个 _ 前缀诊断脚本未计入）`);
  L.push(`wc -l 口径    ${s.lines.wcMinusL} 行   （src ${s.lines.src.wcMinusL} / test ${s.lines.test.wcMinusL}）`);
  L.push(`非空行口径    ${s.lines.nonBlank} 行   （src ${s.lines.src.nonBlank} / test ${s.lines.test.nonBlank}）`);
  L.push('');
  L.push('--- 候选 ---');
  L.push(`总数          ${s.candidates.total}`);
  L.push(`信号分布      ${JSON.stringify(s.candidates.bySignal)}`);
  L.push(`脱敏命中      ${JSON.stringify(s.candidates.redact)}`);
  L.push('');
  L.push('--- 增量 offsets ---');
  L.push(`条目 ${s.offsets.entries} / 归零 ${s.offsets.zeroed}（期望 0）/ size 漂移 ${s.offsets.sizeDrift}`);
  L.push('');
  L.push('--- 运行索引 ---');
  L.push(`历史运行 ${s.runs} 次，最近 ${s.latestRun ? s.latestRun.runId + ' (' + s.latestRun.candidates + ' 候选)' : '(无)'}`);
  L.push('');
  L.push('--- src 文件清单 ---');
  L.push('  ' + s.fileList.src.join('  '));
  L.push('--- test 文件清单 ---');
  L.push('  ' + s.fileList.test.join('  '));
  return L.join('\n');
}

module.exports = { collect, render, countLines };
