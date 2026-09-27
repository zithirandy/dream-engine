'use strict';
/**
 * risk8.cjs —— V2 风险 8：检测**官方 AutoDream** 是否已启用。
 *
 * 背景（P0 调查结论）：本机 Claude Code 2.1.280 的官方 AutoDream 受
 * GrowthBook gate `tengu_onyx_plover` 控制，且 `DISABLE_TELEMETRY=1` 会
 * 让 GrowthBook 整体关闭 ⇒ gate 回退默认值。我们随后自建了本插件。
 *
 * 风险：若 Anthropic 日后放开 gate（用户已写入 `autoDreamEnabled: true`），
 * **官方与自建会同时改写同一个记忆库** ⇒ 必须能检测并退化为只读审计层。
 *
 * 可用信号（全部本地、无需宿主 API）：
 *   1) settings.json 的 `autoDreamEnabled`（显式开关）
 *   2) 是否存在 `.consolidate-lock`（官方 AutoDream 运行过的**直接痕迹**）
 *   3) settings.json 的 `DISABLE_TELEMETRY`（决定 GrowthBook 层是否可用）
 *   4) 最新 debug 日志中是否出现 dream 相关行（弱信号，仅供参考）
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');

function readSettings() {
  const p = pathsMod.paths();
  const f = path.join(p.claudeHome, 'settings.json');
  if (!fs.existsSync(f)) return { exists: false, path: f };
  try {
    const raw = fs.readFileSync(f, 'utf8');
    const j = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return { exists: true, path: f, json: j, mtime: fs.statSync(f).mtime.toISOString() };
  } catch (e) {
    return { exists: true, path: f, error: e.message };
  }
}

/** 扫描所有项目记忆目录下的 .consolidate-lock */
function findLocks() {
  const p = pathsMod.paths();
  const out = [];
  if (!fs.existsSync(p.projectsRoot)) return out;
  for (const ent of fs.readdirSync(p.projectsRoot, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const mem = path.join(p.projectsRoot, ent.name, 'memory');
    const lock = path.join(mem, '.consolidate-lock');
    if (fs.existsSync(lock)) {
      let st = null;
      try { st = fs.statSync(lock); } catch { /* ignore */ }
      out.push({ project: ent.name, lock, mtime: st ? st.mtime.toISOString() : null, size: st ? st.size : null });
    }
  }
  return out;
}

/** 最新 debug 日志里的 dream 相关行（弱信号） */
function scanDebugLog() {
  const p = pathsMod.paths();
  const dir = path.join(p.claudeHome, 'debug');
  const res = { available: false, file: null, dreamLines: 0, growthBookOff: false, noPayload: false };
  if (!fs.existsSync(dir)) return res;
  let newest = null;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.txt')) continue;
    const full = path.join(dir, f);
    const st = fs.statSync(full);
    if (st.size < 1000) continue;
    if (!newest || st.mtimeMs > newest.mtimeMs) newest = { full, mtimeMs: st.mtimeMs, name: f };
  }
  if (!newest) return res;
  res.available = true;
  res.file = newest.name;
  try {
    const text = fs.readFileSync(newest.full, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (/autoDream|onyx_plover|task_dream|dreaming/i.test(line)) res.dreamLines++;
      if (/GrowthBook is off for this session/.test(line)) res.growthBookOff = true;
      // ★ 决定性证据：GrowthBook **从未拿到 payload**。gate 拿不到 payload 就只能用
      //   **默认值**（autoDream 的 `tengu_onyx_plover` 默认 Off）⇒ 本地开关
      //   `autoDreamEnabled: true` 根本不会被咨询到。
      if (/cold GrowthBook cache, no payload yet/.test(line)) res.noPayload = true;
    }
  } catch { /* ignore */ }
  return res;
}

function detect() {
  const settings = readSettings();
  const locks = findLocks();
  const debug = scanDebugLog();

  const s = (settings.json && settings.json.env) || {};
  const explicit = settings.json ? settings.json.autoDreamEnabled : undefined;
  const telemetryOff = s.DISABLE_TELEMETRY !== undefined && String(s.DISABLE_TELEMETRY) !== '0';
  const hasLock = locks.length > 0;

  // GrowthBook 的 payload 状态是**决定性**证据：gate 拿不到 payload 就停在默认值，
  // 而 autoDream 的 gate（`tengu_onyx_plover`）默认 **Off** ⇒ 本地开关 `autoDreamEnabled`
  // 根本不会被咨询到。故"本地开关为 true"**不足以**推断官方在运行 —— 此前本函数只看
  // 开关与遥测、漏掉 payload 证据，把这种情况误报成 likely-active。
  const gbNoPayload = debug.growthBookOff || debug.noPayload;
  const gbState = debug.growthBookOff ? 'off-for-session'
    : (debug.noPayload ? 'cold-cache-no-payload' : (debug.available ? 'unknown' : 'no-log'));

  const evidence = [
    { signal: 'settings.autoDreamEnabled', value: explicit === undefined ? '(未设置)' : String(explicit) },
    { signal: '.consolidate-lock 数量', value: String(locks.length) },
    { signal: 'DISABLE_TELEMETRY', value: telemetryOff ? '已设置（GrowthBook 会整体关闭）' : '(未设置)' },
    { signal: 'GrowthBook payload', value: gbState },
    { signal: '最新 debug 日志 dream 行', value: debug.available ? `${debug.dreamLines} 行（${debug.file}）` : '(无日志)' },
  ];

  let status; let recommendation;
  if (hasLock) {
    status = 'official-running';
    recommendation = '检测到 .consolidate-lock —— 官方 AutoDream 已在运行。'
      + '本插件应退化为**只读审计层**（不写记忆），由 `signals.conventionPromotable=false` 之外的机制进一步收紧。';
  } else if (explicit === true && gbNoPayload) {
    // 本地开关为 true，但 GrowthBook 没有 payload ⇒ 全部 gate 停在默认值（autoDream=Off）
    status = 'official-configured-gate-closed';
    recommendation = `autoDreamEnabled=true，但 GrowthBook ${debug.noPayload ? '从未拿到 payload（cold cache）' : '整体关闭'}`
      + ' ⇒ 全部 gate 停在**默认值**，而 autoDream 的 gate（`tengu_onyx_plover`）默认 Off'
      + ' ⇒ **官方 AutoDream 当前不会运行**（本地开关不会被咨询到）。'
      + ' 加之 .consolidate-lock 为 0、debug 无 dream 行，可判定无实际冲突。'
      + ' 仍建议保留监控：一旦 GrowthBook 成功拉到 payload，gate 可能被服务端放开。';
  } else if (explicit === true && !telemetryOff) {
    status = 'official-configured-likely-active';
    recommendation = 'autoDreamEnabled=true 且遥测未关、GrowthBook 有可用 payload —— 官方 gate 可能已放开。'
      + '本插件建议切换到只读审计层，并监控是否出现 .consolidate-lock。';
  } else if (explicit === true && telemetryOff) {
    status = 'official-configured-blocked';
    recommendation = 'autoDreamEnabled=true 但 DISABLE_TELEMETRY 已设 —— GrowthBook 整体关闭，'
      + '官方 gate 回退默认值（Off），官方 AutoDream 很可能仍不生效。当前无需退让，建议保留监控。';
  } else if (explicit === undefined) {
    status = 'official-off';
    recommendation = 'autoDreamEnabled 未设置且无锁文件 —— 官方走 GrowthBook 默认值（Off）。'
      + '与自建插件无冲突。';
  } else {
    status = 'official-disabled-explicitly';
    recommendation = 'autoDreamEnabled=false 显式关闭 —— 无冲突。';
  }

  return {
    status, evidence, recommendation,
    conflict: status === 'official-running' || status === 'official-configured-likely-active',
    detail: { explicit, telemetryOff, growthBook: gbState, locks, debug, settingsPath: settings.path, settingsMtime: settings.mtime },
  };
}

module.exports = { detect, readSettings, findLocks, scanDebugLog };
