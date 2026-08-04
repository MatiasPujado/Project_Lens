import { anyProject, connect } from './client.js';
import { printStats, stats } from './util.js';

const ITERATIONS = 100;

const client = await connect('lens-bench');
const { tools } = await client.listTools();
const project = (await anyProject(client)).name;
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
