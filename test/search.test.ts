import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { excludeGlobArgs, listFiles, parseRgOutput, searchScope } from '../src/search.js';
import type { ProjectNode } from '../src/types.js';
import { cleanup, makeWorkspace } from './helpers.js';

const LIMIT = 50;

let root: string;
let registry: Registry;
let scope: string[];

beforeAll(async () => {
  root = await makeWorkspace({
    Group: {
      ProjA: {
        '.git': {},
        'main.ts': 'export class TransactionManager {}\n',
        '.env': 'TransactionManager=secret\n'
      },
      ProjB: {
        '.git': {},
        docs: { 'arch.md': 'delegates to the TransactionManager\n' }
      }
    }
  });
  registry = new Registry({ roots: [root], exclude: [], allowWrites: false });
  await registry.initialize();
  scope = registry.getAll().map(n => n.absolutePath);
});

afterAll(() => cleanup(root));

const flatten = (files: Array<{ project: string; file: string; lines: Array<[number, string]> }>) =>
  files.flatMap(f => f.lines.map(([line, excerpt]) => ({ project: f.project, file: f.file, line, excerpt })));

describe('searchScope', () => {
  it('finds matches across a group and maps them to projects', async () => {
    const { files, truncated } = await searchScope(scope, registry.getAll(), 'TransactionManager', {
      limit: LIMIT
    });
    expect(files.map(f => f.project).sort()).toEqual(['ProjA', 'ProjB']);
    expect(truncated).toBe(false);
    const a = files.find(f => f.project === 'ProjA')!;
    expect(a.file).toBe('main.ts');
    expect(a.lines).toEqual([[1, 'export class TransactionManager {}']]);
  });

  it('applies glob filters', async () => {
    const { files } = await searchScope(scope, registry.getAll(), 'TransactionManager', {
      limit: LIMIT,
      glob: '*.md'
    });
    expect(files.map(f => f.project)).toEqual(['ProjB']);
  });

  it('prunes directories named in exclude', async () => {
    const { files } = await searchScope(scope, registry.getAll(), 'TransactionManager', {
      limit: LIMIT,
      exclude: ['docs']
    });
    expect(files.map(f => f.project)).toEqual(['ProjA']);
  });

  it('never returns secret-pattern files', async () => {
    const { files } = await searchScope(scope, registry.getAll(), 'TransactionManager', { limit: LIMIT });
    expect(files.some(f => f.file.includes('.env'))).toBe(false);
  });

  it('returns empty on no matches', async () => {
    await expect(
      searchScope(scope, registry.getAll(), 'zzz_nothing', { limit: LIMIT })
    ).resolves.toEqual({ files: [], hitsReturned: 0, truncated: false });
  });

  it('returns empty without invoking ripgrep when the scope is empty', async () => {
    await expect(searchScope([], registry.getAll(), '[', { limit: LIMIT })).resolves.toEqual({
      files: [],
      hitsReturned: 0,
      truncated: false
    });
  });

  it('signals truncation when matches exceed the limit', async () => {
    const { files, hitsReturned, truncated } = await searchScope(
      scope,
      registry.getAll(),
      'TransactionManager',
      { limit: 1 }
    );
    expect(flatten(files)).toHaveLength(1);
    expect(hitsReturned).toBe(1);
    expect(truncated).toBe(true);
  });

  it('stops ripgrep at the limit instead of buffering a result set it discards', async () => {
    // 100k matches is well past the 10 MB a buffered read of rg --json would need.
    const big = await makeWorkspace({
      Group: { Huge: { '.git': {}, 'huge.txt': 'TransactionManager\n'.repeat(100_000) } }
    });
    const bigRegistry = new Registry({ roots: [big], exclude: [], allowWrites: false });
    await bigRegistry.initialize();
    try {
      const { hitsReturned, truncated } = await searchScope(
        bigRegistry.getAll().map(n => n.absolutePath),
        bigRegistry.getAll(),
        'TransactionManager',
        { limit: 10 }
      );
      expect(hitsReturned).toBe(10);
      expect(truncated).toBe(true);
    } finally {
      await cleanup(big);
    }
  });

  it('fails loudly when ripgrep rejects the pattern', async () => {
    await expect(searchScope(scope, registry.getAll(), '[', { limit: LIMIT })).rejects.toThrow(
      /ripgrep failed/
    );
  });

  it('explains when ripgrep is not on PATH', async () => {
    const previous = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(searchScope(scope, registry.getAll(), 'x', { limit: LIMIT })).rejects.toThrow(
        /ripgrep \(rg\) is not installed/
      );
    } finally {
      process.env.PATH = previous;
    }
  });
});

describe('excludeGlobArgs', () => {
  it('anchors a bare directory name so it prunes under absolute scope paths', () => {
    expect(excludeGlobArgs(['test'])).toEqual(['-g', '!**/test/**']);
  });

  it('passes a shaped pattern through untouched', () => {
    expect(excludeGlobArgs(['src/generated/**', '*.min.js'])).toEqual([
      '-g',
      '!src/generated/**',
      '-g',
      '!*.min.js'
    ]);
  });

  it('is empty when nothing is excluded', () => {
    expect(excludeGlobArgs()).toEqual([]);
  });
});

describe('listFiles', () => {
  it('lists project files relative to its root, skipping secret files', async () => {
    const projA = registry.resolve('ProjA');
    const { files, truncated } = await listFiles(projA);
    expect(files).toEqual(['main.ts']);
    expect(truncated).toBe(false);
  });

  it('applies glob filters', async () => {
    const projB = registry.resolve('ProjB');
    const { files } = await listFiles(projB, '*.md');
    expect(files).toEqual(['docs/arch.md']);
  });
});

describe('parseRgOutput', () => {
  const project: ProjectNode = {
    name: 'ProjA',
    groupPath: 'Group',
    absolutePath: '/w/Group/ProjA',
    root: '/w',
    vcsType: 'git',
    detectedStack: [],
    keyFiles: []
  };

  function event(type: string, file: string, line = 1, text = 'hit\n'): string {
    return JSON.stringify({
      type,
      data: { path: { text: file }, line_number: line, lines: { text } }
    });
  }

  const match = (file: string, line = 1, text = 'hit\n') => event('match', file, line, text);

  it('skips malformed lines instead of aborting the whole search', () => {
    const stdout = ['not json at all', match('/w/Group/ProjA/main.ts')].join('\n');
    expect(parseRgOutput(stdout, [project], LIMIT).files).toEqual([
      { project: 'ProjA', file: 'main.ts', lines: [[1, 'hit']] }
    ]);
  });

  it('ignores unrelated events, pathless matches and hits owned by no project', () => {
    const stdout = [
      JSON.stringify({ type: 'begin', data: { path: { text: '/w/Group/ProjA/main.ts' } } }),
      JSON.stringify({ type: 'match', data: { path: {}, line_number: 1, lines: { text: 'x' } } }),
      match('/elsewhere/other.ts'),
      match('/w/Group/ProjA-sibling/other.ts')
    ].join('\n');
    expect(parseRgOutput(stdout, [project], LIMIT).files).toEqual([]);
  });

  it('tolerates a match event carrying no line text', () => {
    const stdout = JSON.stringify({
      type: 'match',
      data: { path: { text: '/w/Group/ProjA/main.ts' }, line_number: 3, lines: {} }
    });
    expect(parseRgOutput(stdout, [project], LIMIT).files[0]!.lines).toEqual([[3, '']]);
  });

  it('drops secret-pattern files and truncates long excerpts', () => {
    const stdout = [
      match('/w/Group/ProjA/.env'),
      match('/w/Group/ProjA/main.ts', 2, 'x'.repeat(400))
    ].join('\n');
    const { files } = parseRgOutput(stdout, [project], LIMIT);
    expect(files).toHaveLength(1);
    expect(files[0]!.lines[0]![1]).toHaveLength(300);
  });

  it('groups every hit in a file under one entry', () => {
    const stdout = [
      match('/w/Group/ProjA/main.ts', 1),
      match('/w/Group/ProjA/other.ts', 4),
      match('/w/Group/ProjA/main.ts', 7)
    ].join('\n');
    const { files, hitsReturned } = parseRgOutput(stdout, [project], LIMIT);
    expect(files.map(f => f.file)).toEqual(['main.ts', 'other.ts']);
    expect(files[0]!.lines.map(([line]) => line)).toEqual([1, 7]);
    expect(hitsReturned).toBe(3);
  });

  it('folds context lines into the excerpt of the match they surround', () => {
    const stdout = [
      event('context', '/w/Group/ProjA/main.ts', 1, 'before\n'),
      match('/w/Group/ProjA/main.ts', 2, 'hit\n'),
      event('context', '/w/Group/ProjA/main.ts', 3, 'after\n')
    ].join('\n');
    const { files, hitsReturned } = parseRgOutput(stdout, [project], LIMIT, 1);
    expect(hitsReturned).toBe(1);
    expect(files[0]!.lines).toEqual([[2, 'before\nhit\nafter']]);
  });

  it('caps hits at the limit and flags the cut', () => {
    const stdout = Array.from({ length: 150 }, (_, i) =>
      match('/w/Group/ProjA/main.ts', i + 1)
    ).join('\n');
    const capped = parseRgOutput(stdout, [project], 100);
    expect(capped.hitsReturned).toBe(100);
    expect(capped.files[0]!.lines).toHaveLength(100);
    expect(capped.truncated).toBe(true);
    const uncapped = parseRgOutput(stdout, [project], 200);
    expect(uncapped.hitsReturned).toBe(150);
    expect(uncapped.truncated).toBe(false);
  });
});
