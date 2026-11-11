import { stat } from 'node:fs/promises';
import path from 'node:path';
import { excludeFor } from './config.js';
import { scanRoot } from './discovery.js';
import type { LensConfig, ProjectNode } from './types.js';

export interface ScanStats {
  scanned_roots: number;
  groups: number;
  projects: number;
  duration_ms: number;
}

/**
 * The locale is pinned on purpose. `localeCompare` with no locale follows the host's default, so an
 * unpinned call would order group and project names differently on different machines, and these
 * orderings go out in tool responses, which are compared across runs.
 */
export const byName = (a: string, b: string): number => a.localeCompare(b, 'en');

export function projectKey(node: ProjectNode): string {
  return node.groupPath ? `${node.groupPath}/${node.name}` : node.name;
}

const SEPARATORS = /[\s_.-]/g;

/**
 * exact > prefix > substring, first on the name as written, then with separators removed. A name as written
 * always ranks above a separator-insensitive one, so an original lists before a copy renamed without separators.
 */
function matchScore(name: string, query: string, looseQuery: string): number {
  if (name === query) return 6;
  if (name.startsWith(query)) return 5;
  if (name.includes(query)) return 4;
  if (looseQuery === '') return 0;
  const loose = name.replace(SEPARATORS, '');
  if (loose === looseQuery) return 3;
  if (loose.startsWith(looseQuery)) return 2;
  return loose.includes(looseQuery) ? 1 : 0;
}

/** Names a match the caller can pass back: its key, or its absolute path when another root holds the same key. */
function choices(matches: ProjectNode[]): string[] {
  const keys = matches.map(projectKey);
  const shared = (key: string) => keys.indexOf(key) !== keys.lastIndexOf(key);
  return matches.map((node, i) => (shared(keys[i]!) ? node.absolutePath : keys[i]!));
}

export class Registry {
  /** Keyed by absolute path: two roots may hold the same group/name, and both copies stay reachable. */
  private nodes = new Map<string, ProjectNode>();
  private dirMtimes = new Map<string, number>();
  private rootOfDir = new Map<string, string>();
  /** The scan now running, if any. Callers that arrive meanwhile wait for it instead of starting another. */
  private inFlight: Promise<void> | undefined;
  /** Projects added while a scan runs; the scan's maps were copied before them, so the swap puts them back. */
  private addedDuringScan: ProjectNode[] = [];

  constructor(private readonly config: LensConfig) {}

  async initialize(): Promise<ScanStats> {
    return this.refresh();
  }

  async refresh(): Promise<ScanStats> {
    const start = performance.now();
    // A revalidation in flight may rescan only some roots; wait until none runs, then scan them all.
    while (this.inFlight) await this.inFlight;
    await this.exclusive(() => this.rescan(this.config.roots));
    return this.stats(start);
  }

  async revalidate(): Promise<void> {
    await this.exclusive(async () => this.rescan(await this.staleRoots()));
  }

  private exclusive(scan: () => Promise<void>): Promise<void> {
    this.inFlight ??= scan().finally(() => {
      this.inFlight = undefined;
      this.addedDuringScan = [];
    });
    return this.inFlight;
  }

  private async staleRoots(): Promise<string[]> {
    const stale = new Set<string>();
    for (const [dir, mtime] of this.dirMtimes) {
      const root = this.rootOfDir.get(dir)!;
      if (stale.has(root)) continue;
      try {
        if ((await stat(dir)).mtimeMs > mtime) stale.add(root);
      } catch {
        stale.add(root);
      }
    }
    return [...stale];
  }

  /**
   * Scans `roots` into copies of the maps and swaps them in at the end, so a lookup made while the
   * scan awaits the filesystem still sees the previous, complete registry.
   */
  private async rescan(roots: string[]): Promise<void> {
    if (roots.length === 0) return;
    const rescanned = new Set(roots);
    const nodes = new Map([...this.nodes].filter(([, node]) => !rescanned.has(node.root)));
    const rootOfDir = new Map([...this.rootOfDir].filter(([, owner]) => !rescanned.has(owner)));
    const dirMtimes = new Map([...this.dirMtimes].filter(([dir]) => rootOfDir.has(dir)));
    for (const root of roots) {
      const { projects, groupDirs } = await scanRoot(root, excludeFor(this.config, root));
      for (const node of projects) nodes.set(node.absolutePath, node);
      for (const [dir, mtime] of groupDirs) {
        rootOfDir.set(dir, root);
        dirMtimes.set(dir, mtime);
      }
    }
    for (const node of this.addedDuringScan) nodes.set(node.absolutePath, node);
    this.nodes = nodes;
    this.rootOfDir = rootOfDir;
    this.dirMtimes = dirMtimes;
  }

  getAll(): ProjectNode[] {
    return [...this.nodes.values()];
  }

  groups(): string[] {
    const groups = new Set(this.getAll().map(n => n.groupPath).filter(g => g !== ''));
    return [...groups].sort(byName);
  }

  /** Every project whose name matches `query`, best first; callers cap the list themselves. */
  find(query: string): ProjectNode[] {
    const q = query.toLowerCase();
    const loose = q.replace(SEPARATORS, '');
    const scored: Array<[number, ProjectNode]> = [];
    for (const node of this.nodes.values()) {
      const score = matchScore(node.name.toLowerCase(), q, loose);
      if (score > 0) scored.push([score, node]);
    }
    scored.sort((a, b) => b[0] - a[0] || byName(a[1].name, b[1].name));
    return scored.map(([, node]) => node);
  }

  resolve(nameOrPath: string): ProjectNode {
    const byPath = path.isAbsolute(nameOrPath) ? this.nodes.get(path.resolve(nameOrPath)) : undefined;
    if (byPath) return byPath;
    const all = this.getAll();
    const exact = all.filter(n => projectKey(n) === nameOrPath);
    const q = nameOrPath.toLowerCase();
    const matches =
      exact.length > 0 ? exact : all.filter(n => n.name.toLowerCase() === q || projectKey(n).toLowerCase() === q);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`Project name "${nameOrPath}" is ambiguous; use one of: ${choices(matches).join(', ')}`);
    }
    const candidates = choices(this.find(nameOrPath).slice(0, 5));
    throw new Error(
      candidates.length > 0
        ? `Project not found: "${nameOrPath}". Closest matches: ${candidates.join(', ')}`
        : `Project not found: "${nameOrPath}". Try find_project first.`
    );
  }

  add(node: ProjectNode): void {
    this.nodes.set(node.absolutePath, node);
    if (this.inFlight) this.addedDuringScan.push(node);
  }

  private stats(start: number): ScanStats {
    return {
      scanned_roots: this.config.roots.length,
      groups: this.groups().length,
      projects: this.nodes.size,
      duration_ms: Math.round(performance.now() - start)
    };
  }
}
