import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { main } from '../src/main.js';
import { cleanup, makeWorkspace } from './helpers.js';

vi.mock('@modelcontextprotocol/server/stdio', () => ({ serveStdio: vi.fn() }));

let root: string;

beforeAll(async () => {
  root = await makeWorkspace({
    Group: { ProjA: { '.git': {} }, ProjB: { '.git': {} } }
  });
});

afterAll(() => cleanup(root));

afterEach(() => vi.restoreAllMocks());

describe('main', () => {
  it('boots the registry from the root argument and serves over stdio', async () => {
    const banner = vi.spyOn(console, 'error').mockImplementation(() => {});
    await main([root], {});

    expect(banner).toHaveBeenCalledWith(
      expect.stringMatching(/^project-lens: 2 projects in 1 groups across 1 roots \(\d+ ms\)$/)
    );
    expect(serveStdio).toHaveBeenCalledOnce();

    const factory = vi.mocked(serveStdio).mock.calls[0]![0] as unknown as () => { registerTool: unknown };
    expect(factory()).toHaveProperty('registerTool');
  });

  it('prefers PROJECT_LENS_PATH when no root argument is given', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(main([], { PROJECT_LENS_PATH: root })).resolves.toBeUndefined();
  });

  it('fails loudly when no root is configured anywhere', async () => {
    const missing = path.join(root, 'no-such-config-dir');
    await expect(main([], { XDG_CONFIG_HOME: missing })).rejects.toThrow(/No workspace root/);
  });
});
