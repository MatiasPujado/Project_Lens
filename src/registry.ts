import { stat } from 'node:fs/promises';
import { scanRoot } from './discovery.js';
import type { LensConfig, ProjectNode } from './types.js';

export interface ScanStats {
  scanned_roots: number;
  groups: number;
  projects: number;
  duration_ms: number;
}

export function projectKey(node: ProjectNode): string {
  return node.groupPath ? `${node.groupPath}/${node.name}` : node.name;
}

export class Registry {
  private nodes = new Map<string, ProjectNode>();
  private dirMtimes = new Map<string, number>();
  private rootOfDir = new Map<string, string>();

  constructor(private readonly config: LensConfig) {}

  async initialize(): Promise<ScanStats> {
    return this.refresh();
  }

  async refresh(): Promise<ScanStats> {
    const start = performance.now();
    this.nodes.clear();
    this.dirMtimes.clear();
    this.rootOfDir.clear();
    for (const root of this.config.roots) {
      await this.scanOne(root);
    }
    return this.stats(start);
  }

  private async scanOne(root: string): Promise<void> {
    for (const [dir, owner] of this.rootOfDir) {
      if (owner === root) {
        this.dirMtimes.delete(dir);
        this.rootOfDir.delete(dir);
      }
    }
    for (const [key, node] of this.nodes) {
      if (node.root === root) this.nodes.delete(key);
    }
    const { projects, groupDirs } = await scanRoot(root, this.config.exclude);
    for (const node of projects) this.nodes.set(projectKey(node), node);
    for (const dir of groupDirs) {
      this.rootOfDir.set(dir, root);
      try {
        this.dirMtimes.set(dir, (await stat(dir)).mtimeMs);
      } catch {
        console.error(`Warning: group directory "${dir}" vanished during scan`);
      }
    }
  }

  async revalidate(): Promise<void> {
    const staleRoots = new Set<string>();
    for (const [dir, mtime] of this.dirMtimes) {
      const root = this.rootOfDir.get(dir)!;
      if (staleRoots.has(root)) continue;
      try {
        if ((await stat(dir)).mtimeMs > mtime) staleRoots.add(root);
      } catch {
        staleRoots.add(root);
      }
    }
    for (const root of staleRoots) await this.scanOne(root);
  }

  getAll(): ProjectNode[] {
    return [...this.nodes.values()];
  }

  groups(): string[] {
    const groups = new Set(this.getAll().map(n => n.groupPath).filter(g => g !== ''));
    return [...groups].sort();
  }

  find(query: string): ProjectNode[] {
    const q = query.toLowerCase();
    const scored: Array<[number, ProjectNode]> = [];
    for (const node of this.nodes.values()) {
      const name = node.name.toLowerCase();
      let score = 0;
      if (name === q) score = 3;
      else if (name.startsWith(q)) score = 2;
      else if (name.includes(q)) score = 1;
      if (score > 0) scored.push([score, node]);
    }
    return scored
      .sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name))
      .slice(0, 10)
      .map(([, node]) => node);
  }

  resolve(nameOrPath: string): ProjectNode {
    const byKey = this.nodes.get(nameOrPath);
    if (byKey) return byKey;
    const byName = this.getAll().filter(n => n.name === nameOrPath);
    if (byName.length === 1) return byName[0]!;
    if (byName.length > 1) {
      const keys = byName.map(projectKey).join(', ');
      throw new Error(`Project name "${nameOrPath}" is ambiguous; use one of: ${keys}`);
    }
    throw new Error(`Project not found: "${nameOrPath}". Try find_project first.`);
  }

  add(node: ProjectNode): void {
    this.nodes.set(projectKey(node), node);
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
