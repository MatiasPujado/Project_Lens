import { createReadStream } from 'node:fs';
import { readdir, readFile as fsReadFile, mkdir, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { projectFiles, type ProjectFiles } from './discovery.js';
import { vcsInfo } from './git.js';
import { byName, projectKey, type Registry } from './registry.js';
import { scaffoldProject } from './scaffold.js';
import { listFiles, MAX_FILES, searchScope } from './search.js';
import { noFollowWriteFlags, resolveWithin } from './security.js';
import type { LensConfig, ProjectNode } from './types.js';

const MAX_READ_CHARS = 500_000;
const README_SNIPPET_LINES = 10;
const MAX_FIND_MATCHES = 10;

const PROJECT_KEY_DESC =
  "Project name ('Homebanking') or group-qualified path ('Prisma/NEWPAY/Homebanking') when the " +
  'name is ambiguous, or the absolute path when two roots hold the same group-qualified path. ' +
  'Matching is case-insensitive; a miss lists the closest names.';

const projectKeyArg = z.string().min(1).describe(PROJECT_KEY_DESC);

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

function json(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function text(value: string): ToolResult {
  return { content: [{ type: 'text', text: value }] };
}

/** The part of the SDK's request context the tools use: the signal the client's cancellation aborts. */
interface CallContext {
  mcpReq: { signal: AbortSignal };
}

function guarded<A>(
  handler: (args: A, ctx: CallContext) => Promise<ToolResult>
): (args: A, ctx: CallContext) => Promise<ToolResult> {
  return async (args, ctx) => {
    try {
      return await handler(args, ctx);
    } catch (e) {
      return { content: [{ type: 'text', text: (e as Error).message }], isError: true };
    }
  };
}

async function readmeSnippet(readmePath: string | undefined): Promise<string | null> {
  if (!readmePath) return null;
  try {
    const raw = await fsReadFile(readmePath, 'utf8');
    return raw.split('\n').slice(0, README_SNIPPET_LINES).join('\n');
  } catch {
    return null;
  }
}

/**
 * Read now, not from the scan: files change inside a project without touching any directory mtime we watch.
 * An unreadable directory reports no files, as map_workspace does, so one project cannot fail a whole sweep.
 */
async function filesOf(node: ProjectNode): Promise<ProjectFiles> {
  const entries = await readdir(node.absolutePath, { withFileTypes: true }).catch(() => []);
  return projectFiles(node.absolutePath, entries);
}

export interface LineSlice {
  lines: string[];
  total: number;
  endsWithNewline: boolean;
  /** The line the read cap stopped in, when it did. */
  cutAt?: number;
}

/**
 * Keeps lines first..first+count-1 (1-based) of `source` within MAX_READ_CHARS and counts every line. Only the
 * kept text is held: a line outside the slice, or past the cap, is scanned for its newline and dropped, so even a
 * file that is one huge line costs constant memory and linear time.
 */
export async function readLines(
  source: AsyncIterable<string | Buffer> | Iterable<string>,
  first: number,
  count: number
): Promise<LineSlice> {
  const slice: LineSlice = { lines: [], total: 0, endsWithNewline: false };
  let line = 1;
  let kept = '';
  let chars = 0;
  let open = false; // text seen since the last newline
  const wanted = () => line >= first && line < first + count && slice.cutAt === undefined;
  const keep = (text: string) => {
    if (!wanted()) return;
    const room = Math.max(0, MAX_READ_CHARS - chars - kept.length); // a line that filled the cap leaves none
    if (text.length > room) {
      kept += text.slice(0, room);
      slice.cutAt = line;
    } else {
      kept += text;
    }
  };
  const endLine = () => {
    if (wanted() || slice.cutAt === line) {
      slice.lines.push(kept);
      chars += kept.length + 1;
    }
    kept = '';
    line++;
  };
  for await (const chunk of source) {
    const text = String(chunk);
    let start = 0;
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
      keep(text.slice(start, nl));
      endLine();
      start = nl + 1;
    }
    if (start < text.length) {
      keep(text.slice(start));
      open = true;
    } else {
      open = false;
    }
  }
  slice.endsWithNewline = !open && line > 1;
  if (open) endLine();
  slice.total = line - 1;
  return slice;
}

function groupKey(node: ProjectNode): string {
  return node.groupPath === '' ? '(root)' : node.groupPath;
}

function inGroup(groupPath: string, group: string): boolean {
  return groupPath === group || groupPath.startsWith(group + '/');
}

/**
 * Projects under `group`, for list_projects and search alike. Case is ignored, but when some group matches as
 * written only that one counts, so `AI` and `ai` on a case-sensitive disk stay apart. An unknown group is an error.
 */
function projectsInGroup(registry: Registry, group: string): ProjectNode[] {
  const all = registry.getAll();
  const exact = all.filter(n => inGroup(n.groupPath, group));
  if (exact.length > 0) return exact;
  const folded = all.filter(n => inGroup(n.groupPath.toLowerCase(), group.toLowerCase()));
  if (folded.length === 0) throw new Error(`Unknown group: "${group}"`);
  return folded;
}

/**
 * `pathPrefix` checked by resolveWithin, which answers with a real path. ripgrep output is attributed against the
 * project's configured path, so the answer is rebased onto it: under a root reached through a symbolic link the two
 * differ.
 */
async function prefixDir(node: ProjectNode, pathPrefix: string): Promise<string> {
  const real = await resolveWithin(node.absolutePath, pathPrefix);
  return path.join(node.absolutePath, path.relative(await realpath(node.absolutePath), real));
}

/** A project's subdirectory for list_files; a missing one is an error naming it. */
async function subdirectory(node: ProjectNode, pathPrefix: string): Promise<string> {
  try {
    return await prefixDir(node, pathPrefix);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // escapes and .git must surface as they are
    throw new Error(`No subdirectory "${pathPrefix}" in project ${node.name}`, { cause: e });
  }
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
      dirs.push(await prefixDir(node, pathPrefix));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // escapes must surface
    }
  }
  return dirs;
}

export function buildServer(registry: Registry, config: LensConfig): McpServer {
  const server = new McpServer({ name: 'project-lens', version: '0.4.0' });

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
      const nodes = group ? projectsInGroup(registry, group) : registry.getAll();
      nodes.sort((a, b) => byName(projectKey(a), projectKey(b)));
      const wantsVcs = include?.some(f => f === 'branch' || f === 'is_clean') ?? false;
      const vcs = wantsVcs
        ? await Promise.all(nodes.map(n => vcsInfo(n.vcsType, n.absolutePath)))
        : [];
      const stacks = include?.includes('stack')
        ? await Promise.all(nodes.map(async n => (await filesOf(n)).detectedStack))
        : [];
      const columns: Array<[string, (n: ProjectNode, i: number) => unknown]> = [
        ['name', n => n.name],
        ['group', n => groupKey(n)]
      ];
      if (include === undefined) columns.push(['absolute_path', n => n.absolutePath]);
      if (wantsVcs) columns.push(['vcs_type', n => n.vcsType]);
      if (include?.includes('branch')) columns.push(['branch', (_n, i) => vcs[i]!.branch]);
      if (include?.includes('is_clean')) columns.push(['is_clean', (_n, i) => vcs[i]!.is_clean]);
      if (include?.includes('stack')) columns.push(['stack', (_n, i) => stacks[i]]);

      return json({
        fields: columns.map(([field]) => field),
        rows: nodes.map((n, i) => columns.map(([, cell]) => cell(n, i)))
      });
    })
  );

  server.registerTool(
    'find_project',
    {
      description:
        'Find projects by name, case-insensitive: exact, prefix or substring, also with spaces, _, - and . ' +
        'ignored. Names as written rank first. Returns group path and absolute path; truncated when capped.',
      inputSchema: z.object({ query: z.string().min(1).describe("Project name or part of it, e.g. 'project lens'.") })
    },
    guarded(async ({ query }) => {
      await registry.revalidate();
      const found = registry.find(query);
      return json({
        query,
        matches: found.slice(0, MAX_FIND_MATCHES).map(n => ({
          name: n.name,
          group: groupKey(n),
          absolute_path: n.absolutePath
        })),
        truncated: found.length > MAX_FIND_MATCHES
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
      const files = await filesOf(node);
      const [vcs, snippet] = await Promise.all([
        vcsInfo(node.vcsType, node.absolutePath),
        readmeSnippet(files.readmePath)
      ]);
      return json({
        name: node.name,
        group: groupKey(node),
        absolute_path: node.absolutePath,
        vcs,
        detected_stack: files.detectedStack,
        key_files: files.keyFiles,
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
        query: z.string().min(1).describe('Content search pattern, a regex unless fixed_strings is set.'),
        fixed_strings: z.boolean().default(false).describe('Match query literally: ( [ { . * are plain text.'),
        ignore_case: z.boolean().default(false).describe('Match regardless of letter case.'),
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
    guarded(async (args, ctx) => {
      const { query, project, group, scope, path_prefix, glob, exclude, context_lines, limit } = args;
      const { fixed_strings, ignore_case } = args;
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
        scoped = projectsInGroup(registry, group);
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
        contextLines: context_lines,
        fixedStrings: fixed_strings,
        ignoreCase: ignore_case,
        signal: ctx.mcpReq.signal
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
        'Paths inside .git and secret-pattern files (.env*, keys, certificates, credential stores) are never ' +
        'returned. A line slice ends with [lines a-b of N].',
      inputSchema: z.object({
        project: projectKeyArg,
        relative_path: z.string().min(1).describe('Path relative to project root. Escapes rejected.'),
        offset: z.number().int().min(1).optional().describe('1-based line to start reading from.'),
        limit: z.number().int().min(1).optional().describe('Max lines to read.')
      })
    },
    guarded(async ({ project, relative_path, offset, limit }) => {
      await registry.revalidate();
      const node = registry.resolve(project);
      const resolved = await resolveWithin(node.absolutePath, relative_path);
      const first = offset ?? 1;
      const slice = await readLines(createReadStream(resolved, { encoding: 'utf8' }), first, limit ?? Infinity);
      const body = slice.lines.join('\n');
      if (slice.cutAt !== undefined) {
        return text(`${body}\n[truncated at ${MAX_READ_CHARS} chars in line ${slice.cutAt} of ${slice.total}]`);
      }
      if (offset === undefined && limit === undefined) return text(slice.endsWithNewline ? `${body}\n` : body);
      if (slice.lines.length === 0) return text(`[offset ${first} is past the last line, ${slice.total}]`);
      return text(`${body}\n[lines ${first}-${first + slice.lines.length - 1} of ${slice.total}]`);
    })
  );

  server.registerTool(
    'list_files',
    {
      description:
        'List file paths inside a registered project (respects .gitignore, skips hidden files). ' +
        `Paths are relative to the project root, sorted, at most ${MAX_FILES} per call; ` +
        'when truncated, pass next_offset as offset for the next page.',
      inputSchema: z.object({
        project: projectKeyArg,
        glob: z.string().optional().describe("Optional filename filter, e.g. '*.ts'."),
        path_prefix: z.string().optional().describe("Subdirectory to list, e.g. 'src'."),
        offset: z.number().int().min(0).default(0).describe('Paths to skip; the previous call\'s next_offset.')
      })
    },
    guarded(async ({ project, glob, path_prefix, offset }, ctx) => {
      await registry.revalidate();
      const node = registry.resolve(project);
      const dir = path_prefix === undefined ? undefined : await subdirectory(node, path_prefix);
      const { files, total, truncated } = await listFiles(node, { glob, dir, offset, signal: ctx.mcpReq.signal });
      return json({
        project: node.name,
        count: files.length,
        total,
        truncated,
        ...(truncated ? { next_offset: offset + files.length } : {}),
        files
      });
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

/**
 * resolveWithin already refused a link in the last component; O_NOFOLLOW makes the kernel refuse one at open
 * time too, so nothing can swap a link in between that check and the write.
 */
async function writeNoFollow(file: string, content: string, flags: number): Promise<void> {
  const handle = await open(file, flags, 0o666);
  try {
    await handle.writeFile(content, 'utf8');
  } finally {
    await handle.close();
  }
}

/** Registered only when allow_writes is on: everything here mutates the workspace. */
function registerWriteTools(server: McpServer, registry: Registry, config: LensConfig): void {
  server.registerTool(
    'write_file',
    {
      description:
        'Write a file inside a registered project. Paths escaping the project root are rejected — ' +
        'absolute paths, ../ traversal and symlinks pointing outside all fail. Also refused: any path inside .git, ' +
        'secret-pattern names (.env*, keys, certificates, credential stores), a symbolic link as the last path ' +
        'component, and every write on a platform without O_NOFOLLOW (Windows).',
      inputSchema: z.object({
        project: projectKeyArg,
        relative_path: z.string().min(1)
          .describe('Path relative to project root. Missing parent directories are created. Escapes rejected.'),
        content: z.string().describe('Full file content; an existing file is overwritten, not appended to.')
      })
    },
    guarded(async ({ project, relative_path, content }) => {
      await registry.revalidate();
      const node = registry.resolve(project);
      const resolved = await resolveWithin(node.absolutePath, relative_path, { forWrite: true });
      const flags = noFollowWriteFlags(); // before mkdir, so a refused platform creates nothing
      await mkdir(path.dirname(resolved), { recursive: true });
      await writeNoFollow(resolved, content, flags);
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
