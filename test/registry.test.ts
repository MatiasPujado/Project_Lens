import { mkdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Registry } from '../src/registry.js';
import { cleanup, makeWorkspace } from './helpers.js';

const holds = vi.hoisted(() => new Map<string, Promise<void>>());
const reads = vi.hoisted(() => new Map<string, number>());
const afterRead = vi.hoisted(() => new Map<string, () => void>());

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: async (target: string, ...rest: unknown[]) => {
      reads.set(target, (reads.get(target) ?? 0) + 1);
      await holds.get(target);
      const entries = await (actual.readdir as (...a: unknown[]) => Promise<unknown>)(target, ...rest);
      afterRead.get(target)?.();
      return entries;
    }
  };
});

/** Blocks every readdir of `dir` until the returned function is called, and restarts its read count. */
function hold(dir: string): () => void {
  let release!: () => void;
  holds.set(dir, new Promise<void>(resolve => (release = resolve)));
  reads.set(dir, 0);
  return () => {
    holds.delete(dir);
    release();
  };
}

let root: string;
let registry: Registry;

beforeAll(async () => {
  root = await makeWorkspace({
    GroupA: {
      Alpha: { '.git': {} },
      Beta: { '.git': {} }
    },
    GroupB: {
      Alpha: { '.git': {} },
      Gamma_Service: { '.git': {} }
    }
  });
  registry = new Registry({ roots: [root], exclude: [], allowWrites: false });
  await registry.initialize();
});

afterAll(() => cleanup(root));

describe('Registry', () => {
  it('initialize returns scan stats', async () => {
    const fresh = new Registry({ roots: [root], exclude: [], allowWrites: false });
    const stats = await fresh.initialize();
    expect(stats.projects).toBe(4);
    expect(stats.groups).toBe(2);
    expect(stats.scanned_roots).toBe(1);
    expect(stats.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('lists groups sorted', () => {
    expect(registry.groups()).toEqual(['GroupA', 'GroupB']);
  });

  it('find ranks exact > prefix > substring, case-insensitive', () => {
    const matches = registry.find('gamma');
    expect(matches[0]!.name).toBe('Gamma_Service');
    expect(registry.find('alpha')).toHaveLength(2);
    expect(registry.find('zzz')).toHaveLength(0);
  });

  it('resolve rejects ambiguous names and accepts qualified keys', () => {
    expect(() => registry.resolve('Alpha')).toThrow(/ambiguous/);
    expect(registry.resolve('GroupA/Alpha').groupPath).toBe('GroupA');
    expect(registry.resolve('Beta').name).toBe('Beta');
    expect(() => registry.resolve('Nope')).toThrow(/not found/);
  });

  it('resolve matches names and qualified keys case-insensitively', () => {
    expect(registry.resolve('beta').name).toBe('Beta');
    expect(registry.resolve('groupa/alpha').groupPath).toBe('GroupA');
  });

  it('resolve suggests the closest names on a miss', () => {
    expect(() => registry.resolve('Bet')).toThrow(/Closest matches: GroupA\/Beta/);
    expect(() => registry.resolve('zzz')).toThrow(/Try find_project first/);
  });

  it('revalidate picks up a newly created project via group-dir mtime', async () => {
    const fresh = new Registry({ roots: [root], exclude: [], allowWrites: false });
    await fresh.initialize();
    await mkdir(path.join(root, 'GroupB', 'NewProj', '.git'), { recursive: true });
    await fresh.revalidate();
    expect(fresh.getAll().some(n => n.name === 'NewProj')).toBe(true);
  });

  it('revalidate drops projects under a group dir that disappeared', async () => {
    // Nested, so removing it leaves the root's mtime alone and only the vanished directory flags the root stale.
    const scratch = await makeWorkspace({
      Keep: { Kept: { '.git': {} } },
      Outer: { Doomed: { Gone: { '.git': {} } } }
    });
    const fresh = new Registry({ roots: [scratch], exclude: [], allowWrites: false });
    await fresh.initialize();
    expect(fresh.getAll()).toHaveLength(2);

    await rm(path.join(scratch, 'Outer', 'Doomed'), { recursive: true, force: true });
    await fresh.revalidate();

    expect(fresh.getAll().map(n => n.name)).toEqual(['Kept']);
    await cleanup(scratch);
  });

  it('rescans only the stale root when several are configured', async () => {
    const rootA = await makeWorkspace({ GroupA: { A1: { '.git': {} } } });
    const rootB = await makeWorkspace({ GroupB: { B1: { '.git': {} } } });
    const fresh = new Registry({ roots: [rootA, rootB], exclude: [], allowWrites: false });
    expect((await fresh.initialize()).scanned_roots).toBe(2);

    await mkdir(path.join(rootB, 'GroupB', 'B2', '.git'), { recursive: true });
    await fresh.revalidate();

    expect(fresh.getAll().map(n => n.name).sort()).toEqual(['A1', 'B1', 'B2']);
    await cleanup(rootA);
    await cleanup(rootB);
  });

  it('finds a project created right after its group directory was read', async () => {
    const scratch = await makeWorkspace({ Group: { First: { '.git': {} } } });
    const group = path.join(scratch, 'Group');
    afterRead.set(group, () => {
      afterRead.delete(group);
      mkdirSync(path.join(group, 'Second', '.git'), { recursive: true });
    });
    try {
      const fresh = new Registry({ roots: [scratch], exclude: [], allowWrites: false });
      await fresh.initialize();
      await fresh.revalidate();
      expect(fresh.resolve('Second').name).toBe('Second');
    } finally {
      afterRead.delete(group);
      await cleanup(scratch);
    }
  });

  it('find matches a substring in the middle of a name', () => {
    expect(registry.find('service').map(n => n.name)).toEqual(['Gamma_Service']);
  });
});

describe('Registry during a rescan', () => {
  let scratch: string;
  let fresh: Registry;

  beforeAll(async () => {
    scratch = await makeWorkspace({ Group: { Kept: { '.git': {} } } });
  });

  afterAll(() => cleanup(scratch));
  // A failed assertion skips its release(); the next test must not start with the directory still blocked.
  afterEach(() => holds.clear());

  async function started(): Promise<Registry> {
    const registry = new Registry({ roots: [scratch], exclude: [], allowWrites: false });
    await registry.initialize();
    return registry;
  }

  it('keeps resolving the old projects while a refresh is in flight', async () => {
    fresh = await started();
    const release = hold(scratch);
    const done = fresh.refresh();
    await vi.waitFor(() => expect(reads.get(scratch)).toBe(1));
    expect(fresh.resolve('Kept').name).toBe('Kept');
    release();
    await done;
    expect(fresh.resolve('Kept').name).toBe('Kept');
  });

  it('keeps resolving the old projects while a revalidation rescans a stale root', async () => {
    fresh = await started();
    await mkdir(path.join(scratch, 'Group', 'Added', '.git'), { recursive: true });
    const release = hold(scratch);
    const done = fresh.revalidate();
    await vi.waitFor(() => expect(reads.get(scratch)).toBe(1));
    expect(fresh.resolve('Kept').name).toBe('Kept');
    release();
    await done;
    expect(fresh.resolve('Added').name).toBe('Added');
    await rm(path.join(scratch, 'Group', 'Added'), { recursive: true, force: true });
  });

  it('shares one scan between concurrent revalidations', async () => {
    fresh = await started();
    await mkdir(path.join(scratch, 'Group', 'Shared', '.git'), { recursive: true });
    const release = hold(scratch);
    const both = Promise.all([fresh.revalidate(), fresh.revalidate()]);
    await vi.waitFor(() => expect(reads.get(scratch)).toBe(1));
    release();
    await both;
    expect(reads.get(scratch)).toBe(1);
    expect(fresh.resolve('Shared').name).toBe('Shared');
    await rm(path.join(scratch, 'Group', 'Shared'), { recursive: true, force: true });
  });

  it('runs a full refresh after a revalidation already in flight', async () => {
    fresh = await started();
    await mkdir(path.join(scratch, 'Group', 'Late', '.git'), { recursive: true });
    const release = hold(scratch);
    const revalidated = fresh.revalidate();
    await vi.waitFor(() => expect(reads.get(scratch)).toBe(1));
    const refreshed = fresh.refresh();
    release();
    await Promise.all([revalidated, refreshed]);
    expect(reads.get(scratch)).toBe(2);
    await rm(path.join(scratch, 'Group', 'Late'), { recursive: true, force: true });
  });

  it('keeps a project added while a scan is in flight', async () => {
    fresh = await started();
    const release = hold(scratch);
    const done = fresh.refresh();
    await vi.waitFor(() => expect(reads.get(scratch)).toBe(1));
    fresh.add({
      name: 'Scaffolded',
      groupPath: 'Group',
      absolutePath: path.join(scratch, 'Group', 'Scaffolded'),
      root: scratch,
      vcsType: 'git'
    });
    release();
    await done;
    expect(fresh.resolve('Scaffolded').name).toBe('Scaffolded');
  });
});

describe('Registry with the same group/name under two roots', () => {
  let rootA: string;
  let rootB: string;
  let twins: Registry;

  beforeAll(async () => {
    rootA = await makeWorkspace({ AI: { Tools: { '.git': {} } } });
    rootB = await makeWorkspace({ AI: { Tools: { '.git': {} }, Only: { '.git': {} } } });
    twins = new Registry({ roots: [rootA, rootB], exclude: [], allowWrites: false });
    await twins.initialize();
  });

  afterAll(async () => {
    await cleanup(rootA);
    await cleanup(rootB);
  });

  it('keeps both copies', () => {
    expect(twins.getAll().map(n => n.absolutePath).sort()).toEqual(
      [path.join(rootA, 'AI', 'Tools'), path.join(rootB, 'AI', 'Tools'), path.join(rootB, 'AI', 'Only')].sort()
    );
  });

  it('refuses the shared key and lists each copy by its absolute path', () => {
    for (const query of ['AI/Tools', 'Tools', 'ai/tools']) {
      expect(() => twins.resolve(query)).toThrow(/ambiguous/);
      expect(() => twins.resolve(query)).toThrow(path.join(rootA, 'AI', 'Tools'));
      expect(() => twins.resolve(query)).toThrow(path.join(rootB, 'AI', 'Tools'));
    }
  });

  it('resolves a copy by its absolute path', () => {
    expect(twins.resolve(path.join(rootB, 'AI', 'Tools')).root).toBe(rootB);
    expect(twins.resolve(path.join(rootA, 'AI', 'Tools')).root).toBe(rootA);
  });

  it('resolves a copy by its absolute path with a trailing slash', () => {
    expect(twins.resolve(path.join(rootB, 'AI', 'Tools') + '/').root).toBe(rootB);
  });

  it('resolves an absolute path that normalises to a copy', () => {
    expect(twins.resolve(path.join(rootB, 'AI', 'Only') + '/../Tools').root).toBe(rootB);
  });

  it('refuses an absolute path that names no registered project', () => {
    for (const outside of ['/etc', path.join(rootB, 'AI'), path.join(rootB, 'AI', 'Tools', 'src'), rootA]) {
      expect(() => twins.resolve(outside)).toThrow(/Project not found/);
    }
  });

  it('lists twins by absolute path among the closest matches on a miss', () => {
    expect(() => twins.resolve('Tool')).toThrow(path.join(rootA, 'AI', 'Tools'));
    expect(() => twins.resolve('Tool')).toThrow(path.join(rootB, 'AI', 'Tools'));
  });

  it('lists twins by absolute path and other matches by key in one ambiguity error', async () => {
    const rootC = await makeWorkspace({ Other: { Tools: { '.git': {} } } });
    try {
      const mixed = new Registry({ roots: [rootA, rootB, rootC], exclude: [], allowWrites: false });
      await mixed.initialize();
      const message = (() => {
        try {
          mixed.resolve('Tools');
        } catch (e) {
          return (e as Error).message;
        }
        return '';
      })();
      expect(message).toMatch(/ambiguous/);
      expect(message).toContain(path.join(rootA, 'AI', 'Tools'));
      expect(message).toContain(path.join(rootB, 'AI', 'Tools'));
      expect(message).toContain('Other/Tools');
    } finally {
      await cleanup(rootC);
    }
  });

  it('still resolves a project without a twin by its key', () => {
    expect(twins.resolve('AI/Only').root).toBe(rootB);
  });
});
