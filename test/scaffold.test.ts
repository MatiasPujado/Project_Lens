import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { scaffoldProject } from '../src/scaffold.js';
import { cleanup, makeWorkspace } from './helpers.js';

let root: string;
let registry: Registry;

beforeAll(async () => {
  root = await makeWorkspace({
    Experiments: { Existing: { '.git': {} } }
  });
  registry = new Registry({ roots: [root], exclude: [], allowWrites: false });
  await registry.initialize();
});

afterAll(() => cleanup(root));

describe('scaffoldProject', () => {
  it('rejects invalid names and group segments', async () => {
    await expect(scaffoldProject(registry, [root], 'Experiments', 'a;rm -rf')).rejects.toThrow(/Invalid/);
    await expect(scaffoldProject(registry, [root], 'Experiments', '..')).rejects.toThrow(/Invalid/);
    await expect(scaffoldProject(registry, [root], '../etc', 'X')).rejects.toThrow(/Invalid/);
  });

  it('rejects unknown groups', async () => {
    await expect(scaffoldProject(registry, [root], 'NoSuchGroup', 'X')).rejects.toThrow(/does not exist/);
  });

  it('refuses existing targets', async () => {
    await expect(scaffoldProject(registry, [root], 'Experiments', 'Existing')).rejects.toThrow(
      /already exists/
    );
  });

  it('creates dir, runs git init, writes stubs, registers the project', async () => {
    const node = await scaffoldProject(registry, [root], 'Experiments', 'New_Tool', {
      readme: true,
      gitignore: true
    });
    expect(node.absolutePath).toBe(path.join(root, 'Experiments', 'New_Tool'));
    await expect(stat(path.join(node.absolutePath, '.git'))).resolves.toBeDefined();
    await expect(stat(path.join(node.absolutePath, 'README.md'))).resolves.toBeDefined();
    await expect(stat(path.join(node.absolutePath, '.gitignore'))).resolves.toBeDefined();
    expect(registry.resolve('New_Tool').groupPath).toBe('Experiments');
    expect(node.readmePath).toBe(path.join(node.absolutePath, 'README.md'));
  });

  it('writes the gitignore stub when asked for it alone', async () => {
    const node = await scaffoldProject(registry, [root], 'Experiments', 'Ignored', { gitignore: true });
    expect(await readFile(path.join(node.absolutePath, '.gitignore'), 'utf8')).toContain('node_modules/');
    await expect(stat(path.join(node.absolutePath, 'README.md'))).rejects.toThrow();
    expect(node.readmePath).toBeUndefined();
  });

  it('writes no stubs by default', async () => {
    const node = await scaffoldProject(registry, [root], 'Experiments', 'Bare');
    await expect(stat(path.join(node.absolutePath, '.git'))).resolves.toBeDefined();
    await expect(stat(path.join(node.absolutePath, 'README.md'))).rejects.toThrow();
    await expect(stat(path.join(node.absolutePath, '.gitignore'))).rejects.toThrow();
    expect(node.readmePath).toBeUndefined();
  });
});
