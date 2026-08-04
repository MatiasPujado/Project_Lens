import type { BenchProject } from './client.js';

export interface Scenario {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  bash: string | null;
}

export interface Fixtures {
  root: string;
  project: BenchProject;
  readme: string;
  source: string;
  scratch: string;
  scratchContent: string;
}

const QUOTE_ESCAPE = String.raw`'\''`;

export function sq(value: string): string {
  return `'${value.replaceAll("'", QUOTE_ESCAPE)}'`;
}

const vcsDirs = (root: string): string =>
  String.raw`find ${sq(root)} -maxdepth 4 \( -name .git -o -name .svn \) -printf '%h\n'`;

export function scenarios(f: Fixtures): Scenario[] {
  const { root, project: p } = f;
  const dir = sq(p.absolute_path);
  const file = (relative: string) => sq(`${p.absolute_path}/${relative}`);

  return [
    {
      id: 'map_workspace',
      tool: 'map_workspace',
      args: { max_depth: 2 },
      bash: `${vcsDirs(root)} | sort`
    },
    {
      id: 'list_groups',
      tool: 'list_groups',
      args: {},
      bash: `${vcsDirs(root)} | sed 's|/[^/]*$||' | sort -u`
    },
    {
      id: 'list_projects',
      tool: 'list_projects',
      args: {},
      bash: `${vcsDirs(root)} | sort`
    },
    {
      id: 'list_projects (sweep)',
      tool: 'list_projects',
      args: { include: ['branch', 'is_clean'] },
      bash:
        `for d in $(${vcsDirs(root)} | sort); do ` +
        String.raw`printf '%s %s %s\n' "$(basename "$d")" ` +
        `"$(git -C "$d" branch --show-current 2>/dev/null)" ` +
        `"$(test -z "$(git -C "$d" status --porcelain 2>/dev/null)" && echo clean || echo dirty)"; ` +
        `done`
    },
    {
      id: 'find_project',
      tool: 'find_project',
      args: { query: p.name.slice(0, 4) },
      bash: `${vcsDirs(root)} | grep -i ${sq(p.name.slice(0, 4))}`
    },
    {
      id: 'project_info',
      tool: 'project_info',
      args: { name: p.name },
      bash:
        `git -C ${dir} branch --show-current; ` +
        `git -C ${dir} remote get-url origin; ` +
        `git -C ${dir} status --porcelain | head -1; ` +
        `ls ${dir} | grep -E ` +
        String.raw`'^(package\.json|tsconfig\.json|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|pom\.xml|build\.gradle|Dockerfile|docker-compose\.yml|CMakeLists\.txt)$'; ` +
        `head -10 ${file(f.readme)}`
    },
    {
      id: 'search',
      tool: 'search',
      args: { query: 'TODO', project: p.name, limit: 50 },
      bash: `rg -n --no-heading TODO ${dir} | head -50`
    },
    {
      id: 'read_file',
      tool: 'read_file',
      args: { project: p.name, relative_path: f.readme },
      bash: `cat ${file(f.readme)}`
    },
    {
      id: 'read_file (ranged)',
      tool: 'read_file',
      args: { project: p.name, relative_path: f.source, offset: 1, limit: 50 },
      bash: `sed -n '1,50p' ${file(f.source)}`
    },
    {
      id: 'list_files',
      tool: 'list_files',
      args: { project: p.name },
      bash: `rg --files ${dir}`
    },
    {
      id: 'write_file',
      tool: 'write_file',
      args: { project: p.name, relative_path: f.scratch, content: f.scratchContent },
      bash: `printf '%s' ${sq(f.scratchContent)} > ${file(f.scratch)}`
    },
    {
      id: 'refresh_registry',
      tool: 'refresh_registry',
      args: {},
      bash: null
    }
  ];
}
