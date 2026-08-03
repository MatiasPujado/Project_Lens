import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanRoot } from '../src/discovery.js';
import { cleanup, makeWorkspace, notRoot } from './helpers.js';

let root: string;

beforeAll(async () => {
  root = await makeWorkspace({
    Prisma: {
      NEWPAY: {
        Homebanking: {
          '.git': {},
          'pom.xml': '<project/>',
          Dockerfile: 'FROM x',
          'README.md': '# Homebanking\nCore backend\n',
          '.env': 'SECRET=1',
          src: { inner: { '.git': {} } }
        }
      },
      Tools: {
        Pipeline_Updater: { '.git': {}, 'package.json': '{}' }
      }
    },
    Experiments: {
      FlatProj: { '.git': {} }
    },
    Archived_Old: {
      Dead: { '.git': {} }
    },
    Utilities: {
      SomeTool: { '.git': {} }
    },
    NotAProject: { 'readme.txt': 'x' }
  });
});

afterAll(() => cleanup(root));

describe('scanRoot', () => {
  it('finds projects at .git boundaries with arbitrary-depth group paths', async () => {
    const { projects } = await scanRoot(root, []);
    const keys = projects.map(p => (p.groupPath ? `${p.groupPath}/${p.name}` : p.name)).sort();
    expect(keys).toContain('Prisma/NEWPAY/Homebanking');
    expect(keys).toContain('Prisma/Tools/Pipeline_Updater');
    expect(keys).toContain('Experiments/FlatProj');
  });

  it('never descends into project internals', async () => {
    const { projects } = await scanRoot(root, []);
    expect(projects.some(p => p.name === 'inner')).toBe(false);
  });

  it('prunes excluded directories before descent', async () => {
    const { projects } = await scanRoot(root, ['**/Archived*/**', '**/Utilities/**']);
    const names = projects.map(p => p.name);
    expect(names).not.toContain('Dead');
    expect(names).not.toContain('SomeTool');
    expect(names).toContain('Homebanking');
  });

  it('accepts exclude patterns that are not directory globs', async () => {
    const { projects } = await scanRoot(root, ['Experiments']);
    expect(projects.map(p => p.name)).not.toContain('FlatProj');
    expect(projects.map(p => p.name)).toContain('Homebanking');
  });

  it('still revalidates a root that holds no project at all', async () => {
    const barren = await makeWorkspace({ Empty: { 'note.txt': 'x' } });
    const { projects, groupDirs } = await scanRoot(barren, []);
    expect(projects).toEqual([]);
    expect(groupDirs).toEqual([barren]);
    await cleanup(barren);
  });

  it('captures manifests, stack and readme in the boundary readdir', async () => {
    const { projects } = await scanRoot(root, []);
    const hb = projects.find(p => p.name === 'Homebanking')!;
    expect(hb.keyFiles).toEqual(['Dockerfile', 'pom.xml']);
    expect(hb.detectedStack.sort()).toEqual(['Docker', 'Java']);
    expect(hb.readmePath).toMatch(/README\.md$/);
  });

  it('never lists secret-pattern files', async () => {
    const { projects } = await scanRoot(root, []);
    const hb = projects.find(p => p.name === 'Homebanking')!;
    expect(hb.keyFiles.some(f => f.startsWith('.env'))).toBe(false);
  });

  it('records group dirs for mtime revalidation', async () => {
    const { groupDirs } = await scanRoot(root, []);
    expect(groupDirs).toContain(root);
    expect(groupDirs.some(d => d.endsWith('Prisma/NEWPAY'))).toBe(true);
    expect(groupDirs.some(d => d.endsWith('Homebanking'))).toBe(false);
  });

  it('skips dirs that lead to no project, keeping revalidation cheap', async () => {
    const { groupDirs } = await scanRoot(root, []);
    expect(groupDirs.some(d => d.endsWith('NotAProject'))).toBe(false);
  });

  it.skipIf(!notRoot)('skips unreadable dirs instead of aborting the scan', async () => {
    const locked = await makeWorkspace({ Locked: { Hidden: { '.git': {} } }, Open: { Seen: { '.git': {} } } });
    await chmod(path.join(locked, 'Locked'), 0o000);
    try {
      const { projects } = await scanRoot(locked, []);
      expect(projects.map(p => p.name)).toEqual(['Seen']);
    } finally {
      await chmod(path.join(locked, 'Locked'), 0o755);
      await cleanup(locked);
    }
  });
});
