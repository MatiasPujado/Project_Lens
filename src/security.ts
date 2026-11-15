import { constants } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import picomatch from 'picomatch';

export const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const SECRET_GLOBS = [
  '.env*', '*credentials*', '.npmrc', '.netrc', '.pgpass', '.htpasswd',
  'id_rsa*', 'id_ed25519*', 'id_ecdsa*', 'id_dsa*',
  '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.kdbx'
];
const isSecret = picomatch(SECRET_GLOBS, { nocase: true, basename: true, dot: true });

export function isSecretFile(filePath: string): boolean {
  return isSecret(path.basename(filePath));
}

/**
 * The one access rule: a path relative to the project root may be read or written unless a segment is
 * exactly `.git` (git metadata holds remote credentials and hooks git runs) or its name is secret-pattern.
 */
export function isForbiddenPath(relativePath: string): boolean {
  // Any case: on a case-insensitive filesystem `.GIT` opens the real `.git`.
  return relativePath.split(path.sep).some(segment => segment.toLowerCase() === '.git') || isSecretFile(relativePath);
}

type OpenFlags = { O_WRONLY: number; O_CREAT: number; O_TRUNC: number; O_NOFOLLOW?: number };

/**
 * Flags for opening a file to write without following a symbolic link in its last component. Where the
 * platform has no O_NOFOLLOW (Windows), OR-ing undefined would silently drop the protection, so it throws.
 */
export function noFollowWriteFlags(flags: OpenFlags = constants): number {
  if (flags.O_NOFOLLOW === undefined) {
    throw new Error('Writes are not supported on this platform: it has no O_NOFOLLOW to refuse symbolic links');
  }
  return flags.O_WRONLY | flags.O_CREAT | flags.O_TRUNC | flags.O_NOFOLLOW;
}

/** A write never goes through a symbolic link in the last component, dangling or not, inside or out. */
async function assertNotLink(candidate: string, relativePath: string): Promise<void> {
  try {
    if ((await lstat(candidate)).isSymbolicLink()) {
      throw new Error(`Refusing to write through a symbolic link: ${relativePath}`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

function assertAllowed(realRoot: string, target: string, relativePath: string): string {
  if (isForbiddenPath(path.relative(realRoot, target))) {
    throw new Error(`Access forbidden (.git or secret-pattern file): ${relativePath}`);
  }
  return target;
}

export function validateName(name: string, label: string): void {
  if (!NAME_PATTERN.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid ${label} "${name}": only [A-Za-z0-9._-] allowed`);
  }
}

export function within(target: string, root: string): boolean {
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
  assertAllowed(realRoot, candidate, relativePath);
  if (opts.forWrite) await assertNotLink(candidate, relativePath);
  try {
    const real = await realpath(candidate);
    if (!within(real, realRoot)) {
      throw new Error(`Path escapes the project root (symlink): ${relativePath}`);
    }
    return assertAllowed(realRoot, real, relativePath);
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
      return assertAllowed(realRoot, path.join(realAncestor, ...missing.reverse()), relativePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      missing.push(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}
