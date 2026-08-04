# Project-Lens

MCP server that gives Claude a map of your local project setup: a registry of group folders and VCS projects discovered under configured roots, with scoped read/search/write operations that can never escape a project root.

- **Discovery**: a directory containing `.git` or `.svn` is a project (`vcs_type: git | svn`); the folders between a root and the project form its group path (arbitrary depth, e.g. `Prisma/NEWPAY/Homebanking`). SVN working copies are indexed and visible, but the `svn` binary is never invoked — their remote/branch/clean state stays `null`.
- **Token economy**: all structured responses are compact JSON; capped lists carry an explicit `truncated` flag; `list_projects` takes an `include` projection so a whole-group metadata sweep is one call instead of N `project_info` calls.
- **Freshness**: full scan at startup, explicit `refresh_registry` tool, plus mtime revalidation of root/group dirs piggybacked on registry calls. No filesystem watcher, no disk cache.
- **Protocol**: MCP revision 2026-07-28 (stateless core) via the official `@modelcontextprotocol/server` v2 SDK, stdio transport. Legacy 2025-era clients are also served by SDK version negotiation.

## Install

Published as `@mpujado/project-lens` on the home Gitea npm registry (source: `https://gitea.home/AI/Project_Lens`). Point the scope at the registry and authenticate once per machine, then `npx` resolves it:

```bash
npm config set @mpujado:registry https://gitea.home/api/packages/mpujado/npm/
npm config set -- '//gitea.home/api/packages/mpujado/npm/:_authToken' "<PAT with package permission>"
```

The registry path segment is the **package owner** (`mpujado`), independent of the repo's `AI` org. The token is a Gitea personal access token with `package` permission — it lives in `~/.npmrc` (mode `600`), never in this repo. Enter it interactively (`read -rs`) so it never lands in shell history.

`gitea.home` is served by the Homelab internal CA. Node ships its own CA bundle and ignores the OS trust store, so every npm command touching the registry needs:

```bash
export NODE_OPTIONS=--use-system-ca
```

Without it npm fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` even though the root CA is installed system-wide. Use `--use-system-ca` (Node ≥ 22.15), which *augments* Node's bundle — not `cafile`, which *replaces* it and breaks resolution against `registry.npmjs.org`, and never `strict-ssl=false`.

For development, clone + build instead:

```bash
git clone https://gitea.home/AI/Project_Lens.git && cd Project_Lens
npm install
npm run build
```

Requirements: Node.js ≥ 22, `git` on PATH, [`ripgrep`](https://github.com/BurntSushi/ripgrep) (`rg`) on PATH for the `search` tool.

## Configuration

Point the server at your workspace root with `PROJECT_LENS_PATH` — every group and project underneath it gets mapped. That is the whole setup; no config file needed:

```bash
export PROJECT_LENS_PATH="~/Projects/Work"
```

The root must exist and be a directory (`~` is expanded by the server) — startup fails loudly otherwise.

**Root precedence:** positional CLI argument (what `${PROJECT_LENS_PATH}` expands to in the MCP registration) → `PROJECT_LENS_PATH` → `roots` from the config file. With none of them set the server exits with an error.

### Optional config file

Only needed for `exclude` globs or multiple roots. Location: `$PROJECTS_MCP_CONFIG` if set, else `$XDG_CONFIG_HOME/projects-mcp/config.json`, else `~/.config/projects-mcp/config.json`.

```json
{
  "roots": ["/media/Dev/Personal"],
  "exclude": ["**/Utilities/**", "**/Archived*/**"]
}
```

| Field | Type | Meaning |
|---|---|---|
| `roots` | `string[]` (required, non-empty) | Absolute paths (or `~/…`) to walk for projects; overridden by a CLI/env root |
| `exclude` | `string[]` (optional) | Globs matched against root-relative paths; pruned before descent |

A missing file is fine; a malformed one fails startup loudly — the server never runs with a silently widened scope.

## MCP client registration

Registered from the Claude_Toolbox plugin (`toolbox-servers/.mcp.json`), same pattern as the Obsidian servers — `PROJECT_LENS_PATH` must hold the workspace root to scan:

```json
{
  "mcpServers": {
    "project-lens": {
      "type": "stdio",
      "command": "npx",
      "args": [
        "@mpujado/project-lens",
        "${PROJECT_LENS_PATH}"
      ],
      "env": {}
    }
  }
}
```

## Tools

| Tool | Purpose |
|---|---|
| `map_workspace(max_depth?)` | Tree overview: 1 = groups, 2 = groups → projects (default), 3 = + each project's top-level folders |
| `list_groups` | Flat list of group paths |
| `list_projects(group?, include?)` | Projects, optionally filtered by group; `include: ["branch", "is_clean", "stack"]` adds live per-project metadata for bulk sweeps |
| `find_project(query)` | Fuzzy name match → group + absolute path |
| `project_info(name)` | Path, vcs remote/branch/clean state (queried live on every call), detected stack, key manifests, README snippet |
| `search(query, project\|group, glob?, limit?)` | ripgrep content search confined to one project or group; `limit` default 50, max 500, `truncated` flag on cut |
| `list_files(project, glob?)` | File paths relative to the project root (respects `.gitignore`, skips hidden files); capped at 500 + `truncated` flag |
| `read_file(project, relative_path, offset?, limit?)` | Scoped read with optional line paging; `../`, absolute-path and symlink escapes rejected |
| `write_file(project, relative_path, content)` | Scoped write, same traversal guard; creates parent dirs inside the root |
| `scaffold_project(group, name, {readme?, gitignore?})` | **User-initiated only.** Create `<group>/<name>` + `git init`. No network |
| `refresh_registry` | Force full re-scan, returns scan stats |

Secret-pattern files (`.env*`, `*.pem`, `id_rsa*`, `*credentials*`) never appear in `key_files`, listings, or search results. `project_info` strips userinfo (`user:token@`) from git remote URLs before returning them.

## Development

```bash
npm test          # vitest: unit + integration (in-memory MCP client/server)
npm run bench     # e2e latency per tool over stdio (root from argv, PROJECT_LENS_PATH or config)
npm run bench:store  # registry micro-benchmark: cold scan, lookups, memory
npm run inspector # manual acceptance via MCP Inspector
```

### Publishing

`npm publish` from the repo root, with `NODE_OPTIONS=--use-system-ca` set. `prepublishOnly` runs `build` + `test`, so a failing suite aborts the release. Bump `version` for every release — Gitea rejects re-uploading an existing name+version, the old one has to be deleted first (`npm unpublish @mpujado/project-lens@<version>`).

The JetBrains run configurations in `.idea/runConfigurations/` wrap this:

| Runner | Does |
|---|---|
| `Registry Setup (Gitea)` | Writes the scope mapping + auth token to `~/.npmrc` (mode `600`); prompts for the PAT if `GITEA_NPM_TOKEN` is unset |
| `Publish (Gitea)` | Preflight — verifies the `@mpujado` scope mapping and that an auth token for `gitea.home` exists, then confirms before `npm publish` |
| `Published Versions` | Local version vs. what the registry has |
| `Unpublish Current Version` | Deletes the current version from the registry (type-the-version confirmation) |

All four export `NODE_OPTIONS=--use-system-ca`. The PAT is never stored in these XML files — they are git-tracked.

Benchmark SLA (personal PC, 42 projects / 16 groups under `/media/Dev/Personal`): cold scan < 500 ms (measured ~90 ms), registry tools < 15–20 ms (measured < 1 ms), `project_info` < 100 ms (measured ~5 ms), `search` < 80 ms (measured ~7 ms).
