import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { printStats, stats } from './util.js';

const ITERATIONS = 100;
const serverEntry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.js');

const client = new Client({ name: 'lens-bench', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({
    command: 'node',
    args: process.argv[2] ? [serverEntry, process.argv[2]] : [serverEntry],
    env: {
      ...getDefaultEnvironment(),
      ...(process.env.PROJECTS_MCP_CONFIG ? { PROJECTS_MCP_CONFIG: process.env.PROJECTS_MCP_CONFIG } : {}),
      ...(process.env.PROJECT_LENS_PATH ? { PROJECT_LENS_PATH: process.env.PROJECT_LENS_PATH } : {})
    }
  })
);

const { tools } = await client.listTools();
const anyProject = (): Promise<string> =>
  client
    .callTool({ name: 'list_projects', arguments: {} })
    .then(r => {
      const text = (r as { content: Array<{ text: string }> }).content[0]!.text;
      const projects = (JSON.parse(text) as { projects: Array<{ name: string }> }).projects;
      if (projects.length === 0) throw new Error('no projects in registry; check config');
      return projects[0]!.name;
    });

const project = await anyProject();
const cases: Array<[string, Record<string, unknown>]> = [
  ['map_workspace', {}],
  ['list_groups', {}],
  ['list_projects', {}],
  ['find_project', { query: project.slice(0, 4) }],
  ['project_info', { name: project }],
  ['search', { query: 'TODO', project }],
  ['refresh_registry', {}]
];

console.log(`project-lens e2e benchmark — ${tools.length} tools, ${ITERATIONS} iterations each\n`);
for (const [name, args] of cases) {
  await client.callTool({ name, arguments: args }); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await client.callTool({ name, arguments: args });
    samples.push(performance.now() - start);
  }
  printStats(name, stats(samples));
}

await client.close();
