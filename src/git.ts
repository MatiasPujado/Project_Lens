import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface VcsInfo {
  type: 'git' | 'svn';
  remote: string | null;
  branch: string | null;
  is_clean: boolean | null;
}

/** Strips userinfo (user:token@) from scheme://host remotes so credentials never leave the server. */
export function redactRemote(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, '$1');
}

/**
 * A repository's own .git/config is untrusted: `core.fsmonitor` names a program `git status` runs.
 * Overriding it on the command line wins over every config file.
 */
const SAFE_GIT_ARGS = ['-c', 'core.fsmonitor=false'];
const FILTER_COMMANDS = ['clean', 'smudge', 'process'];
/**
 * Config the repository itself supplies; an include from .git/config reports `local` too.
 * Global and system config are the user's own, so their filters (git-lfs) keep working.
 */
const REPOSITORY_SCOPES = new Set(['local', 'worktree']);

async function git(dir: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string | null> {
  try {
    const { stdout } = await run('git', [...SAFE_GIT_ARGS, ...args], { cwd: dir, timeout: 5000, env });
    return stdout.trim();
  } catch {
    return null;
  }
}

/**
 * `git status` hashes a changed file through the clean or process filter the repository configures, which
 * runs that program. Reading config runs nothing, so the filter names the repository's own config defines are
 * listed first and their commands blanked; when the listing fails, status is not run at all. The overrides go through
 * GIT_CONFIG_KEY_n/VALUE_n, which keep key and value apart, because a filter name may itself contain `=`,
 * which `-c key=value` would split on. Submodules are ignored: a submodule's own config could name a filter
 * too, so is_clean reports the superproject's files only.
 */
async function filterFreeEnv(dir: string): Promise<NodeJS.ProcessEnv | null> {
  const listing = await git(dir, ['config', '-z', '--name-only', '--show-scope', '--list']);
  if (listing === null) return null; // filters unknown: running status could run one
  const fields = listing.split('\0'); // scope, key, scope, key, ...
  const names = new Set<string>();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [scope, key] = [fields[i]!, fields[i + 1]!];
    if (!REPOSITORY_SCOPES.has(scope) || !key.startsWith('filter.')) continue;
    const name = key.slice('filter.'.length, key.lastIndexOf('.'));
    if (name) names.add(name); // `filter.clean` names no driver, so git never runs it
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  let count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0; // append after the user's own entries
  for (const name of names) {
    for (const command of FILTER_COMMANDS) {
      env[`GIT_CONFIG_KEY_${count}`] = `filter.${name}.${command}`;
      env[`GIT_CONFIG_VALUE_${count}`] = '';
      count++;
    }
  }
  env.GIT_CONFIG_COUNT = String(count);
  return env;
}

export async function gitInfo(dir: string): Promise<VcsInfo> {
  const [remote, branch, status] = await Promise.all([
    git(dir, ['remote', 'get-url', 'origin']),
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    filterFreeEnv(dir).then(env =>
      env === null ? null : git(dir, ['status', '--porcelain', '--ignore-submodules=all'], env)
    )
  ]);
  return {
    type: 'git',
    remote: remote === null ? null : redactRemote(remote),
    branch,
    is_clean: status === null ? null : status === ''
  };
}

/** SVN working copies are indexed but never queried — the svn binary is not invoked. */
export async function vcsInfo(vcsType: 'git' | 'svn', dir: string): Promise<VcsInfo> {
  if (vcsType === 'git') return gitInfo(dir);
  return { type: 'svn', remote: null, branch: null, is_clean: null };
}
