import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { buildServer } from '../src/tools.js';
import type { LensConfig } from '../src/types.js';
import { cleanup, isError, jsonOf, makeWorkspace, notRoot, textOf } from './helpers.js';

const BIG_FILE_CHARS = 600_000;

interface SearchPayload {
  results: Array<{ project: string; file: string; lines: Array<[number, string]> }>;
  files_matched: number;
  hits_returned: number;
  truncated: boolean;
}

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
        '.hidden': { 'ignored.txt': 'x\n' },
        '.env': 'API_TOKEN=s3cret\n'
      },
      ProjB: {
        '.git': {},
        docs: { 'arch.md': 'context above\ndelegates to the TransactionManager\ncontext below\n' },
        'big.txt': 'a'.repeat(BIG_FILE_CHARS)
      },
      SvnProj: {
        '.svn': {},
        'pom.xml': '<project/>'
      }
    },
    Solo: { '.git': {} }
  });
  config = { roots: [root], exclude: [], allowWrites: true };
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
    expect(payload.map['Group']!['ProjB']).toEqual(['docs']);
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
    const payload = jsonOf<SearchPayload>(
      await client.callTool({ name: 'search', arguments: { query: 'TransactionManager', group: 'Group' } })
    );
    expect([...new Set(payload.results.map(r => r.project))].sort()).toEqual(['ProjA', 'ProjB']);
    expect(payload.files_matched).toBe(payload.results.length);
    expect(payload.hits_returned).toBe(payload.results.reduce((n, r) => n + r.lines.length, 0));
  });

  it('groups every hit in a file under a single entry', async () => {
    const payload = jsonOf<SearchPayload>(
      await client.callTool({
        name: 'search',
        arguments: { query: 'TransactionManager', project: 'ProjA' }
      })
    );
    expect(payload.results).toHaveLength(new Set(payload.results.map(r => r.file)).size);
  });

  it('path_prefix narrows the walk to a subdirectory', async () => {
    const inside = jsonOf<SearchPayload>(
      await client.callTool({
        name: 'search',
        arguments: { query: 'TransactionManager', group: 'Group', path_prefix: 'docs' }
      })
    );
    expect([...new Set(inside.results.map(r => r.project))]).toEqual(['ProjB']);
    expect(inside.results.every(r => r.file.startsWith('docs/'))).toBe(true);
  });

  it('rejects a path_prefix that escapes the project root', async () => {
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'x', project: 'ProjA', path_prefix: '../..' }
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/escapes the project root/);
  });

  it('reports when no project in scope has the path_prefix', async () => {
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'x', group: 'Group', path_prefix: 'no_such_dir' }
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/No project in scope contains the subdirectory "no_such_dir"/);
  });

  it('exclude prunes directories by bare name', async () => {
    const payload = jsonOf<SearchPayload>(
      await client.callTool({
        name: 'search',
        arguments: { query: 'TransactionManager', group: 'Group', exclude: ['docs'] }
      })
    );
    expect([...new Set(payload.results.map(r => r.project))]).toEqual(['ProjA']);
  });

  it('context_lines widens each excerpt around its match', async () => {
    const payload = jsonOf<SearchPayload>(
      await client.callTool({
        name: 'search',
        arguments: { query: 'TransactionManager', project: 'ProjB', context_lines: 1 }
      })
    );
    expect(payload.results[0]!.lines[0]![1]).toContain('TransactionManager');
  });

  it('rejects an unknown group', async () => {
    const result = await client.callTool({ name: 'search', arguments: { query: 'x', group: 'NoSuch' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Unknown group: "NoSuch"/);
  });

  it('requires exactly one scope selector', async () => {
    for (const args of [
      { query: 'x' },
      { query: 'x', project: 'ProjA', group: 'Group' },
      { query: 'x', group: 'Group', scope: 'all' }
    ]) {
      const result = await client.callTool({ name: 'search', arguments: args });
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toMatch(/Exactly one of/);
    }
  });

  it('scope "all" sweeps every root in one call', async () => {
    const other = await makeWorkspace({
      Group: { ProjC: { '.git': {}, 'c.ts': 'const TransactionManager = 1\n' } }
    });
    const multi = { roots: [root, other], exclude: [], allowWrites: false };
    const multiRegistry = new Registry(multi);
    await multiRegistry.initialize();
    const multiClient = await connect(multiRegistry, multi);
    try {
      const payload = jsonOf<{ results: Array<{ project: string }>; scope: unknown }>(
        await multiClient.callTool({
          name: 'search',
          arguments: { query: 'TransactionManager', scope: 'all' }
        })
      );
      expect([...new Set(payload.results.map(r => r.project))].sort()).toEqual(['ProjA', 'ProjB', 'ProjC']);
      expect(payload.scope).toEqual({ scope: 'all' });
    } finally {
      await multiClient.close();
      await cleanup(other);
    }
  });

  it('searches a group that exists under more than one root', async () => {
    const other = await makeWorkspace({
      Group: { ProjC: { '.git': {}, 'c.ts': 'const TransactionManager = 1\n' } }
    });
    const multi = { roots: [root, other], exclude: [], allowWrites: false };
    const multiRegistry = new Registry(multi);
    await multiRegistry.initialize();
    const multiClient = await connect(multiRegistry, multi);
    try {
      const payload = jsonOf<{ results: Array<{ project: string }> }>(
        await multiClient.callTool({
          name: 'search',
          arguments: { query: 'TransactionManager', group: 'Group' }
        })
      );
      expect([...new Set(payload.results.map(r => r.project))].sort()).toEqual(['ProjA', 'ProjB', 'ProjC']);
    } finally {
      await multiClient.close();
      await cleanup(other);
    }
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
  it('refuses secret-pattern files that search and list_files already hide', async () => {
    const result = await client.callTool({
      name: 'read_file',
      arguments: { project: 'ProjA', relative_path: '.env' }
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Refusing to read a secret-pattern file/);
    expect(textOf(result)).not.toContain('s3cret');
  });

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

describe('search over an excluded workspace', () => {
  let excludedRoot: string;
  let excludedClient: Client;

  beforeAll(async () => {
    excludedRoot = await makeWorkspace({
      Live: { Kept: { '.git': {}, 'a.ts': 'TransactionManager\n' } },
      Archived: { Dropped: { '.git': {}, 'b.ts': 'TransactionManager\n' } }
    });
    const cfg: LensConfig = { roots: [excludedRoot], exclude: ['Archived/**'], allowWrites: false };
    const reg = new Registry(cfg);
    await reg.initialize();
    excludedClient = await connect(reg, cfg);
  });

  afterAll(async () => {
    await excludedClient.close();
    await cleanup(excludedRoot);
  });

  it('never reaches a project the config excluded', async () => {
    const payload = jsonOf<SearchPayload>(
      await excludedClient.callTool({
        name: 'search',
        arguments: { query: 'TransactionManager', scope: 'all' }
      })
    );
    expect(payload.results.map(r => r.project)).toEqual(['Kept']);
  });

  it('cannot resolve the excluded project by name either', async () => {
    const result = await excludedClient.callTool({
      name: 'search',
      arguments: { query: 'TransactionManager', project: 'Dropped' }
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Project not found/);
  });
});

describe('search truncation', () => {
  it('flags truncation when the limit cuts results', async () => {
    const payload = jsonOf<SearchPayload>(
      await client.callTool({
        name: 'search',
        arguments: { query: 'TransactionManager', group: 'Group', limit: 1 }
      })
    );
    expect(payload.hits_returned).toBe(1);
    expect(payload.truncated).toBe(true);
  });
});
