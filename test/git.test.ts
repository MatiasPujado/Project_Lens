import { execFile } from 'node:child_process';
import { chmod, stat, writeFile } from 'node:fs/promises';
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

  it('reports the branch of a repository with no commits yet', async () => {
    const fresh = path.join(root, 'Fresh');
    await run('git', ['init', '-q', '-b', 'fresh', fresh]);
    expect((await gitInfo(fresh)).branch).toBe('fresh');
  });

  it('reports HEAD for a detached HEAD', async () => {
    const detached = path.join(root, 'Detached');
    await run('git', ['clone', '-q', repo, detached]);
    await run('git', ['checkout', '-q', '--detach'], { cwd: detached });
    expect((await gitInfo(detached)).branch).toBe('HEAD');
  });
});

describe('gitInfo and repository-supplied programs', () => {
  let root: string;

  beforeAll(async () => {
    root = await makeWorkspace({ repo: { 'a.txt': 'a\n' } });
  });

  afterAll(() => cleanup(root));

  it('never runs the program a repository names in core.fsmonitor', async () => {
    const repo = path.join(root, 'repo');
    const marker = path.join(root, 'fsmonitor-ran');
    const hook = path.join(root, 'hook.sh');
    await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(hook, 0o755);
    await run('git', ['init', '-q'], { cwd: repo });
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: repo });
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
    await run('git', ['config', 'core.fsmonitor', hook], { cwd: repo });

    await gitInfo(repo);

    await expect(stat(marker)).rejects.toThrow(/ENOENT/);
  });

  it('never runs a clean filter a submodule configures, and judges is_clean on the superproject only', async () => {
    const id = ['-c', 'user.name=t', '-c', 'user.email=t@t'];
    const sub = path.join(root, 'sub-origin');
    const superRepo = path.join(root, 'super');
    const marker = path.join(root, 'm-sub');
    await run('git', ['init', '-q', sub]);
    await writeFile(path.join(sub, 'a.txt'), 'a\n');
    await writeFile(path.join(sub, '.gitattributes'), '*.txt filter=s\n');
    await run('git', [...id, 'add', '.'], { cwd: sub });
    await run('git', [...id, 'commit', '-qm', 'init'], { cwd: sub });
    await run('git', ['init', '-q', superRepo]);
    await run('git', [...id, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'sub'], {
      cwd: superRepo
    });
    await run('git', [...id, 'commit', '-qm', 'init'], { cwd: superRepo });
    await run('git', ['config', 'filter.s.clean', `sh -c 'touch ${marker}; cat'`], {
      cwd: path.join(superRepo, 'sub')
    });
    await writeFile(path.join(superRepo, 'sub', 'a.txt'), 'b\n'); // same size: git must hash it

    const info = await gitInfo(superRepo);

    expect(info.is_clean).toBe(true);
    await expect(stat(marker)).rejects.toThrow(/ENOENT/);
  });

  it('blanks a filter the repository pulls in through an include, but keeps the user\'s global filters', async () => {
    const repo = path.join(root, 'scoped');
    const globalConfig = path.join(root, 'global.gitconfig');
    const globalMarker = path.join(root, 'm-global');
    const includeMarker = path.join(root, 'm-include');
    await run('git', ['init', '-q', repo]);
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    await writeFile(path.join(repo, 'b.md'), 'b\n');
    await writeFile(path.join(repo, '.gitattributes'), '*.txt filter=g\n*.md filter=inc\n');
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: repo });
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
    await writeFile(globalConfig, `[filter "g"]\n\tclean = "sh -c 'touch ${globalMarker}; cat'"\n`);
    await writeFile(path.join(repo, 'inc.cfg'), `[filter "inc"]\n\tclean = "sh -c 'touch ${includeMarker}; cat'"\n`);
    await run('git', ['config', 'include.path', '../inc.cfg'], { cwd: repo });
    await writeFile(path.join(repo, 'a.txt'), 'z\n'); // same size: git must hash it
    await writeFile(path.join(repo, 'b.md'), 'y\n');

    const saved = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      await gitInfo(repo);
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = saved;
    }

    await expect(stat(includeMarker)).rejects.toThrow(/ENOENT/);
    await expect(stat(globalMarker)).resolves.toBeDefined();
  });

  it('ignores a filter key with no driver name, which git never runs', async () => {
    const repo = path.join(root, 'nameless');
    await run('git', ['init', '-q', repo]);
    await run('git', ['config', 'filter.clean', 'cat'], { cwd: repo });

    expect((await gitInfo(repo)).is_clean).toBe(true);
  });

  it('keeps config the user passes through GIT_CONFIG_COUNT', async () => {
    const repo = path.join(root, 'user-env');
    await run('git', ['init', '-q', repo]);
    await run('git', ['config', 'filter.x.clean', 'cat'], { cwd: repo });
    await writeFile(path.join(repo, 'untracked.txt'), 'u\n');
    const keys = ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const;
    const saved = keys.map(k => process.env[k]);
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'status.showUntrackedFiles',
      GIT_CONFIG_VALUE_0: 'no'
    });
    try {
      expect((await gitInfo(repo)).is_clean).toBe(true);
    } finally {
      keys.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i])));
    }
  });

  it.each([['unset', undefined], ['not a number', 'abc']])(
    'blanks repository filters when GIT_CONFIG_COUNT is %s',
    async (label, count) => {
      const repo = path.join(root, `count-${label.replace(/ /g, '-')}`);
      const marker = path.join(root, `m-count-${label.replace(/ /g, '-')}`);
      await run('git', ['init', '-q', repo]);
      await writeFile(path.join(repo, 'a.txt'), 'a\n');
      await writeFile(path.join(repo, '.gitattributes'), '*.txt filter=x\n');
      await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: repo });
      await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
      await run('git', ['config', 'filter.x.clean', `sh -c 'touch ${marker}; cat'`], { cwd: repo });
      await writeFile(path.join(repo, 'a.txt'), 'z\n'); // same size: git must hash it

      const saved = process.env.GIT_CONFIG_COUNT;
      if (count === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = count;
      try {
        await gitInfo(repo);
      } finally {
        if (saved === undefined) delete process.env.GIT_CONFIG_COUNT;
        else process.env.GIT_CONFIG_COUNT = saved;
      }

      await expect(stat(marker)).rejects.toThrow(/ENOENT/);
    }
  );

  it('reports is_clean as null and runs no filter when GIT_CONFIG_COUNT is negative', async () => {
    const repo = path.join(root, 'count-negative');
    const marker = path.join(root, 'm-count-negative');
    await run('git', ['init', '-q', repo]);
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    await writeFile(path.join(repo, '.gitattributes'), '*.txt filter=x\n');
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: repo });
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
    await run('git', ['config', 'filter.x.clean', `sh -c 'touch ${marker}; cat'`], { cwd: repo });
    await writeFile(path.join(repo, 'a.txt'), 'z\n'); // same size: git must hash it

    const saved = process.env.GIT_CONFIG_COUNT;
    process.env.GIT_CONFIG_COUNT = '-1';
    let info;
    try {
      info = await gitInfo(repo);
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = saved;
    }

    expect(info.is_clean).toBeNull();
    await expect(stat(marker)).rejects.toThrow(/ENOENT/);
  });

  it('reports is_clean as null without running status when the config cannot be listed', async () => {
    const repo = path.join(root, 'broken-config');
    await run('git', ['init', '-q', repo]);
    await writeFile(path.join(repo, '.git', 'config'), '[filter "x"\n\tclean = broken\n');

    expect((await gitInfo(repo)).is_clean).toBeNull();
  });

  it('never runs a clean or process filter the repository configures, whatever the filter is named', async () => {
    const repo = path.join(root, 'filtered');
    const markers = ['m-clean', 'm-process', 'm-eq'].map(m => path.join(root, m));
    await run('git', ['init', '-q', repo]);
    await writeFile(path.join(repo, 'a.txt'), 'a\n');
    await writeFile(path.join(repo, 'b.md'), 'b\n');
    await writeFile(path.join(repo, '.gitattributes'), '*.txt filter=x\n*.md filter=a=b\n');
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.'], { cwd: repo });
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo });
    await run('git', ['config', 'filter.x.clean', `sh -c 'touch ${markers[0]}; cat'`], { cwd: repo });
    await run('git', ['config', 'filter.x.process', `sh -c 'touch ${markers[1]}'`], { cwd: repo });
    await run('git', ['config', 'filter.a=b.clean', `sh -c 'touch ${markers[2]}; cat'`], { cwd: repo });
    await writeFile(path.join(repo, 'a.txt'), 'z\n'); // same size: git must hash it, which runs the filter
    await writeFile(path.join(repo, 'b.md'), 'y\n');

    const info = await gitInfo(repo);

    expect(info.is_clean).toBe(false);
    for (const marker of markers) await expect(stat(marker)).rejects.toThrow(/ENOENT/);
  });
});
