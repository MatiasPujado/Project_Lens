import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { buildServer } from '../src/tools.js';
import { packageVersion } from '../src/version.js';
import { cleanup, makeWorkspace } from './helpers.js';

const made: string[] = [];
afterAll(async () => {
  for (const dir of made) await cleanup(dir);
});

describe('packageVersion', () => {
  it('reads the version of the nearest package.json above the directory', async () => {
    const root = await makeWorkspace({ 'package.json': '{"version":"9.9.9"}', dist: { src: {} } });
    made.push(root);
    expect(packageVersion(path.join(root, 'dist', 'src'))).toBe('9.9.9');
  });

  it('fails loudly when no package.json is found up to the filesystem root', () => {
    expect(() => packageVersion(path.parse(process.cwd()).root)).toThrow(/package\.json/);
  });

  it('fails loudly on a package.json it cannot read, rather than using one further up', async () => {
    const root = await makeWorkspace({ 'package.json': '{"version":"1.0.0"}', pkg: { 'package.json': {} } });
    made.push(root);
    expect(() => packageVersion(path.join(root, 'pkg'))).toThrow(/EISDIR/);
  });

  it('fails loudly on a package.json that is not JSON', async () => {
    const root = await makeWorkspace({ 'package.json': '{ not json' });
    made.push(root);
    expect(() => packageVersion(root)).toThrow(SyntaxError);
  });

  it('fails loudly when the package.json has no string version', async () => {
    const root = await makeWorkspace({ 'package.json': '{"name":"x"}' });
    made.push(root);
    expect(() => packageVersion(root)).toThrow(/version/);
  });
});

describe('server version', () => {
  it('is the version in package.json', async () => {
    const manifest = fileURLToPath(new URL('../package.json', import.meta.url));
    const { version } = JSON.parse(await readFile(manifest, 'utf8')) as { version: string };
    const root = await makeWorkspace({});
    made.push(root);
    const config = { roots: [root], exclude: [], allowWrites: false };
    const registry = new Registry(config);
    await registry.initialize();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await buildServer(registry, config).connect(serverTransport);
    const client = new Client({ name: 'lens-version-test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      expect(client.getServerVersion()?.version).toBe(version);
    } finally {
      await client.close();
    }
  });
});
