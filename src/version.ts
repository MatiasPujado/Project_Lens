import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The version in the nearest package.json at or above `dir`. Searched rather than imported: the build lands in
 * dist/src and only package.json at the package root is published, so the relative path differs between the
 * sources and the build.
 */
export function packageVersion(dir: string = path.dirname(fileURLToPath(import.meta.url))): string {
  for (let current = dir; ; current = path.dirname(current)) {
    const file = path.join(current, 'package.json');
    let raw: string;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // one that exists but cannot be read is an error
      if (path.dirname(current) === current) throw new Error(`No package.json found above ${dir}`, { cause: e });
      continue;
    }
    const { version } = JSON.parse(raw) as { version?: unknown };
    if (typeof version !== 'string') throw new Error(`${file} has no string version`);
    return version;
  }
}
