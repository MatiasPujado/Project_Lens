import { mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { configPath, expandHome, loadConfig, overrideRoot, resolveConfig } from '../src/config.js';

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
    const file = await writeConfig(JSON.stringify({ roots: [] }));
    expect(() => loadConfig(file)).toThrow(/invalid/);
    const file2 = await writeConfig(JSON.stringify({ exclude: ['x'] }));
    expect(() => loadConfig(file2)).toThrow(/invalid/);
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
  const base = { roots: ['/orig'], exclude: ['**/skip/**'] };

  it('replaces roots with the resolved directory, keeps exclude', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lens-root-'));
    expect(overrideRoot(base, dir)).toEqual({ roots: [dir], exclude: ['**/skip/**'] });
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
    expect(config).toEqual({ roots: [dir], exclude: [] });
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
    expect(config).toEqual({ roots: [dir], exclude: ['**/skip/**'] });
  });

  it('falls back to the config file when no root is given', async () => {
    const file = await writeConfig(JSON.stringify({ roots: ['/orig'] }));
    expect(resolveConfig(undefined, { PROJECTS_MCP_CONFIG: file }).roots).toEqual(['/orig']);
  });

  it('fails loudly when no root and no config file', () => {
    expect(() => resolveConfig(undefined, { PROJECTS_MCP_CONFIG: '/nonexistent/config.json' })).toThrow(
      /PROJECT_LENS_PATH/
    );
  });
});

describe('expandHome', () => {
  it('expands ~ and ~/', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/x')).toBe(path.join(homedir(), 'x'));
    expect(expandHome('/abs')).toBe('/abs');
  });
});
