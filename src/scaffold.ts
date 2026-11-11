import { execFile } from 'node:child_process';
import { mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateName, within } from './security.js';
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
        const realRoot = await realpath(root);
        if (!within(await realpath(candidate), realRoot)) {
          throw new Error(`Group "${group}" is a symbolic link that leaves the root ${root}`);
        }
        groupDir = candidate;
        owningRoot = root;
        break;
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!code) throw e;
      console.error(`Group "${group}" is not usable under root ${root} (${code})`);
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
  try {
    await run('git', ['init'], { cwd: target, timeout: 10000 });
  } catch (e) {
    await rm(target, { recursive: true, force: true });
    throw e;
  }
  if (opts.readme) await writeFile(path.join(target, 'README.md'), `# ${name}\n`);
  if (opts.gitignore) await writeFile(path.join(target, '.gitignore'), GITIGNORE_STUB);

  const node: ProjectNode = {
    name,
    groupPath: group,
    absolutePath: target,
    root: owningRoot,
    vcsType: 'git'
  };
  registry.add(node);
  return node;
}
