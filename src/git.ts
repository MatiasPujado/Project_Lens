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

async function git(dir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', args, { cwd: dir, timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function gitInfo(dir: string): Promise<VcsInfo> {
  const [remote, branch, status] = await Promise.all([
    git(dir, ['remote', 'get-url', 'origin']),
    git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(dir, ['status', '--porcelain'])
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
