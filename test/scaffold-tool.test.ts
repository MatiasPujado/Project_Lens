import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { Client, InMemoryTransport, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { buildServer } from '../src/tools.js';
import type { LensConfig } from '../src/types.js';
import { cleanup, isError, jsonOf, makeWorkspace, textOf } from './helpers.js';

type Answer = (request: ElicitRequest) => ElicitResult | Promise<ElicitResult>;

let root: string;
let config: LensConfig;
let registry: Registry;
const asked: string[] = [];

/**
 * A client that shows the confirmation form and answers it with `answer`; with no answer, no elicitation at all.
 * buildServer offers only the 2025 protocol, so the SDK's legacy shim turns the tool's input_required result into
 * an elicitation/create request to this client.
 */
async function connect(answer?: Answer, reg = registry, cfg = config): Promise<Client> {
  const server = buildServer(reg, cfg);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: 'lens-scaffold-test', version: '0.0.0' },
    answer && { capabilities: { elicitation: { form: {} } } }
  );
  if (answer) {
    client.setRequestHandler('elicitation/create', request => {
      asked.push(request.params.message);
      return answer(request);
    });
  }
  await client.connect(clientTransport);
  return client;
}

async function scaffold(answer: Answer | undefined, args: Record<string, unknown>) {
  const client = await connect(answer);
  try {
    return await client.callTool({ name: 'scaffold_project', arguments: args });
  } finally {
    await client.close();
  }
}

const absent = (name: string) => expect(stat(path.join(root, 'Group', name))).rejects.toThrow(/ENOENT/);

beforeAll(async () => {
  root = await makeWorkspace({ Group: { Existing: { '.git': {} } } });
  config = { roots: [root], exclude: [], allowWrites: true };
  registry = new Registry(config);
  await registry.initialize();
});

afterAll(() => cleanup(root));

describe('scaffold_project asks the user to confirm', () => {
  it('creates the project when the user confirms, after naming the exact target', async () => {
    asked.length = 0;
    const result = await scaffold(() => ({ action: 'accept', content: { confirm: true } }), {
      group: 'Group',
      name: 'Confirmed'
    });
    expect(isError(result)).toBe(false);
    const target = path.join(root, 'Group', 'Confirmed');
    expect(jsonOf<{ created: string }>(result).created).toBe(target);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain(target);
    expect((await stat(path.join(target, '.git'))).isDirectory()).toBe(true);
  });

  it.each([
    ['answers confirm: false', { action: 'accept', content: { confirm: false } }],
    ['declines', { action: 'decline' }],
    ['cancels', { action: 'cancel' }],
    ['accepts with confirm: "yes", not a boolean', { action: 'accept', content: { confirm: 'yes' } }],
    ['accepts with no content', { action: 'accept' }]
  ] as Array<[string, ElicitResult]>)('creates nothing when the user %s', async (_label, answer) => {
    const name = `Refused_${answer.action}_${String(answer.content?.confirm)}`;
    const result = await scaffold(() => answer, { group: 'Group', name });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/not created/i);
    await absent(name);
  });

  it('creates nothing when the client cannot show the form', async () => {
    const result = await scaffold(undefined, { group: 'Group', name: 'NoForm' });
    expect(isError(result)).toBe(true);
    await absent('NoForm');
  });

  it('creates a project straight under a named root, with no group', async () => {
    const result = await scaffold(() => ({ action: 'accept', content: { confirm: true } }), {
      root,
      name: 'Under_Root'
    });
    expect(isError(result)).toBe(false);
    expect(jsonOf<{ created: string; group: string }>(result)).toMatchObject({
      created: path.join(root, 'Under_Root'),
      group: '(root)'
    });
  });

  it('creates nothing when a confirmed answer comes back without the confirmed path', async () => {
    const client = await connect();
    try {
      // inputResponses is not in callTool's typed params: the SDK lifts it from any tools/call, which is the point.
      const params = {
        name: 'scaffold_project',
        arguments: { group: 'Group', name: 'NoState' },
        inputResponses: { confirm: { action: 'accept', content: { confirm: true } } }
      };
      const result = await client.callTool(params);
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toMatch(/not created: the answer did not carry back the confirmed path/i);
      await absent('NoState');
    } finally {
      await client.close();
    }
  });

  it.each([
    ['an unconfigured root', { root: '/etc', name: 'X' }, /not a configured root/],
    ['an invalid name', { group: 'Group', name: 'a;rm' }, /Invalid/],
    ['an unknown group', { group: 'Nope', name: 'X' }, /does not exist/],
    ['an existing target', { group: 'Group', name: 'Existing' }, /already exists/]
  ])('reports %s without asking', async (_label, args, message) => {
    asked.length = 0;
    const result = await scaffold(() => ({ action: 'accept', content: { confirm: true } }), args);
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(message);
    expect(asked).toHaveLength(0);
  });
});

describe('scaffold_project when the target moves while the user answers', () => {
  let first: string;
  let second: string;
  let cfg: LensConfig;
  let reg: Registry;

  beforeAll(async () => {
    first = await makeWorkspace({});
    second = await makeWorkspace({ Shared: {} });
    cfg = { roots: [first, second], exclude: [], allowWrites: true };
    reg = new Registry(cfg);
    await reg.initialize();
  });

  afterAll(async () => {
    await cleanup(first);
    await cleanup(second);
  });

  it('refuses, and creates nothing, when the path worked out again is not the one confirmed', async () => {
    const client = await connect(
      async () => {
        await mkdir(path.join(first, 'Shared')); // while the form is open, the first root starts winning the lookup
        return { action: 'accept', content: { confirm: true } };
      },
      reg,
      cfg
    );
    try {
      const result = await client.callTool({ name: 'scaffold_project', arguments: { group: 'Shared', name: 'Moved' } });
      expect(isError(result)).toBe(true);
      expect(textOf(result)).toMatch(/not created/i);
      await expect(stat(path.join(first, 'Shared', 'Moved'))).rejects.toThrow(/ENOENT/);
      await expect(stat(path.join(second, 'Shared', 'Moved'))).rejects.toThrow(/ENOENT/);
    } finally {
      await client.close();
    }
  });
});
