import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Registry } from '../src/registry.js';
import { buildServer, readLines } from '../src/tools.js';
import type { LensConfig } from '../src/types.js';
import { cleanup, isError, jsonOf, makeWorkspace, notRoot, textOf } from './helpers.js';

const spawnSignals = vi.hoisted(() => [] as Array<AbortSignal | undefined>);

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options?: { signal?: AbortSignal }) => {
      if (command === 'rg') spawnSignals.push(options?.signal);
      return actual.spawn(command, args, options ?? {});
    }
  };
});

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
        '.git': { config: '[remote "origin"]\n\turl = https://u:FAKETOKEN@example.invalid/r.git\n' },
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
      vcsType: 'git'
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
    expect(objects(table).map(p => `${String(p.group)}/${String(p.name)}`)).toEqual([
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

  it('matches a group ignoring letter case', async () => {
    const table = jsonOf<Table>(await client.callTool({ name: 'list_projects', arguments: { group: 'group' } }));
    expect(objects(table).map(p => p.name)).toEqual(['ProjA', 'ProjB', 'SvnProj']);
  });

  it('rejects an unknown group, as search does', async () => {
    const result = await client.callTool({ name: 'list_projects', arguments: { group: 'NoSuch' } });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Unknown group: "NoSuch"/);
  });

  it('sorts with the pinned locale', async () => {
    const compare = vi.spyOn(String.prototype, 'localeCompare');
    try {
      await client.callTool({ name: 'list_projects', arguments: {} });
      expect(compare.mock.calls.length).toBeGreaterThan(0);
      expect(compare.mock.calls.every(call => call[1] === 'en')).toBe(true);
    } finally {
      compare.mockRestore();
    }
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

  it('refuses a path_prefix inside .git', async () => {
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'FAKETOKEN', project: 'ProjA', path_prefix: '.git' }
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).not.toContain('FAKETOKEN@');
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

  it('fixed_strings matches regex metacharacters literally', async () => {
    const asRegex = await client.callTool({
      name: 'search',
      arguments: { query: 'TransactionManager {', project: 'ProjA' }
    });
    expect(isError(asRegex)).toBe(true);
    const literal = jsonOf<SearchPayload>(
      await client.callTool({
        name: 'search',
        arguments: { query: 'TransactionManager {', project: 'ProjA', fixed_strings: true }
      })
    );
    expect(literal.results.map(r => r.file)).toEqual(['main.ts']);
  });

  it('ignore_case matches regardless of case', async () => {
    const exact = jsonOf<SearchPayload>(
      await client.callTool({ name: 'search', arguments: { query: 'transactionmanager', project: 'ProjA' } })
    );
    expect(exact.results).toEqual([]);
    const folded = jsonOf<SearchPayload>(
      await client.callTool({
        name: 'search',
        arguments: { query: 'transactionmanager', project: 'ProjA', ignore_case: true }
      })
    );
    expect(folded.results.map(r => r.file)).toEqual(['main.ts']);
  });

  it('matches a group ignoring letter case', async () => {
    const payload = jsonOf<SearchPayload>(
      await client.callTool({ name: 'search', arguments: { query: 'TransactionManager', group: 'group' } })
    );
    expect([...new Set(payload.results.map(r => r.project))].sort()).toEqual(['ProjA', 'ProjB']);
  });

  it('hands ripgrep the request signal, so a cancelled call stops it', async () => {
    spawnSignals.length = 0;
    await client.callTool({ name: 'search', arguments: { query: 'TransactionManager', project: 'ProjA' } });
    await client.callTool({ name: 'list_files', arguments: { project: 'ProjA' } });
    expect(spawnSignals).toHaveLength(2);
    expect(spawnSignals.every(signal => signal instanceof AbortSignal)).toBe(true);
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
  it('refuses a file inside .git', async () => {
    const result = await client.callTool({
      name: 'read_file',
      arguments: { project: 'ProjA', relative_path: '.git/config' }
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).not.toContain('FAKETOKEN');
  });

  it('refuses secret-pattern files that search and list_files already hide', async () => {
    const result = await client.callTool({
      name: 'read_file',
      arguments: { project: 'ProjA', relative_path: '.env' }
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Access forbidden \(.git or secret-pattern file\)/);
    expect(textOf(result)).not.toContain('s3cret');
  });

  it('truncates files past the read cap', async () => {
    const content = textOf(
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'ProjB', relative_path: 'big.txt' }
      })
    );
    expect(content).toBe(`${'a'.repeat(500_000)}\n[truncated at 500000 chars in line 1 of 1]`);
  });

  it('returns a whole file exactly, with no footer', async () => {
    const content = textOf(
      await client.callTool({ name: 'read_file', arguments: { project: 'ProjA', relative_path: 'lines.txt' } })
    );
    expect(content).toBe('l1\nl2\nl3\nl4\n');
  });

  it('cuts at the read cap on a line boundary and names the line it stopped in', async () => {
    const line = 'b'.repeat(200_000);
    await writeFile(path.join(root, 'Group', 'ProjB', 'lines-big.txt'), `${line}\n${line}\n${line}\n${line}\n`);
    const content = textOf(
      await client.callTool({ name: 'read_file', arguments: { project: 'ProjB', relative_path: 'lines-big.txt' } })
    );
    expect(content).toBe(`${line}\n${line}\n${'b'.repeat(99_998)}\n[truncated at 500000 chars in line 3 of 4]`);
  });

  it('says when the offset is past the last line', async () => {
    const content = textOf(
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'ProjA', relative_path: 'lines.txt', offset: 9 }
      })
    );
    expect(content).toBe('[offset 9 is past the last line, 4]');
  });

  it('returns an empty file as empty text', async () => {
    await writeFile(path.join(root, 'Solo', 'empty.txt'), '');
    const content = textOf(
      await client.callTool({ name: 'read_file', arguments: { project: 'Solo', relative_path: 'empty.txt' } })
    );
    expect(content).toBe('');
  });

  it('pages with offset and limit', async () => {
    const content = textOf(
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'ProjA', relative_path: 'lines.txt', offset: 2, limit: 2 }
      })
    );
    expect(content).toBe('l2\nl3\n[lines 2-3 of 4]');
  });

  it('reads from the first line when only limit is given', async () => {
    const content = textOf(
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'ProjA', relative_path: 'lines.txt', limit: 1 }
      })
    );
    expect(content).toBe('l1\n[lines 1-1 of 4]');
  });

  it('reads from offset to the end when limit is omitted', async () => {
    const content = textOf(
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'ProjA', relative_path: 'lines.txt', offset: 4 }
      })
    );
    expect(content).toBe('l4\n[lines 4-4 of 4]');
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

  it('path_prefix lists one subdirectory', async () => {
    const payload = jsonOf<{ files: string[] }>(
      await client.callTool({ name: 'list_files', arguments: { project: 'ProjA', path_prefix: 'src' } })
    );
    expect(payload.files).toEqual(['src/a.ts']);
  });

  it('path_prefix refuses an escape, .git and a missing directory', async () => {
    for (const [prefix, message] of [
      ['../..', /escapes the project root/],
      ['.git', /Access forbidden/],
      ['no_such_dir', /No subdirectory "no_such_dir"/]
    ] as const) {
      const result = await client.callTool({
        name: 'list_files',
        arguments: { project: 'ProjA', path_prefix: prefix }
      });
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toMatch(message);
    }
  });

  it('pages past the cap with offset and next_offset', async () => {
    const names = Array.from({ length: 501 }, (_, i) => `f${String(i).padStart(4, '0')}.txt`);
    const dir = path.join(root, 'Group', 'ProjB', 'many');
    await mkdir(dir);
    await Promise.all(names.map(n => writeFile(path.join(dir, n), 'x\n')));
    const first = jsonOf<{ files: string[]; total: number; truncated: boolean; next_offset?: number }>(
      await client.callTool({ name: 'list_files', arguments: { project: 'ProjB', path_prefix: 'many' } })
    );
    expect(first).toMatchObject({ total: 501, truncated: true, next_offset: 500 });
    expect(first.files).toHaveLength(500);
    const second = jsonOf<{ files: string[]; truncated: boolean; next_offset?: number }>(
      await client.callTool({
        name: 'list_files',
        arguments: { project: 'ProjB', path_prefix: 'many', offset: first.next_offset }
      })
    );
    expect(second.files).toEqual(['many/f0500.txt']);
    expect(second.truncated).toBe(false);
    expect(second).not.toHaveProperty('next_offset');
  });

  it('returns an empty page for an offset past the end', async () => {
    const payload = jsonOf<{ files: string[]; total: number; truncated: boolean }>(
      await client.callTool({ name: 'list_files', arguments: { project: 'ProjA', offset: 1000 } })
    );
    expect(payload).toMatchObject({ files: [], truncated: false });
    expect(payload).not.toHaveProperty('next_offset');
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

describe('write_file and symbolic links', () => {
  it('refuses a dangling link that points outside the project, and creates nothing there', async () => {
    const outsideTarget = path.join(root, 'outside-target.txt');
    await symlink(outsideTarget, path.join(root, 'Group', 'ProjA', 'dangling'));
    const result = await client.callTool({
      name: 'write_file',
      arguments: { project: 'ProjA', relative_path: 'dangling', content: 'x' }
    });
    expect(isError(result)).toBe(true);
    await expect(stat(outsideTarget)).rejects.toThrow(/ENOENT/);
  });

  it('refuses a link to an existing file inside the project, and leaves that file unchanged', async () => {
    const target = path.join(root, 'Group', 'ProjA', 'src', 'a.ts');
    const before = await readFile(target, 'utf8');
    await symlink(target, path.join(root, 'Group', 'ProjA', 'inside-link'));
    const result = await client.callTool({
      name: 'write_file',
      arguments: { project: 'ProjA', relative_path: 'inside-link', content: 'y\n' }
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/symbolic link/);
    await expect(readFile(target, 'utf8')).resolves.toBe(before);
  });
});

describe('file tools on a project created after startup', () => {
  let lateRoot: string;
  let lateClient: Client;

  beforeAll(async () => {
    lateRoot = await makeWorkspace({ Group: { Early: { '.git': {} } } });
    const cfg: LensConfig = { roots: [lateRoot], exclude: [], allowWrites: true };
    const reg = new Registry(cfg);
    await reg.initialize();
    lateClient = await connect(reg, cfg);
  });

  afterAll(async () => {
    await lateClient.close();
    await cleanup(lateRoot);
  });

  async function createProject(name: string): Promise<void> {
    await mkdir(path.join(lateRoot, 'Group', name, '.git'), { recursive: true });
    await writeFile(path.join(lateRoot, 'Group', name, 'notes.txt'), 'late\n');
  }

  it('read_file finds it', async () => {
    await createProject('LateRead');
    const result = await lateClient.callTool({
      name: 'read_file',
      arguments: { project: 'LateRead', relative_path: 'notes.txt' }
    });
    expect(textOf(result)).toBe('late\n');
  });

  it('list_files finds it', async () => {
    await createProject('LateList');
    const payload = jsonOf<{ files: string[] }>(
      await lateClient.callTool({ name: 'list_files', arguments: { project: 'LateList' } })
    );
    expect(payload.files).toEqual(['notes.txt']);
  });

  it('project_info reads stack, key files and README at call time, not from the startup scan', async () => {
    const early = path.join(lateRoot, 'Group', 'Early');
    await writeFile(path.join(early, 'package.json'), '{}\n');
    await writeFile(path.join(early, 'README.md'), '# Early\n');
    const info = jsonOf<{ detected_stack: string[]; key_files: string[]; readme_snippet: string | null }>(
      await lateClient.callTool({ name: 'project_info', arguments: { name: 'Early' } })
    );
    expect(info.detected_stack).toEqual(['Node.js']);
    expect(info.key_files).toEqual(['package.json']);
    expect(info.readme_snippet).toBe('# Early\n');
  });

  it('list_projects reads the stack at call time too', async () => {
    await writeFile(path.join(lateRoot, 'Group', 'Early', 'go.mod'), 'module early\n');
    const payload = jsonOf<{ fields: string[]; rows: unknown[][] }>(
      await lateClient.callTool({ name: 'list_projects', arguments: { include: ['stack'] } })
    );
    const stack = payload.fields.indexOf('stack');
    const early = payload.rows.find(row => row[0] === 'Early')!;
    expect(early[stack]).toContain('Go');
  });

  it.skipIf(!notRoot)('list_projects reports an empty stack for an unreadable project, not an error', async () => {
    const locked = path.join(lateRoot, 'Group', 'Locked');
    await mkdir(path.join(locked, '.git'), { recursive: true });
    await lateClient.callTool({ name: 'list_projects', arguments: {} }); // registers it while still readable
    await chmod(locked, 0o000);
    try {
      const result = await lateClient.callTool({ name: 'list_projects', arguments: { include: ['stack'] } });
      expect(isError(result)).toBe(false);
      const payload = jsonOf<{ fields: string[]; rows: unknown[][] }>(result);
      const row = payload.rows.find(r => r[0] === 'Locked')!;
      expect(row[payload.fields.indexOf('stack')]).toEqual([]);
    } finally {
      await chmod(locked, 0o755);
    }
  });

  it('read_file refuses an absolute path that names no registered project', async () => {
    const result = await lateClient.callTool({
      name: 'read_file',
      arguments: { project: '/etc', relative_path: 'passwd' }
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Project not found/);
  });

  it('write_file finds it', async () => {
    await createProject('LateWrite');
    const result = await lateClient.callTool({
      name: 'write_file',
      arguments: { project: 'LateWrite', relative_path: 'out.txt', content: 'written\n' }
    });
    expect(isError(result)).toBe(false);
    await expect(readFile(path.join(lateRoot, 'Group', 'LateWrite', 'out.txt'), 'utf8')).resolves.toBe('written\n');
  });
});

describe('find_project', () => {
  let manyRoot: string;
  let manyClient: Client;

  beforeAll(async () => {
    const services = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`Svc${i}`, { '.git': {} }]));
    manyRoot = await makeWorkspace({ Group: { ...services, Project_Lens: { '.git': {} } } });
    const cfg: LensConfig = { roots: [manyRoot], exclude: [], allowWrites: false };
    const reg = new Registry(cfg);
    await reg.initialize();
    manyClient = await connect(reg, cfg);
  });

  afterAll(async () => {
    await manyClient.close();
    await cleanup(manyRoot);
  });

  it('caps the matches and says so', async () => {
    const payload = jsonOf<{ matches: unknown[]; truncated: boolean }>(
      await manyClient.callTool({ name: 'find_project', arguments: { query: 'svc' } })
    );
    expect(payload.matches).toHaveLength(10);
    expect(payload.truncated).toBe(true);
  });

  it('reports no truncation when every match fits', async () => {
    const payload = jsonOf<{ matches: Array<{ name: string }>; truncated: boolean }>(
      await manyClient.callTool({ name: 'find_project', arguments: { query: 'project lens' } })
    );
    expect(payload.matches.map(m => m.name)).toEqual(['Project_Lens']);
    expect(payload.truncated).toBe(false);
  });
});

describe('readLines', () => {
  /** A line far longer than the read cap, spread over many chunks, followed by a short one. */
  function* hugeFirstLine(chunks: number): Generator<string> {
    const piece = 'x'.repeat(64 * 1024);
    for (let i = 0; i < chunks; i++) yield piece;
    yield '\nsecond\n';
  }

  it('skips a long line outside the slice without keeping it, in linear time', async () => {
    const slice = await readLines(hugeFirstLine(4000), 2, 1); // 256 MiB of line 1
    expect(slice.lines).toEqual(['second']);
    expect(slice.total).toBe(2);
  }, 10_000);

  it('stops at the next line once a line fills the cap exactly', async () => {
    const slice = await readLines([`${'a'.repeat(500_000)}\nhello\n`], 1, Infinity);
    expect(slice.lines).toEqual(['a'.repeat(500_000), '']);
    expect(slice.cutAt).toBe(2);
  });

  it('keeps no more than the cap of a long line inside the slice', async () => {
    const slice = await readLines(hugeFirstLine(4000), 1, 1);
    expect(slice.lines[0]).toHaveLength(500_000);
    expect(slice.cutAt).toBe(1);
    expect(slice.total).toBe(2);
  }, 10_000);
});

describe('group filter with groups that differ only by case', () => {
  let caseRoot: string;
  let caseClient: Client;

  beforeAll(async () => {
    caseRoot = await makeWorkspace({
      AI: { Upper: { '.git': {}, 'a.ts': 'needle\n' } },
      ai: { Lower: { '.git': {}, 'b.ts': 'needle\n' } }
    });
    const cfg: LensConfig = { roots: [caseRoot], exclude: [], allowWrites: false };
    const reg = new Registry(cfg);
    await reg.initialize();
    caseClient = await connect(reg, cfg);
  });

  afterAll(async () => {
    await caseClient.close();
    await cleanup(caseRoot);
  });

  it('takes only the group spelled exactly as given', async () => {
    const table = jsonOf<{ rows: unknown[][] }>(
      await caseClient.callTool({ name: 'list_projects', arguments: { group: 'AI' } })
    );
    expect(table.rows.map(r => r[0])).toEqual(['Upper']);
    const payload = jsonOf<SearchPayload>(
      await caseClient.callTool({ name: 'search', arguments: { query: 'needle', group: 'ai' } })
    );
    expect(payload.results.map(r => r.project)).toEqual(['Lower']);
  });

  it('takes every case-insensitive match when none is spelled exactly', async () => {
    const table = jsonOf<{ rows: unknown[][] }>(
      await caseClient.callTool({ name: 'list_projects', arguments: { group: 'Ai' } })
    );
    expect(table.rows.map(r => r[0]).sort()).toEqual(['Lower', 'Upper']);
  });
});

describe('path_prefix under a root reached through a symbolic link', () => {
  let realRoot: string;
  let linkRoot: string;
  let linkClient: Client;

  beforeAll(async () => {
    realRoot = await makeWorkspace({ Group: { Linked: { '.git': {}, src: { 'a.ts': 'needle\n' } } } });
    linkRoot = `${realRoot}-link`;
    await symlink(realRoot, linkRoot);
    const cfg: LensConfig = { roots: [linkRoot], exclude: [], allowWrites: false };
    const reg = new Registry(cfg);
    await reg.initialize();
    linkClient = await connect(reg, cfg);
  });

  afterAll(async () => {
    await linkClient.close();
    await cleanup(linkRoot);
    await cleanup(realRoot);
  });

  it('list_files keeps paths relative to the project root', async () => {
    const payload = jsonOf<{ files: string[] }>(
      await linkClient.callTool({ name: 'list_files', arguments: { project: 'Linked', path_prefix: 'src' } })
    );
    expect(payload.files).toEqual(['src/a.ts']);
  });

  it('search still attributes the hits to the project', async () => {
    const payload = jsonOf<SearchPayload>(
      await linkClient.callTool({
        name: 'search',
        arguments: { query: 'needle', project: 'Linked', path_prefix: 'src' }
      })
    );
    expect(payload.results.map(r => `${r.project}:${r.file}`)).toEqual(['Linked:src/a.ts']);
  });
});
