import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { parseRgOutput, searchScope } from '../src/search.js';
import type { ProjectNode } from '../src/types.js';
import { cleanup, makeWorkspace } from './helpers.js';

let root: string;
let registry: Registry;

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
  registry = new Registry({ roots: [root], exclude: [] });
  await registry.initialize();
});

afterAll(() => cleanup(root));

describe('searchScope', () => {
  it('finds matches across a group and maps them to projects', async () => {
    const hits = await searchScope(
      `${root}/Group`,
      registry.getAll(),
      'TransactionManager'
    );
    const projects = hits.map(h => h.project).sort();
    expect(projects).toEqual(['ProjA', 'ProjB']);
    const a = hits.find(h => h.project === 'ProjA')!;
    expect(a.file).toBe('main.ts');
    expect(a.line).toBe(1);
    expect(a.excerpt).toContain('TransactionManager');
  });

  it('applies glob filters', async () => {
    const hits = await searchScope(`${root}/Group`, registry.getAll(), 'TransactionManager', '*.md');
    expect(hits.map(h => h.project)).toEqual(['ProjB']);
  });

  it('never returns secret-pattern files', async () => {
    const hits = await searchScope(`${root}/Group`, registry.getAll(), 'TransactionManager');
    expect(hits.some(h => h.file.includes('.env'))).toBe(false);
  });

  it('returns empty on no matches', async () => {
    await expect(searchScope(`${root}/Group`, registry.getAll(), 'zzz_nothing')).resolves.toEqual([]);
  });

  it('fails loudly when ripgrep rejects the pattern', async () => {
    await expect(searchScope(`${root}/Group`, registry.getAll(), '[')).rejects.toThrow(
      /ripgrep failed/
    );
  });

  it('explains when ripgrep is not on PATH', async () => {
    const previous = process.env.PATH;
    process.env.PATH = '';
    try {
      await expect(searchScope(`${root}/Group`, registry.getAll(), 'x')).rejects.toThrow(
        /ripgrep \(rg\) is not installed/
      );
    } finally {
      process.env.PATH = previous;
    }
  });
});

describe('parseRgOutput', () => {
  const project: ProjectNode = {
    name: 'ProjA',
    groupPath: 'Group',
    absolutePath: '/w/Group/ProjA',
    root: '/w',
    detectedStack: [],
    keyFiles: [],
    scannedAt: 0
  };

  function match(file: string, line = 1, text = 'hit\n'): string {
    return JSON.stringify({
      type: 'match',
      data: { path: { text: file }, line_number: line, lines: { text } }
    });
  }

  it('skips malformed lines instead of aborting the whole search', () => {
    const stdout = ['not json at all', match('/w/Group/ProjA/main.ts')].join('\n');
    expect(parseRgOutput(stdout, [project])).toEqual([
      { project: 'ProjA', file: 'main.ts', line: 1, excerpt: 'hit' }
    ]);
  });

  it('ignores non-match events, pathless matches and hits owned by no project', () => {
    const stdout = [
      JSON.stringify({ type: 'begin', data: { path: { text: '/w/Group/ProjA/main.ts' } } }),
      JSON.stringify({ type: 'match', data: { path: {}, line_number: 1, lines: { text: 'x' } } }),
      match('/elsewhere/other.ts'),
      match('/w/Group/ProjA-sibling/other.ts')
    ].join('\n');
    expect(parseRgOutput(stdout, [project])).toEqual([]);
  });

  it('tolerates a match event carrying no line text', () => {
    const stdout = JSON.stringify({
      type: 'match',
      data: { path: { text: '/w/Group/ProjA/main.ts' }, line_number: 3, lines: {} }
    });
    expect(parseRgOutput(stdout, [project])[0]!.excerpt).toBe('');
  });

  it('drops secret-pattern files and truncates long excerpts', () => {
    const stdout = [
      match('/w/Group/ProjA/.env'),
      match('/w/Group/ProjA/main.ts', 2, 'x'.repeat(400))
    ].join('\n');
    const hits = parseRgOutput(stdout, [project]);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.excerpt).toHaveLength(300);
  });

  it('caps the result list', () => {
    const stdout = Array.from({ length: 150 }, (_, i) =>
      match('/w/Group/ProjA/main.ts', i + 1)
    ).join('\n');
    expect(parseRgOutput(stdout, [project])).toHaveLength(100);
  });
});
