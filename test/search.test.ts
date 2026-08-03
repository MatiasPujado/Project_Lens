import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { searchScope } from '../src/search.js';
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
});
