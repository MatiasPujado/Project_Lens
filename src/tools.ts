import { readdir, readFile as fsReadFile, mkdir, writeFile as fsWriteFile } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { gitInfo } from './git.js';
import { projectKey, type Registry } from './registry.js';
import { scaffoldProject } from './scaffold.js';
import { searchScope } from './search.js';
import { isSecretFile, resolveWithin } from './security.js';
import type { LensConfig, ProjectNode } from './types.js';

const MAX_READ_CHARS = 500_000;
const README_SNIPPET_LINES = 10;

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function json(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
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

export function buildServer(registry: Registry, config: LensConfig): McpServer {
  const server = new McpServer({ name: 'project-lens', version: '0.1.0' });

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
          ((map[key] ??= []) as string[]).push(node.name);
        } else {
          const entries = await readdir(node.absolutePath, { withFileTypes: true }).catch(() => []);
          const folders = entries
            .filter(e => e.isDirectory() && !e.name.startsWith('.'))
            .map(e => e.name)
            .sort();
          ((map[key] ??= {}) as Record<string, string[]>)[node.name] = folders;
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
      description: 'List projects, optionally filtered by group path.',
      inputSchema: z.object({
        group: z.string().optional().describe("Group path filter, e.g. 'Prisma/NEWPAY'. Omit for all.")
      })
    },
    guarded(async ({ group }) => {
      await registry.revalidate();
      let nodes = registry.getAll();
      if (group) nodes = nodes.filter(n => inGroup(n, group));
      return json({
        projects: nodes
          .sort((a, b) => projectKey(a).localeCompare(projectKey(b)))
          .map(n => ({ name: n.name, group: groupKey(n), absolute_path: n.absolutePath }))
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
      description: 'Full metadata for one project: path, git state, detected stack, key files, README snippet.',
      inputSchema: z.object({
        name: z.string().min(1)
          .describe("Project name or group-qualified path ('Prisma/NEWPAY/Homebanking') when ambiguous.")
      })
    },
    guarded(async ({ name }) => {
      await registry.revalidate();
      const node = registry.resolve(name);
      const [vcs, snippet] = await Promise.all([gitInfo(node.absolutePath), readmeSnippet(node)]);
      return json({
        name: node.name,
        group: groupKey(node),
        absolute_path: node.absolutePath,
        vcs,
        detected_stack: node.detectedStack,
        key_files: node.keyFiles,
        readme_snippet: snippet,
        scanned_at: new Date(node.scannedAt).toISOString()
      });
    })
  );

  server.registerTool(
    'search',
    {
      description: 'Content search (ripgrep) confined to one project or one group.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Content search pattern (literal or regex).'),
        project: z.string().optional().describe('Confine to one project.'),
        group: z.string().optional().describe('Confine to a group path. Exactly one of project|group required.'),
        glob: z.string().optional().describe("Optional filename filter, e.g. '*.ts'.")
      })
    },
    guarded(async ({ query, project, group, glob }) => {
      if (!!project === !!group) {
        throw new Error('Exactly one of "project" or "group" is required');
      }
      await registry.revalidate();
      let scopeDir: string;
      let scoped: ProjectNode[];
      if (project) {
        const node = registry.resolve(project);
        scopeDir = node.absolutePath;
        scoped = [node];
      } else {
        scoped = registry.getAll().filter(n => inGroup(n, group!));
        if (scoped.length === 0) throw new Error(`Unknown group: "${group}"`);
        scopeDir = path.join(scoped[0]!.root, ...group!.split('/'));
      }
      const results = await searchScope(scopeDir, scoped, query, glob);
      return json({
        query,
        scope: project ? { project } : { group },
        matches_found: results.length,
        results
      });
    })
  );

  server.registerTool(
    'read_file',
    {
      description: 'Read a file inside a registered project. Paths escaping the project root are rejected.',
      inputSchema: z.object({
        project: z.string().min(1),
        relative_path: z.string().min(1).describe('Path relative to project root. Escapes rejected.')
      })
    },
    guarded(async ({ project, relative_path }) => {
      const node = registry.resolve(project);
      const resolved = await resolveWithin(node.absolutePath, relative_path);
      const content = await fsReadFile(resolved, 'utf8');
      return text(
        content.length > MAX_READ_CHARS
          ? content.slice(0, MAX_READ_CHARS) + `\n[truncated at ${MAX_READ_CHARS} chars]`
          : content
      );
    })
  );

  server.registerTool(
    'write_file',
    {
      description: 'Write a file inside a registered project. Paths escaping the project root are rejected.',
      inputSchema: z.object({
        project: z.string().min(1),
        relative_path: z.string().min(1),
        content: z.string()
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
        readme: z.boolean().default(false),
        gitignore: z.boolean().default(false)
      })
    },
    guarded(async ({ group, name, readme, gitignore }) => {
      const node = await scaffoldProject(registry, config.roots, group, name, { readme, gitignore });
      return json({ created: node.absolutePath, group: node.groupPath, name: node.name });
    })
  );

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
