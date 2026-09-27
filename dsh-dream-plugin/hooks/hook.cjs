#!/usr/bin/env node
'use strict';
/**
 * hooks/hook.cjs —— DSH 侧 hook 转发（D-P1）。
 *
 * 与 Claude Code 侧 `dream-plugin/hooks/hook.cjs` 的**唯一实质差异**：
 *   **项目归属必须由 DSH 自己解析**，不能交给引擎的 CC 推导。
 *
 * 为什么（两条实测事实，见《AutoDream-DSH落地推进方案》§2.1）：
 *   1. DSH 的 hook 桥 `@deepseek-ai/dsh-hooks-claude-code` 把 `transcript_path`
 *      **恒置为空串**（README："it is always `''`"）⇒ 引擎项目推导的第一顺位必失败；
 *   2. 退到 `slugFromPath(cwd)` 用的是 **CC 的 slug 规则**，对非 ASCII 路径会算错：
 *      `F:\Demo` 推导得 `F--Demo`，而真实 CC slug 是 **`F--Demo`**。
 *      ⇒ 照现状直接接桥，本机主力工作区的事件会**归错项目**。
 *
 * 解法：用适配层已有的 `resolveProject()`（自动 slug 索引，实测 114/114 会话、0 跳过、
 * 建索引仅 9ms），把结果通过 `DREAM_PROJECT` / `DREAM_HOST` 交给引擎的 nudge。
 * **引擎不需要知道 DSH 的存在**（"引擎只有一份、宿主各挂薄适配"）。
 *
 * ⚠️ 不加索引缓存：实测建索引 9ms，而缓存会引入"陈旧映射 ⇒ 挂错项目"的正确性风险。
 *    为 9ms 承担那个风险不划算。
 *
 * 三条硬约束（与 CC 侧一致）：
 *   1. **绝不阻塞会话**：stdin 有界读、spawn 有 deadline、任何异常静默退出 0；
 *   2. **原样转发 stdin**：stdin 只能读一次 —— 本进程读完 `cwd` 后，把**同样的字节**
 *      通过 `spawnSync({ input })` 交给 nudge（否则 nudge 拿不到载荷）；
 *   3. **未安装运行时则静默退出**，不报错、不弹提示。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

/** 总预算：Stop 的事件级 timeout 是 3s，这里留足余量，绝不顶到宿主的上限 */
const STDIN_BUDGET_MS = 800;
const HOOK_BUDGET_MS = 3000;
const MARGIN_MS = 300;

const QUIET = () => {
  try { process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n'); } catch { /* ignore */ }
  process.exit(0);
};

/** 有界读 stdin：hook **绝不能**挂住会话（拿不到就当作空载荷继续） */
function readStdin(timeoutMs) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(data); } };
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (c) => { data += c; if (data.length > 262144) finish(); });
      process.stdin.on('end', finish);
      process.stdin.on('error', finish);
    } catch { return finish(); }
    setTimeout(finish, timeoutMs);
  });
}

(async () => {
  const t0 = Date.now();
  try {
    const runtime = path.join(os.homedir(), '.claude', '.dream', 'bin', 'nudge.cjs');
    if (!fs.existsSync(runtime)) QUIET();               // 未安装引擎 ⇒ 静默

    const kind = process.argv[2] || '';
    const raw = await readStdin(STDIN_BUDGET_MS);

    let input = {};
    try { input = JSON.parse(raw || '{}'); } catch { /* 容忍非 JSON / 半截载荷 */ }

    // ---- 项目归属：用 DSH 自己的自动 slug 索引解析（**不猜**）----
    let slug = '';
    let via = 'unmapped';
    try {
      const ing = require('../src/ingest.cjs');
      const idx = ing.buildSlugIndex();
      const r = ing.resolveProject(input.cwd || '', { slugIndex: idx });
      if (r && r.mapped && r.slug) { slug = r.slug; via = r.via || 'cwd-index'; }
      else via = 'unmapped:' + (r && r.reason ? r.reason : 'no-cwd-or-no-memory-dir');
    } catch (e) {
      via = 'resolve-error:' + (e && e.message ? e.message.slice(0, 60) : 'unknown');
    }

    // DREAM_PROJECT **设了但为空** 表示"明确未映射" —— nudge 据此写 null 而**不回退去猜**
    // （见 dream-plugin/src/nudge.cjs 的 projectProvided 注释）。
    const env = { ...process.env, DREAM_HOST: 'dsh', DREAM_PROJECT: slug, DREAM_PROJECT_VIA: via };

    const left = HOOK_BUDGET_MS - (Date.now() - t0) - MARGIN_MS;
    spawnSync(process.execPath, [runtime, kind], {
      input: raw,                                        // ★ 原样转发（stdin 只能读一次）
      env,
      stdio: ['pipe', 'ignore', 'ignore'],
      windowsHide: true,
      timeout: Math.max(800, left),
    });
  } catch { /* 任何异常都不得影响用户会话 */ }
  QUIET();
})();
