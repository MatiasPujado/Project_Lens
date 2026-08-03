import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Registry } from '../src/registry.js';
import { buildServer } from '../src/tools.js';
import { cleanup, makeWorkspace } from './helpers.js';

let root: string;
let client: Client;

function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text: string }> };
  return r.content[0]!.text;
}

function jsonOf<T>(result: unknown): T {
  return JSON.parse(textOf(result)) as T;
}

beforeAll(async () => {
  root = await makeWorkspace({
    Prisma: {
      NEWPAY: {
        Homebanking: {
          '.git': {},
          'pom.xml': '<project/>',
          'README.md': '# Homebanking\nCore backend\n',
          src: { 'Main.java': 'class TransactionManager {}\n' }
        }
      }
    },
    Experiments: { FlatProj: { '.git': {}, 'package.json': '{}' } }
  });
  const config = { roots: [root], exclude: [] };
  const registry = new Registry(config);
  await registry.initialize();
  const server = buildServer(registry, config);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'lens-test', version: '0.0.0' });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await cleanup(root);
});

describe('Project-Lens over MCP', () => {
  it('exposes exactly the 10 spec tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map(t => t.name).sort()).toEqual([
      'find_project',
      'list_groups',
      'list_projects',
      'map_workspace',
      'project_info',
      'read_file',
      'refresh_registry',
      'scaffold_project',
      'search',
      'write_file'
    ]);
  });

  it('map_workspace returns the group -> project map', async () => {
    const payload = jsonOf<{ total_projects: number; map: Record<string, string[]> }>(
      await client.callTool({ name: 'map_workspace', arguments: {} })
    );
    expect(payload.total_projects).toBe(2);
    expect(payload.map['Prisma/NEWPAY']).toEqual(['Homebanking']);
  });

  it('list_groups / list_projects / find_project answer from the registry', async () => {
    const groups = jsonOf<{ groups: string[] }>(
      await client.callTool({ name: 'list_groups', arguments: {} })
    );
    expect(groups.groups).toEqual(['Experiments', 'Prisma/NEWPAY']);

    const listed = jsonOf<{ projects: Array<{ name: string }> }>(
      await client.callTool({ name: 'list_projects', arguments: { group: 'Prisma' } })
    );
    expect(listed.projects.map(p => p.name)).toEqual(['Homebanking']);

    const found = jsonOf<{ matches: Array<{ name: string; group: string }> }>(
      await client.callTool({ name: 'find_project', arguments: { query: 'homebank' } })
    );
    expect(found.matches[0]).toMatchObject({ name: 'Homebanking', group: 'Prisma/NEWPAY' });
  });

  it('project_info returns lazy metadata', async () => {
    const info = jsonOf<{ detected_stack: string[]; readme_snippet: string; vcs: { type: string } }>(
      await client.callTool({ name: 'project_info', arguments: { name: 'Homebanking' } })
    );
    expect(info.detected_stack).toEqual(['Java']);
    expect(info.readme_snippet).toContain('# Homebanking');
    expect(info.vcs.type).toBe('git');
  });

  it('search is scoped and maps hits to projects', async () => {
    const payload = jsonOf<{ results: Array<{ project: string; file: string }> }>(
      await client.callTool({
        name: 'search',
        arguments: { query: 'TransactionManager', project: 'Homebanking' }
      })
    );
    expect(payload.results[0]).toMatchObject({ project: 'Homebanking', file: 'src/Main.java' });

    const invalid = await client.callTool({ name: 'search', arguments: { query: 'x' } });
    expect((invalid as { isError?: boolean }).isError).toBe(true);
  });

  it('read_file and write_file stay inside the project root', async () => {
    const content = textOf(
      await client.callTool({
        name: 'read_file',
        arguments: { project: 'Homebanking', relative_path: 'pom.xml' }
      })
    );
    expect(content).toBe('<project/>');

    await client.callTool({
      name: 'write_file',
      arguments: { project: 'FlatProj', relative_path: 'notes/todo.md', content: 'hi' }
    });
    expect(await readFile(path.join(root, 'Experiments', 'FlatProj', 'notes', 'todo.md'), 'utf8')).toBe('hi');

    const escape = await client.callTool({
      name: 'read_file',
      arguments: { project: 'Homebanking', relative_path: '../../../etc/passwd' }
    });
    expect((escape as { isError?: boolean }).isError).toBe(true);
  });

  it('scaffold_project and refresh_registry round-trip', async () => {
    const created = jsonOf<{ created: string }>(
      await client.callTool({
        name: 'scaffold_project',
        arguments: { group: 'Experiments', name: 'Scaffolded', readme: true }
      })
    );
    expect(created.created).toBe(path.join(root, 'Experiments', 'Scaffolded'));

    const stats = jsonOf<{ projects: number }>(
      await client.callTool({ name: 'refresh_registry', arguments: {} })
    );
    expect(stats.projects).toBe(3);
  });
});
