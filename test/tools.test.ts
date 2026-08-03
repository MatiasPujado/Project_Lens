import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { buildServer } from '../src/tools.js';
import type { LensConfig } from '../src/types.js';
import { cleanup, isError, jsonOf, makeWorkspace, notRoot, textOf } from './helpers.js';

const BIG_FILE_CHARS = 600_000;

let root: string;
let config: LensConfig;
let registry: Registry;
let client: Client;

async function connect(reg: Registry, cfg: LensConfig): Promise<Client> {
  const server = buildServer(reg, cfg);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const c = new Client({ name: 'lens-tools-test', version: '0.0.0' });
  await c.connect(clientTransport);
  return c;
}

beforeAll(async () => {
  root = await makeWorkspace({
    Group: {
      ProjA: {
        '.git': {},
        'README.md': '# ProjA\n',
        'main.ts': 'export class TransactionManager {}\n',
        src: { 'a.ts': 'x\n' },
        '.hidden': { 'ignored.txt': 'x\n' }
      },
      ProjB: {
        '.git': {},
        'notes.md': 'delegates to the TransactionManager\n',
        'big.txt': 'a'.repeat(BIG_FILE_CHARS)
      }
    },
    Solo: { '.git': {} }
  });
  config = { roots: [root], exclude: [] };
  registry = new Registry(config);
  await registry.initialize();
  client = await connect(registry, config);
});

afterAll(async () => {
  await client.close();
  await chmod(path.join(root, 'Group', 'ProjA', 'README.md'), 0o644).catch(() => {});
  await cleanup(root);
});

describe('map_workspace', () => {
  it('depth 1 returns a project count per group', async () => {
    const payload = jsonOf<{ map: Record<string, number>; total_groups: number }>(
      await client.callTool({ name: 'map_workspace', arguments: { max_depth: 1 } })
    );
    expect(payload.map).toEqual({ Group: 2, '(root)': 1 });
    expect(payload.total_groups).toBe(1);
  });

  it("depth 3 lists each project's top-level folders, hiding dotfiles", async () => {
    const payload = jsonOf<{ map: Record<string, Record<string, string[]>> }>(
      await client.callTool({ name: 'map_workspace', arguments: { max_depth: 3 } })
    );
    expect(payload.map['Group']!['ProjA']).toEqual(['src']);
    expect(payload.map['Group']!['ProjB']).toEqual([]);
  });

  it('depth 3 tolerates a project directory it cannot read', async () => {
    const isolated = new Registry(config);
    await isolated.initialize();
    isolated.add({
      name: 'Phantom',
      groupPath: 'Group',
      absolutePath: path.join(root, 'Group', 'never-existed'),
      root,
      detectedStack: [],
      keyFiles: [],
      scannedAt: Date.now()
    });
    const isolatedClient = await connect(isolated, config);
    try {
      const payload = jsonOf<{ map: Record<string, Record<string, string[]>> }>(
        await isolatedClient.callTool({ name: 'map_workspace', arguments: { max_depth: 3 } })
      );
      expect(payload.map['Group']!['Phantom']).toEqual([]);
    } finally {
      await isolatedClient.close();
    }
  });
});

describe('list_projects', () => {
  it('returns every project sorted by group-qualified key when no group is given', async () => {
    const payload = jsonOf<{ projects: Array<{ name: string; group: string }> }>(
      await client.callTool({ name: 'list_projects', arguments: {} })
    );
    expect(payload.projects.map(p => `${p.group}/${p.name}`)).toEqual([
      'Group/ProjA',
      'Group/ProjB',
      '(root)/Solo'
    ]);
  });
});

describe('search', () => {
  it('scoped by group maps hits across every project in it', async () => {
    const payload = jsonOf<{ results: Array<{ project: string }>; matches_found: number }>(
      await client.callTool({ name: 'search', arguments: { query: 'TransactionManager', group: 'Group' } })
    );
    expect([...new Set(payload.results.map(r => r.project))].sort()).toEqual(['ProjA', 'ProjB']);
    expect(payload.matches_found).toBe(payload.results.length);
  });

  it('rejects an unknown group', async () => {
    const result = await client.callTool({ name: 'search', arguments: { query: 'x', group: 'NoSuch' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Unknown group: "NoSuch"/);
  });
});

describe('project_info', () => {
  it.skipIf(!notRoot)('returns a null snippet when the README is unreadable', async () => {
    await chmod(path.join(root, 'Group', 'ProjA', 'README.md'), 0o000);
    const info = jsonOf<{ readme_snippet: string | null }>(
      await client.callTool({ name: 'project_info', arguments: { name: 'ProjA' } })
    );
    expect(info.readme_snippet).toBeNull();
    await chmod(path.join(root, 'Group', 'ProjA', 'README.md'), 0o644);
  });

  it('returns a null snippet for a project without a README', async () => {
    const info = jsonOf<{ readme_snippet: string | null; group: string }>(
      await client.callTool({ name: 'project_info', arguments: { name: 'Solo' } })
    );
    expect(info.readme_snippet).toBeNull();
    expect(info.group).toBe('(root)');
  });

  it('surfaces registry resolution failures as tool errors', async () => {
    const result = await client.callTool({ name: 'project_info', arguments: { name: 'Nope' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Project not found/);
  });
});

describe('read_file', () => {
  it('truncates files past the read cap', async () => {
    const content = textOf(
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'ProjB', relative_path: 'big.txt' }
      })
    );
    expect(content).toMatch(/\n\[truncated at 500000 chars\]$/);
    expect(content.length).toBeLessThan(BIG_FILE_CHARS);
  });

  it('rejects an unknown project', async () => {
    const result = await client.callTool({
      name: 'read_file',
      arguments: { project: 'Nope', relative_path: 'x' }
    });
    expect(isError(result)).toBe(true);
  });
});
