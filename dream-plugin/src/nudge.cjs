'use strict';
/**
 * nudge.cjs —— 宿主 hook 的薄转发器（对应 V2 §7.2 与 M4 修正）。
 *
 * 契约：
 *   - 从 stdin 读 hook JSON
 *   - 探活/拉起引擎 → POST /event
 *   - 无论发生什么，都必须快速退出且 exit 0（绝不阻塞用户会话）
 *   - 不用 curl，不用 shell（避免 M4 的中文编码/引号坑）
 *
 * 用法：node nudge.cjs <eventKind>     （eventKind 可省略，从 stdin 的 hook_event_name 推断）
 */
const http = require('http');
const pathsMod = require('./paths.cjs');
const tokenMod = require('./token.cjs');
const spawnMod = require('./spawn.cjs');
const configMod = require('./config.cjs');
const log = require('./log.cjs');
const projectsMod = require('./projects.cjs');

const TOTAL_BUDGET_MS = 8000;

function readStdin(timeoutMs = 1500) {
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

const HOOK_TO_KIND = {
  SessionStart: 'session-start',
  Stop: 'stop',
  SessionEnd: 'session-end',
  UserPromptSubmit: 'prompt-submit',
};

/**
 * ★ P5 修复：把宿主事件名**归一化**成文档化的小写 kind。
 *
 * 修的是什么：原实现是
 *     `const kind = argvKind || HOOK_TO_KIND[input.hook_event_name] || 'unknown'`
 * 而真实路径上 `hooks.json` **恒把事件名作为 argv[2] 传入**（`node hook.cjs Stop`），
 * 于是 `argvKind` 恒为真 ⇒ **`HOOK_TO_KIND` 永不被查** ⇒ 落盘 kind 恒为大写原名
 * （实测 `kind:"Stop"`）。后果是**静默失效**：任何按文档化小写 kind 判定的消费者
 * —— 首先就是 `autoDream.triggerOn: ['session-end','stop']` —— **永不匹配**，
 * 自动梦装了也永远不触发。
 *
 * 归一化优先用 `hook_event_name`（语义最准），退回 argv，再退回小写化，
 * 最后才是 `unknown`。三种输入形态都覆盖，且有单测（见 test/auto.cjs F 组）。
 */
function normalizeKind({ argvKind = null, hookEventName = null } = {}) {
  const raw = hookEventName || argvKind || '';
  if (!raw) return 'unknown';
  return HOOK_TO_KIND[raw] || String(raw).toLowerCase();
}

function postEvent(port, token, payload, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8'); // 显式 UTF-8
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/event',
          method: 'POST',
          timeout: timeoutMs,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': body.length,
            'X-Dream-Token': token,
            Host: `127.0.0.1:${port}`,
          },
        },
        (res) => {
          let out = '';
          res.on('data', (c) => { out += c; });
          res.on('end', () => done({ ok: res.statusCode === 200, status: res.statusCode, body: out }));
        },
      );
    } catch (e) { return done({ ok: false, error: e.message }); }
    req.on('timeout', () => { req.destroy(); done({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => done({ ok: false, error: e.code || e.message }));
    req.write(body);
    req.end();
  });
}

async function main() {
  const started = Date.now();
  const argvKind = process.argv[2];
  const raw = await readStdin();

  let input = {};
  try { input = JSON.parse(raw || '{}'); } catch { /* 容忍非 JSON */ }

  // ★ P5 修复：必须归一化，否则落盘 kind 是大写原名，消费者永不匹配（见 normalizeKind）
  const kind = normalizeKind({ argvKind, hookEventName: input.hook_event_name });
  const cfg = configMod.load().config;
  const port = cfg.server.port;

  // ═══════════════════════════════════════════════════════════════════════
  // ★ DSH 落地（D-P1）：宿主可通过环境变量**显式覆盖** host 与 project。
  //
  //   为什么必须由宿主提供 project：DSH 的 hook 桥（`dsh-hooks-claude-code`）
  //   明确把 `transcript_path` **恒置为空串**（"it is always `''`"），于是下面的
  //   CC 推导第一顺位必失败，退到 `slugFromPath(cwd)` —— 而那是 **CC 的 slug 规则**，
  //   对非 ASCII 路径会算错（`F:\Demo` 推导得 `F--Demo`，真实 CC slug 是 `F--Demo`）。
  //   DSH 侧有自己的**自动 slug 索引**（实测 114/114 会话、0 跳过），应由它解析后传进来。
  //
  //   ⚠️ 关键语义：**"设了但为空" 与 "没设" 必须区分**。
  //      宿主解析失败时会设成空串 —— 那表示"**明确未映射**"，此时**绝不能**回退去猜，
  //      否则会把 DSH 的事件挂到错误项目的记忆上（这正是适配层 `resolveProject()`
  //      "绝不猜"原则的同一条要求）。
  // ═══════════════════════════════════════════════════════════════════════
  const projectProvided = Object.prototype.hasOwnProperty.call(process.env, 'DREAM_PROJECT');
  const slug = projectProvided
    ? (process.env.DREAM_PROJECT || null)                       // 设了：用宿主的判断，空串 ⇒ null（未映射，不猜）
    : (projectsMod.slugFromTranscript(input.transcript_path) || // 没设：维持原有 CC 行为，逐字不变
       (input.cwd ? projectsMod.slugFromPath(input.cwd) : null));

  const payload = {
    kind,
    host: process.env.DREAM_HOST || 'claude-code',
    project: slug,
    sessionId: input.session_id || null,
    cwd: input.cwd || null,
    raw: { hook_event_name: input.hook_event_name || null, projectSource: projectProvided ? 'host-provided' : 'cc-derived' },
  };

  let result = { ok: false, reason: 'skipped' };
  try {
    const ens = await spawnMod.ensureRunning({ port, waitMs: Math.max(1000, TOTAL_BUDGET_MS - (Date.now() - started) - 1200) });
    if (ens.ok) {
      const token = tokenMod.readToken();
      if (token) result = await postEvent(port, token, payload);
      else result = { ok: false, reason: 'no-token' };
    } else {
      result = { ok: false, reason: ens.reason };
    }
  } catch (e) {
    result = { ok: false, reason: 'exception', error: e.message };
    log.warn('nudge failed', { kind, err: e.message });
  }

  // hook 契约：不阻塞、不输出噪音
  process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n');

  // 调试信息只写 daemon.log，不污染 stdout
  log.info('nudge done', { kind, project: slug, ok: result.ok, reason: result.reason, ms: Date.now() - started });
  process.exit(0);
}

if (require.main === module) {
  main().catch(() => {
    try { process.stdout.write(JSON.stringify({ continue: true, suppressOutput: true }) + '\n'); } catch { /* ignore */ }
    process.exit(0);
  });
}

module.exports = { main, HOOK_TO_KIND, normalizeKind };
