import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { anyProject, callText, column, connect, type ProjectTable } from './client.js';
import { scenarios, type Fixtures, type Scenario } from './scenarios.js';
import { countTokens, flushCache, framingTokens, COUNTER, MODEL, UNIT } from './tokenizer.js';

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
  /**
   * False when the row does not reproduce run to run. Both sides of a search stop at 50 hits and
   * ripgrep's traversal order decides which 50, so those rows are a range, not a number. They are
   * reported, but nothing is derived from them.
   */
  stable: boolean;
  /** What the two sides actually returned, so a row measuring nothing cannot pass for a result. */
  yield?: string;
}

const client = await connect('lens-bench-tokens');

/**
 * The benchmark client forces writes on so the write_file scenario has a tool to call, but a
 * default session never registers these. Their schemas are counted and reported separately rather
 * than folded into a session cost nobody actually pays.
 */
const WRITE_TOOLS = new Set(['write_file', 'scaffold_project']);

const { tools } = await client.listTools();
const perTool = await Promise.all(
  tools.map(async t => [t.name, await countTokens(JSON.stringify(t))] as const)
);
const sum = (entries: ReadonlyArray<readonly [string, number]>): number =>
  entries.reduce((total, [, count]) => total + count, 0);
const schemaTokens = sum(perTool);
const defaultSchemaTokens = sum(perTool.filter(([name]) => !WRITE_TOOLS.has(name)));

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

/**
 * A search that finds nothing still costs its response envelope, and against a bash command that
 * printed nothing the ratio looks like a regression. Report both sides' yield so that row is
 * readable as what it is.
 */
function searchYield(response: string, output: string): string {
  const { hits_returned, files_matched } = JSON.parse(response) as {
    hits_returned: number;
    files_matched: number;
  };
  const lines = output.split('\n').filter(Boolean).length;
  return `${hits_returned} hits / ${files_matched} files vs ${lines} bash lines`;
}

async function measure(s: Scenario): Promise<Row> {
  const stable = s.tool !== 'search';
  const framing = JSON.stringify({ name: s.tool, arguments: s.args });
  const response = await callText(client, s.tool, s.args);
  const mcp = (await countTokens(framing)) + (await countTokens(response));
  if (s.bash === null) return { id: s.id, mcp, bash: null, stable };
  const output = await runBash(s.bash);
  const bash = (await countTokens(s.bash)) + (await countTokens(output));
  const row: Row = { id: s.id, mcp, bash, stable };
  if (!stable) row.yield = searchYield(response, output);
  return row;
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
const framing = await framingTokens();
if (framing !== null) {
  console.log(
    `  framing overhead subtracted from every count: ${framing} tokens ` +
      `(two per side per row — rows under ~200 tokens carry the most of it)`
  );
}
if (process.env.ANTHROPIC_BASE_URL) console.log(`endpoint: ${process.env.ANTHROPIC_BASE_URL}`);
console.log(`sample project: ${project.name} (${project.group}) under ${fixtures.root}`);
console.log(`read_file scenarios use ${readme}; both sides scale with it — pin LENS_BENCH_PROJECT to compare runs`);
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
  const off = WRITE_TOOLS.has(name) ? '  (off by default)' : '';
  console.log(`  ${name.padEnd(26)} ${n(count)} ${UNIT}${off}`);
}
console.log(`  ${'TOTAL (all tools)'.padEnd(26)} ${n(schemaTokens)} ${UNIT}`);
console.log(
  `  ${'TOTAL (default session)'.padEnd(26)} ${n(defaultSchemaTokens)} ${UNIT}` +
    `  — what a client without writes enabled actually loads\n`
);

console.log(`${'scenario'.padEnd(26)} ${'mcp'.padStart(7)} ${'bash'.padStart(7)}    ratio`);
for (const r of rows) {
  const ratio = r.bash === null || r.bash === 0 ? '     n/a' : (r.mcp / r.bash).toFixed(2).padStart(8);
  const note = r.yield === undefined ? '' : `   ${r.yield}`;
  console.log(`${r.id.padEnd(26)} ${n(r.mcp)} ${r.bash === null ? '    n/a' : n(r.bash)} ${ratio}${note}`);
}

const registry = JSON.parse(await callText(client, 'list_projects', {})) as ProjectTable;
const nameOf = column(registry, 'name');
const groupOf = column(registry, 'group');
let nInfo = 0;
for (const row of registry.rows) {
  const group = groupOf(row);
  const name = group === '(root)' ? nameOf(row) : `${group}/${nameOf(row)}`;
  nInfo += await countTokens(JSON.stringify({ name: 'project_info', arguments: { name } }));
  nInfo += await countTokens(await callText(client, 'project_info', { name }));
}

const sweep = rows.find(r => r.id === 'list_projects (sweep)');
if (sweep) {
  console.log(
    `\nbulk sweep over ${registry.rows.length} projects: ` +
      `projection ${sweep.mcp} vs ${nInfo} for ${registry.rows.length}× project_info ` +
      `— ${(nInfo / sweep.mcp).toFixed(1)}× smaller (spec target ≥10×)`
  );
}

/**
 * Repaid against the default-session schema cost, since the write tools whose schemas the other
 * total includes are not registered in the session doing the repaying.
 *
 * Only stable rows are eligible. A search saves more tokens than anything else here, but its saving
 * moves between runs and the call it would be advertising is the unnarrowed one the tool's own
 * description tells the model to avoid, a headline that is neither reproducible nor good advice.
 */
const savings = rows
  .filter((r): r is Row & { bash: number } => r.stable && r.bash !== null && r.bash > r.mcp)
  .map(r => ({ id: r.id, saving: r.bash - r.mcp }))
  .sort((a, b) => b.saving - a.saving);

if (savings.length === 0) {
  console.log(`\nbreak-even: never — no stable scenario costs less than its bash equivalent`);
} else {
  const best = savings[0]!;
  console.log(
    `\nbreak-even: ${Math.ceil(defaultSchemaTokens / best.saving)}× ${best.id} repays the ` +
      `${defaultSchemaTokens}-${UNIT} default-session schema cost ` +
      `(saves ${best.saving} ${UNIT}/call; next: ${savings
        .slice(1, 4)
        .map(s => `${s.id} ${s.saving}`)
        .join(', ')})`
  );
  console.log('  stable rows only — the search rows save more, but not the same amount twice');
}
console.log('scaffold_project is USER-INITIATED ONLY — schema cost counted, tool never invoked');

await client.close();
