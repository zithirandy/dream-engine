'use strict';
/**
 * guard.cjs —— 官方 AutoDream 冲突隔离（V2 风险 8 的处置层）。
 *
 * 背景：本机 `settings.json` 写了 `autoDreamEnabled: true` 且遥测未关，曾据此判断
 * "官方可能已激活"。**该判断是误报** —— GrowthBook 从未拿到 payload（`cold GrowthBook
 * cache, no payload yet`），gate 只能取默认值，而 autoDream 的 gate 默认 **Off**，
 * 本地开关根本不会被咨询到；且全盘 `.consolidate-lock` 为 0。
 * 故 `risk8` 现判 `official-configured-gate-closed` / `conflict = false`。
 *
 * 但隔离层**仍然保留**，理由不是当前有冲突，而是：
 *   1) 官方能力存在于二进制中（本地 dreamTasks / 服务端 /v1/dreams），
 *      GrowthBook 一旦成功拉到 payload，gate 可能被服务端放开；
 *   2) 默认只读是"向保守方向失败"，且写入路径已通过隔离端到端验证（`_write-e2e`）。
 * 官方与本插件仍会改写**同一个记忆库**，故写入必须被守门。
 *
 * 策略（两层，缺一不可）：
 *   1) `config.mode`：`audit`（默认，只读审计层，绝不写记忆）| `active`（允许写入）。
 *      未知值一律按 `audit` 处理 —— 配置写错时向**保守**方向失败。
 *   2) 即使 `active`，若存在**新鲜**的 `.consolidate-lock`（说明官方此刻正在跑），
 *      本次运行仍降级为 audit。锁过旧（超过 `guard.lockStaleMinutes`）视为官方
 *      崩溃残留，不阻塞 —— 否则一次异常退出会永久禁用本插件。
 *
 * 纯函数 `decideWrite()`，便于测试：时间由参数注入，不读全局时钟。
 */
const configMod = require('./config.cjs');
const risk8 = require('./risk8.cjs');

const MODES = ['audit', 'active'];

/**
 * 计算本次运行的写入策略。
 * @param {{cfg?:object, risk?:object, now?:number}} o
 * @returns {{allow:boolean, mode:string, effectiveMode:string, reason:string,
 *            officialStatus:string, conflict:boolean, freshLocks:Array, staleLocks:Array, warnings:Array}}
 */
function decideWrite({ cfg, risk, now = Date.now() } = {}) {
  const c = cfg || configMod.load().config;
  const r = risk || risk8.detect();

  const rawMode = c.mode;
  const mode = MODES.includes(rawMode) ? rawMode : 'audit';
  const modeUnknown = rawMode !== undefined && !MODES.includes(rawMode);

  const staleMin = (c.guard && Number.isFinite(c.guard.lockStaleMinutes)) ? c.guard.lockStaleMinutes : 30;
  const staleMs = staleMin * 60000;

  const locks = (r.detail && r.detail.locks) || [];
  const freshLocks = [];
  const staleLocks = [];
  for (const l of locks) {
    const t = l.mtime ? Date.parse(l.mtime) : NaN;
    if (Number.isFinite(t) && (now - t) < staleMs) freshLocks.push(l);
    else staleLocks.push(l);
  }

  const warnings = [];
  if (modeUnknown) warnings.push(`config.mode 取值非法（${JSON.stringify(rawMode)}）→ 按 audit 处理`);
  for (const l of staleLocks) warnings.push(`忽略过期锁 ${l.project}/.consolidate-lock（mtime ${l.mtime}，超过 ${staleMin} 分钟）`);

  let allow = false;
  let reason;
  if (mode !== 'active') {
    reason = 'config.mode=audit（只读审计层）：只打分与产出候选，不写任何记忆文件';
  } else if (freshLocks.length) {
    reason = `官方 AutoDream 正在运行（${freshLocks.length} 个新鲜 .consolidate-lock）：本次降级为只读审计`;
  } else {
    allow = true;
    reason = 'config.mode=active 且无官方运行痕迹：允许写入记忆';
    if (r.conflict) warnings.push(`官方状态为 ${r.status}（冲突=true）—— 官方可能在两次运行之间，写入仍可能与官方竞争，建议监控 .consolidate-lock`);
  }

  return {
    allow, mode, effectiveMode: allow ? 'active' : 'audit', reason,
    officialStatus: r.status, conflict: !!r.conflict,
    freshLocks, staleLocks, warnings,
    lockStaleMinutes: staleMin,
  };
}

/** doctor 探针：单行摘要 */
function probeLine(policy) {
  const p = policy || decideWrite();
  const tag = p.effectiveMode === 'active' ? '可写' : '只读';
  return `${tag}（mode=${p.mode}, 官方=${p.officialStatus}${p.staleLocks.length ? `, 过期锁 ${p.staleLocks.length}` : ''}）`;
}

module.exports = { decideWrite, probeLine, MODES };
