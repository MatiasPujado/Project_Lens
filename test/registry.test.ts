import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { cleanup, makeWorkspace } from './helpers.js';

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
  registry = new Registry({ roots: [root], exclude: [] });
  await registry.initialize();
});

afterAll(() => cleanup(root));

describe('Registry', () => {
  it('initialize returns scan stats', async () => {
    const fresh = new Registry({ roots: [root], exclude: [] });
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

  it('revalidate picks up a newly created project via group-dir mtime', async () => {
    const fresh = new Registry({ roots: [root], exclude: [] });
    await fresh.initialize();
    await mkdir(path.join(root, 'GroupB', 'NewProj', '.git'), { recursive: true });
    await fresh.revalidate();
    expect(fresh.getAll().some(n => n.name === 'NewProj')).toBe(true);
  });

  it('revalidate drops projects under a group dir that disappeared', async () => {
    const scratch = await makeWorkspace({
      Keep: { Kept: { '.git': {} } },
      Doomed: { Gone: { '.git': {} } }
    });
    const fresh = new Registry({ roots: [scratch], exclude: [] });
    await fresh.initialize();
    expect(fresh.getAll()).toHaveLength(2);

    await rm(path.join(scratch, 'Doomed'), { recursive: true, force: true });
    await fresh.revalidate();

    expect(fresh.getAll().map(n => n.name)).toEqual(['Kept']);
    await cleanup(scratch);
  });

  it('rescans only the stale root when several are configured', async () => {
    const rootA = await makeWorkspace({ GroupA: { A1: { '.git': {} } } });
    const rootB = await makeWorkspace({ GroupB: { B1: { '.git': {} } } });
    const fresh = new Registry({ roots: [rootA, rootB], exclude: [] });
    expect((await fresh.initialize()).scanned_roots).toBe(2);

    await mkdir(path.join(rootB, 'GroupB', 'B2', '.git'), { recursive: true });
    await fresh.revalidate();

    expect(fresh.getAll().map(n => n.name).sort()).toEqual(['A1', 'B1', 'B2']);
    await cleanup(rootA);
    await cleanup(rootB);
  });

  it('find matches a substring in the middle of a name', () => {
    expect(registry.find('service').map(n => n.name)).toEqual(['Gamma_Service']);
  });
});
