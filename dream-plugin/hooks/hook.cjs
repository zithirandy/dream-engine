#!/usr/bin/env node
'use strict';
/**
 * hooks/hook.cjs —— Claude Code 插件的**薄转发**（V2 §7.2 / M4 修正）。
 *
 * 职责只有一个：把 hook 事件转交给**已安装的运行时**（`~/.claude/.dream/bin/nudge.cjs`），
 * 由它负责"读 stdin → POST /event → 必要时拉起引擎"。
 *
 * 三条硬性约束：
 *   1. **绝不用 inline `curl -d`**（M4 修正）—— shell 中文编码坑会让事件内容损坏。
 *   2. **绝不阻塞用户会话**：任何异常都静默退出 0，并打印 `{continue:true}`。
 *   3. **未安装运行时则静默退出**（exit 0），不报错、不弹提示。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const QUIET = () => {
  try { process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n'); } catch { /* ignore */ }
  process.exit(0);
};

try {
  const runtime = path.join(os.homedir(), '.claude', '.dream', 'bin', 'nudge.cjs');
  if (!fs.existsSync(runtime)) QUIET();          // 未安装 ⇒ 静默

  const kind = process.argv[2] || '';            // SessionStart / Stop / SessionEnd
  // 超时给足（引擎冷启动需要时间），但总有上界，绝不无限等
  const timeout = kind === 'SessionStart' ? 10000 : 3000;
  const r = spawnSync(process.execPath, [runtime, kind], {
    stdio: ['inherit', 'ignore', 'ignore'],      // stdin 透传给 nudge（它要读 hook JSON）
    windowsHide: true,
    timeout,
  });
  void r;
} catch { /* 任何异常都不得影响用户会话 */ }
QUIET();
