'use strict';
/**
 * cli.cjs —— dreamctl：P0 全部运维护命令。
 *
 *   install    把开发态源码复制到 ~/.claude/.dream/bin/（安装态）
 *   init       建目录 + token + state + config + 扫描项目 + git 化
 *   status     门控/锁/引擎/config 一览
 *   doctor     全面体检（含风险 7 探针）
 *   start      拉起引擎（带 windowsHide）
 *   stop       通过 HTTP 优雅关闭
 *   rollback   列出内容仓库与最近提交（P0 只读；apply 在 P3）
 *   projects   列出/刷新 state.projects
 *   hook       hook 入口（转 nudge.cjs）
 */
const fs = require('fs');
const path = require('path');
const pathsMod = require('./paths.cjs');
const configMod = require('./config.cjs');
const stateMod = require('./state.cjs');
const lockMod = require('./lock.cjs');
const tokenMod = require('./token.cjs');
const spawnMod = require('./spawn.cjs');
const projectsMod = require('./projects.cjs');
const gitops = require('./gitops.cjs');
const log = require('./log.cjs');
const serverMod = require('./server.cjs');

const SRC = __dirname;
const PKG = path.resolve(__dirname, '..', 'package.json');

function hr(title) {
  console.log('\n' + title);
  console.log('-'.repeat(Math.max(8, Math.min(72, title.length + 8))));
}

function ensureDirs() {
  for (const d of pathsMod.dirsToCreate()) fs.mkdirSync(d, { recursive: true });
}

// ---------------------------------------------------------------- install
function cmdInstall() {
  const p = pathsMod.paths();
  ensureDirs();
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.cjs'));
  for (const f of files) fs.copyFileSync(path.join(SRC, f), path.join(p.bin, f));
  fs.copyFileSync(PKG, path.join(p.home, 'package.json'));
  console.log(`已安装 ${files.length} 个模块 → ${p.bin}`);
  console.log(`package.json → ${path.join(p.home, 'package.json')}`);

  // ★ 核验 §5.1：把全量默认值落进 config.json（用户值优先，只补缺失键）
  const mat = configMod.materialize();
  if (mat.ok) {
    console.log(`配置已补全 → ${mat.path}`);
    console.log(`  ${mat.existed ? '已存在，仅补缺失键' : '首次生成'}：新增 ${mat.addedCount} 个键`);
    if (mat.addedCount) {
      const show = mat.added.slice(0, 8).join(', ');
      console.log(`  新增：${show}${mat.addedCount > 8 ? ` …(+${mat.addedCount - 8})` : ''}`);
    }
  } else {
    console.log(`⚠️ 配置补全失败：${mat.reason}${mat.error ? ' — ' + mat.error : ''}`);
    console.log('   （原 config.json 未被改动，请先手工修正其 JSON 语法）');
  }

  // ★ P5：**install 不会重启已运行的守护进程** —— 它会继续跑**旧代码**。
  //
  //   2026-09-24 实测踩中：改掉 `server.cjs` 的 /status 载荷后重装，`/status` 仍返回
  //   已被删掉的死键，我一度以为是"改动没生效"。真相是常驻进程在启动时就把旧模块
  //   载入内存了。这类"改了没反应"极难自查，所以在这里**主动告警**。
  try {
    const lk = lockMod.readLock();
    if (lk && lk.exists && lk.alive && lk.pid !== process.pid) {
      console.log('');
      console.log(`⚠️ 有守护进程正在运行（pid ${lk.pid}）—— 它仍在跑**旧代码**。`);
      console.log(`   要让改动生效：node ${path.join(p.bin, 'cli.cjs')} stop && … start`);
    }
  } catch { /* 告警失败不影响安装 */ }
}

// ---------------------------------------------------------------- init
function cmdInit({ git = true } = {}) {
  const p = pathsMod.paths();
  ensureDirs();

  // token
  tokenMod.ensureToken();

  // config（不覆盖已存在的）
  if (!fs.existsSync(p.config)) {
    fs.writeFileSync(p.config, JSON.stringify(configMod.DEFAULTS, null, 2), 'utf8');
    console.log(`已写入默认配置 → ${p.config}`);
  } else {
    console.log(`配置已存在，保留 → ${p.config}`);
  }

  // state + 项目播种（残余注意项 #2）
  const discovered = projectsMod.scan();
  const st = stateMod.read();
  const { state: next, added, refreshed } = stateMod.mergeProjects(st, discovered);
  stateMod.write(next);

  console.log(`state.json → ${p.state}`);
  console.log(`项目播种：新增 ${added}，刷新 ${refreshed}，共 ${Object.keys(next.projects).length}`);

  // git 化
  let gitResult = null;
  if (git) {
    hr('git 化');
    const targets = [{ label: 'global', dir: p.global }];
    for (const d of discovered) targets.push({ label: d.slug, dir: d.memoryDir });

    const summary = { initialized: 0, already: 0, skipped: 0, empty: 0, failed: [] };
    for (const t of targets) {
      fs.mkdirSync(t.dir, { recursive: true });
      const r = gitops.initRepo(t.dir);
      if (r.ok && r.reason === 'initialized') { summary.initialized++; console.log(`  ✓ ${t.label} — 首次提交完成`); }
      else if (r.ok && r.reason === 'already-repo') { summary.already++; }
      else if (r.ok && r.reason === 'repo-empty-nothing-to-commit') { summary.empty++; console.log(`  · ${t.label} — 空目录，已 init 无提交`); }
      else { summary.skipped++; summary.failed.push({ label: t.label, reason: r.reason, parent: r.parent }); }
    }
    gitResult = summary;
    console.log(`  仓库：新建 ${summary.initialized}，已存在 ${summary.already}，空 ${summary.empty}，跳过 ${summary.skipped}`);
    if (summary.failed.length) {
      console.log('  跳过明细：');
      for (const f of summary.failed.slice(0, 10)) console.log(`    · ${f.label} (${f.reason}${f.parent ? ' → ' + f.parent : ''})`);
    }
  }

  // 首条运行日志
  log.run({
    run: 'init', host: 'cli', projects: Object.keys(next.projects).length,
    git: gitResult, result: 'ok',
  });

  return { projects: Object.keys(next.projects).length, git: gitResult };
}

// ---------------------------------------------------------------- status
function cmdStatus() {
  const p = pathsMod.paths();
  const cfg = configMod.load();
  const st = stateMod.read();
  const lk = lockMod.readLock();

  hr('AutoDream 状态');
  console.log(`DREAM_HOME      ${p.home}`);
  console.log(`配置来源        ${cfg.source}`);
  console.log(`enabled         ${cfg.config.enabled}`);
  console.log(`门控            minHours=${cfg.config.minHours}  throttle=${cfg.config.scanThrottleMinutes}min`);
  console.log(`egress          ${cfg.config.egress}`);
  console.log(`服务            127.0.0.1:${cfg.config.server.port}  requireToken=${cfg.config.server.requireToken}`);
  console.log(`token           ${fs.existsSync(p.token) ? '已生成 (' + tokenMod.readToken().length + ' 字符)' : '缺失'}`);
  console.log(`锁              ${lk.exists ? `PID ${lk.pid} 存活=${lk.alive} 年龄=${Math.round(lk.ageMs / 1000)}s` : '未持有'}`);
  console.log(`lastRunAt       ${st.lastRunAt || '(从未运行)'}`);
  console.log(`lastSpawnAt     ${st.lastSpawnAt || '(无)'}`);
  console.log(`计数器          ${JSON.stringify(st.counters)}`);
  console.log(`项目数          ${Object.keys(st.projects).length}`);
}

function cmdStatusLive() {
  const cfg = configMod.load().config;
  return spawnMod.pingHttp(cfg.server.port, 800);
}

// ---------------------------------------------------------------- doctor
function probeRisk7() {
  // 风险 7 / M6：claude-md-management 是否会改写 ~/.claude/CLAUDE.md
  const p = pathsMod.paths();
  const base = path.join(p.claudeHome, 'plugins', 'cache', 'claude-plugins-official', 'claude-md-management');
  const out = { found: false, versions: [], hooks: [], writesClaudeMd: 'unknown', evidence: [] };
  if (!fs.existsSync(base)) { out.evidence.push('插件缓存目录不存在'); return out; }

  out.found = true;
  for (const v of fs.readdirSync(base)) {
    const dir = path.join(base, v);
    if (!fs.statSync(dir).isDirectory()) continue;
    out.versions.push(v);

    const hooksJson = path.join(dir, 'hooks', 'hooks.json');
    if (fs.existsSync(hooksJson)) {
      const text = fs.readFileSync(hooksJson, 'utf8');
      out.hooks.push({ version: v, file: hooksJson });
      // 粗判：hook 命令里是否出现写盘动作或 CLAUDE.md
      const suspicious = [];
      if (/CLAUDE\.md/.test(text)) suspicious.push('mentions CLAUDE.md');
      if (/\b(write|Write|append|Append|edit|Edit|sed -i|>\s*)/.test(text)) suspicious.push('has write-like verbs');
      if (suspicious.length) out.evidence.push(`hooks.json@${v}: ${suspicious.join(', ')}`);
    }

    // 扫描该插件的 skills/commands 文本
    for (const sub of ['skills', 'commands', 'agents']) {
      const d = path.join(dir, sub);
      if (!fs.existsSync(d)) continue;
      const walk = (dir2) => {
        for (const e of fs.readdirSync(dir2, { withFileTypes: true })) {
          const full = path.join(dir2, e.name);
          if (e.isDirectory()) { walk(full); continue; }
          if (!e.name.endsWith('.md') && !e.name.endsWith('.json')) continue;
          const t = fs.readFileSync(full, 'utf8');
          if (/CLAUDE\.md/.test(t) && /\b(Write|Edit|update|rewrite|rewrite|append|modify)\b/i.test(t)) {
            out.evidence.push(`${sub}/${e.name}: 提到 CLAUDE.md 且有改写语义`);
          }
        }
      };
      walk(d);
    }
  }

  if (out.evidence.length === 0) out.writesClaudeMd = 'no-static-evidence';
  else out.writesClaudeMd = 'possible-see-evidence';
  return out;
}

function cmdDoctor({ json = false } = {}) {
  const p = pathsMod.paths();
  const cfg = configMod.load();
  const st = stateMod.read();
  const report = { checks: [], risk7: null, git: null, projects: null };

  const add = (name, ok, detail) => report.checks.push({ name, ok, detail });

  add('node >= 18', Number(process.versions.node.split('.')[0]) >= 18, process.versions.node);
  add('DREAM_HOME 可写', (() => { try { ensureDirs(); const f = path.join(p.home, '.writetest'); fs.writeFileSync(f, 'x'); fs.unlinkSync(f); return true; } catch { return false; } })(), p.home);
  const tok = tokenMod.readToken();
  add('token 已生成', !!tok && tok.length === 64, tok ? `${tok.length} 字符` : '缺失');
  add('state.json 有效', !!st && st.version === stateMod.STATE_VERSION, `version=${st.version} projects=${Object.keys(st.projects).length}`);
  add('config 已加载', true, cfg.source);
  // ★ 默认值漂移：materialize 保留用户值 ⇒ 改 DEFAULTS 不会生效，必须显式核对
  const driftRes = configMod.drift();
  add('config 默认值无漂移', driftRes.count === 0,
    driftRes.count === 0 ? '默认值已全部落地' : `${driftRes.count} 处差异：${driftRes.diffs.slice(0, 3).map((x) => x.path).join(', ')}${driftRes.count > 3 ? ' …' : ''}（用 config set 落地）`);
  const lk = lockMod.readLock();
  add('锁状态', !lk.exists || lk.alive, lk.exists ? `PID ${lk.pid} alive=${lk.alive} age=${Math.round(lk.ageMs / 1000)}s` : '未持有');

  // 项目扫描
  const discovered = projectsMod.scan();
  report.projects = {
    count: discovered.length,
    inState: Object.keys(st.projects).length,
    needsReview: Object.values(st.projects).filter((x) => x.needsReview).length,
  };
  add('项目已播种', report.projects.count === report.projects.inState, `${report.projects.count} 扫描 / ${report.projects.inState} 在 state`);

  // git 状态
  const repos = [{ label: '(.dream/global)', dir: p.global }].concat(discovered.map((d) => ({ label: d.slug, dir: d.memoryDir })));
  let repoCount = 0; let dirty = 0; const notRepo = [];
  for (const r of repos) {
    if (gitops.isRepo(r.dir)) { repoCount++; if ((gitops.dirtyCount(r.dir) || 0) > 0) dirty++; }
    else notRepo.push(r.label);
  }
  report.git = { total: repos.length, repos: repoCount, dirty, notRepo };
  add('内容目录已 git 化', notRepo.length === 0, `${repoCount}/${repos.length} 是仓库，${dirty} 个有未提交改动`);

  // 风险 8 / P2 冲突隔离：写入策略
  const guardMod = require('./guard.cjs');
  const policy = guardMod.decideWrite({ cfg: cfg.config });
  report.guard = policy;
  add('冲突隔离（官方 AutoDream）', policy.effectiveMode === 'active' || policy.mode === 'audit',
    `${guardMod.probeLine(policy)} — ${policy.reason}`);

  // 风险 7
  report.risk7 = probeRisk7();
  add('风险7（CLAUDE.md 改写）静态探针', true, report.risk7.writesClaudeMd + (report.risk7.evidence.length ? ` | ${report.risk7.evidence.length} 条证据` : ''));

  // ★ 风险 8：官方 AutoDream 是否已启用（是否与自建冲突）
  report.risk8 = require('./risk8.cjs').detect();
  add('风险8（官方 AutoDream 冲突）', !report.risk8.conflict, `${report.risk8.status}${report.risk8.conflict ? ' ⚠️' : ''}`);

  if (json) { console.log(JSON.stringify(report, null, 2)); return report; }

  hr('AutoDream doctor');
  for (const c of report.checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name.padEnd(30)} ${c.detail}`);
  hr('风险 7 探针（claude-md-management 是否改写 CLAUDE.md）');
  console.log(`  插件存在     ${report.risk7.found}`);
  console.log(`  版本         ${report.risk7.versions.join(', ') || '(无)'}`);
  console.log(`  判定         ${report.risk7.writesClaudeMd}`);
  for (const e of report.risk7.evidence) console.log(`    · ${e}`);
  hr('风险 8（官方 AutoDream 是否与自建冲突）');
  console.log(`  状态         ${report.risk8.status}   冲突=${report.risk8.conflict ? '⚠️ 是' : '否'}`);
  for (const e of report.risk8.evidence) console.log(`    · ${e.signal.padEnd(30)} ${e.value}`);
  console.log(`  → ${report.risk8.recommendation}`);
  hr('git 化');
  console.log(`  仓库         ${report.git.repos}/${report.git.total}，未提交 ${report.git.dirty}`);
  if (report.git.notRepo.length) console.log(`  未初始化     ${report.git.notRepo.slice(0, 12).join(', ')}${report.git.notRepo.length > 12 ? ` …(+${report.git.notRepo.length - 12})` : ''}`);
  hr('项目');
  console.log(`  扫描/在册    ${report.projects.count} / ${report.projects.inState}，待复核 ${report.projects.needsReview}`);
  return report;
}

// ---------------------------------------------------------------- start/stop
async function cmdStart() {
  const cfg = configMod.load().config;
  const r = await spawnMod.ensureRunning({ port: cfg.server.port });
  console.log(JSON.stringify(r, null, 2));
  return r;
}

async function cmdStop() {
  const p = pathsMod.paths();
  const cfg = configMod.load().config;
  const token = tokenMod.readToken();
  const probe = await spawnMod.pingHttp(cfg.server.port, 800);
  if (!probe.ok) { console.log('引擎未在运行'); return { ok: true, alreadyStopped: true }; }

  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ confirm: true }), 'utf8');
    const req = require('http').request({
      host: '127.0.0.1', port: cfg.server.port, path: '/shutdown', method: 'POST', timeout: 3000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, 'X-Dream-Token': token, Host: `127.0.0.1:${cfg.server.port}` },
    }, (res) => {
      let out = ''; res.on('data', (c) => { out += c; });
      res.on('end', () => { console.log('已请求关闭：', res.statusCode, out); resolve({ ok: res.statusCode === 200 }); });
    });
    req.on('error', (e) => { console.log('关闭失败：', e.message); resolve({ ok: false, error: e.message }); });
    req.end(body);
  });
}

// ---------------------------------------------------------------- rollback / projects
function cmdRollback() {
  const p = pathsMod.paths();
  const discovered = projectsMod.scan();
  hr('内容仓库与最近提交（P0 只读）');
  const rows = [{ label: '(.dream/global)', dir: p.global }].concat(discovered.map((d) => ({ label: d.slug, dir: d.memoryDir })));
  for (const r of rows) {
    if (!gitops.isRepo(r.dir)) { console.log(`  ${r.label.padEnd(34)} (未版本化)`); continue; }
    const last = gitops.lastCommit(r.dir) || '(无提交)';
    const d = gitops.dirtyCount(r.dir);
    console.log(`  ${r.label.padEnd(34)} ${String(last).padEnd(52)} dirty=${d}`);
  }
  console.log('\n提示：P0 不执行回退动作；apply/rollback 在 P3 实现。');
}

function cmdProjects({ refresh = false, json = false } = {}) {
  const discovered = projectsMod.scan();
  if (refresh) {
    const st = stateMod.read();
    const { state: next, added, refreshed } = stateMod.mergeProjects(st, discovered);
    stateMod.write(next);
    console.log(`已刷新：新增 ${added}，更新 ${refreshed}，共 ${Object.keys(next.projects).length}`);
  }
  if (json) { console.log(JSON.stringify(discovered, null, 2)); return discovered; }

  hr(`项目记忆目录（${discovered.length}）`);
  console.log('  slug'.padEnd(40) + 'files'.padStart(6) + 'idxB'.padStart(8) + 'idxL'.padStart(6) + '  描述');
  for (const d of discovered) {
    console.log('  ' + d.slug.padEnd(38) + String(d.memoryFiles).padStart(6) + String(d.indexBytes).padStart(8) + String(d.indexLines).padStart(6) + '  ' + d.description.slice(0, 46));
  }
  return discovered;
}

// ---------------------------------------------------------------- P1
function cmdIngest({ project = null, force = false, sealAll = false, json = false } = {}) {
  const ing = require('./transcripts.cjs').ingest({ projectFilter: project, force, sealAll });
  if (json) { console.log(JSON.stringify({ stats: ing.stats, perFile: ing.perFile }, null, 2)); return ing; }
  hr('采集（增量）');
  const s = ing.stats;
  console.log(`  文件         ${s.files}`);
  console.log(`  新读字节     ${s.bytesRead}`);
  console.log(`  行           ${s.lines}`);
  console.log(`  事件         ${s.events}`);
  console.log(`  超长行跳过   ${s.oversized}`);
  console.log(`  解析失败     ${s.parseErrors}`);
  console.log(`  轮转重置     ${s.rescans}`);
  console.log(`  尾巴留待下轮 ${s.tailsLeft}`);
  console.log(`  尾巴已封口   ${s.sealed}`);
  if (ing.perFile.length) {
    hr('按文件');
    for (const f of ing.perFile.slice(0, 20)) {
      console.log(`  ${(f.slug + '/' + f.sessionId.slice(0, 8)).padEnd(34)} read=${String(f.bytesRead).padStart(9)} lines=${String(f.lines).padStart(5)} ev=${String(f.events).padStart(5)} tail=${f.tailBytes}${f.tailSealed ? ' (sealed)' : ''}${f.rescan ? ' (rescan)' : ''}`);
    }
    if (ing.perFile.length > 20) console.log(`  …(+${ing.perFile.length - 20})`);
  }
  return ing;
}

function cmdDryrun({ project = null, limit = 20, verbose = false, json = false, maxBytes = null } = {}) {
  const r = require('./pipeline.cjs').run({
    project, dryRun: true, force: true, sealAll: true, verbose, limit,
    maxBytesPerRun: maxBytes,
  });
  if (json) { console.log(JSON.stringify(r, null, 2)); return r; }

  hr('P1 干跑（只看不写）');
  console.log(`  门控         ${r.gate.pass ? 'pass' : 'skip'}  ${r.gate.reasons.join('; ')}`);
  console.log(`  采集         文件 ${r.ingest.files} / 字节 ${r.ingest.bytesRead} / 行 ${r.ingest.lines} / 事件 ${r.ingest.events}`);
  console.log(`  字节预算     ${r.maxBytesPerRun === null ? '无限制' : r.maxBytesPerRun.toLocaleString() + ' B'}` +
    (r.ingest.budgetExhausted ? `  ⚠️ 已触顶，跳过 ${r.ingest.filesSkippedByBudget} 个文件（用 --max-bytes 提高）` : '  未触顶'));
  console.log(`  异常行       超长 ${r.ingest.oversized} / 解析失败 ${r.ingest.parseErrors} / 轮转 ${r.ingest.rescans}`);
  console.log(`  尾巴         留待下轮 ${r.ingest.tailsLeft} / 已封口 ${r.ingest.sealed}`);
  console.log(`  候选         ${r.candidates}${r.truncated ? `（截断前 ${r.candidatesBeforeCap}，超 maxCandidatesPerRun 丢弃 ${r.truncated}）` : ''}（其中已知道 ${r.alreadyKnown}）`);
  console.log(`  信号分布     ${JSON.stringify(r.bySignal)}`);
  console.log(`  耗时         ${r.durationMs} ms`);
  console.log(`  落盘         ${r.saved.saved ? 'YES' : 'NO（干跑）'}`);

  if (r.perProject.length) {
    hr('按项目');
    for (const p of r.perProject.sort((a, b) => b.candidates - a.candidates).slice(0, 25)) {
      console.log(`  ${p.project.padEnd(36)} ev=${String(p.events).padStart(6)} cand=${String(p.candidates).padStart(4)} known=${String(p.alreadyKnown).padStart(4)} idx=${p.existingIndexFiles} aux=${p.existingAuxFiles}`);
    }
  }

  hr(`候选样本（前 ${r.sample.length}）`);
  for (const c of r.sample) {
    console.log(`\n  [${c.id}] ${c.signal} · w=${c.weight} · dup=${c.dupOf ? c.dupOf.file : 'no'}`);
    console.log('    ' + String(c.text).split('\n').join('\n    ').slice(0, 500));
  }
  return r;
}

function cmdCandidates({ limit = 5, json = false } = {}) {
  const store = require('./store.cjs');
  const runs = store.listRuns();
  if (json) { console.log(JSON.stringify(runs.slice(0, limit), null, 2)); return runs; }
  hr(`候选运行索引（${runs.length} 次）`);
  for (const r of runs.slice(0, limit)) {
    console.log(`  ${r.runId}  cand=${String(r.candidates).padStart(4)} rej=${String(r.rejected).padStart(3)}  ${r.ts}`);
  }
  if (!runs.length) console.log('  (尚无运行；先执行 dreamctl extract)');
  return runs;
}

// ---------------------------------------------------------------- P1 分析工具
function cmdStats({ json = false } = {}) {
  const statsMod = require('./stats.cjs');
  const s = statsMod.collect(path.resolve(__dirname, '..'));
  if (json) { console.log(JSON.stringify(s, null, 2)); return s; }
  console.log(statsMod.render(s));
  return s;
}

function cmdSupport({ signal = null, minSupport = 1, threshold = 0.6, limit = 25, json = false } = {}) {
  const store = require('./store.cjs');
  const supportMod = require('./support.cjs');
  const cands = store.loadCandidates({ limit: 50 });
  const r = supportMod.analyze(cands, { signal, minSupport, threshold });

  if (json) { console.log(JSON.stringify(r, null, 2)); return r; }

  hr(`复现度聚合（输入 ${r.input} 条 → ${r.clusters} 簇，support≥${minSupport} 保留 ${r.kept} 簇${signal ? '，信号=' + signal : ''}）`);
  console.log('  按信号：' + JSON.stringify(r.bySignal));
  console.log('');
  console.log('  support  成员  信号            文本');
  console.log('  -------  ----  --------------  ----');
  for (const c of r.filtered.slice(0, limit)) {
    const t = (c.text || '').replace(/\n/g, ' ').slice(0, 78);
    console.log(`  ${String(c.support).padStart(7)}  ${String(c.members).padStart(4)}  ${c.signal.padEnd(14)}  ${t}`);
  }
  if (r.filtered.length > limit) console.log(`  …(+${r.filtered.length - limit})`);
  return r;
}

function cmdLabel({ signal = null, n = 60, json = false } = {}) {
  const labeling = require('./labeling.cjs');
  const r = labeling.makeSheet({ signal, n });
  if (json) { console.log(JSON.stringify(r, null, 2)); return r; }
  if (!r.ok) { console.log('生成失败：' + r.reason); return r; }
  hr('精度标注表已生成');
  console.log(`  文件    ${r.file}`);
  console.log(`  抽取    ${r.picked} / ${r.pool}（等距，step=${r.step}）`);
  console.log('');
  console.log('  下一步：在表格「判定」列填 好 / 边缘 / 噪声，然后执行');
  console.log(`    node "${process.argv[1]}" precision --file "${r.file}"`);
  return r;
}

function cmdPrecision({ file = null, json = false } = {}) {
  const labeling = require('./labeling.cjs');
  if (!file) { console.log('用法：dreamctl precision --file <标注表路径>'); return { ok: false }; }
  const r = labeling.score({ file });
  if (json) { console.log(JSON.stringify(r, null, 2)); return r; }
  console.log(labeling.renderScore(r));
  return r;
}

function cmdCompare({ a = null, b = null, json = false } = {}) {
  const labeling = require('./labeling.cjs');
  if (!a || !b) { console.log('用法：dreamctl compare --a <预标表> --b <用户标注表>'); return { ok: false }; }
  const r = labeling.compare({ a, b });
  if (json) { console.log(JSON.stringify(r, null, 2)); return r; }
  console.log(labeling.renderCompare(r));
  return r;
}

function cmdRisk8({ json = false } = {}) {
  const r = require('./risk8.cjs').detect();
  if (json) { console.log(JSON.stringify(r, null, 2)); return r; }
  hr('风险 8：官方 AutoDream 检测');
  console.log(`  状态         ${r.status}`);
  console.log(`  与自建冲突   ${r.conflict ? '⚠️ 是' : '否'}`);
  for (const e of r.evidence) console.log(`  · ${e.signal.padEnd(32)} ${e.value}`);
  console.log('');
  console.log('  ' + r.recommendation);
  return r;
}

// ---------------------------------------------------------------- P2 前置
async function cmdJevTest({ sizes = [8, 32, 128], project = null, dry = false, json = false } = {}) {
  const jev = require('./jev.cjs');
  const store = require('./store.cjs');
  const cfg = configMod.load().config;

  const all = store.loadCandidates({ limit: 50 });
  if (!all.length) { console.log('无候选，先跑 extract。'); return { ok: false, reason: 'no-candidates' }; }

  // 选候选最多的项目（保证同一项目、同一 digest，比较才有意义）
  let pool = all;
  if (project) pool = all.filter((c) => c.project === project);
  else {
    const byProj = {};
    for (const c of all) byProj[c.project] = (byProj[c.project] || 0) + 1;
    const top = Object.entries(byProj).sort((a, b) => b[1] - a[1])[0];
    project = top[0];
    pool = all.filter((c) => c.project === project);
  }

  const keyInfo = jev.readApiKey(cfg);
  hr('Jev batchSize 实测（V2 风险 3）');
  console.log(`  项目         ${project}（候选 ${pool.length}）`);
  console.log(`  端点         ${cfg.jev.endpoint}`);
  console.log(`  模型         ${cfg.jev.model}`);
  console.log(`  密钥         ${keyInfo.ok ? '已读取 ← ' + keyInfo.from : '❌ ' + keyInfo.reason}`);
  const egMode = require('./jev.cjs').egressOf(cfg);
  console.log(`  模式         ${dry ? 'DRY（只构造与预检，不出网）'
    : (egMode === 'off' ? 'SKIP（egress=off：硬开关拦截，不会出网）' : `REAL（真实调用 · egress=${egMode}）`)}`);
  console.log(`  尺寸         ${sizes.join(' / ')}`);

  const rows = [];
  let bestAnswers = null;
  let bestSize = 0;
  let bestModel = null;   // 最大成功批次的模型名（写入结果文件，供 --from-results 写 frontmatter）

  for (const size of sizes) {
    const picked = pool.slice(0, Math.min(size, pool.length));
    const signalById = Object.fromEntries(picked.map((c) => [c.id, c.signal]));
    const { payload, idMap, egressHits } = jev.buildRequest(picked, { project, cfg });
    const shape = jev.validateShape(payload);
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');

    if (!shape.ok) {
      console.log(`\n  [${size}] ❌ 形状预检失败：${shape.errs.slice(0, 3).join('; ')}`);
      rows.push({ size, ok: false, reason: 'shape-invalid', errs: shape.errs, payloadBytes });
      continue;
    }

    const audit = jev.auditPayload(payload, `jevtest-${size}`);
    if (dry) {
      console.log(`\n  [${size}] DRY ✓ 预检通过 · 问题数 ${shape.questionCount} · payload ${payloadBytes} B · 脱敏命中 ${JSON.stringify(egressHits)}`);
      console.log(`        审计已写 ${audit}`);
      rows.push({ size, ok: true, dry: true, questionCount: shape.questionCount, payloadBytes, egressHits });
      continue;
    }

    const r = await jev.callAdaptive(picked, {
      cfg,
      tag: `jevtest-${size}`,
      onNote: (m) => console.log(m),
    });
    if (!r.ok && !r.results.length) {
      const first = r.batches[0] || {};
      console.log(`\n  [${size}] ❌ 未取得任何答案（calls=${r.calls} status=${first.status || '-'}）`);
      rows.push({ size, ok: false, status: first.status, calls: r.calls, blocked: r.blocked.length, latencyMs: r.latencyMs, payloadBytes });
      continue;
    }

    const per = r.results;
    const okCount = per.filter((x) => x.ok).length;
    const costUsd = (r.tokensIn / 1e6) * 0.042;
    console.log(`\n  [${size}] ✓ ${r.latencyMs} ms · ${r.model} · 调用 ${r.calls} 次 · in=${r.tokensIn} out=${r.tokensOut} · 答案 ${okCount}/${picked.length} · 被 WAF 拦 ${r.blocked.length} · 约 $${costUsd.toFixed(5)}`);
    console.log(`        审计 ${audit}`);
    rows.push({
      size, ok: true, latencyMs: r.latencyMs, model: r.model, calls: r.calls,
      tokensIn: r.tokensIn, tokensOut: r.tokensOut, answers: okCount, expected: picked.length,
      blocked: r.blocked.length, blockedSignals: r.blocked.reduce((m, b) => { m[b.signal || '?'] = (m[b.signal || '?'] || 0) + 1; return m; }, {}),
      costUsd, payloadBytes, questionCount: shape.questionCount, batches: r.batches,
    });

    if (picked.length > bestSize) { bestSize = picked.length; bestAnswers = per; bestModel = r.model || null; }
  }

  // ---- 阈值标定（用最大成功批次）----
  let calibration = null;
  if (bestAnswers && bestAnswers.length) {
    calibration = calibrate(bestAnswers, cfg);
    // 保存逐候选结果，供后续离线分析（不必重复花钱调用）
    try {
      const p2 = pathsMod.paths();
      const outFile = require('path').join(p2.reports, `jevtest-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      require('fs').mkdirSync(p2.reports, { recursive: true });
      // ★ 必须存 `model`：`--from-results` 落盘时要用它写 frontmatter 的 `jevModel`，
      //   否则记忆文件里会写成 `jevModel: unknown`（实测首次真实写入就是这样）。
      require('fs').writeFileSync(outFile, JSON.stringify({
        ts: new Date().toISOString(), project, model: bestModel || null,
        cfg: { weights: cfg.weights, gates: cfg.gates, thresholds: cfg.thresholds },
        results: bestAnswers,
      }, null, 2), 'utf8');
      console.log(`\n  逐候选结果已保存 → ${outFile}`);
    } catch (e) { console.log(`  （结果保存失败：${e.message}）`); }

    hr('promote 阈值标定（V2 前置第 6 项：纯数学、无需出网）');
    console.log(`  样本         ${bestAnswers.length} 条（最大成功批次）`);
    console.log(`  分数分布     ${calibration.dist}`);
    console.log('');
    console.log('  各维度分布（判断哪个问题在给中庸答案）：');
    for (const [k, v] of Object.entries(calibration.dims)) {
      console.log(`    ${k.padEnd(14)} min=${String(v.min).padEnd(6)} p25=${String(v.p25).padEnd(6)} p50=${String(v.p50).padEnd(6)} p75=${String(v.p75).padEnd(6)} max=${v.max}`);
    }
    console.log(`  kind 分布    ${JSON.stringify(calibration.kindDist)}`);
    console.log('');
    console.log('  闸门归因     ' + JSON.stringify(calibration.gateFail));
    console.log('');
    console.log('  阈值    过硬门槛  仅复合分  仅reusable');
    for (const row of calibration.rows) {
      console.log(`  ${String(row.threshold.toFixed(2))}    ${String(row.withGates).padStart(6)}   ${String(row.scoreOnly).padStart(6)}   ${String(row.reusableOnly).padStart(8)}`);
    }
    console.log('');
    console.log('  按信号（过硬门槛者）：' + JSON.stringify(calibration.bySignalPass));
    console.log('  ' + calibration.note);
  }

  const out = { ok: true, project, dry, sizes, rows, calibration };
  if (json) console.log(JSON.stringify(out, null, 2));
  return out;
}

/** 阈值标定：给定真实 Jev 答案，算出各 promote 阈值下的通过量 + 各维度分布 + 闸门归因 */
function calibrate(per, cfg) {
  const ok = per.filter((x) => x.ok);
  const n = ok.length;
  if (!n) return { n: 0, rows: [], dist: '(无有效答案)', bySignalPass: {}, note: '', dims: {}, kindDist: {}, gateFail: {} };

  const stat = (vals) => {
    const s = vals.slice().sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
    const r3 = (x) => Number((x === undefined ? 0 : x).toFixed(3));
    return { min: r3(s[0]), p25: r3(q(0.25)), p50: r3(q(0.5)), p75: r3(q(0.75)), max: r3(s[s.length - 1]) };
  };

  const scores = ok.map((x) => x.score);
  const sorted = scores.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(n - 1, Math.floor(p * n))];
  const dist = `min=${sorted[0].toFixed(3)} p25=${q(0.25).toFixed(3)} p50=${q(0.5).toFixed(3)} p75=${q(0.75).toFixed(3)} max=${sorted[n - 1].toFixed(3)}`;

  // 各维度分布（判断"哪个问题在给中庸答案"）
  const dims = {
    reusable: stat(ok.map((x) => x.n.reusable)),
    nontrivial: stat(ok.map((x) => x.n.nontrivial)),
    still_true: stat(ok.map((x) => x.n.still_true)),
    durabilityRaw: stat(ok.map((x) => x.n.durabilityRaw)),
  };

  // kind 分布
  const kindDist = {};
  for (const x of ok) kindDist[x.kind] = (kindDist[x.kind] || 0) + 1;

  // 闸门归因：谁在挡
  const g = cfg.gates || { stillTrueMin: 0.8, reusableMin: 0.7 };
  const gateFail = {
    still_true: ok.filter((x) => x.n.still_true < g.stillTrueMin).length,
    reusable: ok.filter((x) => x.n.reusable < g.reusableMin).length,
    both: ok.filter((x) => x.n.still_true < g.stillTrueMin && x.n.reusable < g.reusableMin).length,
    passed: ok.filter((x) => x.passHardGates).length,
  };

  const thresholds = [0.50, 0.55, 0.60, 0.65, 0.70];
  const rows = thresholds.map((t) => ({
    threshold: t,
    scoreOnly: ok.filter((x) => x.score >= t).length,
    withGates: ok.filter((x) => x.score >= t && x.passHardGates).length,
    // 若把硬门槛换成"仅 reusable"，通过量是多少（用于给出可调方向）
    reusableOnly: ok.filter((x) => x.score >= t && x.n.reusable >= g.reusableMin).length,
  }));

  const passers = ok.filter((x) => x.passHardGates);
  const bySignalPass = {};
  for (const x of passers) bySignalPass[x.signal] = (bySignalPass[x.signal] || 0) + 1;

  const binding = gateFail.still_true >= gateFail.reusable ? 'still_true' : 'reusable';
  const note = `硬门槛（still_true≥${g.stillTrueMin} 且 reusable≥${g.reusableMin}）砍掉 ${gateFail.still_true + gateFail.reusable - gateFail.both}/${n}；`
    + ` 主要约束是 **${binding}**（单独不达标 ${binding === 'still_true' ? gateFail.still_true : gateFail.reusable} 条）。`
    + ` still_true 的中位数仅 ${dims.still_true.p50} —— 若 codebaseDigest 过于单薄，该问题本就不具备可答性，闸门会恒不通过。`;

  return { n, dist, rows, bySignalPass, note, dims, kindDist, gateFail, hardGatePassRate: gateFail.passed / n };
}

function cmdGuard({ json = false } = {}) {
  const guardMod = require('./guard.cjs');
  const policy = guardMod.decideWrite({ cfg: configMod.load().config });
  if (json) { console.log(JSON.stringify(policy, null, 2)); return policy; }
  hr('冲突隔离：写入策略（P2 核验清单 #1）');
  console.log(`  有效模式     ${policy.effectiveMode}${policy.effectiveMode !== policy.mode ? `（配置为 ${policy.mode}，本次降级）` : ''}`);
  console.log(`  官方状态     ${policy.officialStatus}${policy.conflict ? '  ⚠️ 冲突=true' : ''}`);
  console.log(`  允许写记忆   ${policy.allow ? '是' : '否'}`);
  console.log(`  新鲜锁       ${policy.freshLocks.length} 个${policy.freshLocks.length ? '：' + policy.freshLocks.map((l) => l.project).join(', ') : ''}`);
  console.log(`  过期锁       ${policy.staleLocks.length} 个（阈值 ${policy.lockStaleMinutes} 分钟）`);
  console.log(`  判定         ${policy.reason}`);
  for (const w of policy.warnings) console.log(`  ⚠️ ${w}`);
  return policy;
}

// ---------------------------------------------------------------- P2 自动梦
async function cmdDream(opts = {}) {
  const p2 = require('./p2.cjs');
  const r = await p2.autoDream(opts);
  if (opts.json) { console.log(JSON.stringify(r, null, 2)); return r; }
  hr('P2 自动梦（打分 → 决策 → 提升 → G2 分发）');
  console.log(`  写入策略     ${r.policy.effectiveMode}${r.policy.allow ? '' : '（不写记忆）'}  — ${r.policy.reason}`);
  console.log(`  官方状态     ${r.policy.officialStatus}${r.policy.conflict ? ' ⚠️ 冲突' : ''}`);
  console.log(`  候选池       ${r.candidatesInPool} 条，其中已打分 ${r.alreadyScored} 条 → 本轮选 ${r.selected} 条${r.fromResults ? `（来源：已保存答案 ${require('path').basename(r.fromResults)}）` : ''}`);
  if (r.skipped) {
    console.log(`  跳过         ${r.reason}`);
    console.log(`  耗时         ${r.durationMs} ms`);
    return r;
  }
  console.log(`  Jev          ${r.scoring.calls} 次调用 · in=${r.scoring.tokensIn} out=${r.scoring.tokensOut} · ${r.scoring.latencyMs} ms · ${r.scoring.model || '-'}`);
  console.log(`  决策         promote ${r.decisions.promote} · hold ${r.decisions.hold} · reject ${r.decisions.reject}`);
  console.log(`  按理由       ${JSON.stringify(r.decisions.byReason)}`);
  console.log(`  提升         ${r.applied.promoted.filter((x) => x.ok).length} 条（全局经验 ${r.applied.globalExperiences.length} 条）`);
  for (const x of r.applied.promoted.filter((y) => y.ok)) console.log(`    ✓ [${x.kind}] ${x.name} → ${x.file}`);
  if (r.applied.refused) console.log(`  ⚠️ 未写记忆：${r.applied.refused}`);
  if (r.applied.dryRun) for (const x of r.applied.promoted) console.log(`    (dry) ${x.candId} score=${x.score} ${x.signal}`);
  console.log(`  G2           ${r.g2.calls} 次调用 · 评估 ${r.g2.evaluated} 个项目 · 命中 ${r.g2.hits.length} · 写指针 ${r.g2.applied.length}${r.g2.reason ? ` · ${r.g2.reason}` : ''}`);
  for (const a of r.g2.applied) console.log(`    ✓ ${a.project} ← ${a.action}`);
  console.log(`  已打分落账   ${r.saved && r.saved.appended ? r.saved.appended + ' 条 → scores.jsonl' : JSON.stringify(r.saved)}`);
  if (r.resultsFile) console.log(`  逐候选结果   ${r.resultsFile}`);
  console.log(`  耗时         ${r.durationMs} ms`);
  return r;
}

// ---------------------------------------------------------------- P5 自动梦

/**
 * `auto` 子命令 —— 自动梦的运维面。
 *
 * ⚠️ CLI 是**独立进程**，读不到守护进程里调度器的内存状态。所以这里做的是
 *    "**用同一套纯门控**在本地重算一次判定" —— 得到的答案与守护进程一致
 *    （因为 `decide()` 是纯函数、输入相同），并且能回答操作员最关心的问题：
 *    **现在会不会跑？不会的话，卡在哪一条？**
 */
async function cmdAuto({ op = 'status', force = false, dry = false, json = false } = {}) {
  const autoMod = require('./auto.cjs');
  const pathsMod = require('./paths.cjs');
  const lockMod = require('./lock.cjs');

  const { config: cfg, source } = configMod.load();
  const offs = autoMod.readAutoOffsets();
  const state = stateMod.read();
  const pending = autoMod.readPending({ file: pathsMod.paths().pendingEvents, fromOffset: offs.pendingOffset });
  const lock = lockMod.readLock();
  const a = cfg.autoDream || {};

  const verdict = autoMod.decide({
    cfg, state, pending, lock, nowMs: Date.now(), running: false, selfPid: process.pid, force,
    // 仅"运维显式 --force 跑一次"允许没有未消费事件（等价于 dreamctl dream 的人工意图）。
    // 不带 --force 时**不能**放开 —— 否则 `auto once` 会在安静期意外跑一轮付费梦。
    allowNoEvents: force && op === 'once',
  });

  // 最近几轮自动梦（读专用日志，不解析 daemon.log）
  let recent = [];
  try {
    const f = pathsMod.paths().autoLog;
    if (fs.existsSync(f)) {
      recent = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-5)
        .map((l) => { try { return JSON.parse(l); } catch { return { malformed: l.slice(0, 120) }; } });
    }
  } catch { /* ignore */ }

  if (op === 'once') {
    if (!verdict.pass) {
      if (json) { console.log(JSON.stringify({ ok: false, refused: true, verdict }, null, 2)); return { ok: false, verdict }; }
      hr('P5 自动梦 · once（被拒）');
      console.log(`  判定        不执行 —— 理由：${verdict.reasons.join(' · ')}`);
      console.log('  提示        加 --force 可在"已到间隔/未静默"时强制跑（仍不能绕过 enabled=false）');
      if (verdict.reasons.includes('auto-dream-disabled')) {
        console.log('              开启：node cli.cjs config set autoDream.enabled=true');
      }
      return { ok: false, verdict };
    }
    // `--dry` ⇒ 只打分不写记忆（等价于把这一轮的 guard 强制成 audit）
    const runCfg = dry ? { ...cfg, autoDream: { ...a, dryRun: true } } : cfg;
    if (!json) {
      hr(dry ? 'P5 自动梦 · once（空跑：不打分、不出网、不写记忆）' : 'P5 自动梦 · once（真实跑一轮）');
      console.log(`  触发         ${verdict.reasons.includes('force-bypass') ? '--force' : '门控通过'} · 待决事件 ${pending.events.length} 条`);
    }
    const rec = await autoMod.runRound({ cfg: runCfg, reason: 'cli-once', force });
    if (json) { console.log(JSON.stringify(rec, null, 2)); return rec; }
    console.log(`  结果         ${rec.ok ? '✅ 完成' : '❌ 失败'} · 阶段 ${rec.phase} · 耗时 ${rec.durationMs} ms`);
    if (rec.harvest) console.log(`  采集         ok=${rec.harvest.ok} skipped=${rec.harvest.skipped} 候选=${rec.harvest.candidates} ${rec.harvest.gate ? JSON.stringify(rec.harvest.gate) : ''}`);
    if (rec.dream) {
      console.log(`  写入策略     ${rec.dream.policy ? rec.dream.policy.effectiveMode : '-'}${rec.dream.policy && rec.dream.policy.allow ? '' : '（不写记忆）'}`);
      console.log(`  打分/决策    选中 ${rec.dream.selected} · Jev ${rec.dream.jevCalls} 次 · ${JSON.stringify(rec.dream.decisions)}`);
      console.log(`  提升         ${rec.dream.promoted} 条${rec.dream.refused ? ` · 未写记忆：${rec.dream.refused}` : ''}`);
      if (rec.dream.skipped) console.log(`  跳过         ${rec.dream.reason}`);
    }
    if (rec.error) console.log(`  错误         [${rec.phase}] ${rec.error}`);
    return rec;
  }

  // ---- status ----
  if (json) {
    console.log(JSON.stringify({ config: a, configSource: source, offsets: offs, pending: { events: pending.events.length, kinds: verdict.detail.kinds }, verdict, state: { lastAutoDreamAt: state.lastAutoDreamAt, counters: state.counters, lastAutoDreamError: state.lastAutoDreamError }, lock, recent }, null, 2));
    return { verdict };
  }
  hr('P5 自动梦 · status');
  console.log(`  开关         ${a.enabled ? '✅ 已开启' : '⛔ 已关闭（默认）'}${a.dryRun ? ' · 空跑（不打分不出网不写记忆）' : ''}`);
  console.log(`  配置来源     ${source}`);
  console.log(`  触发事件     ${(a.triggerOn || []).join(', ')} · 静默 ${a.idleMinutes} 分钟 · 最小间隔 ${a.minIntervalMinutes} 分钟 · 至少 ${a.minEvents} 个事件`);
  console.log(`  免静默事件   ${(a.idleExemptKinds || []).length ? (a.idleExemptKinds || []).join(', ') + '（视为已静默，不等观察期）' : '（无 —— 所有事件都要等静默期）'}`);
  console.log(`  先采集       ${a.harvestFirst === false ? '否（⚠ 只能对旧候选池打分）' : `是${a.harvestIgnoreMinHours === false ? '（受 24h 采集中枢约束）' : ' · **绕过 24h minHours**，保留 10min 抖动节流'}`}`);
  console.log('');
  console.log(`  未消费事件   ${pending.events.length} 条${pending.events.length ? ` · 类型 ${verdict.detail.kinds.join('|')}` : ''}${pending.truncated ? ' · ⚠ 检测到文件截断，偏移已归零' : ''}`);
  console.log(`  消费偏移     ${offs.pendingOffset} B · 上次消费 ${offs.lastRunAt || '从未'}${offs.primed ? ' · 已预热（历史事件不计为触发）' : ''}`);
  if (!offs.updatedAt && pending.events.length) {
    console.log(`              ⓘ 尚未预热：守护进程首次启动时会把这 ${pending.events.length} 条**历史事件**记为已消费，不触发做梦`);
  }
  {
    const cap = Number(a.pendingEventsMaxBytes) || 2097152;
    const sz = pending.size || 0;
    console.log(`  事件文件     ${(sz / 1024).toFixed(1)} KB / 上限 ${(cap / 1024 / 1024).toFixed(1)} MB（${((sz / cap) * 100).toFixed(1)}%）${offs.rotatedAt ? ` · 上次轮转 ${offs.rotatedAt}` : ''}`);
  }
  console.log(`  上次自动梦   ${state.lastAutoDreamAt || '从未'}${state.lastAutoDreamOk === false ? ' ⚠ 上次失败' : ''}`);
  console.log(`  计数         autoRuns=${(state.counters || {}).autoRuns || 0} autoFailures=${(state.counters || {}).autoFailures || 0}`);
  if (state.lastAutoDreamError) console.log(`  最近错误     [${state.lastAutoDreamError.phase}] ${state.lastAutoDreamError.error} @ ${state.lastAutoDreamError.at}`);
  console.log(`  守护锁       ${lock.exists ? (lock.alive ? `pid ${lock.pid}（存活）` : `pid ${lock.pid}（已死，视为残留）`) : '无'}`);
  console.log('');
  console.log(`  ▶ 现在会跑吗 ${verdict.pass ? '✅ 会（下一 tick 即执行）' : '⛔ 不会'}`);
  if (!verdict.pass) for (const r of verdict.reasons) console.log(`      · ${r}`);
  if (verdict.detail.idleMinutes !== null) console.log(`      静默时长 ${verdict.detail.idleMinutes} 分钟 · 距上次自动梦 ${verdict.detail.sinceLastAutoMinutes ?? '—'} 分钟`);
  if (recent.length) {
    console.log('');
    console.log('  最近几轮：');
    for (const r of recent) console.log(`    ${r.ts} ${r.ok ? '✅' : '❌'} ${r.reason} ${r.durationMs}ms ${r.error ? '— ' + r.error : ''}`);
  }
  return { verdict };
}

// ---------------------------------------------------------------- P3 手动梦
/**
 * P3 四步：prepare → （宿主模型产提案）→ validate → apply。
 * 引擎只当裁判与执行者，**不含任何 LLM 客户端**。
 */
function cmdPrepare({ mode = 'manual', json = false } = {}) {
  const inboxMod = require('./inbox.cjs');
  const pruned = inboxMod.pruneApplied();       // 顺手清理过期归档（30 天）
  const r = inboxMod.writeInbox({ mode });
  if (json) { console.log(JSON.stringify({ ...r, pruned }, null, 2)); return r; }
  hr('P3 手动梦 · prepare');
  console.log(`  inbox 已写出 → ${r.file}`);
  console.log(`  汇总         项目 ${r.stats.projects} 个 · 经验 ${r.stats.experiences} 条 · 全局 ${r.stats.global} 条 · 待决候选 ${r.stats.pendingCandidates} 条`);
  const f = r.findings;
  console.log(`  线索         疑似重复 ${f.nearDuplicates.length} · 同主题成对 ${f.topicClusters.length} · 矛盾线索 ${f.contradictionHints.length} · 索引超限 ${f.indexOverflow.length} · 界标异常 ${f.malformedIndex.length} · 未索引文件 ${f.unindexed.length} · 全局未分发 ${f.globalNotFanout.length}`);
  if (f.malformedIndex.length) console.log('  🔴 存在界标不配对，受控区块写入会被拒绝，需先人工修复');
  console.log('');
  console.log('  下一步：受限子代理读该 inbox → 产出提案 → 写 proposals/proposal-<ts>.json');
  console.log(`         然后：node "${process.argv[1]}" validate <提案文件>`);
  return r;
}

function cmdValidate({ file, json = false } = {}) {
  const proposalMod = require('./proposal.cjs');
  if (!file) { console.log('用法：validate <提案文件>'); return { ok: false, reason: 'no-file' }; }
  let prop;
  try { prop = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.log(`❌ 提案不是合法 JSON：${e.message}`); return { ok: false, reason: 'invalid-json', error: e.message }; }
  const r = proposalMod.validateProposal(prop);
  if (json) { console.log(JSON.stringify(r, null, 2)); return r; }
  hr('P3 手动梦 · validate');
  if (r.ok) {
    console.log('  ✅ 通过');
    console.log(`  操作统计     ${JSON.stringify(r.stats.byType)}`);
    if (r.warnings.length) { console.log('  警告：'); for (const w of r.warnings) console.log(`    ⚠️ ${w}`); }
    console.log(`\n  下一步：node "${process.argv[1]}" apply ${file}            # 展示 diff 后落盘`);
    console.log(`          node "${process.argv[1]}" apply ${file} --yes      # 跳过确认`);
  } else {
    console.log(`  ❌ 校验失败（${r.errors.length} 处）—— 按下列结构化错误修正后重试：`);
    for (const e of r.errors) console.log(`    ${e.path}\n      期望 ${e.expected}\n      实际 ${e.got}`);
    if (r.warnings.length) { console.log('  警告：'); for (const w of r.warnings) console.log(`    ⚠️ ${w}`); }
  }
  return r;
}

function cmdApply({ file, yes = false, dry = false, json = false } = {}) {
  const proposalMod = require('./proposal.cjs');
  const applyMod = require('./apply.cjs');
  if (!file) { console.log('用法：apply <提案文件> [--yes] [--dry]'); return { ok: false, reason: 'no-file' }; }
  let prop;
  try { prop = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { console.log(`❌ 提案不是合法 JSON：${e.message}`); return { ok: false, reason: 'invalid-json' }; }
  const v = proposalMod.validateProposal(prop);
  if (!v.ok) { console.log(`❌ 提案未通过校验（${v.errors.length} 处），先跑 validate`); return { ok: false, reason: 'validation-failed', errors: v.errors }; }

  const r = applyMod.applyProposal(prop, { confirm: yes, dryRun: dry, proposalName: path.basename(file) });
  if (json) { console.log(JSON.stringify(r, null, 2)); return r; }
  hr('P3 手动梦 · apply');
  const pl = r.planned;
  console.log(`  计划        新建 ${pl.summary.creates} · 更新 ${pl.summary.updates} · 删除 ${pl.summary.deletes} · 指针 +${pl.summary.pointerAdds}/-${pl.summary.pointerRemoves} · note ${pl.summary.notes}`);
  console.log(`  破坏性      ${pl.summary.destructive ? '⚠️ 是（含删除）' : '否'}   触碰手写区文件 ${pl.summary.touchesUserFiles ? '⚠️ 是' : '否'}`);
  console.log('  --- diff 预览 ---');
  for (const s of pl.steps) {
    const tag = { create: '＋', delete: '－', update: '～', 'pointer-add': '＋→', 'pointer-remove': '－→', note: '·' }[s.kind] || '?';
    console.log(`   ${tag} ${s.detail || s.path}`);
  }
  for (const w of pl.warnings) console.log(`   ⚠️ ${w}`);
  if (r.phase === 'preview') { console.log(`\n  （未落盘：${r.reason === 'dry-run' ? 'dry-run' : '等待确认 — 加 --yes 执行'}）`); return r; }
  if (r.phase === 'guard') { console.log(`\n  ⚠️ 未落盘：${r.reason}`); return r; }
  console.log(`\n  已执行 ${r.executed.length} 步${r.errors.length ? `，失败 ${r.errors.length} 步` : ''}`);
  for (const c of r.commits) console.log(`  git ${c.dir.replace(pathsMod.paths().projectsRoot, '<projectsRoot>')}: ${c.commit || c.reason || c.error || 'ok'}`);
  if (r.archived) console.log(`  提案已归档 → ${r.archived}`);
  for (const e of r.errors) console.log(`  ❌ ${e.step}: ${e.error}`);
  return r;
}

function cmdProposals({ json = false } = {}) {
  const inboxMod = require('./inbox.cjs');
  const list = inboxMod.listProposals();
  if (json) { console.log(JSON.stringify(list, null, 2)); return list; }
  hr('P3 提案目录');
  const p = pathsMod.paths().proposals;
  console.log(`  目录         ${p}`);
  console.log(`  inbox        ${list.inbox.length} 个${list.inbox.length ? '：最新 ' + list.inbox[list.inbox.length - 1] : ''}`);
  console.log(`  提案         ${list.proposal.length} 个${list.proposal.length ? '：最新 ' + list.proposal[list.proposal.length - 1] : ''}`);
  console.log(`  已归档       ${list.applied.length} 个`);
  return list;
}

// ---------------------------------------------------------------- config
/**
 * ★ P2 前置：`config get` / `config set`。
 * 存在的理由：materialize 只补缺失键、绝不覆盖用户值，所以 config.json 一旦
 * 写过 `gates`，阈值就再也无法通过 CLI 更改 —— 而阈值标定注定要反复复标。
 */
function cmdConfig({ action = 'get', dotted = null, pairs = [], json = false } = {}) {
  if (action === 'set') {
    const r = configMod.setValues(pairs);
    if (json) { console.log(JSON.stringify(r, null, 2)); return r; }
    hr('config set');
    if (!r.applied.length) console.log('  ✗ 没有任何改动被应用');
    for (const a of r.applied) console.log(`  ✓ ${a.path}  ${JSON.stringify(a.from)} → ${JSON.stringify(a.to)}`);
    for (const x of r.rejected) console.log(`  ✗ ${x.path}  被拒绝：${x.reason}`);
    if (r.applied.length && r.path) console.log(`\n  已写入 ${r.path}`);
    if (r.reason === 'existing-config-invalid-json') console.log(`  ✗ 现有 config.json 不是合法 JSON：${r.error}`);
    return r;
  }
  const { config, source, error } = configMod.load();
  if (error) console.log(`⚠️ config.json 解析失败，已回退默认值：${error}`);
  if (action === 'diff') {
    // ★ 默认值 vs 线上值的漂移：改 DEFAULTS **不会**影响已有 config.json，必须显式核对。
    //   本会话被这个陷阱咬过两次（闸值、chunkDelayMs），故固化成命令与 doctor 检查。
    const d = configMod.drift();
    if (json) { console.log(JSON.stringify(d, null, 2)); return d; }
    hr('config diff（默认值 vs 线上值）');
    console.log(`  来源 ${d.source}`);
    if (!d.count && !d.extraCount) console.log('  ✓ 无差异、无孤儿键 —— 默认值已全部落地');
    else {
      if (d.count) {
        console.log(`  ⚠️ ${d.count} 处差异（改 DEFAULTS 不会自动生效，需用 config set 落地）：`);
        for (const x of d.diffs) console.log(`    ${x.path}\n      默认 ${JSON.stringify(x.default)}   线上 ${JSON.stringify(x.live)}`);
      }
      // ★ 孤儿键：在 config.json 里但 DEFAULTS 里没有（改名/删键的残留）。
      //   ⚠️ 它们**没有任何代码会读**，但操作员看到会以为生效了 —— 会骗人的静默陷阱。
      if (d.extraCount) {
        console.log(`  🧹 ${d.extraCount} 个**孤儿键**（config.json 有、DEFAULTS 没有；无代码读取，建议清理）：`);
        for (const x of d.extra) console.log(`    ${x.path} = ${JSON.stringify(x.live)}`);
      }
    }
    return d;
  }
  if (dotted) {
    const v = configMod.getPath(config, dotted);
    if (json) { console.log(JSON.stringify({ path: dotted, value: v === undefined ? null : v, source }, null, 2)); return v; }
    console.log(v === undefined ? `(无效路径) ${dotted}` : `${dotted} = ${JSON.stringify(v)}`);
    return v;
  }
  if (json) { console.log(JSON.stringify({ source, config }, null, 2)); return config; }
  hr('有效配置（默认值 ⊕ config.json，用户值优先）');
  console.log(`  来源 ${source}`);
  console.log(`  闸值 gates.stillTrueMin=${config.gates.stillTrueMin} gates.reusableMin=${config.gates.reusableMin}`);
  console.log(JSON.stringify(config, null, 2));
  return config;
}

// ---------------------------------------------------------------- main
async function main() {
  const argvAll = process.argv.slice(2);
  const [cmd, ...rest] = argvAll;
  const has = (f) => rest.includes(f);
  const argVal = (name, dflt) => {
    const i = rest.indexOf(name);
    return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : dflt;
  };

  switch (cmd) {
    case 'install': cmdInstall(); break;
    case 'init': {
      const r = cmdInit({ git: !has('--no-git') });
      console.log('\ninit 完成：', JSON.stringify(r));
      break;
    }
    case 'status': {
      cmdStatus();
      const live = await cmdStatusLive();
      hr('引擎');
      console.log(live.ok ? `  在线  ${JSON.stringify(live.body)}` : `  离线  (${live.error || 'no-response'})`);
      break;
    }
    case 'doctor': cmdDoctor({ json: has('--json') }); break;
    case 'start': await cmdStart(); break;
    case 'stop': await cmdStop(); break;
    case 'rollback': cmdRollback(); break;
    case 'projects': cmdProjects({ refresh: has('--refresh'), json: has('--json') }); break;
    case 'ingest': {
      cmdIngest({ project: argVal('--project', null), force: has('--force'), sealAll: has('--seal-all'), json: has('--json') });
      break;
    }
    case 'dryrun': {
      cmdDryrun({
        project: argVal('--project', null),
        limit: Number(argVal('--limit', 20)) || 20,
        verbose: has('--verbose'),
        json: has('--json'),
        maxBytes: Number(argVal('--max-bytes', 0)) || null,
      });
      break;
    }
    case 'extract': {
      const r = require('./pipeline.cjs').run({
        project: argVal('--project', null),
        dryRun: false,
        force: has('--force'),
        sealAll: has('--seal-all'),
        ignoreGate: has('--ignore-gate'),
        maxBytesPerRun: Number(argVal('--max-bytes', 0)) || undefined,
        limit: 5,
      });
      hr('提炼并落盘');
      if (r.skipped) {
        console.log('  ⚠️ 被门控跳过：' + r.gate.reasons.join('; '));
        console.log('     如需手动强制运行，加 --ignore-gate');
      } else {
        console.log(JSON.stringify({
          ok: r.ok, candidates: r.candidates, truncated: r.truncated,
          bySignal: r.bySignal, saved: r.saved, durationMs: r.durationMs,
          budgetExhausted: r.ingest.budgetExhausted,
        }, null, 2));
      }
      break;
    }
    case 'candidates': cmdCandidates({ limit: Number(argVal('--limit', 5)) || 5, json: has('--json') }); break;
    case 'stats': cmdStats({ json: has('--json') }); break;
    case 'support': {
      cmdSupport({
        signal: argVal('--signal', null),
        minSupport: Number(argVal('--min-support', 1)) || 1,
        threshold: Number(argVal('--threshold', 0.6)) || 0.6,
        limit: Number(argVal('--limit', 25)) || 25,
        json: has('--json'),
      });
      break;
    }
    case 'label': cmdLabel({ signal: argVal('--signal', null), n: Number(argVal('--n', 60)) || 60, json: has('--json') }); break;
    case 'precision': cmdPrecision({ file: argVal('--file', null), json: has('--json') }); break;
    case 'compare': cmdCompare({ a: argVal('--a', null), b: argVal('--b', null), json: has('--json') }); break;
    case 'risk8': cmdRisk8({ json: has('--json') }); break;
    case 'guard': cmdGuard({ json: has('--json') }); break;
    case 'prepare': cmdPrepare({ mode: argVal('--mode', 'manual'), json: has('--json') }); break;
    case 'validate': cmdValidate({ file: rest[0] && !rest[0].startsWith('--') ? rest[0] : null, json: has('--json') }); break;
    case 'apply': cmdApply({
      file: rest[0] && !rest[0].startsWith('--') ? rest[0] : null,
      yes: has('--yes'), dry: has('--dry'), json: has('--json'),
    }); break;
    case 'proposals': cmdProposals({ json: has('--json') }); break;
    case 'dream':
    case 'autodream': {
      await cmdDream({
        project: argVal('--project', null),
        dryRun: has('--dry'),
        // ★ 用已保存的打分答案直接落盘（不再出网）。必要性：audit 下候选已打完分，
        //   若只按"跳过已打分"筛选，切 active 后新 run 什么都不会提升。
        //   配 `--dry` 可先预览将要写入的内容。
        fromResults: argVal('--from-results', null),
        limit: Number(argVal('--limit', 500)) || 500,
        maxCandidates: Number(argVal('--max-candidates', 0)) || undefined,
        runG2: !has('--no-g2'),
        json: has('--json'),
      });
      break;
    }
    case 'auto': {
      // auto status（默认）· auto once [--dry] [--force]
      const sub = rest[0] === 'once' || rest[0] === 'status' ? rest[0] : 'status';
      await cmdAuto({ op: sub, force: has('--force'), dry: has('--dry'), json: has('--json') });
      break;
    }
    case 'config': {
      const sub = rest[0] === 'set' || rest[0] === 'get' || rest[0] === 'diff' ? rest[0] : 'get';
      const pairs = rest
        .filter((a) => !a.startsWith('--') && a.includes('=') && a !== rest[0])
        .map((s) => { const i = s.indexOf('='); return { path: s.slice(0, i), value: s.slice(i + 1) }; });
      cmdConfig({
        action: sub,
        dotted: sub === 'get' && rest[1] && !rest[1].startsWith('--') ? rest[1] : null,
        pairs,
        json: has('--json'),
      });
      break;
    }
    case 'jevtest': {
      const sizes = String(argVal('--sizes', '8,32,128')).split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
      await cmdJevTest({
        sizes,
        project: argVal('--project', null),
        dry: has('--dry'),
        json: has('--json'),
      });
      break;
    }
    case 'hook': {
      process.argv = [process.argv[0], require.resolve('./nudge.cjs'), ...rest];
      await require('./nudge.cjs').main();
      break;
    }
    case 'hostcheck': {
      // 自检 Host 头白名单（server.cjs 导出）
      const port = configMod.load().config.server.port;
      const cases = [
        [`127.0.0.1:${port}`, true], [`localhost:${port}`, true], [`[::1]:${port}`, true],
        ['evil.com', false], ['evil.com:443', false], ['127.0.0.1.nip.io:' + port, false], ['', false],
      ];
      let pass = 0;
      for (const [h, want] of cases) {
        const got = serverMod.hostAllowed(h, port);
        const ok = got === want;
        if (ok) pass++;
        console.log(`  ${ok ? '✓' : '✗'} ${String(h).padEnd(30)} 期望=${want} 实际=${got}`);
      }
      console.log(`  Host 头白名单自检：${pass}/${cases.length}`);
      break;
    }
    default:
      console.log(`dreamctl（AutoDream · P0 地基 + P1 采集/提炼）

用法：node cli.cjs <命令> [选项]

  —— P0 ——
  install                  安装到 ~/.claude/.dream/bin/
  init [--no-git]          建目录/token/state/config + 扫描项目 + git 化
  status                   门控/锁/引擎一览
  doctor [--json]          全面体检（含风险 7 探针）
  start | stop             拉起 / 优雅关闭引擎
  rollback                 列出内容仓库与最近提交
  projects [--refresh] [--json]
  hook <event>             hook 入口（转 nudge）
  hostcheck                Host 头白名单自检

  —— P1 采集与提炼（不调 Jev、不写记忆）——
  ingest [--project S] [--force] [--seal-all] [--json]
                           转录增量解析，打印统计
  dryrun [--project S] [--limit N] [--max-bytes B] [--json]
                           只看不写干跑：采集 + 提炼 + 打印候选样本
  extract [--project S] [--force] [--seal-all] [--ignore-gate] [--max-bytes B]
                           提炼并落盘到 candidates/ 与 ledger
                           （默认受 24h 门控约束；--ignore-gate 供手动/验证用）
  candidates [--limit N] [--json]
                           查看候选运行索引

  —— P1 分析与统计（报告数字必须来自这里）——
  stats [--json]           代码规模/候选/offsets/运行的权威统计
  support [--signal S] [--min-support N] [--threshold T] [--limit N] [--json]
                           候选的跨会话复现度聚合（convention 精度处置核心）
  label [--signal S] [--n N] [--json]
                           生成精度标注表（人工填 好/边缘/噪声）
  precision --file <标注表>
                           由标注表计算严格/宽松精度（按信号分组）
  compare --a <预标表> --b <用户标注表>
                           两人标注一致性 + 混淆矩阵 + 分歧明细（分歧率是信噪指标）

  —— 风险检查 ——
  risk8 [--json]           检测官方 AutoDream 是否已启用（是否与自建冲突）

  —— P2 前置 ——
  jevtest --sizes 8,32,128 [--project S] [--dry] [--json]
                           Jev batchSize 实测 + promote 阈值标定
                           （--dry 只做形状预检与脱敏审计，不出网）

  —— P2 自动梦（打分 → 决策 → 提升 → G2 分发）——
  dream | autodream [--dry] [--from-results F] [--limit N] [--no-g2] [--json]

  —— P3 手动梦（引擎当裁判，模型产提案）——
  prepare [--mode manual]  汇总线索 → 写 proposals/inbox-<ts>.md
  validate <提案文件>       按 schema 校验提案（失败给结构化错误）
  apply <提案文件> [--yes]  展示 diff；--yes 才落盘
  proposals                列出 inbox / 提案 / 归档

  —— P5 自动梦调度（/event 的消费端）——
  auto [status]            开关/闸值/未消费事件/上次结果/**现在会不会跑及理由**
  auto once [--dry] [--force]
                           在本进程真实跑一轮（--dry = 只打分不写记忆）
                           ⚠️ 会自动外呼付费 Jev；默认关闭，需
                              config set autoDream.enabled=true 才会被事件触发
`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('dreamctl 失败：', e && e.stack || e); process.exit(1); });
}

module.exports = { cmdInstall, cmdInit, cmdStatus, cmdDoctor, cmdStart, cmdStop, cmdRollback, cmdProjects, probeRisk7 };
