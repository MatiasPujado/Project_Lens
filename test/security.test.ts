import { symlink } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isForbiddenPath, isSecretFile, noFollowWriteFlags, resolveWithin, validateName } from '../src/security.js';
import { cleanup, makeWorkspace } from './helpers.js';

let base: string;
let project: string;
let outside: string;

beforeAll(async () => {
  base = await makeWorkspace({
    proj: {
      'file.txt': 'hello',
      sub: { 'nested.txt': 'x' },
      '.git': { config: '[remote "origin"]\n\turl = https://u:FAKETOKEN@example.invalid/r.git\n' },
      '.github': { 'ci.yml': 'x' },
      '.gitignore': 'x',
      'foo.git': 'x',
      mod: { '.git': 'gitdir: ../.git/modules/mod\n' }
    },
    outside: { 'secret.txt': 'top' }
  });
  project = path.join(base, 'proj');
  outside = path.join(base, 'outside');
  await symlink(outside, path.join(project, 'link-dir'));
  await symlink(path.join(outside, 'secret.txt'), path.join(project, 'link-file'));
  await symlink(path.join(project, '.git', 'config'), path.join(project, 'notes.txt'));
  await symlink(path.join(project, 'file.txt'), path.join(project, 'ok-link'));
  await symlink(path.join(project, '.git'), path.join(project, 'gitlink'));
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

describe('resolveWithin access policy', () => {
  it('refuses a read inside .git', async () => {
    await expect(resolveWithin(project, '.git/config')).rejects.toThrow(/forbidden/);
  });

  it('refuses the .git directory itself, as a search path_prefix would name it', async () => {
    await expect(resolveWithin(project, '.git')).rejects.toThrow(/forbidden/);
  });

  it('refuses a committed link whose real path is inside .git', async () => {
    await expect(resolveWithin(project, 'notes.txt')).rejects.toThrow(/forbidden/);
  });

  it('refuses a submodule .git file', async () => {
    await expect(resolveWithin(project, 'mod/.git')).rejects.toThrow(/forbidden/);
  });

  it('refuses a write of a new file inside .git', async () => {
    await expect(resolveWithin(project, '.git/hooks/pre-commit', { forWrite: true })).rejects.toThrow(
      /forbidden/
    );
  });

  it('refuses a write of a new file through a committed directory link into .git', async () => {
    await expect(resolveWithin(project, 'gitlink/hooks/pre-commit', { forWrite: true })).rejects.toThrow(
      /forbidden/
    );
  });

  it('passes on an lstat error other than a missing file, such as a path under a regular file', async () => {
    await expect(resolveWithin(project, 'file.txt/x', { forWrite: true })).rejects.toThrow(/ENOTDIR/);
  });

  it('refuses a write of a secret-pattern file', async () => {
    await expect(resolveWithin(project, '.env', { forWrite: true })).rejects.toThrow(/forbidden/);
  });

  it('allows names that only resemble .git', async () => {
    for (const ok of ['.github/ci.yml', '.gitignore', 'foo.git']) {
      await expect(resolveWithin(project, ok)).resolves.toBe(path.join(project, ok));
    }
  });

  it('allows the project root and a link to an allowed file', async () => {
    await expect(resolveWithin(project, '.')).resolves.toBe(project);
    await expect(resolveWithin(project, 'ok-link')).resolves.toBe(path.join(project, 'file.txt'));
  });
});

describe('isForbiddenPath', () => {
  it('matches a .git segment exactly, anywhere in the path', () => {
    expect(isForbiddenPath('.git')).toBe(true);
    expect(isForbiddenPath('.git/config')).toBe(true);
    expect(isForbiddenPath('mod/.git')).toBe(true);
    expect(isForbiddenPath('a/.git/b')).toBe(true);
  });

  it('matches a .git segment in any letter case, as a case-insensitive filesystem would resolve it', () => {
    expect(isForbiddenPath('.GIT/config')).toBe(true);
    expect(isForbiddenPath('mod/.Git')).toBe(true);
  });

  it('matches a secret-pattern basename', () => {
    expect(isForbiddenPath('.env')).toBe(true);
    expect(isForbiddenPath('keys/id_rsa')).toBe(true);
  });

  it('allows ordinary paths and the root', () => {
    for (const ok of ['', '.github/ci.yml', '.gitignore', 'foo.git', 'src/git/x.ts', 'README.md']) {
      expect(isForbiddenPath(ok)).toBe(false);
    }
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
  });

  it('flags every credential and key file family', () => {
    for (const name of [
      '.npmrc', '.netrc', '.pgpass', '.git-credentials', '.htpasswd',
      'id_ed25519', 'id_ed25519.pub', 'id_ecdsa', 'id_dsa',
      'server.key', 'cert.p12', 'cert.pfx', 'vault.kdbx', 'store.jks', 'app.keystore'
    ]) {
      expect(isSecretFile(`/x/${name}`), name).toBe(true);
    }
    for (const name of ['keyboard.ts', 'monkey.txt', 'npmrc.md', 'id_card.ts']) {
      expect(isSecretFile(`/x/${name}`), name).toBe(false);
    }
    expect(isSecretFile('/x/README.md')).toBe(false);
  });
});

describe('noFollowWriteFlags', () => {
  it('combines write, create, truncate and no-follow', () => {
    const flags = { O_WRONLY: 1, O_CREAT: 2, O_TRUNC: 4, O_NOFOLLOW: 8 };
    expect(noFollowWriteFlags(flags)).toBe(15);
  });

  it('refuses to write where the platform has no O_NOFOLLOW, instead of silently following links', () => {
    expect(() => noFollowWriteFlags({ O_WRONLY: 1, O_CREAT: 2, O_TRUNC: 4 })).toThrow(/O_NOFOLLOW/);
  });
});
