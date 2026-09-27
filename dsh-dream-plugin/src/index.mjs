/**
 * index.mjs —— DSH（Cordis）插件入口。
 *
 * 本文件是 **ESM**（DSH 各包均为 `"type":"module"`），而适配层与引擎是 CJS，
 * 故用 `createRequire` 加载它们 —— 避免为了加载引擎而把整棵树改成 ESM。
 *
 * API **调用形状**对照官方包源码逐条核对过，不是猜的：
 *   · 插件形状 `export const name / inject / function apply(ctx, config)`
 *     —— 见 `@deepseek-ai/dsh-schedule`、`@deepseek-ai/dsh-tool-ask-user` 的 `lib/index.js`
 *   · 工具注册 `ctx.tools.register(defineTool({…}))`
 *     —— 见 `@deepseek-ai/dsh-tool-ask-user/lib/index.js:15`
 *   · `inject` 需声明依赖的服务名（如 `"tools"`）
 *     —— 见 `@deepseek-ai/dsh-tool-ask-user/lib/index.js:12`
 *   · **`output` 必须带 `schema`，且 `render` 平铺在 `output` 下**（不得嵌进 `output.summary`）
 *     —— 见 `@deepseek-ai/dsh-tool-ask-user/lib/index.js:66-95` 样例；`{type:'json'}` 是
 *        dsh-tools 文档化的 any-JSON 值模式（`schema.d.ts:65/140`、`schema.js:152`）。
 *
 * ⚠️ 历史教训（2026-09-24 真实踩中，装载即崩）：上面第 4 条**最初没核对**，`output` 缺
 *    `schema` 且 `render` 嵌在 `output.summary.render` —— `defineTool` 在 `apply()` 注册期
 *    抛 `JsonSchemaError`，整棵插件树装载失败。根因是**离线测试把 `defineTool` 桩成恒等函数**
 *    （`test/plugin.cjs`），使契约违法在测试中永远不可见；而 `--dump-config` 只组合树不装载。
 *    → 契约校验发生在**注册期**，是**可离线核对的静态契约**，不能归入"装入后的运行行为"。
 *    → `test/plugin.cjs` 的 P5 按源码形状做结构断言可拦住此次具体形状；
 *      但**真校验器**只有装入副本才拿得到（`@deepseek-ai/dsh-tools` 是 peer dep，
 *      源码树不安装），故 README §9 要求安装后跑一次真 `defineTool` 冒烟。
 *
 * ⚠️ **未在本机装入 DSH 验证**（用户明确要求"暂不接线"）。已核对的是上述 API 契约；
 *    未验证的是装入后的运行行为。装入需要改 DSH 的 profile 配置。
 *
 * 三条设计约束（继承自 V2，不得违反）：
 *   1. 引擎只有一份 —— 本插件调用已安装的运行时（`~/.claude/.dream/bin/`），**不复制引擎**；
 *   2. 模型可见面很小 —— 只暴露 `dream_status` / `dream_run`，**不暴露 Jev**；
 *   3. 引擎不含 LLM 客户端。
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { defineTool } from '@deepseek-ai/dsh-tools';

const require = createRequire(import.meta.url);
const ingest = require('./ingest.cjs');
const S = require('./dsh-session.cjs');

export const name = 'autodream-dsh';
export const inject = ['tools'];

const ENGINE_BIN = ingest.enginePath();

function engineReady() {
  try { return fs.existsSync(path.join(ENGINE_BIN, 'cli.cjs')); } catch { return false; }
}

/** 读引擎状态（只读；引擎不在线也能给出本地读数） */
function readStatus() {
  const engine = engineReady();
  const out = { engine, engineBin: ENGINE_BIN, guard: null, counters: null, proposals: null, dsh: null };
  if (!engine) return out;
  try {
    const configMod = require(path.join(ENGINE_BIN, 'config.cjs'));
    const guardMod = require(path.join(ENGINE_BIN, 'guard.cjs'));
    const stateMod = require(path.join(ENGINE_BIN, 'state.cjs'));
    const inboxMod = require(path.join(ENGINE_BIN, 'inbox.cjs'));
    out.guard = guardMod.decideWrite({ cfg: configMod.load().config });
    out.counters = stateMod.read().counters;
    out.proposals = inboxMod.listProposals();
  } catch (e) { out.error = e.message; }
  return out;
}

export function apply(ctx) {
  // ---------- 只读状态 ----------
  ctx.tools.register(defineTool({
    name: 'dream_status',
    description:
      '报告 AutoDream 状态：引擎是否已安装/写入策略（audit 只读 / active 可写）/累计计数/待处理提案。只读，不修改任何东西。',
    parameters: {},
    async execute() {
      const s = readStatus();
      return {
        engineInstalled: s.engine,
        engineBin: s.engineBin,
        writeMode: s.guard ? s.guard.effectiveMode : null,
        writeReason: s.guard ? s.guard.reason : null,
        officialAutoDream: s.guard ? s.guard.officialStatus : null,
        conflict: s.guard ? s.guard.conflict : null,
        counters: s.counters,
        proposals: s.proposals,
        ...(s.error ? { error: s.error } : {}),
      };
    },
    // ★ P4 修复（真实运行时验证发现）：defineTool 契约要求 output.schema（值模式）存在，
    //   且 render 平铺在 output 下（不是 output.summary.render——离线测试曾按错误嵌套自洽断言）。
    //   参照 @deepseek-ai/dsh-tool-ask-user/lib/index.js 的 output 写法。
    output: {
      schema: { type: 'json' },
      render: (_args, v) => [{
        type: 'text',
        text: JSON.stringify({
          engineInstalled: v.engineInstalled,
          writeMode: v.writeMode,
          counters: v.counters,
          proposals: v.proposals,
          ...(v.error ? { error: v.error } : {}),
        }, null, 2),
      }],
    },
  }));

  // ---------- 触发采集（写操作：受 guard 守门） ----------
  ctx.tools.register(defineTool({
    name: 'dream_run',
    description:
      '从 DSH 会话转录采集经验候选并交给引擎提炼。默认 dryRun（只看不写）。'
      + '写入受引擎的 guard 策略守门：audit 模式下只产出候选、不写任何记忆文件。',
    parameters: {
      dry_run: {
        type: 'boolean',
        description: '只统计/预演，不落任何候选与偏移（默认 true）。要真正落盘需显式传 false。',
      },
      force: {
        type: 'boolean',
        description: '忽略增量偏移，从头重读所有 DSH 会话（默认 false）。',
      },
    },
    async execute(args) {
      const dry = args.dry_run !== false;      // 默认 true：安全默认
      const col = ingest.collect({ force: !!args.force });
      const res = ingest.ingestIntoEngine({ dryRun: dry, force: !!args.force });
      return {
        dryRun: dry,
        sessions: col.stats.sessions,
        ingested: col.stats.filesIngested,
        events: col.stats.events,
        skipped: col.stats.skipped,
        skipReasons: [...new Set(col.skipped.map((s) => s.reason))].slice(0, 5),
        candidates: res.engine ? res.engine.candidates : null,
        bySignal: res.engine ? res.engine.bySignal : null,
        engineOk: !!(res.engine && res.engine.ok),
      };
    },
    output: {
      schema: { type: 'json' },
      render: (_args, v) => [{
        type: 'text',
        text: `AutoDream${v.dryRun ? '（dry run，未落盘）' : '（已落盘）'}：`
          + `DSH 会话 ${v.sessions} 个 / 本次采集 ${v.ingested} 个 / 事件 ${v.events} / 跳过 ${v.skipped}`
          + `\n候选 ${v.candidates === null ? '(未产出)' : v.candidates}`
          + (v.bySignal ? `\n按信号 ${JSON.stringify(v.bySignal)}` : '')
          + (v.skipReasons && v.skipReasons.length ? `\n跳过理由：${v.skipReasons.join(' | ')}` : ''),
      }],
    },
  }));

  // ⚠️ 关于"每日自动梦"：DSH 的 Schedule（`@deepseek-ai/dsh-schedule`）是
  //    **agent 作用域的会话内提醒**（durable reminders over the session event log），
  //    **不是系统级 cron** —— 它不能自己去跑一个后台提炼进程。
  //    因此"每日自动梦"在 DSH 侧有两条路：
  //      a) 会话内：用 Schedule 提醒 → 由会话里的 agent 调 `dream_run`；
  //      b) 系统级：用 Windows 计划任务（schtasks）直接跑引擎 CLI，不依赖任何会话。
  //    本插件**不擅自注册** Schedule 任务 —— 那会改变用户的会话行为，需显式同意。
}

/** 供测试与诊断使用（不注册任何东西） */
export const __internals = { readStatus, engineReady, ENGINE_BIN, S };
