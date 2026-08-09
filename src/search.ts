import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { isSecretFile } from './security.js';
import type { ProjectNode } from './types.js';

/** Hits for one file: [line number, excerpt] pairs, positional to keep responses small. */
export interface FileHits {
  project: string;
  file: string;
  lines: Array<[number, string]>;
}

export interface SearchResult {
  files: FileHits[];
  hitsReturned: number;
  truncated: boolean;
}

export interface SearchOptions {
  limit: number;
  glob?: string;
  exclude?: string[];
  contextLines?: number;
}

export const MAX_FILES = 500;
const MAX_EXCERPT_CHARS = 300;

function runRg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('rg', args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error('ripgrep (rg) is not installed or not on PATH; the search tool requires it'));
      } else if (err && (err as { code?: unknown }).code === 1) {
        resolve(''); // rg exit 1 = no matches
      } else if (err) {
        reject(new Error(`ripgrep failed: ${err.message}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * ripgrep matches globs against the path as given. Scope directories are absolute, so a bare
 * name like "test" only prunes when anchored with a leading **; a pattern the caller already
 * shaped is passed through untouched.
 */
export function excludeGlobArgs(exclude: string[] = []): string[] {
  return exclude.flatMap(pattern => {
    const anchored = /[/*]/.test(pattern) ? pattern : `**/${pattern}/**`;
    return ['-g', `!${anchored}`];
  });
}

interface RgEvent {
  type: string;
  data: { path: { text?: string }; line_number: number; lines: { text?: string } };
}

/**
 * Accumulates rg --json events. Reports when it has seen everything it can use, so a streaming
 * caller can stop ripgrep instead of buffering matches it will throw away.
 */
class HitCollector {
  private readonly matches = new Map<string, number[]>();
  private readonly texts = new Map<string, Map<number, string>>();
  private readonly owners = new Map<string, ProjectNode | undefined>();
  private readonly byPathDesc: ProjectNode[];
  private eventsSinceLimit = 0;
  truncated = false;
  total = 0;

  constructor(
    projects: ProjectNode[],
    private readonly limit: number,
    private readonly contextLines: number
  ) {
    this.byPathDesc = [...projects].sort((a, b) => b.absolutePath.length - a.absolutePath.length);
  }

  private ownerOf(file: string): ProjectNode | undefined {
    if (!this.owners.has(file)) {
      this.owners.set(
        file,
        this.byPathDesc.find(p => file === p.absolutePath || file.startsWith(p.absolutePath + path.sep))
      );
    }
    return this.owners.get(file);
  }

  accept(line: string): boolean {
    if (line) {
      let event: RgEvent;
      try {
        event = JSON.parse(line);
      } catch {
        return true;
      }
      if (event.type === 'match' || event.type === 'context') this.record(event);
    }
    return !this.truncated || this.eventsSinceLimit < this.contextLines;
  }

  private record(event: RgEvent): void {
    const file = event.data.path.text;
    if (!file || isSecretFile(file) || !this.ownerOf(file)) return;
    if (this.truncated) this.eventsSinceLimit++;

    let lines = this.texts.get(file);
    if (!lines) this.texts.set(file, (lines = new Map()));
    lines.set(event.data.line_number, (event.data.lines.text ?? '').trimEnd());

    if (event.type !== 'match') return;
    if (this.total === this.limit) {
      this.truncated = true;
      return;
    }
    this.total++;
    const hit = this.matches.get(file);
    if (hit) hit.push(event.data.line_number);
    else this.matches.set(file, [event.data.line_number]);
  }

  result(): SearchResult {
    const files: FileHits[] = [];
    for (const [file, lineNumbers] of this.matches) {
      const owner = this.ownerOf(file)!;
      const lines = this.texts.get(file)!;
      files.push({
        project: owner.name,
        file: path.relative(owner.absolutePath, file),
        lines: lineNumbers.map(n => [n, excerptAt(lines, n, this.contextLines)] as [number, string])
      });
    }
    return { files, hitsReturned: this.total, truncated: this.truncated };
  }
}

export function parseRgOutput(
  stdout: string,
  projects: ProjectNode[],
  limit: number,
  contextLines = 0
): SearchResult {
  const collector = new HitCollector(projects, limit, contextLines);
  for (const line of stdout.split('\n')) {
    if (!collector.accept(line)) break;
  }
  return collector.result();
}

function excerptAt(lines: Map<number, string>, at: number, contextLines: number): string {
  const block: string[] = [];
  for (let n = at - contextLines; n <= at + contextLines; n++) {
    const text = lines.get(n);
    if (text !== undefined) block.push(text);
  }
  return block.join('\n').slice(0, MAX_EXCERPT_CHARS * (contextLines * 2 + 1));
}

export async function searchScope(
  scopeDirs: string[],
  projects: ProjectNode[],
  query: string,
  opts: SearchOptions
): Promise<SearchResult> {
  if (scopeDirs.length === 0) return { files: [], hitsReturned: 0, truncated: false };
  const contextLines = opts.contextLines ?? 0;
  const args = ['--json', '-e', query];
  if (opts.glob) args.push('-g', opts.glob);
  args.push(...excludeGlobArgs(opts.exclude));
  if (contextLines) args.push('-C', String(contextLines));
  args.push('--', ...scopeDirs);

  const collector = new HitCollector(projects, opts.limit, contextLines);
  return new Promise((resolve, reject) => {
    const rg = spawn('rg', args);
    let stderr = '';
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      fn();
    };

    rg.on('error', (err: NodeJS.ErrnoException) => {
      finish(() =>
        reject(
          err.code === 'ENOENT'
            ? new Error('ripgrep (rg) is not installed or not on PATH; the search tool requires it')
            : new Error(`ripgrep failed: ${err.message}`)
        )
      );
    });
    rg.stderr.on('data', chunk => {
      stderr += String(chunk);
    });

    const lines = readline.createInterface({ input: rg.stdout });
    lines.on('line', line => {
      if (!collector.accept(line)) {
        lines.close();
        rg.kill();
        finish(() => resolve(collector.result()));
      }
    });

    rg.on('close', code => {
      finish(() =>
        code === 0 || code === 1
          ? resolve(collector.result())
          : reject(new Error(`ripgrep failed: ${stderr.trim() || `exit code ${code}`}`))
      );
    });
  });
}

export async function listFiles(
  project: ProjectNode,
  glob?: string
): Promise<{ files: string[]; truncated: boolean }> {
  const args = ['--files'];
  if (glob) args.push('-g', glob);
  args.push('--', project.absolutePath);
  const stdout = await runRg(args);
  const files = stdout
    .split('\n')
    .filter(f => f !== '' && !isSecretFile(f))
    .map(f => path.relative(project.absolutePath, f))
    .sort();
  return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
}
