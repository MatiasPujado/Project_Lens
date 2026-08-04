import { execFile } from 'node:child_process';
import path from 'node:path';
import { isSecretFile } from './security.js';
import type { ProjectNode } from './types.js';

export interface SearchHit {
  project: string;
  file: string;
  line: number;
  excerpt: string;
}

export interface SearchResult {
  hits: SearchHit[];
  truncated: boolean;
}

export const MAX_FILES = 500;

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

export function parseRgOutput(stdout: string, projects: ProjectNode[], limit: number): SearchResult {
  const byPathDesc = [...projects].sort((a, b) => b.absolutePath.length - a.absolutePath.length);
  const hits: SearchHit[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    let event: { type: string; data: { path: { text?: string }; line_number: number; lines: { text?: string } } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== 'match') continue;
    const file = event.data.path.text;
    if (!file || isSecretFile(file)) continue;
    const owner = byPathDesc.find(
      p => file === p.absolutePath || file.startsWith(p.absolutePath + path.sep)
    );
    if (!owner) continue;
    if (hits.length === limit) return { hits, truncated: true };
    hits.push({
      project: owner.name,
      file: path.relative(owner.absolutePath, file),
      line: event.data.line_number,
      excerpt: (event.data.lines.text ?? '').trimEnd().slice(0, 300)
    });
  }
  return { hits, truncated: false };
}

export async function searchScope(
  scopeDir: string,
  projects: ProjectNode[],
  query: string,
  glob: string | undefined,
  limit: number
): Promise<SearchResult> {
  const args = ['--json', '--max-count', '20', '-e', query];
  if (glob) args.push('-g', glob);
  args.push('--', scopeDir);
  return parseRgOutput(await runRg(args), projects, limit);
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
