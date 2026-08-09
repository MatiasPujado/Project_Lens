import { anyProject, connect } from './client.js';
import { printStats, stats } from './util.js';

const ITERATIONS = 100;

const client = await connect('lens-bench');
const { tools } = await client.listTools();
const sample = await anyProject(client);
const project = sample.name;
interface Case {
  label: string;
  tool: string;
  args: Record<string, unknown>;
}
const cases: Case[] = [
  { label: 'map_workspace', tool: 'map_workspace', args: {} },
  { label: 'list_groups', tool: 'list_groups', args: {} },
  { label: 'list_projects', tool: 'list_projects', args: {} },
  { label: 'find_project', tool: 'find_project', args: { query: project.slice(0, 4) } },
  { label: 'project_info', tool: 'project_info', args: { name: project } },
  { label: 'search (project)', tool: 'search', args: { query: 'TODO', project } },
  // The widest scope is the one the narrowing parameters exist to avoid; measure what it costs.
  { label: 'search (scope all)', tool: 'search', args: { query: 'TODO', scope: 'all' } },
  { label: 'refresh_registry', tool: 'refresh_registry', args: {} }
];

console.log(
  `project-lens e2e benchmark — ${new Set(cases.map(c => c.tool)).size} of ${tools.length} ` +
    `registered tools in ${cases.length} cases, ${ITERATIONS} iterations each`
);
console.log(
  `sample project: ${sample.group}/${sample.name} — project_info and search scale with it; ` +
    'pin it with LENS_BENCH_PROJECT to compare runs\n'
);
for (const { label, tool, args } of cases) {
  await client.callTool({ name: tool, arguments: args }); // warm-up
  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const start = performance.now();
    await client.callTool({ name: tool, arguments: args });
    samples.push(performance.now() - start);
  }
  printStats(label, stats(samples));
}

await client.close();
