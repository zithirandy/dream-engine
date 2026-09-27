'use strict';
/**
 * gitops.cjs —— 内容目录 git 化（对应 V2 §8.4 与 P0 "memory/ 与 .dream/global/ git 化"）。
 * 只用 execFileSync 调 git，不引入依赖。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const GIT_IDENT = ['-c', 'user.name=AutoDream', '-c', 'user.email=autodream@localhost'];

function git(args, cwd, { allowFail = false } = {}) {
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() };
  } catch (e) {
    const out = (e.stdout || '') + (e.stderr || '');
    if (!allowFail) throw e;
    return { ok: false, out: String(out).trim(), code: e.status, error: e.message };
  }
}

function isRepo(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

/** 向上查找是否存在父级仓库（避免嵌套 repo 造成混乱） */
function hasParentRepo(dir) {
  let cur = path.resolve(dir);
  const root = path.parse(cur).root;
  cur = path.dirname(cur);
  while (true) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (cur === root || parent === cur) return null;
    cur = parent;
  }
}

const GITIGNORE = [
  '# AutoDream: 忽略运行时噪声，只版本化内容',
  '*.tmp',
  '*.tmp.*',
  '.consolidate-lock',
  '',
].join('\n');

/** 初始化仓库并做首次提交；已存在则跳过 */
function initRepo(dir, { message = 'chore(dream): initial import before AutoDream P0' } = {}) {
  if (!fs.existsSync(dir)) return { ok: false, reason: 'dir-not-found', dir };
  if (isRepo(dir)) return { ok: true, reason: 'already-repo', dir };

  const parent = hasParentRepo(dir);
  if (parent) return { ok: false, reason: 'inside-parent-repo', dir, parent };

  git(['init', '-q'], dir);
  const gi = path.join(dir, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, GITIGNORE, 'utf8');
  git(['add', '-A'], dir);
  const st = git(['status', '--porcelain'], dir, { allowFail: true });
  if (!st.out) return { ok: true, reason: 'repo-empty-nothing-to-commit', dir };
  git([...GIT_IDENT, 'commit', '-q', '-m', message], dir);
  return { ok: true, reason: 'initialized', dir };
}

function lastCommit(dir) {
  if (!isRepo(dir)) return null;
  const r = git(['log', '-1', '--pretty=%h %ad %s', '--date=short'], dir, { allowFail: true });
  return r.ok ? r.out : null;
}

function dirtyCount(dir) {
  if (!isRepo(dir)) return null;
  const r = git(['status', '--porcelain'], dir, { allowFail: true });
  if (!r.ok) return null;
  return r.out ? r.out.split('\n').filter(Boolean).length : 0;
}

function commitAll(dir, message) {
  if (!isRepo(dir)) return { ok: false, reason: 'not-a-repo', dir };
  git(['add', '-A'], dir);
  const st = git(['status', '--porcelain'], dir, { allowFail: true });
  if (!st.out) return { ok: true, reason: 'clean', dir };
  git([...GIT_IDENT, 'commit', '-q', '-m', message], dir);
  return { ok: true, reason: 'committed', dir, commit: lastCommit(dir) };
}

module.exports = { git, isRepo, hasParentRepo, initRepo, lastCommit, dirtyCount, commitAll, GIT_IDENT };
