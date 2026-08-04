# Project-Lens

MCP server that gives Claude a map of your local project setup: a registry of group folders and VCS projects discovered under configured roots, with scoped read/search/write operations that can never escape a project root.

- **Discovery**: a directory containing `.git` or `.svn` is a project (`vcs_type: git | svn`); the folders between a root and the project form its group path (arbitrary depth, e.g. `Prisma/NEWPAY/Homebanking`). SVN working copies are indexed and visible, but the `svn` binary is never invoked — their remote/branch/clean state stays `null`.
- **Token economy**: all structured responses are compact JSON; capped lists carry an explicit `truncated` flag; `list_projects` returns a `{fields, rows}` matrix (positional rows, keys paid once instead of per project) and takes an `include` projection so a whole-group metadata sweep is one call instead of N `project_info` calls.
- **Freshness**: full scan at startup, explicit `refresh_registry` tool, plus mtime revalidation of root/group dirs piggybacked on registry calls. No filesystem watcher, no disk cache.
- **Protocol**: MCP revision 2026-07-28 (stateless core) via the official `@modelcontextprotocol/server` v2 SDK, stdio transport. Legacy 2025-era clients are also served by SDK version negotiation.

## Install

Requirements on the machine that will run the server: **Node.js ≥ 22**, `git` on PATH, and [`ripgrep`](https://github.com/BurntSushi/ripgrep) (`rg`) on PATH for the `search` and `list_files` tools.

Fastest path if someone handed you a tarball:

```bash
npm install -g ./mpujado-project-lens-0.2.0.tgz
export PROJECT_LENS_PATH="$HOME/Projects"      # workspace root to scan
claude mcp add project-lens -- project-lens "$PROJECT_LENS_PATH"
```

That is the whole install — the package has three runtime dependencies and needs no registry access, no credentials and no CA configuration. See [Distribution](#distribution) for how to produce that tarball, for cloning and building instead, and for installing from a private registry.

<details>
<summary>Installing from the Homelab Gitea registry (internal network only)</summary>

The package is published as `@mpujado/project-lens` to a private Gitea registry that is only reachable inside the Homelab network. If you are on it, point the scope at the registry and authenticate once per machine, then `npx` resolves it:

```bash
npm config set @mpujado:registry https://gitea.home/api/packages/mpujado/npm/
npm config set -- '//gitea.home/api/packages/mpujado/npm/:_authToken' "<PAT with package permission>"
```

The registry path segment is the **package owner** (`mpujado`), independent of the repo's `AI` org. The token is a Gitea personal access token with `package` permission — it lives in `~/.npmrc` (mode `600`), never in this repo. Enter it interactively (`read -rs`) so it never lands in shell history.

`gitea.home` is served by the Homelab internal CA. Node ships its own CA bundle and ignores the OS trust store, so every npm command touching that registry needs:

```bash
export NODE_OPTIONS=--use-system-ca
```

Without it npm fails with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` even though the root CA is installed system-wide. Use `--use-system-ca` (Node ≥ 22.15), which *augments* Node's bundle — not `cafile`, which *replaces* it and breaks resolution against `registry.npmjs.org`, and never `strict-ssl=false`.

None of this applies to a tarball or a clone-and-build install.

</details>

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

Transport is stdio, so a client only needs a command to spawn and the workspace root to pass it. `PROJECT_LENS_PATH` must be set, or the root given as a positional argument.

```bash
claude mcp add project-lens -- project-lens "$PROJECT_LENS_PATH"
```

Equivalent config-file form:

```json
{
  "mcpServers": {
    "project-lens": {
      "type": "stdio",
      "command": "project-lens",
      "args": ["${PROJECT_LENS_PATH}"],
      "env": {}
    }
  }
}
```

The `command` depends on how the server was installed — see the table in [Distribution](#registering-the-server-with-a-client). In this setup it is registered from the Claude_Toolbox plugin (`toolbox-servers/.mcp.json`), same pattern as the Obsidian servers, using `npx @mpujado/project-lens` against the private registry.

## Tools

| Tool | Purpose |
|---|---|
| `map_workspace(max_depth?)` | Tree overview: 1 = groups, 2 = groups → projects (default), 3 = + each project's top-level folders |
| `list_groups` | Flat list of group paths |
| `list_projects(group?, include?)` | Projects as `{fields, rows}`, optionally filtered by group; `include: ["branch", "is_clean", "stack"]` adds live per-project metadata for bulk sweeps and drops `absolute_path` |
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
npm run bench:tokens # token cost per tool vs the equivalent bash command
npm run inspector # manual acceptance via MCP Inspector
```

`bench:tokens` counts real tokens when `ANTHROPIC_API_KEY` is set (free `count_tokens` endpoint) or `CLAUDE_CODE_OAUTH_TOKEN` (probes `/v1/messages`, billed to your plan; results are cached on disk). With neither it degrades to UTF-8 bytes — `npm run bench:tokens:bytes` forces that mode.

## Distribution

The published artifact is small and self-contained: `files: ["dist/src"]` ships the compiled server only — no tests, no benchmarks, no source. Three runtime dependencies (`@modelcontextprotocol/server`, `picomatch`, `zod`). The `bin` entry is `project-lens`.

Pick the route that matches what the recipient can reach.

### Route A — tarball (no registry, works anywhere)

Use this to hand the server to someone who cannot reach your npm registry. This is the default for sharing with colleagues.

Maintainer:

```bash
npm ci                              # or npm install
npm test                            # pack does not run the test gate; publish does
npm run build
npm pack                            # writes mpujado-project-lens-<version>.tgz
```

Recipient — **no `~/.npmrc` entry, no scope mapping, no auth token, no CA configuration**. Installing from a local file bypasses registry resolution for the package itself; the three runtime dependencies still resolve from whatever default registry npm is already configured with (normally `registry.npmjs.org`), so this needs ordinary network access but nothing project-specific:

```bash
npm install -g ./mpujado-project-lens-0.2.0.tgz
which project-lens                  # binary on PATH
npm ls -g @mpujado/project-lens     # installed version
```

The server takes no flags — its only positional argument is the workspace root, so `project-lens --version` would be read as a path and fail. Verify with the two commands above instead.

The tarball is a normal npm package: `npm install ./…tgz` into a project instead of `-g` also works, in which case the binary lands in `node_modules/.bin/project-lens`.

Verify what you are about to hand over with `npm pack --dry-run` — it prints the exact file list. Anything outside `dist/src` in that output is a packaging bug.

### Route B — clone and build

For anyone who will also modify the server:

```bash
git clone <repo url> && cd Project_Lens
npm ci
npm run build
npm link                            # optional: puts `project-lens` on PATH
```

Without `npm link`, register the absolute path to `dist/src/index.js` (see below).

### Route C — private npm registry

Only if the recipient can reach the registry over the network **and** has credentials for it. `publishConfig.registry` in `package.json` currently pins publishes to the Homelab Gitea (`https://gitea.home/api/packages/mpujado/npm/`), which is not reachable outside that network — override it for any other target:

```bash
npm publish --registry https://<your-registry>/
```

`prepublishOnly` runs `build` + `test`, so a failing suite aborts the release. Bump `version` for every release: registries reject re-uploading an existing name+version, and Gitea requires deleting the old one first (`npm unpublish @mpujado/project-lens@<version>`).

Publishing to the Homelab Gitea specifically also needs `NODE_OPTIONS=--use-system-ca` (internal CA — see [Install](#install)) and a Gitea PAT with `package` permission in `~/.npmrc`. Neither applies to a public registry or to Routes A and B.

### Registering the server with a client

After any of the three routes, point an MCP client at the binary. `PROJECT_LENS_PATH` (or a positional argument) must hold the workspace root to scan.

Claude Code, one command:

```bash
claude mcp add project-lens -- project-lens "$PROJECT_LENS_PATH"
```

Or by config file, using whichever `command` matches the install route:

```json
{
  "mcpServers": {
    "project-lens": {
      "type": "stdio",
      "command": "project-lens",
      "args": ["${PROJECT_LENS_PATH}"],
      "env": {}
    }
  }
}
```

| Route | `command` / `args` |
|---|---|
| A, installed with `-g` | `"project-lens"` |
| A, installed into a project | `"./node_modules/.bin/project-lens"` |
| B, without `npm link` | `"node"`, args `["<abs path>/dist/src/index.js", "<root>"]` |
| C, private registry reachable | `"npx"`, args `["@mpujado/project-lens", "${PROJECT_LENS_PATH}"]` |

**Other MCP clients.** The server is a plain stdio MCP server built on the official SDK, so any spec-compliant client can drive it — the eleven tools and their schemas are identical everywhere, and version negotiation covers older 2025-era clients. Only the registration differs:

- `claude mcp add` is a Claude Code command. Other clients register through their own UI or config file; the `command` / `args` / `env` triple above is what they all ultimately need.
- `${PROJECT_LENS_PATH}` expansion inside the JSON is a Claude Code feature. Elsewhere, pass the workspace root literally in `args`, or set it in the server's own `env` block: `"env": {"PROJECT_LENS_PATH": "/abs/path"}`.
- GUI clients often do not inherit a shell PATH, so a bare `"project-lens"` can fail to spawn even when it works in a terminal. Use an absolute path there: `which project-lens` in a terminal prints it, or invoke `node` with the absolute path to `dist/src/index.js`.

Recipient checklist: Node ≥ 22, `git` on PATH, `ripgrep` (`rg`) on PATH, and a `PROJECT_LENS_PATH` pointing at an existing directory. The server exits loudly if any of the last three are missing — it never starts with a silently reduced tool surface.

### Maintainer conveniences

The JetBrains run configurations in `.idea/runConfigurations/` wrap the above (`Publish (Gitea)`, `Registry Setup (Gitea)`, `Published Versions`, `Unpublish Current Version`, `Pack (dry run)`, plus build/test/bench runners). They are **not** part of the distribution: `.idea/` is gitignored, so nobody who clones or installs the package gets them. Every command they run is documented above; the runners only add confirmation prompts.

No secret is stored in those XML files by the publish flow — the Gitea PAT is read from `~/.npmrc` or prompted for at run time. Because `.idea/` is untracked, it is also a workable place for a local-only value like the `ANTHROPIC_API_KEY` the token benchmark uses; treat that as machine-local and never copy such a file to a colleague.

## Benchmarks

All figures below are from one machine (personal PC, 42 projects / 16 groups under `/media/Dev/Personal`, v0.2.0). Re-run them with `npm run bench`, `npm run bench:store` and `npm run bench:tokens`.

### Latency (`npm run bench`, 100 iterations per tool)

| Tool | mean | p95 | SLA |
|---|---|---|---|
| `map_workspace` | 0.60 ms | 0.80 ms | < 15 ms |
| `list_groups` | 0.46 ms | 0.58 ms | < 15 ms |
| `list_projects` | 0.52 ms | 0.62 ms | < 20 ms |
| `find_project` | 0.46 ms | 0.54 ms | < 15 ms |
| `project_info` | 5.61 ms | 6.16 ms | < 100 ms |
| `search` | 6.68 ms | 7.44 ms | < 80 ms |
| `refresh_registry` | 73.38 ms | 83.92 ms | < 500 ms |

Registry internals (`npm run bench:store`): cold scan 87 ms, `getAll()` 0.2 µs mean, `find()` 10.9 µs mean, 10.3 MB heap used.

### Token cost (`npm run bench:tokens`, real `claude-opus-5` counts)

Each row compares one MCP call — request framing plus response — against the bash command a model would otherwise run for the same information, script text included.

| Scenario | mcp | bash | ratio |
|---|---|---|---|
| `map_workspace` | 652 | 1275 | **0.51** |
| `list_groups` | 207 | 359 | **0.58** |
| `list_files` | 97 | 159 | **0.61** |
| `project_info` | 255 | 375 | **0.68** |
| `read_file` (ranged) | 989 | 978 | 1.01 |
| `read_file` | 346 | 337 | 1.03 |
| `find_project` | 155 | 109 | 1.42 |
| `list_projects` (sweep) | 1355 | 795 | 1.70 |
| `write_file` | 108 | 62 | 1.74 |
| `list_projects` | 2263 | 1275 | 1.77 |
| `search` | 88 | 41 | 2.15 |

The eleven tool schemas cost 1886 tokens once per session. Roughly three `map_workspace` calls repay that: the winning scenarios save 623, 152, 120 and 62 tokens per call respectively.

The two `list_projects` rows stay above parity by design — the bash baselines print strictly less information (`find` emits only paths; the sweep loop only branch plus porcelain status), while `list_projects` also carries `name` and `group`. The metric that matters for bulk work is the projection: **1355 tokens for a 42-project sweep against 15184 for 42 `project_info` calls — 11.2× smaller**, past the ≥10× design target. The `{fields, rows}` matrix bought most of that; the array-of-objects shape it replaced scored 6.6×.

Without `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) the harness counts UTF-8 bytes instead and labels itself DEGRADED. Byte ratios land within a few percent of the token ones, but the error runs in either direction depending on the payload. Good enough to spot a regression, not to settle a close call.
