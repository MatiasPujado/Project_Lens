import { realpath } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';

export const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const SECRET_GLOBS = ['.env*', '*.pem', 'id_rsa*', '*credentials*'];
const isSecret = picomatch(SECRET_GLOBS, { nocase: true, basename: true });

export function isSecretFile(filePath: string): boolean {
  return isSecret(path.basename(filePath));
}

export function validateName(name: string, label: string): void {
  if (!NAME_PATTERN.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid ${label} "${name}": only [A-Za-z0-9._-] allowed`);
  }
}

function within(target: string, root: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

export async function resolveWithin(
  projectRoot: string,
  relativePath: string,
  opts: { forWrite?: boolean } = {}
): Promise<string> {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Path must be relative to the project root: ${relativePath}`);
  }
  const realRoot = await realpath(projectRoot);
  const candidate = path.resolve(realRoot, relativePath);
  if (!within(candidate, realRoot)) {
    throw new Error(`Path escapes the project root: ${relativePath}`);
  }
  try {
    const real = await realpath(candidate);
    if (!within(real, realRoot)) {
      throw new Error(`Path escapes the project root (symlink): ${relativePath}`);
    }
    return real;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || !opts.forWrite) throw e;
  }
  let ancestor = path.dirname(candidate);
  const missing: string[] = [path.basename(candidate)];
  for (;;) {
    try {
      const realAncestor = await realpath(ancestor);
      if (!within(realAncestor, realRoot)) {
        throw new Error(`Path escapes the project root (symlink): ${relativePath}`);
      }
      return path.join(realAncestor, ...missing.reverse());
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      missing.push(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}
