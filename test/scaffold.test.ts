import { mkdtemp, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

  it('refuses a group directory that is a symbolic link leaving the root, and creates nothing', async () => {
    const outside = await makeWorkspace({});
    await symlink(outside, path.join(root, 'Escape'));
    try {
      await expect(scaffoldProject(registry, [root], 'Escape', 'X')).rejects.toThrow(/leaves the root/);
      await expect(stat(path.join(outside, 'X'))).rejects.toThrow(/ENOENT/);
    } finally {
      await cleanup(outside);
    }
  });

  it('removes the new directory when git init fails, so a retry is not blocked', async () => {
    const emptyPath = await mkdtemp(path.join(tmpdir(), 'lens-nogit-'));
    const savedPath = process.env.PATH;
    process.env.PATH = emptyPath;
    try {
      await expect(scaffoldProject(registry, [root], 'Experiments', 'No_Git')).rejects.toThrow();
    } finally {
      process.env.PATH = savedPath;
      await cleanup(emptyPath);
    }
    await expect(stat(path.join(root, 'Experiments', 'No_Git'))).rejects.toThrow(/ENOENT/);
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
  });

  it('writes the gitignore stub when asked for it alone', async () => {
    const node = await scaffoldProject(registry, [root], 'Experiments', 'Ignored', { gitignore: true });
    expect(await readFile(path.join(node.absolutePath, '.gitignore'), 'utf8')).toContain('node_modules/');
    await expect(stat(path.join(node.absolutePath, 'README.md'))).rejects.toThrow();
  });

  it('writes no stubs by default', async () => {
    const node = await scaffoldProject(registry, [root], 'Experiments', 'Bare');
    await expect(stat(path.join(node.absolutePath, '.git'))).resolves.toBeDefined();
    await expect(stat(path.join(node.absolutePath, 'README.md'))).rejects.toThrow();
    await expect(stat(path.join(node.absolutePath, '.gitignore'))).rejects.toThrow();
  });
});

describe('scaffoldProject directly under a root', () => {
  let first: string;
  let second: string;
  let twoRoots: Registry;

  beforeAll(async () => {
    first = await makeWorkspace({ Shared: {}, OnlyFirst: {} });
    second = await makeWorkspace({ Shared: {} });
    twoRoots = new Registry({ roots: [first, second], exclude: [], allowWrites: true });
    await twoRoots.initialize();
  });

  afterAll(async () => {
    await cleanup(first);
    await cleanup(second);
  });

  it('creates the project at the root of the only configured root, with no group', async () => {
    const node = await scaffoldProject(registry, [root], undefined, 'Top_Level');
    expect(node.absolutePath).toBe(path.join(root, 'Top_Level'));
    expect(node.groupPath).toBe('');
    await expect(stat(path.join(root, 'Top_Level', '.git'))).resolves.toBeDefined();
    expect(registry.resolve('Top_Level').absolutePath).toBe(path.join(root, 'Top_Level'));
  });

  it('asks which root when there is no group and several roots, listing them, and creates nothing', async () => {
    const attempt = scaffoldProject(twoRoots, [first, second], undefined, 'Unplaced');
    await expect(attempt).rejects.toThrow(/root/);
    await expect(attempt).rejects.toThrow(first);
    await expect(attempt).rejects.toThrow(second);
    await expect(stat(path.join(first, 'Unplaced'))).rejects.toThrow(/ENOENT/);
    await expect(stat(path.join(second, 'Unplaced'))).rejects.toThrow(/ENOENT/);
  });

  it('creates the project under the named root, written with a trailing slash too', async () => {
    const node = await scaffoldProject(twoRoots, [first, second], undefined, 'In_Second', { root: `${second}/` });
    expect(node.absolutePath).toBe(path.join(second, 'In_Second'));
  });

  it('refuses a root that is not configured, and creates nothing there', async () => {
    const outside = await makeWorkspace({});
    try {
      await expect(scaffoldProject(twoRoots, [first, second], undefined, 'X', { root: outside })).rejects.toThrow(
        /not a configured root/
      );
      await expect(stat(path.join(outside, 'X'))).rejects.toThrow(/ENOENT/);
    } finally {
      await cleanup(outside);
    }
  });

  it('looks the group up only under the named root', async () => {
    const node = await scaffoldProject(twoRoots, [first, second], 'Shared', 'Second_Shared', { root: second });
    expect(node.absolutePath).toBe(path.join(second, 'Shared', 'Second_Shared'));
    await expect(
      scaffoldProject(twoRoots, [first, second], 'OnlyFirst', 'Y', { root: second })
    ).rejects.toThrow(/does not exist/);
  });
});
