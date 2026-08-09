import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ROOT_CONFIG_FILE,
  configPath,
  excludeFor,
  expandHome,
  loadConfig,
  overrideRoot,
  resolveConfig
} from '../src/config.js';

async function writeConfig(content: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'lens-cfg-'));
  const file = path.join(dir, 'config.json');
  await writeFile(file, content);
  return file;
}

describe('loadConfig', () => {
  it('loads a valid config and resolves roots', async () => {
    const file = await writeConfig(JSON.stringify({ roots: ['~/Projects'], exclude: ['**/Archived*/**'] }));
    const config = loadConfig(file)!;
    expect(config.roots).toEqual([path.join(homedir(), 'Projects')]);
    expect(config.exclude).toEqual(['**/Archived*/**']);
  });

  it('defaults exclude to empty', async () => {
    const file = await writeConfig(JSON.stringify({ roots: ['/tmp/x'] }));
    expect(loadConfig(file)!.exclude).toEqual([]);
  });

  it('treats a missing file as no config', () => {
    expect(loadConfig('/nonexistent/config.json')).toBeUndefined();
  });

  it('fails loudly when the path is unreadable', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lens-cfg-dir-'));
    expect(() => loadConfig(dir)).toThrow(/not readable at/);
  });

  it('fails loudly on invalid JSON', async () => {
    const file = await writeConfig('{nope');
    expect(() => loadConfig(file)).toThrow(/not valid JSON/);
  });

  it('fails loudly on schema violations', async () => {
    const file = await writeConfig(JSON.stringify({ roots: 'not-an-array' }));
    expect(() => loadConfig(file)).toThrow(/invalid/);
    const file2 = await writeConfig(JSON.stringify({ exclude: [''] }));
    expect(() => loadConfig(file2)).toThrow(/invalid/);
  });

  it('accepts a file that sets only exclude, for use with an argv or env root', async () => {
    const file = await writeConfig(JSON.stringify({ exclude: ['Archived/**'] }));
    expect(loadConfig(file)).toEqual({ roots: [], exclude: ['Archived/**'], allowWrites: false });
  });
});

describe('configPath', () => {
  it('prefers PROJECTS_MCP_CONFIG', () => {
    expect(configPath({ PROJECTS_MCP_CONFIG: '/etc/lens.json' })).toBe('/etc/lens.json');
  });

  it('falls back to XDG_CONFIG_HOME then ~/.config', () => {
    expect(configPath({ XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/projects-mcp/config.json');
    expect(configPath({})).toBe(path.join(homedir(), '.config', 'projects-mcp', 'config.json'));
  });
});

describe('overrideRoot', () => {
  const base = { roots: ['/orig'], exclude: ['**/skip/**'], allowWrites: false };

  it('replaces roots with the resolved directory, keeps exclude', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lens-root-'));
    expect(overrideRoot(base, dir)).toEqual({ roots: [dir], exclude: ['**/skip/**'], allowWrites: false });
  });

  it('fails loudly on nonexistent path', () => {
    expect(() => overrideRoot(base, '/nonexistent/root')).toThrow(/does not exist/);
  });

  it('fails loudly when path is not a directory', async () => {
    const file = await writeConfig('{}');
    expect(() => overrideRoot(base, file)).toThrow(/not a directory/);
  });
});

describe('resolveConfig', () => {
  it('uses PROJECT_LENS_PATH when no config file exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lens-env-'));
    const config = resolveConfig(undefined, {
      PROJECTS_MCP_CONFIG: '/nonexistent/config.json',
      PROJECT_LENS_PATH: dir
    });
    expect(config).toEqual({ roots: [dir], exclude: [], allowWrites: false });
  });

  it('prefers the CLI argument over PROJECT_LENS_PATH', async () => {
    const argDir = await mkdtemp(path.join(tmpdir(), 'lens-arg-'));
    const envDir = await mkdtemp(path.join(tmpdir(), 'lens-env-'));
    const config = resolveConfig(argDir, {
      PROJECTS_MCP_CONFIG: '/nonexistent/config.json',
      PROJECT_LENS_PATH: envDir
    });
    expect(config.roots).toEqual([argDir]);
  });

  it('overrides the config roots but keeps its exclude', async () => {
    const file = await writeConfig(JSON.stringify({ roots: ['/orig'], exclude: ['**/skip/**'] }));
    const dir = await mkdtemp(path.join(tmpdir(), 'lens-env-'));
    const config = resolveConfig(undefined, { PROJECTS_MCP_CONFIG: file, PROJECT_LENS_PATH: dir });
    expect(config).toEqual({ roots: [dir], exclude: ['**/skip/**'], allowWrites: false });
  });

  it('falls back to the config file when no root is given', async () => {
    const file = await writeConfig(JSON.stringify({ roots: ['/orig'] }));
    expect(resolveConfig(undefined, { PROJECTS_MCP_CONFIG: file }).roots).toEqual(['/orig']);
  });

  it('keeps writes off unless the config file or the env var turns them on', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lens-writes-'));
    const env = { PROJECTS_MCP_CONFIG: '/nonexistent/config.json', PROJECT_LENS_PATH: dir };
    expect(resolveConfig(undefined, env).allowWrites).toBe(false);

    const enabled = await writeConfig(JSON.stringify({ roots: [dir], allow_writes: true }));
    expect(resolveConfig(undefined, { PROJECTS_MCP_CONFIG: enabled }).allowWrites).toBe(true);

    for (const value of ['1', 'true', 'YES', 'on']) {
      expect(resolveConfig(undefined, { ...env, PROJECT_LENS_ALLOW_WRITES: value }).allowWrites).toBe(true);
    }
    for (const value of ['0', 'false', '']) {
      expect(resolveConfig(undefined, { ...env, PROJECT_LENS_ALLOW_WRITES: value }).allowWrites).toBe(false);
    }
    expect(
      resolveConfig(undefined, { PROJECTS_MCP_CONFIG: enabled, PROJECT_LENS_ALLOW_WRITES: '0' }).allowWrites
    ).toBe(false);
  });

  it('fails loudly when no root and no config file', () => {
    expect(() => resolveConfig(undefined, { PROJECTS_MCP_CONFIG: '/nonexistent/config.json' })).toThrow(
      /PROJECT_LENS_PATH/
    );
  });

  it('fails loudly when the config file supplies no root either', async () => {
    const file = await writeConfig(JSON.stringify({ exclude: ['x'] }));
    expect(() => resolveConfig(undefined, { PROJECTS_MCP_CONFIG: file })).toThrow(/PROJECT_LENS_PATH/);
  });
});

describe('per-root .project-lens.json', () => {
  async function makeRoot(rootConfig?: unknown): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'lens-root-'));
    if (rootConfig !== undefined) {
      await writeFile(path.join(dir, ROOT_CONFIG_FILE), JSON.stringify(rootConfig));
    }
    return dir;
  }

  it('contributes exclude patterns for its own root only', async () => {
    const withConfig = await makeRoot({ exclude: ['Archived/**'] });
    const plain = await makeRoot();
    const file = await writeConfig(JSON.stringify({ roots: [withConfig, plain], exclude: ['global/**'] }));
    const config = resolveConfig(undefined, { PROJECTS_MCP_CONFIG: file });
    expect(excludeFor(config, withConfig)).toEqual(['global/**', 'Archived/**']);
    expect(excludeFor(config, plain)).toEqual(['global/**']);
  });

  it('applies to a root that came from the environment', async () => {
    const dir = await makeRoot({ exclude: ['Archived/**'] });
    const config = resolveConfig(undefined, { PROJECT_LENS_PATH: dir });
    expect(excludeFor(config, dir)).toEqual(['Archived/**']);
  });

  it('ignores allow_writes, which a workspace file must never be able to turn on', async () => {
    const dir = await makeRoot({ exclude: [], allow_writes: true });
    expect(resolveConfig(undefined, { PROJECT_LENS_PATH: dir }).allowWrites).toBe(false);
  });

  it('ignores roots declared inside a workspace file', async () => {
    const dir = await makeRoot({ roots: ['/etc'], exclude: ['x/**'] });
    expect(resolveConfig(undefined, { PROJECT_LENS_PATH: dir }).roots).toEqual([dir]);
  });

  it('fails loudly on a malformed workspace file rather than ignoring it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lens-root-'));
    await writeFile(path.join(dir, ROOT_CONFIG_FILE), '{nope');
    expect(() => resolveConfig(undefined, { PROJECT_LENS_PATH: dir })).toThrow(/not valid JSON/);
  });

  it('is optional', async () => {
    const dir = await makeRoot();
    const config = resolveConfig(undefined, { PROJECT_LENS_PATH: dir });
    expect(config.rootExclude).toBeUndefined();
    expect(excludeFor(config, dir)).toEqual([]);
  });
});

describe('expandHome', () => {
  it('expands ~ and ~/', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/x')).toBe(path.join(homedir(), 'x'));
    expect(expandHome('/abs')).toBe('/abs');
  });
});
