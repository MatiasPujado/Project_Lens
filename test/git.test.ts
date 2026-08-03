import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitInfo, redactRemote } from '../src/git.js';
import { cleanup, makeWorkspace } from './helpers.js';

const run = promisify(execFile);

describe('redactRemote', () => {
  it('strips user:token from https remotes', () => {
    expect(redactRemote('https://mpujado:s3cr3t-token@gitea.home/Home_Servers/LinuxServices.git')).toBe(
      'https://gitea.home/Home_Servers/LinuxServices.git'
    );
  });

  it('strips bare-user userinfo', () => {
    expect(redactRemote('https://token@github.com/org/repo.git')).toBe('https://github.com/org/repo.git');
  });

  it('leaves clean https and scp-style ssh remotes untouched', () => {
    expect(redactRemote('https://gitea.home/AI/Project_Lens.git')).toBe('https://gitea.home/AI/Project_Lens.git');
    expect(redactRemote('git@gitea.home:AI/Project_Lens.git')).toBe('git@gitea.home:AI/Project_Lens.git');
  });
});

describe('gitInfo', () => {
  let root: string;
  let repo: string;

  beforeAll(async () => {
    root = await makeWorkspace({ Repo: { 'tracked.txt': 'v1\n' }, NotARepo: { 'x.txt': 'x\n' } });
    repo = path.join(root, 'Repo');
    await run('git', ['init', '-b', 'trunk'], { cwd: repo });
    await run('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
    await run('git', ['config', 'user.name', 'Test'], { cwd: repo });
    await run('git', ['add', '.'], { cwd: repo });
    await run('git', ['commit', '-m', 'init'], { cwd: repo });
  });

  afterAll(() => cleanup(root));

  it('reports branch and a clean tree, with no remote configured', async () => {
    expect(await gitInfo(repo)).toEqual({
      type: 'git',
      remote: null,
      branch: 'trunk',
      is_clean: true
    });
  });

  it('redacts credentials out of the origin remote', async () => {
    await run('git', ['remote', 'add', 'origin', 'https://user:s3cr3t@example.com/x.git'], { cwd: repo });
    const info = await gitInfo(repo);
    expect(info.remote).toBe('https://example.com/x.git');
    expect(info.remote).not.toContain('s3cr3t');
  });

  it('reports a dirty tree once a file changes', async () => {
    await writeFile(path.join(repo, 'tracked.txt'), 'v2\n');
    expect((await gitInfo(repo)).is_clean).toBe(false);
  });

  it('returns nulls outside a repository', async () => {
    expect(await gitInfo(path.join(root, 'NotARepo'))).toEqual({
      type: 'git',
      remote: null,
      branch: null,
      is_clean: null
    });
  });
});
