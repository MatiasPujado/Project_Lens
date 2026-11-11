import type { Dirent } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { MANIFEST_FILES, detectStack } from './stack.js';
import { isSecretFile } from './security.js';
import type { ProjectNode } from './types.js';

export interface ScanOutput {
  projects: ProjectNode[];
  /** Group directories (and the root) with the mtime each had just before it was read. */
  groupDirs: Map<string, number>;
}

export interface ProjectFiles {
  detectedStack: string[];
  keyFiles: string[];
  readmePath: string | undefined;
}

/** What a project directory's own entries say about it: manifests (never a secret-pattern name), stack and README. */
export function projectFiles(dir: string, entries: Dirent[]): ProjectFiles {
  const keyFiles = entries
    .filter(e => e.isFile() && MANIFEST_FILES.has(e.name) && !isSecretFile(e.name))
    .map(e => e.name)
    .sort();
  const readme = entries.find(e => e.isFile() && e.name.toLowerCase() === 'readme.md');
  return {
    detectedStack: detectStack(keyFiles),
    keyFiles,
    readmePath: readme ? path.join(dir, readme.name) : undefined
  };
}

export function buildExcludeMatcher(exclude: string[]): (rel: string) => boolean {
  if (exclude.length === 0) return () => false;
  const patterns = exclude.flatMap(g => (g.endsWith('/**') ? [g, g.slice(0, -3)] : [g]));
  return picomatch(patterns, { dot: true });
}

export async function scanRoot(root: string, exclude: string[]): Promise<ScanOutput> {
  const isExcluded = buildExcludeMatcher(exclude);
  const projects: ProjectNode[] = [];
  const groupDirs = new Map<string, number>();

  async function walk(dir: string, groupSegments: string[]): Promise<boolean> {
    let mtime;
    let entries;
    try {
      // Taken before the read: an entry added after it moves the mtime past this value, so revalidation sees it.
      mtime = (await stat(dir)).mtimeMs;
      if (dir === root) groupDirs.set(dir, mtime); // root is always revalidated, even when it cannot be read
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    const names = new Set(entries.map(e => e.name));

    const vcsType = names.has('.git') ? 'git' : names.has('.svn') ? 'svn' : null;
    if (vcsType) {
      projects.push({
        name: path.basename(dir),
        groupPath: groupSegments.slice(0, -1).join('/'),
        absolutePath: dir,
        root,
        vcsType
      });
      return true;
    }

    let hasProject = false;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const rel = [...groupSegments, entry.name].join('/');
      if (isExcluded(rel)) continue;
      if (await walk(path.join(dir, entry.name), [...groupSegments, entry.name])) hasProject = true;
    }
    if (hasProject) groupDirs.set(dir, mtime);
    return hasProject;
  }

  await walk(root, []);
  return { projects, groupDirs };
}
