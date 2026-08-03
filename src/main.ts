import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { resolveConfig } from './config.js';
import { Registry } from './registry.js';
import { buildServer } from './tools.js';

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const config = resolveConfig(argv[0], env);
  const registry = new Registry(config);
  const stats = await registry.initialize();
  console.error(
    `project-lens: ${stats.projects} projects in ${stats.groups} groups across ${stats.scanned_roots} roots (${stats.duration_ms} ms)`
  );
  serveStdio(() => buildServer(registry, config));
}
