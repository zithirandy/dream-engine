'use strict';
/**
 * paths.cjs —— 解析 DREAM_HOME 与全部子路径。
 * 单一职责：所有路径只在这里拼，其他模块不得自行拼路径。
 */
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 37778;

/** DREAM_HOME：环境变量优先，否则 ~/.claude/.dream */
function dreamHome() {
  const fromEnv = process.env.DREAM_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.claude', '.dream');
}

/** Claude Code 的配置根。DREAM_CLAUDE_HOME 可覆盖（测试隔离用；P4 抽成宿主适配层） */
function claudeHome() {
  const fromEnv = process.env.DREAM_CLAUDE_HOME;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.claude');
}

function paths() {
  const home = dreamHome();
  return {
    home,
    claudeHome: claudeHome(),
    state: path.join(home, 'state.json'),
    config: path.join(home, 'config.json'),
    token: path.join(home, 'token'),
    lock: path.join(home, 'lock'),
    bin: path.join(home, 'bin'),
    logs: path.join(home, 'logs'),
    daemonLog: path.join(home, 'logs', 'daemon.log'),
    runLogsDir: path.join(home, 'logs'),
    ledger: path.join(home, 'ledger.jsonl'),
    scores: path.join(home, 'scores.jsonl'),
    raw: path.join(home, 'raw'),
    offsets: path.join(home, 'raw', 'offsets.json'),
    candidates: path.join(home, 'candidates'),
    rejected: path.join(home, 'rejected'),
    global: path.join(home, 'global'),
    proposals: path.join(home, 'proposals'),
    reports: path.join(home, 'reports'),
    redacted: path.join(home, 'logs', 'redacted'),
    pendingEvents: path.join(home, 'raw', 'pending-events.jsonl'),
    // ★ P5 自动梦：事件消费偏移（与转录偏移 `offsets` 分开 —— 两者的文件、
    //   失败语义、重置时机都不同，混用一个文件会互相踩）
    autoOffsets: path.join(home, 'raw', 'auto-offsets.json'),
    // ★ P5 自动梦专用日志：每轮一行 JSON（跑没跑、为什么、结果）。
    //   与 daemon.log（进程级）分开，便于 `auto status` 直接读。
    autoLog: path.join(home, 'logs', 'auto-dream.jsonl'),
    // ★ GitHub 采集：与自动梦**完全分开**的三份状态。
    //   理由见 github.cjs 文件头 —— 两者的触发语义（事件驱动 vs 墙上时钟）、
    //   失败重试语义、数据来源（本地转录 vs 外部网络）都不同，共用会互相踩。
    //   `githubReports` 只是**默认**输出目录；实际目录由 `github.report.dir`
    //   覆盖（用户要求落到仓库外的固定位置）。
    githubState: path.join(home, 'raw', 'github-state.json'),
    githubLog: path.join(home, 'logs', 'github.jsonl'),
    githubReports: path.join(home, 'github-reports'),
    // 宿主记忆根
    projectsRoot: path.join(claudeHome(), 'projects'),
  };
}

/** 所有需要在 init 时创建的目录 */
function dirsToCreate() {
  const p = paths();
  return [p.home, p.bin, p.logs, p.raw, p.candidates, p.rejected, p.global, p.proposals, p.reports, p.redacted, p.githubReports];
}

module.exports = {
  DEFAULT_PORT,
  dreamHome,
  claudeHome,
  paths,
  dirsToCreate,
};
