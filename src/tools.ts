import { readdir, readFile as fsReadFile, mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { vcsInfo } from './git.js';
import { byName, projectKey, type Registry } from './registry.js';
import { scaffoldProject } from './scaffold.js';
import { listFiles, searchScope } from './search.js';
import { isSecretFile, resolveWithin } from './security.js';
import type { LensConfig, ProjectNode } from './types.js';

const MAX_READ_CHARS = 500_000;
const README_SNIPPET_LINES = 10;

const PROJECT_KEY_DESC =
  "Project name ('Homebanking') or group-qualified path ('Prisma/NEWPAY/Homebanking') when the " +
  'name is ambiguous. Matching is case-insensitive; a miss lists the closest names.';

const projectKeyArg = z.string().min(1).describe(PROJECT_KEY_DESC);

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function json(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

function guarded<A>(handler: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async args => {
    try {
      return await handler(args);
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  };
}

async function readmeSnippet(node: ProjectNode): Promise<string | null> {
  if (!node.readmePath) return null;
  try {
    const raw = await fsReadFile(node.readmePath, 'utf8');
    return raw.split('\n').slice(0, README_SNIPPET_LINES).join('\n');
  } catch {
    return null;
  }
}

function groupKey(node: ProjectNode): string {
  return node.groupPath === '' ? '(root)' : node.groupPath;
}

function inGroup(node: ProjectNode, group: string): boolean {
  return node.groupPath === group || node.groupPath.startsWith(group + '/');
}

/**
 * Directories handed to ripgrep. Searching the registered project dirs rather than the roots
 * keeps rg out of everything the registry excluded or never registered. Those hits would be
 * discarded during attribution anyway.
 */
async function scopeDirsFor(scoped: ProjectNode[], pathPrefix?: string): Promise<string[]> {
  if (pathPrefix === undefined) return scoped.map(n => n.absolutePath);
  const dirs: string[] = [];
  for (const node of scoped) {
    try {
      dirs.push(await resolveWithin(node.absolutePath, pathPrefix));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // escapes must surface
    }
  }
  return dirs;
}

export function buildServer(registry: Registry, config: LensConfig): McpServer {
  const server = new McpServer({ name: 'project-lens', version: '0.3.0' });

  server.registerTool(
    'map_workspace',
    {
      description: 'Tree overview of all groups and their projects across configured roots.',
      inputSchema: z.object({
        max_depth: z.number().int().min(1).max(3).default(2)
          .describe("1 = groups only, 2 = groups -> projects (default), 3 = adds each project's top-level folders.")
      })
    },
    guarded(async ({ max_depth }) => {
      await registry.revalidate();
      const all = registry.getAll();
      const map: Record<string, unknown> = {};
      for (const node of all) {
        const key = groupKey(node);
        if (max_depth === 1) {
          map[key] = ((map[key] as number) ?? 0) + 1;
        } else if (max_depth === 2) {
          map[key] ??= [];
          (map[key] as string[]).push(node.name);
        } else {
          const entries = await readdir(node.absolutePath, { withFileTypes: true }).catch(() => []);
          const folders = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => e.name)
            .sort(byName);
          map[key] ??= {};
          (map[key] as Record<string, string[]>)[node.name] = folders;
        }
      }
      return json({
        roots: config.roots,
        total_groups: registry.groups().length,
        total_projects: all.length,
        map
      });
    })
  );

  server.registerTool(
    'list_groups',
    { description: 'Flat list of all group paths.', inputSchema: z.object({}) },
    guarded(async () => {
      await registry.revalidate();
      return json({ groups: registry.groups() });
    })
  );

  server.registerTool(
    'list_projects',
    {
      description:
        'List projects, optionally filtered by group path. Use include for bulk metadata sweeps ' +
        '(one call instead of N project_info calls); branch/is_clean are queried live. ' +
        'Returns {fields, rows}: each row is positional against fields.',
      inputSchema: z.object({
        group: z.string().optional().describe("Group path filter, e.g. 'Prisma/NEWPAY'. Omit for all."),
        include: z.array(z.enum(['branch', 'is_clean', 'stack'])).optional()
          .describe('Extra per-project fields for metadata sweeps; branch/is_clean are live vcs queries ' +
            '(null for svn). Rows drop absolute_path in this mode — resolve paths via find_project.')
      })
    },
    guarded(async ({ group, include }) => {
      await registry.revalidate();
      let nodes = registry.getAll();
      if (group) nodes = nodes.filter(n => inGroup(n, group));
      nodes.sort((a, b) => projectKey(a).localeCompare(projectKey(b)));
      const wantsVcs = include?.some(f => f === 'branch' || f === 'is_clean') ?? false;
      const vcs = wantsVcs
        ? await Promise.all(nodes.map(n => vcsInfo(n.vcsType, n.absolutePath)))
        : [];
      const columns: Array<[string, (n: ProjectNode, i: number) => unknown]> = [
        ['name', n => n.name],
        ['group', n => groupKey(n)]
      ];
      if (include === undefined) columns.push(['absolute_path', n => n.absolutePath]);
      if (wantsVcs) columns.push(['vcs_type', n => n.vcsType]);
      if (include?.includes('branch')) columns.push(['branch', (_n, i) => vcs[i]!.branch]);
      if (include?.includes('is_clean')) columns.push(['is_clean', (_n, i) => vcs[i]!.is_clean]);
      if (include?.includes('stack')) columns.push(['stack', n => n.detectedStack]);

      return json({
        fields: columns.map(([field]) => field),
        rows: nodes.map((n, i) => columns.map(([, cell]) => cell(n, i)))
      });
    })
  );

  server.registerTool(
    'find_project',
    {
      description: 'Fuzzy match a project name; returns group path and absolute path.',
      inputSchema: z.object({ query: z.string().min(1).describe('Fuzzy match against project names.') })
    },
    guarded(async ({ query }) => {
      await registry.revalidate();
      return json({
        query,
        matches: registry.find(query).map(n => ({
          name: n.name,
          group: groupKey(n),
          absolute_path: n.absolutePath
        }))
      });
    })
  );

  server.registerTool(
    'project_info',
    {
      description:
        'Full metadata for one project: path, vcs state (queried live on every call), detected stack, ' +
        'key files, README snippet.',
      inputSchema: z.object({ name: projectKeyArg })
    },
    guarded(async ({ name }) => {
      await registry.revalidate();
      const node = registry.resolve(name);
      const [vcs, snippet] = await Promise.all([
        vcsInfo(node.vcsType, node.absolutePath),
        readmeSnippet(node)
      ]);
      return json({
        name: node.name,
        group: groupKey(node),
        absolute_path: node.absolutePath,
        vcs,
        detected_stack: node.detectedStack,
        key_files: node.keyFiles,
        readme_snippet: snippet
      });
    })
  );

  server.registerTool(
    'search',
    {
      description:
        'Content search (ripgrep) over one project, one group, or every registered project. ' +
        'Narrow before widening: project or group plus path_prefix and glob costs a fraction of ' +
        'scope:"all". Results are grouped by file.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Content search pattern (literal or regex).'),
        project: z.string().optional().describe(`Confine to one project. ${PROJECT_KEY_DESC}`),
        group: z.string().optional().describe("Confine to a group path, e.g. 'Prisma/NEWPAY'."),
        scope: z.literal('all').optional()
          .describe('Search every registered project in one call. Exactly one of project|group|scope required.'),
        path_prefix: z.string().optional()
          .describe("Subdirectory of each project to search, e.g. 'src'. Prunes the walk rather than " +
            'filtering after it; projects lacking the subdirectory are skipped.'),
        glob: z.string().optional().describe("Optional filename filter, e.g. '*.ts'."),
        exclude: z.array(z.string().min(1)).optional()
          .describe("Directory names or globs to skip, e.g. ['test', 'fixtures']. Persistent workspace " +
            'noise belongs in the exclude list of the config file instead.'),
        context_lines: z.number().int().min(0).max(3).default(0)
          .describe('Lines of surrounding context per hit. Costs tokens per hit; saves a read_file call.'),
        limit: z.number().int().min(1).max(500).default(50)
          .describe('Max hits returned across all files; truncated flag set when more exist.')
      })
    },
    guarded(async ({ query, project, group, scope, path_prefix, glob, exclude, context_lines, limit }) => {
      if ([project, group, scope].filter(Boolean).length !== 1) {
        throw new Error('Exactly one of "project", "group" or "scope" is required');
      }
      await registry.revalidate();
      let scoped: ProjectNode[];
      let scopeLabel: Record<string, string>;
      if (project) {
        scoped = [registry.resolve(project)];
        scopeLabel = { project };
      } else if (group) {
        scoped = registry.getAll().filter(n => inGroup(n, group));
        if (scoped.length === 0) throw new Error(`Unknown group: "${group}"`);
        scopeLabel = { group };
      } else {
        scoped = registry.getAll();
        scopeLabel = { scope: 'all' };
      }
      const scopeDirs = await scopeDirsFor(scoped, path_prefix);
      if (scopeDirs.length === 0 && path_prefix !== undefined) {
        throw new Error(`No project in scope contains the subdirectory "${path_prefix}"`);
      }
      const { files, hitsReturned, truncated } = await searchScope(scopeDirs, scoped, query, {
        limit,
        glob,
        exclude,
        contextLines: context_lines
      });
      return json({
        query,
        scope: scopeLabel,
        files_matched: files.length,
        hits_returned: hitsReturned,
        truncated,
        results: files
      });
    })
  );

  server.registerTool(
    'read_file',
    {
      description:
        'Read a file inside a registered project. Paths escaping the project root are rejected — ' +
        'absolute paths, ../ traversal and symlinks pointing outside all fail. ' +
        'Secret-pattern files (.env*, *.pem, id_rsa*, *credentials*) are never returned.',
      inputSchema: z.object({
        project: projectKeyArg,
        relative_path: z.string().min(1).describe('Path relative to project root. Escapes rejected.'),
        offset: z.number().int().min(1).optional().describe('1-based line to start reading from.'),
        limit: z.number().int().min(1).optional().describe('Max lines to read.')
      })
    },
    guarded(async ({ project, relative_path, offset, limit }) => {
      const node = registry.resolve(project);
      const resolved = await resolveWithin(node.absolutePath, relative_path);
      if (isSecretFile(resolved)) {
        throw new Error(`Refusing to read a secret-pattern file: ${relative_path}`);
      }
      let content = await fsReadFile(resolved, 'utf8');
      if (offset !== undefined || limit !== undefined) {
        const start = (offset ?? 1) - 1;
        const lines = content.split('\n');
        content = lines.slice(start, limit === undefined ? undefined : start + limit).join('\n');
      }
      return text(
        content.length > MAX_READ_CHARS
          ? content.slice(0, MAX_READ_CHARS) + `\n[truncated at ${MAX_READ_CHARS} chars]`
          : content
      );
    })
  );

  server.registerTool(
    'list_files',
    {
      description:
        'List file paths inside a registered project (respects .gitignore, skips hidden files). ' +
        'Paths are relative to the project root.',
      inputSchema: z.object({
        project: projectKeyArg,
        glob: z.string().optional().describe("Optional filename filter, e.g. '*.ts'.")
      })
    },
    guarded(async ({ project, glob }) => {
      const node = registry.resolve(project);
      const { files, truncated } = await listFiles(node, glob);
      return json({ project: node.name, count: files.length, truncated, files });
    })
  );

  if (config.allowWrites) registerWriteTools(server, registry, config);

  server.registerTool(
    'refresh_registry',
    {
      description: 'Force a full re-scan of all configured roots. Returns scan stats.',
      inputSchema: z.object({})
    },
    guarded(async () => json(await registry.refresh()))
  );

  return server;
}

/** Registered only when allow_writes is on: everything here mutates the workspace. */
function registerWriteTools(server: McpServer, registry: Registry, config: LensConfig): void {
  server.registerTool(
    'write_file',
    {
      description:
        'Write a file inside a registered project. Paths escaping the project root are rejected — ' +
        'absolute paths, ../ traversal and symlinks pointing outside all fail.',
      inputSchema: z.object({
        project: projectKeyArg,
        relative_path: z.string().min(1)
          .describe('Path relative to project root. Missing parent directories are created. Escapes rejected.'),
        content: z.string().describe('Full file content; an existing file is overwritten, not appended to.')
      })
    },
    guarded(async ({ project, relative_path, content }) => {
      const node = registry.resolve(project);
      const resolved = await resolveWithin(node.absolutePath, relative_path, { forWrite: true });
      await mkdir(path.dirname(resolved), { recursive: true });
      await fsWriteFile(resolved, content, 'utf8');
      return json({
        project: node.name,
        relative_path,
        bytes_written: Buffer.byteLength(content, 'utf8')
      });
    })
  );

  server.registerTool(
    'scaffold_project',
    {
      description:
        'USER-INITIATED ONLY. Create <group>/<name> under the matching root and run git init. No network.',
      inputSchema: z.object({
        group: z.string().min(1).describe('Existing group path the project goes under.'),
        name: z.string().min(1)
          .describe('New project dir name. Validated: no separators, no shell metacharacters.'),
        readme: z.boolean().default(false).describe('Seed the project with a README.md.'),
        gitignore: z.boolean().default(false).describe('Seed the project with a .gitignore.')
      })
    },
    guarded(async ({ group, name, readme, gitignore }) => {
      const node = await scaffoldProject(registry, config.roots, group, name, { readme, gitignore });
      return json({ created: node.absolutePath, group: node.groupPath, name: node.name });
    })
  );
}
