import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { anyProject, callText, connect } from './client.js';
import { scenarios, type Fixtures, type Scenario } from './scenarios.js';
import { countTokens, flushCache, COUNTER, MODEL, UNIT } from './tokenizer.js';

const exec = promisify(execFile);

const SCRATCH = '.project-lens-bench-scratch';
const SCRATCH_CONTENT = 'project-lens token benchmark scratch file\n';

async function runBash(script: string): Promise<string> {
  try {
    const { stdout, stderr } = await exec('bash', ['-c', script], { maxBuffer: 64 * 1024 * 1024 });
    return stdout + stderr;
  } catch (e) {
    const { stdout = '', stderr = '' } = e as { stdout?: string; stderr?: string };
    return stdout + stderr;
  }
}

interface Row {
  id: string;
  mcp: number;
  bash: number | null;
}

const client = await connect('lens-bench-tokens');

const { tools } = await client.listTools();
const schemaTokens = await countTokens(JSON.stringify(tools));
const perTool = await Promise.all(
  tools.map(async t => [t.name, await countTokens(JSON.stringify(t))] as const)
);

const project = await anyProject(client);
const files = (JSON.parse(await callText(client, 'list_files', { project: project.name })) as {
  files: string[];
}).files;
if (files.length === 0) throw new Error(`project "${project.name}" has no listable files`);

const readme = files.find(f => /^readme/i.test(f)) ?? files[0]!;
const source =
  files.find(f => f !== readme && /\.(ts|js|md|py|java|go|rs)$/.test(f)) ??
  files.find(f => f !== readme) ??
  readme;

const roots = (JSON.parse(await callText(client, 'map_workspace', { max_depth: 1 })) as {
  roots: string[];
}).roots;

const fixtures: Fixtures = {
  root: roots[0]!,
  project,
  readme,
  source,
  scratch: SCRATCH,
  scratchContent: SCRATCH_CONTENT
};

async function measure(s: Scenario): Promise<Row> {
  const framing = JSON.stringify({ name: s.tool, arguments: s.args });
  const response = await callText(client, s.tool, s.args);
  const mcp = (await countTokens(framing)) + (await countTokens(response));
  if (s.bash === null) return { id: s.id, mcp, bash: null };
  const output = await runBash(s.bash);
  const bash = (await countTokens(s.bash)) + (await countTokens(output));
  return { id: s.id, mcp, bash };
}

const banner = {
  api: `project-lens token benchmark — ${UNIT}, model ${MODEL}`,
  messages:
    `project-lens token benchmark — ${UNIT}, model ${MODEL}\n` +
    `  Counted via /v1/messages probes, billed to your Claude plan; cached runs cost nothing.`,
  bytes:
    `project-lens token benchmark — DEGRADED: counting UTF-8 ${UNIT}, NOT tokens.\n` +
    `  Ratios are indicative only; set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN for real counts ` +
    `against ${MODEL}.`
};
console.log(banner[COUNTER]);
if (process.env.ANTHROPIC_BASE_URL) console.log(`endpoint: ${process.env.ANTHROPIC_BASE_URL}`);
console.log(`registry: ${project.name} (${project.group}) under ${fixtures.root}`);
console.log(`note: the write_file scenario creates and deletes ${SCRATCH} inside that project\n`);

const rows: Row[] = [];
try {
  for (const s of scenarios(fixtures)) rows.push(await measure(s));
} finally {
  await rm(path.join(project.absolute_path, SCRATCH), { force: true });
  flushCache();
}

const n = (v: number) => String(v).padStart(7);
console.log('tool schemas (one-time, per session)');
const bySize = [...perTool].sort((a, b) => b[1] - a[1]);
for (const [name, count] of bySize) {
  console.log(`  ${name.padEnd(26)} ${n(count)} ${UNIT}`);
}
console.log(`  ${'TOTAL'.padEnd(26)} ${n(schemaTokens)} ${UNIT}\n`);

console.log(`${'scenario'.padEnd(26)} ${'mcp'.padStart(7)} ${'bash'.padStart(7)}    ratio`);
for (const r of rows) {
  const ratio = r.bash === null || r.bash === 0 ? '     n/a' : (r.mcp / r.bash).toFixed(2).padStart(8);
  console.log(`${r.id.padEnd(26)} ${n(r.mcp)} ${r.bash === null ? '    n/a' : n(r.bash)} ${ratio}`);
}

/**
 * The spec's bulk-sweep criterion is projection vs N× `project_info` over the same registry —
 * a different comparison from the bash baselines above, and the one the recorded 6.1× came from.
 */
const registry = (JSON.parse(await callText(client, 'list_projects', {})) as {
  projects: typeof project[];
}).projects;
let nInfo = 0;
for (const p of registry) {
  const name = p.group === '(root)' ? p.name : `${p.group}/${p.name}`;
  nInfo += await countTokens(JSON.stringify({ name: 'project_info', arguments: { name } }));
  nInfo += await countTokens(await callText(client, 'project_info', { name }));
}

const sweep = rows.find(r => r.id === 'list_projects (sweep)');
if (sweep) {
  console.log(
    `\nbulk sweep over ${registry.length} projects: ` +
      `projection ${sweep.mcp} vs ${nInfo} for ${registry.length}× project_info ` +
      `— ${(nInfo / sweep.mcp).toFixed(1)}× smaller (spec target ≥10×)`
  );
}

if (sweep?.bash != null) {
  const saving = sweep.bash - sweep.mcp;
  console.log(
    `\nbreak-even: ${
      saving > 0
        ? `${Math.ceil(schemaTokens / saving)} sweep calls repay the ${schemaTokens}-${UNIT} schema cost`
        : 'never — the sweep costs more than its bash equivalent'
    }`
  );
}
console.log('scaffold_project is USER-INITIATED ONLY — schema cost counted, tool never invoked');

await client.close();
