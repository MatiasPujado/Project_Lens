# Project-Lens

**A Model Context Protocol server that gives your AI coding agent a map of every project on your machine.**

Coding agents are good at working inside one repository and blind outside of it. Ask one about a project in a sibling directory and it starts guessing paths, shelling out to `find`, and burning context on directory listings that mostly do not matter.

Project-Lens fixes that. It scans the workspace roots you configure, builds a registry of every version-controlled project it finds, and exposes eleven tools that let an agent answer questions like *"where is the payments service?"*, *"which of my repos are on a dirty branch?"* or *"which project defines `TransactionManager`?"*. Each in a single call, with responses shaped to be cheap in tokens rather than pretty to a human.

Design points worth knowing up front:

- **Stateless.** Built on the MCP revision with the current `@modelcontextprotocol/server` v2 SDK, following its recommended server factory pattern. No session state is held between requests, so instances are interchangeable (scale them vertically or horizontally, restart them freely, run several side by side against different roots). Older 2025-era clients are still served through SDK version negotiation.
- **Sandboxed by construction.** Every path an agent supplies is resolved against a known project root; `../`, absolute paths and symlinks that escape are rejected. Files matching secret patterns are invisible to every tool.
- **Read-only by default.** The two tools that mutate anything are not even registered unless you explicitly enable writes, so a confused or prompt-injected client cannot call what does not exist.
- **Token-frugal.** Compact JSON, explicit truncation flags, and a positional `{fields, rows}` matrix for bulk listings, one call to sweep a whole workspace instead of one call per project. Measured at **11.3× cheaper** than the equivalent per-project calls.

---

## Why it exists

The project started from a recurring annoyance: an agent that already had a perfectly good picture of the repository it was in had no idea that a dozen related repositories sat next to it. Every cross-project question turned into the same ritual (`ls` a few directories, guess at a name, `find` for a file, read a `package.json` to work out what the thing even is). Each step cost tokens, several steps returned nothing useful, and the agent still ended up asking which folder to look in.

The underlying problem is that a workspace has structure the filesystem does not express. You know that `Work/Payments/Gateway` is a service, that `Work/Payments` groups related services, and that the archived folder next to them is dead weight. An agent shelling out to `find` knows none of that and cannot learn it without paying for a directory walk every single time.

Project-Lens turns that structure into a queryable registry built once at startup, and puts a small, deliberately shaped tool surface in front of it:

- **One call per question.** A whole-workspace metadata sweep is one `list_projects` call with a projection, not N `project_info` calls.
- **Responses sized for a context window.** Positional rows instead of repeated keys, capped lists with an explicit `truncated` flag, per-line excerpt caps on search hits.
- **A boundary the agent cannot cross.** Reads and writes are scoped to a resolved project root, secrets are filtered out before anything is returned, and mutation is off unless you switch it on.

---

## How it works

<details>
<summary><b>Discovery: how projects and groups are found</b></summary>

A directory containing `.git` or `.svn` is a project. The folders between a configured root and that project become its **group path**, at arbitrary depth (`Work/Payments/Gateway` is a project named `Gateway` in group `Work/Payments`). Groups are whatever your directory layout already says they are; there is nothing to declare.

SVN working copies are indexed and visible, but the `svn` binary is never invoked, so their remote, branch and clean state stay `null`. Git projects get all three, queried live on the calls that report them.

Projects are addressed by a bare name (`Gateway`) when it is unique, or by the group-qualified path (`Work/Payments/Gateway`) when it is not. Matching is case-insensitive; an ambiguous name returns the qualified keys, a miss returns the closest matches.

**Freshness:** full scan at startup, an explicit `refresh_registry` tool, plus mtime revalidation of root and group directories piggybacked onto registry calls. No filesystem watcher, no disk cache, nothing to invalidate by hand.

</details>

<details>
<summary><b>Tools: the eleven-tool surface</b></summary>

| Tool | Purpose |
|---|---|
| `map_workspace(max_depth?)` | Tree overview: 1 = groups, 2 = groups → projects (default), 3 = + each project's top-level folders |
| `list_groups` | Flat list of group paths |
| `list_projects(group?, include?)` | Projects as `{fields, rows}`, optionally filtered by group; `include: ["branch", "is_clean", "stack"]` adds live metadata for bulk sweeps |
| `find_project(query)` | Fuzzy name match → group + absolute path |
| `project_info(name)` | Path, VCS remote/branch/clean state, detected stack, key manifests, README snippet |
| `search(query, project\|group\|scope, path_prefix?, glob?, exclude?, context_lines?, limit?)` | ripgrep content search over one project, one group, or every registered project; results grouped one entry per file |
| `list_files(project, glob?)` | Paths relative to the project root; respects `.gitignore`, skips hidden files; capped at 500 |
| `read_file(project, relative_path, offset?, limit?)` | Scoped read with optional line paging |
| `write_file(project, relative_path, content)` | **Off by default.** Scoped write; creates parent dirs inside the root |
| `scaffold_project(group, name, {readme?, gitignore?})` | **Off by default. User-initiated only.** Create `<group>/<name>` + `git init`. No network access |
| `refresh_registry` | Force a full re-scan, returns scan stats |

**Narrowing a search.** `search` only scans the directories of the projects in scope, never the whole root, and takes *four parameters that narrow it further*: `path_prefix` (a subdirectory of each project), `glob` (passed to `rg -g`), `exclude` (per-call pruning), and `context_lines` (`0`–`3`, default `0`). The tool description steers the model toward these before widening to `scope: "all"`.

Results come back grouped one entry per file, with hits as positional `[line, excerpt]` pairs:

```json
{ "query": "TransactionManager", "scope": { "scope": "all" },
  "files_matched": 12, "hits_returned": 34, "truncated": false,
  "results": [
    { "project": "Gateway", "file": "src/tx/Manager.java",
      "lines": [[14, "public class TransactionManager ..."], [88, "  return new TransactionManager("]] }
  ] }
```

Ripgrep output is read as a stream and stopped as soon as `limit` is reached, so a query matching a hundred thousand lines costs the same as one matching fifty.

</details>

<details>
<summary><b>Security model</b></summary>

- **Path traversal is rejected** on every tool that takes a relative path `../`, absolute paths and symlinks pointing outside the resolved project root.
- **Secret-pattern files are invisible.** `.env*`, `*.pem`, `id_rsa*` and `*credentials*` never appear in key files, listings, search results or `read_file` output.
- **Remote URLs are sanitised.** `project_info` strips userinfo (`user:token@`) from git remotes before returning them.
- **Writes are unregistered, not merely refused,** unless explicitly enabled a client that connects without them cannot call them at all.
- **Untrusted config cannot widen scope.** A per-root `.project-lens.json` may only set `exclude`; a cloned repository cannot switch writes on or add roots.
- **Failures are loud.** Malformed configuration aborts startup rather than running with a silently changed scope.

</details>

---

## Benchmarks

All figures come from one machine, one session, against a workspace of **42 projects across 16 groups** with no exclusions configured and a pinned sample project. Your numbers will differ; reproduce them with `npm run bench`, `npm run bench:store` and `npm run bench:tokens`.

Read the two halves differently. **Token counts are deterministic**, the same workspace and sample give the same integers every run, so any movement is a real change. **Latency is deterministic nowhere**: `project_info` alone spans 12% across consecutive runs of identical code. Treat latency as a tripwire against the SLA column, not as evidence that one revision beat another.

<details>
<summary><b>Latency</b>: every read tool under 10 ms, full re-scan under 80 ms</summary>

`npm run bench`, 100 iterations per tool:

| Tool | mean | p95 | SLA |
|---|---|---|---|
| `map_workspace` | 0.56 ms | 0.77 ms | < 15 ms |
| `list_groups` | 0.47 ms | 0.51 ms | < 15 ms |
| `list_projects` | 0.53 ms | 0.61 ms | < 20 ms |
| `find_project` | 0.51 ms | 0.58 ms | < 15 ms |
| `project_info` | 5.53 ms | 6.01 ms | < 100 ms |
| `search` (one project) | 6.63 ms | 7.21 ms | < 80 ms |
| `search` (`scope: "all"`) | 9.46 ms | 10.36 ms | < 80 ms |
| `refresh_registry` | 71.64 ms | 79.57 ms | < 500 ms |

`p99` is deliberately not reported: at 100 iterations the 99th percentile *is* the maximum, so printing both would show one number twice and read as though the second corroborated the first.

**Every project-scoped row depends on which project got sampled**, and that drift dwarfs the run-to-run noise. Unpinned, the harness takes whichever project sorts first by group-qualified key, so the sample moves as the workspace does. On the same machine at the same commit, `search` (one project) measured 6.63 ms against one sample and 7.54 ms against another enough to take the cost of widening to `scope: "all"` from 43% to 23%. Always pin:

```bash
LENS_BENCH_PROJECT="<group>/<Project>" npm run bench
```

**Registry internals** (`npm run bench:store`): cold scan ~86 ms, `getAll()` 0.11 µs, `find()` 3.6 µs, 10.5 MB heap used. Three caveats, because each is a different kind of measurement. The cold scan is a **single sample** that folds in OS page-cache state and module load, so it moves ±10 ms and is reported rounded. `getAll()` is timed as one 10 000-iteration batch and its result is consumed (per-iteration timing would have measured `performance.now()` itself, and an unconsumed result is free for the JIT to delete). `find()` is quoted as the **median**: its mean is 9.2 µs against a 3.6 µs median, because the first call carries JIT warm-up.

</details>

<details>
<summary><b>Token cost</b>: 11.3× cheaper for a bulk sweep; schema cost repaid in four calls</summary>

`npm run bench:tokens`, real `claude-opus-5` counts. Each row compares one MCP call (request framing plus response) against the shell command a model would otherwise run for the same information, script text included.

| Scenario | mcp | shell | ratio |
|---|---|---|---|
| `map_workspace` | 652 | 1275 | **0.51** |
| `list_groups` | 207 | 359 | **0.58** |
| `list_files` | 124 | 210 | **0.59** |
| `search` (`scope: "all"`) | 3332 | 5221 | **0.64** ± |
| `project_info` | 255 | 375 | **0.68** |
| `read_file` (ranged) | 989 | 978 | 1.01 |
| `read_file` | 391 | 382 | 1.02 |
| `find_project` | 155 | 109 | 1.42 |
| `list_projects` (sweep) | 1344 | 785 | 1.71 |
| `write_file` | 108 | 62 | 1.74 |
| `list_projects` | 2263 | 1275 | 1.77 |
| `search` (project) | 97 | 54 | 1.80 ± |

`±` marks the two rows that do not reproduce: both sides stop at 50 hits and ripgrep's traversal order picks which 50. Every other row is exact.

**The headline number is not in that table.** The metric that matters for bulk work is the projection: **1344 tokens for a 42-project metadata sweep against 15 173 for 42 individual `project_info` calls 11.3× smaller**, past the ≥10× design target. The `{fields, rows}` matrix bought most of that; the array-of-objects shape it replaced scored 6.6×.

**Rows above 1.0 are honest** The `list_projects` rows stay above parity by design, the shell baselines print strictly less (`find` emits only paths; the sweep loop emits only branch plus porcelain status) while `list_projects` also carries name and group. The same asymmetry runs the other way in the strongest row: `map_workspace` is compared against a `find` emitting bare paths against a tool returning a tree, so part of its 0.51 is a discount for answering a smaller question. And the `search` (project) row found nothing at all (the pinned sample has no `TODO`) so its 1.80 is a fixed response envelope weighed against a command that printed nothing. It is published rather than deleted because dropping it would hide that the pinned sample cannot exercise that path.

**Schema cost.** All eleven tool schemas cost 2710 tokens, but a default session loads nine (`write_file` (298) and `scaffold_project` (254) are not registered unless writes are enabled) so the real one-time cost is **2158 tokens**. Four `map_workspace` calls repay it. Repayment is quoted against the best *stable* scenario: `search (scope: "all")` saves far more, around 1900 tokens a call, but a headline built on it would be advertising precisely the unnarrowed call the tool's own description tells the model to avoid.

`search` is the most expensive schema at 658 tokens, a third of it the `path_prefix`, `exclude` and `context_lines` parameters (a one-time cost against a tool whose single unnarrowed call runs into the thousands, so those parameters pay for themselves the first time the model uses one). Every parameter of every tool carries a description, which is most of the difference between the nine-tool figure and a bare-schema server. It is worth the tokens: one `read_file` that guesses the project key wrong costs a rejected call plus a `find_project` round trip to recover.

One asymmetry is not corrected for: **MCP is charged for its tool schemas and the shell is not.** A model calling out to a shell pays for the Bash tool's schema too, and that cost never appears in the shell column. Every ratio here is therefore slightly pessimistic about MCP: the conservative direction, which is why it is left in.

</details>

<details>
<summary><b>Methodology notes</b>: why the baselines look the way they do</summary>

**Both shell baselines pass `-M 300 --max-columns-preview`,** giving them the same per-line cap the tool applies to its excerpts. Both flags are load-bearing. `-M 300` alone does not cap a long line, it drops it:

```
$ rg -n --no-heading -M 300 TODO vendor/bundle.min.js
2:[Omitted long matching line]
```

That is 26 characters where the tool would have paid 300 (a silent subsidy to the shell on exactly the minified and vendored files the cap exists to handle). `--max-columns-preview` turns the omission back into a truncation, which is what the tool's excerpt cap actually does.

Some cap is non-negotiable: without one, a single minified line blows the comparison up, and the row swung between 1.1 MB and 17.9 MB depending on which lines `head -50` happened to catch. Worth knowing as a property of the naive command (an uncapped `rg | head -50` really can put megabytes into a context window).

**Without an API token the harness counts UTF-8 bytes and labels itself `DEGRADED`. That error is a bias, not noise.** Run back to back on the same workspace, bytes scored higher than tokens in all twelve rows, never once lower:

| Scenario | tokens | bytes | |
|---|---|---|---|
| `read_file` (ranged) | 1.01 | 1.02 | +1% |
| `read_file` | 1.02 | 1.04 | +2% |
| `project_info` | 0.68 | 0.70 | +3% |
| `list_projects` | 1.77 | 1.86 | +5% |
| `search` (`scope: "all"`) | 0.64 | 0.71 | +11% |
| `find_project` | 1.42 | 1.57 | +11% |
| `write_file` | 1.74 | 2.04 | +17% |
| `list_files` | 0.59 | 0.71 | +20% |

The mechanism is visible in the ordering: the `read_file` rows are mostly prose and land within 2%, while rows dominated by paths, keys and JSON punctuation are off by 10–20%, because the tokenizer packs those far better than one byte per token and they are exactly what the MCP side of a row is made of. Bytes mode always flatters the shell. Good enough to spot a regression on a large payload, never a source for a published ratio.

**Exclusions move every number here.** Excluding a tree removes its projects from the registry entirely, which shrinks the startup scan, the candidate set for every search, and the size of every listing response but also makes those projects unresolvable by name from *every* tool, not just from `search`. On the benchmarked workspace, excluding one archive directory took `list_projects` from 42 rows to 14, the startup scan from 70 ms to 17 ms, and the candidate set for a `TODO` search from 465 files to 25. The configuration is part of the measurement, not context for it.

</details>

---

## For users

### Requirements

On the machine that runs the server:

- **Node.js ≥ 22**
- **`git`** on `PATH`
- **[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`)** on `PATH`, required by `search` and `list_files`

The server exits loudly if any of these is missing; it never starts with a silently reduced tool surface.

### Install

**From a release asset** (fastest, no build toolchain, no registry account):

```bash
npm install -g https://github.com/MatiasPujado/Project_Lens/releases/download/v0.3.0/mpujado-project-lens-0.3.0.tgz
```

npm installs a tarball straight from a URL, so this needs no authentication and no registry configuration for the package itself. Its three runtime dependencies still resolve from whatever registry npm is already configured with. Check [the releases page](https://github.com/MatiasPujado/Project_Lens/releases) for the current version.

**From source:**

```bash
git clone https://github.com/MatiasPujado/Project_Lens.git && cd Project_Lens
npm ci
npm run build
npm link          # optional: puts `project-lens` on PATH
```

**As a tarball**, for handing the built server to someone else:

```bash
npm run build && npm pack               # writes mpujado-project-lens-<version>.tgz
npm install -g ./mpujado-project-lens-<version>.tgz
```

The package ships `dist/src` only (no tests, no benchmarks, no sources) and has three runtime dependencies (`@modelcontextprotocol/server`, `picomatch`, `zod`). Verify with `which project-lens` and `npm ls -g @mpujado/project-lens`; the binary takes no flags, so `--version` would be read as a workspace path and fail.

### Point it at a workspace

The server needs one thing: a root directory to scan. Everything underneath it becomes groups and projects.

```bash
export PROJECT_LENS_PATH="$HOME/Projects"
```

Precedence: positional CLI argument → `PROJECT_LENS_PATH` → `roots` in the config file. With none of them set, the server exits with an error. The root must exist and be a directory (`~` is expanded by the server).

### Register with an agent

Transport is stdio, so every client needs the same three things: a command to spawn, the workspace root, and optionally an environment block. Any spec-compliant MCP client can drive the server, only the registration syntax differs.

<details>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add project-lens -- project-lens "$PROJECT_LENS_PATH"
```

Or in a config file, where `${VAR}` expansion is supported:

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

</details>

<details>
<summary><b>Codex CLI</b></summary>

In `~/.codex/config.toml`:

```toml
[mcp_servers.project-lens]
command = "project-lens"
args = ["/absolute/path/to/workspace"]
```

</details>

<details>
<summary><b>Gemini CLI</b></summary>

In `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "project-lens": {
      "command": "project-lens",
      "args": ["/absolute/path/to/workspace"]
    }
  }
}
```

</details>

<details>
<summary><b>Cursor, Windsurf, Zed, Claude Desktop and other JSON-configured clients</b></summary>

```json
{
  "mcpServers": {
    "project-lens": {
      "type": "stdio",
      "command": "project-lens",
      "args": ["/absolute/path/to/workspace"],
      "env": {}
    }
  }
}
```

</details>

Pick `command` to match how you installed:

| Install | `command` / `args` |
|---|---|
| Global (`npm install -g`, or `npm link`) | `"project-lens"` |
| Into a project | `"./node_modules/.bin/project-lens"` |
| Clone, without `npm link` | `"node"`, args `["<abs path>/dist/src/index.js", "<root>"]` |

Two things that commonly trip people up:

- **GUI clients often do not inherit your shell `PATH`,** so a bare `"project-lens"` can fail to spawn even when it works in a terminal. Use an absolute path there (`which project-lens` prints it).
- **Environment-variable expansion inside config JSON is client-specific.** If yours does not support it, pass the workspace root literally in `args`, or set it in the server's own environment: `"env": {"PROJECT_LENS_PATH": "/absolute/path"}`.

<details>
<summary><b>Optional configuration file</b>: exclusions, multiple roots, enabling writes</summary>

Only needed for exclusion globs, multiple roots, or enabling writes. Location: `$PROJECTS_MCP_CONFIG` if set, else `$XDG_CONFIG_HOME/projects-mcp/config.json`, else `~/.config/projects-mcp/config.json`. A missing file is fine; a malformed one fails startup.

```json
{
  "roots": ["/absolute/path/to/workspace"],
  "exclude": ["**/Archived*/**", "**/vendor/**"]
}
```

| Field | Type | Meaning |
|---|---|---|
| `roots` | `string[]` (optional) | Absolute paths (or `~/…`) to walk for projects; overridden by a CLI or env root. A file setting only `exclude` is valid as long as a root comes from elsewhere |
| `exclude` | `string[]` (optional) | Globs matched against root-relative paths; pruned before descent |
| `allow_writes` | `boolean` (optional, default `false`) | Registers `write_file` and `scaffold_project`; overridden by `PROJECT_LENS_ALLOW_WRITES` |

**Excluding is worth doing**: it shrinks the startup scan, the candidate set for every search, and every listing response. The tradeoff is real, though: an excluded tree leaves the registry entirely, so its projects stop being resolvable by name from *every* tool, not just from `search`.

</details>

<details>
<summary><b>Per-root <code>.project-lens.json</code></b>: excludes that travel with the workspace</summary>

A root can declare its own excludes in a `.project-lens.json` at its top level. This is the right place for them when the workspace is shared across machines, or when the server is launched with a bare path and no global config file at all:

```json
{ "exclude": ["Archived/**"] }
```

Its patterns are unioned with the global `exclude`, but only for that root. One root's excludes never apply to a sibling.

**`exclude` is the only key this file may set.** It lives inside a workspace tree, which is content an untrusted repository can author, so `allow_writes` and `roots` are ignored here on purpose: a cloned repository must not be able to turn the write tools on or widen the scan. Set those in the global config file only. A malformed `.project-lens.json` fails startup rather than being skipped.

</details>

<details>
<summary><b>Enabling writes</b>: off by default</summary>

`write_file` and `scaffold_project` are the only tools that mutate anything, and they are **not registered** unless you turn them on:

```bash
export PROJECT_LENS_ALLOW_WRITES=1     # or 'true' / 'yes' / 'on'
```

```json
{ "roots": ["/absolute/path/to/workspace"], "allow_writes": true }
```

The environment variable wins over the config file. Everything else the server exposes is read-only.

</details>

---

## For developers and contributors

```
src/         config, discovery, registry, git, search, security, stack, tools, server entry
test/        vitest suites, one per module, plus an in-process MCP integration suite
benchmark/   e2e latency, registry micro-benchmarks, token-cost harness
```

```bash
npm run build          # tsc
npm test               # vitest: unit + integration
npm run test:watch     # watch mode
npm run test:coverage  # coverage report
npm run inspector      # manual acceptance via the MCP Inspector
```

Setup, testing, benchmarking, commit conventions and how to submit a change are in [CONTRIBUTING.md](CONTRIBUTING.md).

---

## License

See [LICENSE](LICENSE).
