import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import type { LensConfig } from './types.js';

const configSchema = z.object({
  roots: z.array(z.string().min(1)).min(1),
  exclude: z.array(z.string().min(1)).default([])
});

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2));
  return p;
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PROJECTS_MCP_CONFIG) return expandHome(env.PROJECTS_MCP_CONFIG);
  const xdg = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME) : path.join(homedir(), '.config');
  return path.join(xdg, 'projects-mcp', 'config.json');
}

export function loadConfig(file: string = configPath()): LensConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Project-Lens config not readable at ${file}: ${(e as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Project-Lens config at ${file} is not valid JSON: ${(e as Error).message}`);
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Project-Lens config at ${file} is invalid: ${z.prettifyError(result.error)}`);
  }
  const roots = result.data.roots.map(r => path.resolve(expandHome(r)));
  return { roots, exclude: result.data.exclude };
}

export function overrideRoot(config: LensConfig, root: string): LensConfig {
  const resolved = path.resolve(expandHome(root));
  let stat;
  try {
    stat = statSync(resolved);
  } catch {
    throw new Error(`PROJECT_LENS_PATH root does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`PROJECT_LENS_PATH root is not a directory: ${resolved}`);
  }
  return { ...config, roots: [resolved] };
}

export function resolveConfig(rootArg?: string, env: NodeJS.ProcessEnv = process.env): LensConfig {
  const file = configPath(env);
  const fromFile = loadConfig(file);
  const root = rootArg || env.PROJECT_LENS_PATH;
  if (root) return overrideRoot(fromFile ?? { roots: [], exclude: [] }, root);
  if (fromFile) return fromFile;
  throw new Error(
    `No workspace root: export PROJECT_LENS_PATH, pass a root as the first argument, or create a config file at ${file}`
  );
}
