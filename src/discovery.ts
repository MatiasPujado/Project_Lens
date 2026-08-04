import { readdir } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';
import { MANIFEST_FILES, detectStack } from './stack.js';
import { isSecretFile } from './security.js';
import type { ProjectNode } from './types.js';

export interface ScanOutput {
  projects: ProjectNode[];
  groupDirs: string[];
}

export function buildExcludeMatcher(exclude: string[]): (rel: string) => boolean {
  if (exclude.length === 0) return () => false;
  const patterns = exclude.flatMap(g => (g.endsWith('/**') ? [g, g.slice(0, -3)] : [g]));
  return picomatch(patterns, { dot: true });
}

export async function scanRoot(root: string, exclude: string[]): Promise<ScanOutput> {
  const isExcluded = buildExcludeMatcher(exclude);
  const projects: ProjectNode[] = [];
  const groupDirs: string[] = [];

  async function walk(dir: string, groupSegments: string[]): Promise<boolean> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    const names = new Set(entries.map(e => e.name));

    const vcsType = names.has('.git') ? 'git' : names.has('.svn') ? 'svn' : null;
    if (vcsType) {
      const name = path.basename(dir);
      const manifests = entries
        .filter(e => e.isFile() && MANIFEST_FILES.has(e.name) && !isSecretFile(e.name))
        .map(e => e.name)
        .sort();
      const readme = entries.find(e => e.isFile() && e.name.toLowerCase() === 'readme.md');
      projects.push({
        name,
        groupPath: groupSegments.slice(0, -1).join('/'),
        absolutePath: dir,
        root,
        vcsType,
        detectedStack: detectStack(manifests),
        keyFiles: manifests,
        readmePath: readme ? path.join(dir, readme.name) : undefined
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
    if (hasProject) groupDirs.push(dir);
    return hasProject;
  }

  await walk(root, []);
  if (!groupDirs.includes(root)) groupDirs.push(root); // root is always revalidated
  return { projects, groupDirs };
}
