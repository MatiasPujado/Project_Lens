import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export type Tree = { [name: string]: Tree | string };

export async function makeTree(base: string, tree: Tree): Promise<void> {
  for (const [name, value] of Object.entries(tree)) {
    const target = path.join(base, name);
    if (typeof value === 'string') {
      await writeFile(target, value);
    } else {
      await mkdir(target, { recursive: true });
      await makeTree(target, value);
    }
  }
}

export async function makeWorkspace(tree: Tree): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'lens-test-'));
  await makeTree(root, tree);
  return root;
}

export async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}
