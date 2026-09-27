'use strict';
/**
 * hook.cjs —— 宿主 hooks.json 的直接入口（对应 V2 §7.2 M4 修正）。
 *
 * hooks.json 应写：
 *   "command": "node \"$HOME/.claude/.dream/bin/hook.cjs\" SessionStart"
 *
 * 本文件只做转发，逻辑全在 nudge.cjs，避免 hook 里出现 shell 引用/编码问题。
 * 无论发生什么，都以 exit 0 结束，绝不阻塞宿主会话。
 */
const nudge = require('./nudge.cjs');

nudge.main().catch(() => {
  try { process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n'); } catch { /* ignore */ }
  process.exit(0);
});
