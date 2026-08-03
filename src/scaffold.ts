import { execFile } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateName } from './security.js';
import type { Registry } from './registry.js';
import type { ProjectNode } from './types.js';

const run = promisify(execFile);

const GITIGNORE_STUB = `.idea/
out/
.ai/
.junie/
.claude/
.gemini/
node_modules/
dist/
target/
*.log
.vscode/
bin/
tmp/
target/
build/
`;

export interface ScaffoldOptions {
  readme?: boolean;
  gitignore?: boolean;
}

export async function scaffoldProject(
  registry: Registry,
  roots: string[],
  group: string,
  name: string,
  opts: ScaffoldOptions = {}
): Promise<ProjectNode> {
  validateName(name, 'project name');
  const segments = group.split('/');
  for (const segment of segments) validateName(segment, 'group segment');

  let groupDir: string | undefined;
  let owningRoot: string | undefined;
  for (const root of roots) {
    const candidate = path.join(root, ...segments);
    try {
      if ((await stat(candidate)).isDirectory()) {
        groupDir = candidate;
        owningRoot = root;
        break;
      }
    } catch {
      // not under this root
    }
  }
  if (!groupDir || !owningRoot) {
    throw new Error(`Group "${group}" does not exist under any configured root`);
  }

  const target = path.join(groupDir, name);
  try {
    await stat(target);
    throw new Error(`Target already exists: ${target}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  await mkdir(target);
  await run('git', ['init'], { cwd: target, timeout: 10000 });
  if (opts.readme) await writeFile(path.join(target, 'README.md'), `# ${name}\n`);
  if (opts.gitignore) await writeFile(path.join(target, '.gitignore'), GITIGNORE_STUB);

  const node: ProjectNode = {
    name,
    groupPath: group,
    absolutePath: target,
    root: owningRoot,
    detectedStack: [],
    keyFiles: [],
    readmePath: opts.readme ? path.join(target, 'README.md') : undefined,
    scannedAt: Date.now()
  };
  registry.add(node);
  return node;
}
