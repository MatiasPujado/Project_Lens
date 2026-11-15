import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { isForbiddenPath } from './security.js';
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
  fixedStrings?: boolean;
  ignoreCase?: boolean;
  /** The request's cancellation; aborting it kills ripgrep. */
  signal?: AbortSignal;
}

export const MAX_FILES = 500;
const MAX_EXCERPT_CHARS = 300;
const MAX_STDERR_CHARS = 4096;

/** A user's ripgreprc could hide files or change the output format, so the server never reads one. */
const RG_BASE_ARGS = ['--no-config'];

/**
 * Runs ripgrep and hands it each stdout line. `onLine` returns false once it has all it can use; ripgrep is
 * then stopped instead of producing output nobody reads. Exit 1 means no matches, not a failure.
 */
function runRg(args: string[], onLine: (line: string) => boolean, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const rg = spawn('rg', [...RG_BASE_ARGS, ...args], { signal });
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
          err.name === 'AbortError'
            ? new Error('Request cancelled; ripgrep stopped')
            : err.code === 'ENOENT'
              ? new Error('ripgrep (rg) is not installed or not on PATH; this tool requires it')
              : new Error(`ripgrep failed: ${err.message}`)
        )
      );
    });
    rg.stderr.on('data', chunk => {
      stderr = (stderr + String(chunk)).slice(0, MAX_STDERR_CHARS); // only the start reaches the error
    });

    const lines = readline.createInterface({ input: rg.stdout });
    lines.on('line', line => {
      if (onLine(line)) return;
      lines.close();
      rg.kill();
      finish(resolve);
    });

    rg.on('close', code => {
      finish(() =>
        code === 0 || code === 1
          ? resolve()
          : reject(new Error(`ripgrep failed: ${stderr.trim() || `exit code ${code}`}`))
      );
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
        event = JSON.parse(line) as RgEvent;
      } catch {
        return true;
      }
      if (event.type === 'match' || event.type === 'context') this.record(event);
    }
    return !this.truncated || this.eventsSinceLimit < this.contextLines;
  }

  private record(event: RgEvent): void {
    const file = event.data.path.text;
    const owner = file ? this.ownerOf(file) : undefined;
    if (!file || !owner || isForbiddenPath(path.relative(owner.absolutePath, file))) return;
    if (this.truncated) this.eventsSinceLimit++;

    let lines = this.texts.get(file);
    if (!lines) this.texts.set(file, (lines = new Map<number, string>()));
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
    // Each line is capped on its own, so a long neighbour can never push the matching line out.
    if (text !== undefined) block.push(text.slice(0, MAX_EXCERPT_CHARS));
  }
  return block.join('\n');
}

export async function searchScope(
  scopeDirs: string[],
  projects: ProjectNode[],
  query: string,
  opts: SearchOptions
): Promise<SearchResult> {
  if (scopeDirs.length === 0) return { files: [], hitsReturned: 0, truncated: false };
  const contextLines = opts.contextLines ?? 0;
  const args = ['--json'];
  if (opts.fixedStrings) args.push('-F');
  if (opts.ignoreCase) args.push('-i');
  args.push('-e', query);
  if (opts.glob) args.push('-g', opts.glob);
  args.push(...excludeGlobArgs(opts.exclude));
  if (contextLines) args.push('-C', String(contextLines));
  args.push('--', ...scopeDirs);

  const collector = new HitCollector(projects, opts.limit, contextLines);
  await runRg(args, line => collector.accept(line), opts.signal);
  return collector.result();
}

export interface ListOptions {
  glob?: string;
  /** Directory inside the project to list; paths stay relative to the project root. */
  dir?: string;
  /** Paths to skip, so a caller can page past MAX_FILES. */
  offset?: number;
  /** The request's cancellation; aborting it kills ripgrep. */
  signal?: AbortSignal;
}

export async function listFiles(
  project: ProjectNode,
  opts: ListOptions = {}
): Promise<{ files: string[]; total: number; truncated: boolean }> {
  const args = ['--files'];
  if (opts.glob) args.push('-g', opts.glob);
  args.push('--', opts.dir ?? project.absolutePath);
  const listed: string[] = [];
  await runRg(
    args,
    line => {
      listed.push(line);
      return true;
    },
    opts.signal
  );
  const all = listed
    .map(f => path.relative(project.absolutePath, f))
    .filter(f => !isForbiddenPath(f))
    .sort();
  const offset = opts.offset ?? 0;
  return {
    files: all.slice(offset, offset + MAX_FILES),
    total: all.length,
    truncated: all.length > offset + MAX_FILES
  };
}
