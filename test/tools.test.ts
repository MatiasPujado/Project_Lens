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
        'lines.txt': 'l1\nl2\nl3\nl4\n',
        src: { 'a.ts': 'x\n' },
        '.hidden': { 'ignored.txt': 'x\n' }
      },
      ProjB: {
        '.git': {},
        'notes.md': 'delegates to the TransactionManager\n',
        'big.txt': 'a'.repeat(BIG_FILE_CHARS)
      },
      SvnProj: {
        '.svn': {},
        'pom.xml': '<project/>'
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
    expect(payload.map).toEqual({ Group: 3, '(root)': 1 });
    expect(payload.total_groups).toBe(1);
  });

  it('emits compact JSON', async () => {
    const result = await client.callTool({ name: 'map_workspace', arguments: { max_depth: 1 } });
    expect(textOf(result)).not.toContain('\n');
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
      vcsType: 'git',
      detectedStack: [],
      keyFiles: []
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
  interface Table {
    fields: string[];
    rows: unknown[][];
  }

  /** Rebuilds an object per row so assertions read against field names, not indexes. */
  function objects(table: Table): Array<Record<string, unknown>> {
    return table.rows.map(row => Object.fromEntries(table.fields.map((f, i) => [f, row[i]])));
  }

  it('returns every project sorted by group-qualified key when no group is given', async () => {
    const table = jsonOf<Table>(await client.callTool({ name: 'list_projects', arguments: {} }));
    expect(objects(table).map(p => `${p.group}/${p.name}`)).toEqual([
      'Group/ProjA',
      'Group/ProjB',
      'Group/SvnProj',
      '(root)/Solo'
    ]);
    expect(table.fields).toEqual(['name', 'group', 'absolute_path']);
  });

  it('include projects vcs and stack fields in one sweep', async () => {
    const table = jsonOf<Table>(
      await client.callTool({
        name: 'list_projects',
        arguments: { group: 'Group', include: ['branch', 'is_clean', 'stack'] }
      })
    );
    expect(table.fields).toEqual(['name', 'group', 'vcs_type', 'branch', 'is_clean', 'stack']);
    const projects = objects(table);
    expect(projects.map(p => p.name)).toEqual(['ProjA', 'ProjB', 'SvnProj']);

    const svn = projects.find(p => p.name === 'SvnProj')!;
    expect(svn.vcs_type).toBe('svn');
    expect(svn.branch).toBeNull();
    expect(svn.is_clean).toBeNull();
    expect(svn.stack).toEqual(['Java']);
    expect(projects.find(p => p.name === 'ProjA')!.vcs_type).toBe('git');
  });

  it('include of stack alone runs no vcs queries and omits vcs_type', async () => {
    const table = jsonOf<Table>(
      await client.callTool({ name: 'list_projects', arguments: { group: 'Group', include: ['stack'] } })
    );
    expect(table.fields).toEqual(['name', 'group', 'stack']);
    expect(table.rows).toHaveLength(3);
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

  it('reports svn projects without invoking svn and carries no scanned_at', async () => {
    const info = jsonOf<Record<string, unknown>>(
      await client.callTool({ name: 'project_info', arguments: { name: 'SvnProj' } })
    );
    expect(info['vcs']).toEqual({ type: 'svn', remote: null, branch: null, is_clean: null });
    expect(info).not.toHaveProperty('scanned_at');
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

  it('pages with offset and limit', async () => {
    const content = textOf(
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'ProjA', relative_path: 'lines.txt', offset: 2, limit: 2 }
      })
    );
    expect(content).toBe('l2\nl3');
  });

  it('reads from the first line when only limit is given', async () => {
    const content = textOf(
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'ProjA', relative_path: 'lines.txt', limit: 1 }
      })
    );
    expect(content).toBe('l1');
  });

  it('reads from offset to the end when limit is omitted', async () => {
    const content = textOf(
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'ProjA', relative_path: 'lines.txt', offset: 4 }
      })
    );
    expect(content).toBe('l4\n');
  });

  it('rejects an unknown project', async () => {
    const result = await client.callTool({
      name: 'read_file',
      arguments: { project: 'Nope', relative_path: 'x' }
    });
    expect(isError(result)).toBe(true);
  });
});

describe('list_files', () => {
  it('lists project files relative to the root, skipping hidden dirs', async () => {
    const payload = jsonOf<{ files: string[]; count: number; truncated: boolean }>(
      await client.callTool({ name: 'list_files', arguments: { project: 'ProjA' } })
    );
    expect(payload.files).toEqual(['README.md', 'lines.txt', 'main.ts', 'src/a.ts']);
    expect(payload.count).toBe(4);
    expect(payload.truncated).toBe(false);
  });

  it('applies glob filters', async () => {
    const payload = jsonOf<{ files: string[] }>(
      await client.callTool({ name: 'list_files', arguments: { project: 'ProjA', glob: '*.ts' } })
    );
    expect(payload.files).toEqual(['main.ts', 'src/a.ts']);
  });

  it('rejects an unknown project', async () => {
    const result = await client.callTool({ name: 'list_files', arguments: { project: 'Nope' } });
    expect(isError(result)).toBe(true);
  });
});

describe('search truncation', () => {
  it('flags truncation when the limit cuts results', async () => {
    const payload = jsonOf<{ truncated: boolean; matches_found: number }>(
      await client.callTool({
        name: 'search',
        arguments: { query: 'TransactionManager', group: 'Group', limit: 1 }
      })
    );
    expect(payload.matches_found).toBe(1);
    expect(payload.truncated).toBe(true);
  });
});
