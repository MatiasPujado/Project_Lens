import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import * as z from 'zod/v4';
import type { LensConfig } from './types.js';

const configSchema = z.object({
  roots: z.array(z.string().min(1)).default([]),
  exclude: z.array(z.string().min(1)).default([]),
  allow_writes: z.boolean().default(false)
});

/**
 * A root's own config file lives inside the workspace, so a cloned repository can author it.
 * It may only prune what gets scanned, allow_writes and roots are deliberately not readable here.
 */
const rootConfigSchema = z.object({
  exclude: z.array(z.string().min(1)).default([])
});

export const ROOT_CONFIG_FILE = '.project-lens.json';

const TRUTHY = /^(1|true|yes|on)$/i;

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
  return { roots, exclude: result.data.exclude, allowWrites: result.data.allow_writes };
}

/** Exclude patterns a root declares for itself; missing or unreadable file means none. */
export function loadRootExclude(root: string): string[] {
  const file = path.join(root, ROOT_CONFIG_FILE);
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Root config at ${file} is not valid JSON: ${(e as Error).message}`);
  }
  const result = rootConfigSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Root config at ${file} is invalid: ${z.prettifyError(result.error)}`);
  }
  return result.data.exclude;
}

/** Every exclude pattern that applies to one root: the global list plus the root's own. */
export function excludeFor(config: LensConfig, root: string): string[] {
  return [...config.exclude, ...(config.rootExclude?.[root] ?? [])];
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
  const empty: LensConfig = { roots: [], exclude: [], allowWrites: false };
  let config: LensConfig;
  if (root) config = overrideRoot(fromFile ?? empty, root);
  else if (fromFile && fromFile.roots.length > 0) config = fromFile;
  else
    throw new Error(
      `No workspace root: export PROJECT_LENS_PATH, pass a root as the first argument, or create a config file at ${file}`
    );
  const rootExclude: Record<string, string[]> = {};
  for (const r of config.roots) {
    const patterns = loadRootExclude(r);
    if (patterns.length > 0) rootExclude[r] = patterns;
  }
  if (Object.keys(rootExclude).length > 0) config = { ...config, rootExclude };
  const envWrites = env.PROJECT_LENS_ALLOW_WRITES;
  return envWrites === undefined ? config : { ...config, allowWrites: TRUTHY.test(envWrites) };
}
