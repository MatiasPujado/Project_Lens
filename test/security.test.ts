import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isSecretFile, resolveWithin, validateName } from '../src/security.js';
import { cleanup, makeWorkspace } from './helpers.js';

let base: string;
let project: string;
let outside: string;

beforeAll(async () => {
  base = await makeWorkspace({
    proj: { 'file.txt': 'hello', sub: { 'nested.txt': 'x' } },
    outside: { 'secret.txt': 'top' }
  });
  project = path.join(base, 'proj');
  outside = path.join(base, 'outside');
  await symlink(outside, path.join(project, 'link-dir'));
  await symlink(path.join(outside, 'secret.txt'), path.join(project, 'link-file'));
});

afterAll(() => cleanup(base));

describe('resolveWithin', () => {
  it('resolves normal relative paths', async () => {
    await expect(resolveWithin(project, 'file.txt')).resolves.toBe(path.join(project, 'file.txt'));
    await expect(resolveWithin(project, 'sub/nested.txt')).resolves.toBe(
      path.join(project, 'sub', 'nested.txt')
    );
  });

  it('rejects ../ escapes', async () => {
    await expect(resolveWithin(project, '../outside/secret.txt')).rejects.toThrow(/escapes/);
    await expect(resolveWithin(project, 'sub/../../outside/secret.txt')).rejects.toThrow(/escapes/);
  });

  it('rejects absolute paths', async () => {
    await expect(resolveWithin(project, '/etc/passwd')).rejects.toThrow(/relative/);
  });

  it('rejects symlink escapes on read', async () => {
    await expect(resolveWithin(project, 'link-file')).rejects.toThrow(/symlink/);
    await expect(resolveWithin(project, 'link-dir/secret.txt')).rejects.toThrow(/symlink/);
  });

  it('rejects symlink escapes on write of a new file', async () => {
    await expect(resolveWithin(project, 'link-dir/new.txt', { forWrite: true })).rejects.toThrow(
      /symlink/
    );
  });

  it('allows writes to new files in new subdirectories', async () => {
    await expect(resolveWithin(project, 'brand/new/file.txt', { forWrite: true })).resolves.toBe(
      path.join(project, 'brand', 'new', 'file.txt')
    );
  });

  it('rejects reads of missing files', async () => {
    await expect(resolveWithin(project, 'missing.txt')).rejects.toThrow();
  });
});

describe('validateName', () => {
  it('accepts safe names and rejects separators/metacharacters', () => {
    expect(() => validateName('My_Proj.2', 'name')).not.toThrow();
    for (const bad of ['a/b', 'a\\b', 'a;rm', 'a b', '$(x)', '.', '..', 'a|b']) {
      expect(() => validateName(bad, 'name')).toThrow(/Invalid/);
    }
  });
});

describe('isSecretFile', () => {
  it('flags secret patterns case-insensitively', () => {
    expect(isSecretFile('/x/.env')).toBe(true);
    expect(isSecretFile('/x/.env.local')).toBe(true);
    expect(isSecretFile('/x/server.pem')).toBe(true);
    expect(isSecretFile('/x/id_rsa')).toBe(true);
    expect(isSecretFile('/x/id_rsa.pub')).toBe(true);
    expect(isSecretFile('/x/aws_credentials.json')).toBe(true);
    expect(isSecretFile('/x/main.ts')).toBe(false);
    expect(isSecretFile('/x/README.md')).toBe(false);
  });
});
