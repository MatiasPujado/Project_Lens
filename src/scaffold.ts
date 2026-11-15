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
build/
`;

export interface ScaffoldOptions {
  readme?: boolean;
  gitignore?: boolean;
  /** A configured root to create the project under; the only one considered when given. */
  root?: string;
  /** The path the user agreed to; when given, any other target is refused rather than created. */
  confirmedTarget?: string;
}

export interface ScaffoldTarget {
  target: string;
  owningRoot: string;
}

/** The configured roots a project may go under: all of them, or the one `root` resolves to. */
function candidateRoots(roots: string[], root: string | undefined): string[] {
  if (root === undefined) return roots;
  const named = roots.filter(r => path.resolve(r) === path.resolve(root));
  if (named.length === 0) throw new Error(`"${root}" is not a configured root: ${roots.join(', ')}`);
  return named;
}

interface Placement {
  groupDir: string;
  owningRoot: string;
}

/** No group: the project goes straight under the root, which must be the only candidate. */
function onlyRoot(candidates: string[]): Placement {
  if (candidates.length !== 1) {
    throw new Error(`No group given and several roots are configured; name one as root: ${candidates.join(', ')}`);
  }
  const root = candidates[0]!;
  return { groupDir: root, owningRoot: root };
}

/** The first candidate root holding `group` as a directory that stays inside that root. */
async function findGroup(candidates: string[], group: string): Promise<Placement> {
  const segments = group.split('/');
  for (const segment of segments) validateName(segment, 'group segment');
  for (const root of candidates) {
    const candidate = path.join(root, ...segments);
    try {
      if ((await stat(candidate)).isDirectory()) {
        const realRoot = await realpath(root);
        if (!within(await realpath(candidate), realRoot)) {
          throw new Error(`Group "${group}" is a symbolic link that leaves the root ${root}`);
        }
        return { groupDir: candidate, owningRoot: root };
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!code) throw e;
      console.error(`Group "${group}" is not usable under root ${root} (${code})`);
    }
  }
  throw new Error(`Group "${group}" does not exist under any configured root`);
}

/**
 * Where scaffoldProject would create <group>/<name>, or <name> straight under a root when there is no group, after
 * every check it makes before writing: valid names, an existing group inside its root, one root to use, no existing
 * target. Lets the caller ask the user about the exact path first.
 */
export async function scaffoldTarget(
  roots: string[],
  group: string | undefined,
  name: string,
  root?: string
): Promise<ScaffoldTarget> {
  validateName(name, 'project name');
  const candidates = candidateRoots(roots, root);
  const { groupDir, owningRoot } =
    group === undefined ? onlyRoot(candidates) : await findGroup(candidates, group);

  const target = path.join(groupDir, name);
  try {
    await stat(target);
    throw new Error(`Target already exists: ${target}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return { target, owningRoot };
}

export async function scaffoldProject(
  registry: Registry,
  roots: string[],
  group: string | undefined,
  name: string,
  opts: ScaffoldOptions = {}
): Promise<ProjectNode> {
  const { target, owningRoot } = await scaffoldTarget(roots, group, name, opts.root);
  if (opts.confirmedTarget !== undefined && opts.confirmedTarget !== target) {
    throw new Error(`Project not created: the target is now ${target}, not the confirmed ${opts.confirmedTarget}`);
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
    groupPath: group ?? '',
    absolutePath: target,
    root: owningRoot,
    vcsType: 'git'
  };
  registry.add(node);
  return node;
}
