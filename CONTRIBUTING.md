# Contributing to Project-Lens

Thanks for your interest in Project-Lens. This guide covers getting set up, the conventions the codebase follows, and how to get a change in front of the maintainer.

Read the [README](README.md) first if you have not, it explains what the server does and why its responses are shaped the way they are. Most of the rules below follow from that.

## Getting started

### Prerequisites

- **Node.js ≥ 22**
- **npm** (ships with Node)
- **`git`**
- **[ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`)** on `PATH`

`git` and `ripgrep` are runtime requirements, not just development ones. The `search` and `list_files` tools shell out to `rg`, and project metadata comes from `git`. The test suite needs them too.

### Setup

```bash
git clone https://github.com/MatiasPujado/Project_Lens.git
cd Project_Lens
npm ci
npm run build
npm test
```

`npm test` on a fresh clone is expected to pass with no configuration. The suite builds throwaway workspaces under the OS temp directory (see `test/helpers.ts`), so it never touches your real projects and behaves the same on Linux, macOS and Windows.

## Project structure

```
src/
  index.ts        bin entry point
  main.ts         startup: resolve config, scan, serve over stdio
  config.ts       config file + env + CLI root resolution and validation
  discovery.ts    filesystem walk; what counts as a project and a group
  registry.ts     in-memory project store, lookup, mtime revalidation
  git.ts          remote / branch / clean state, remote URL sanitising
  search.ts       ripgrep invocation, streaming, result grouping
  security.ts     path containment, secret-file filtering
  stack.ts        manifest-based stack detection
  tools.ts        MCP tool definitions, schemas and handlers
  types.ts        shared types

test/             one suite per src module, plus integration.test.ts
benchmark/        e2e latency, registry micro-benchmarks, token-cost harness
```

One package, one build. There are no workspaces or sub-packages to juggle.

## Development workflow

```bash
npm run build          # tsc
npm test               # vitest: unit + integration
npm run test:watch     # watch mode
npm run test:coverage  # coverage report
npm run inspector      # manual acceptance via the MCP Inspector
```

To drive the built server by hand against a scratch workspace:

```bash
mkdir -p /tmp/lens-scratch/GroupA/ProjectOne && git -C /tmp/lens-scratch/GroupA/ProjectOne init
npm run build
node dist/src/index.js /tmp/lens-scratch
```

It speaks MCP over stdio, so a bare terminal is not much use on its own. `npm run inspector` is the practical way to click through tools by hand. It reads the workspace root from `PROJECT_LENS_PATH`.

## Design invariants

These are the rules a change is measured against. They are not style preferences; each one is load-bearing for either the token economy or the security model.

- **Keep responses compact.** A new field costs tokens on every call, for every user, forever. Prefer an opt-in projection parameter over always-on data. Capped lists carry an explicit `truncated` flag rather than silently shortening.
- **Describe every parameter.** Schema descriptions are the cheapest thing in the budget: a model that guesses a project key wrong costs a rejected call plus a recovery round trip, which dwarfs the schema text.
- **Never widen scope from untrusted input.** Configuration that can live inside a scanned workspace (`.project-lens.json`) may only *narrow* what the server sees. A cloned repository must never be able to enable writes or add roots.
- **Fail loudly.** Malformed configuration aborts startup. The server must never run with a silently changed scope or a silently reduced tool surface.
- **Security-relevant changes need a test that fails without the fix.** See below.

## Testing

Each module has an isolated suite, and on top of them sits an **integration suite that drives a real MCP client against a real server over an in-memory transport** (`test/integration.test.ts`). Tools are exercised through the actual protocol rather than by calling handlers directly, so schema, registration and serialisation bugs surface in tests instead of in someone's client.

Security-relevant behaviour has dedicated coverage, and it needs to stay that way:

| Invariant | Where |
|---|---|
| Path traversal rejection (`../`, absolute paths, escaping symlinks) | `test/security.test.ts` |
| Secret-file masking (`.env*`, `*.pem`, `id_rsa*`, `*credentials*`) | `test/security.test.ts` |
| Remote URL sanitising (`user:token@` stripped) | `test/git.test.ts` |
| Write gate: write tools unregistered unless enabled | `test/integration.test.ts`, `test/config.test.ts` |

Write-tool tests deliberately assert on **registration**, not just on refusal. "The tool rejected the call" and "the tool was never exposed" are different guarantees, and the second is the one the security model claims. If you touch that path, keep the distinction.

A change to path resolution, the secret-file filter, or the write gate is not reviewable without a test that fails before your fix and passes after it. Include it.

## Benchmarking

```bash
npm run bench          # e2e latency per tool over stdio
npm run bench:store    # registry internals: cold scan, lookup, memory
npm run bench:tokens   # token cost per tool vs the equivalent shell command
```

Each harness takes its workspace root from argv, `PROJECT_LENS_PATH` or the config file, and prints the sample project it used.

The token harness counts real tokens when `ANTHROPIC_API_KEY` is set (free `count_tokens` endpoint) or `CLAUDE_CODE_OAUTH_TOKEN` (probes `/v1/messages`, billed to your plan; results cached on disk). With neither, it falls back to counting UTF-8 bytes and labels itself `DEGRADED`; `npm run bench:tokens:bytes` forces that mode. Bytes mode is a **bias, not noise**, it consistently flatters the shell baseline, so it can spot a regression but must never be the source of a published ratio.

Two rules if you quote numbers from these in an issue or a patch:

- **Pin the sample** with `LENS_BENCH_PROJECT="<group>/<Project>"`. Unpinned runs take whichever project sorts first by group-qualified key, so the sample moves as the workspace does and results are not comparable between runs.
- **State the configuration.** Roots and exclusions change *what is measured*, not just the context around it. Token counts are deterministic for a fixed workspace and sample; latency is deterministic nowhere, so treat it as a tripwire against a target rather than evidence that one revision beat another.

## Making changes

### Commit convention

Conventional commits:

```
type(scope): description

feat(search): add path_prefix narrowing
fix(security): reject symlinks resolving outside the project root
docs(readme): clarify the write gate
test(registry): cover mtime revalidation on group rename
```

**Types**: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`

**Scopes**: `config`, `discovery`, `registry`, `git`, `search`, `security`, `stack`, `tools`, `benchmark`, `tests`, `docs`, `release`

Keep commits focused and atomic. A change that touches behaviour, its test and its documentation belongs in one commit; two unrelated fixes do not.

### Submitting a change

**This repository is a read-only mirror.** Development happens in an upstream repository the maintainer controls, and this GitHub copy is synchronised from it in one direction. A pull request opened here cannot be merged, and a sync can overwrite refs. So please do not spend effort on one. It will be read, but it has to be re-applied upstream by hand either way.

The fast path is a patch series attached to an issue:

1. **Open an issue first** describing the problem or the change. For anything beyond an obvious fix, agreement on the approach before you write code saves everyone a round trip.

2. **Work on a branch:**

   ```bash
   git checkout -b fix/short-description
   ```

3. **Verify before you send:**

   ```bash
   npm run build && npm test
   ```

4. **Export the series and attach it to the issue:**

   ```bash
   git format-patch main --stdout > project-lens-fix.patch
   ```

   A patch series preserves your commits, message and authorship, so you keep credit in the history once it is applied upstream.

For a one-line typo, just describe it in the issue. No patch needed.

## Where help is most useful

- **Stack detection** (`src/stack.ts`) currently recognises Node, TypeScript, Python, Go, Java/Gradle/Maven and Docker Compose manifests. More ecosystems are welcome, as long as detection stays manifest-based and cheap.
- **VCS support.** Git is fully supported; SVN working copies are indexed but never shelled out to. Adding real SVN metadata, or another VCS, is a self-contained piece of work.
- **Search ergonomics**: better narrowing, better result shaping, fewer tokens per hit.
- **Response shape.** Anything that makes a common call measurably cheaper without losing information. Bring benchmark numbers.
- **Documentation and examples**, particularly registration recipes for MCP clients not yet covered in the README.

### Out of scope

- Changes that make a default tool call cost more tokens without a clear payoff.
- Anything that widens the server's filesystem reach, or that lets workspace-local configuration do so.
- Network access from the server. It has none by design, including in `scaffold_project`.
- Persistent state: the server is deliberately stateless, which is what lets instances be replaced and scaled freely.

## Reporting issues

1. **Search existing issues** before opening a new one.
2. **Include your environment:** OS, `node --version`, `rg --version`, and how the server is registered with your client.
3. **Steps to reproduce**, and what you expected instead.
4. **Never paste secrets.** If a path or a git remote is relevant, redact tokens and credentials first and if the server ever surfaces one, that is a security bug worth reporting on its own.

## Getting help

- **GitHub Issues**: bugs and feature requests
- **GitHub Discussions**: questions and general discussion

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
