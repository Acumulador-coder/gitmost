# AGENTS.md

## What this is

Gitmost is an AGPL-only fork of [Docmost](https://github.com/docmost/docmost) (a collaborative
wiki) with the Enterprise-Edition code deleted; the `require('./ee/ee.module')` stub in
`app.module.ts` fails and is swallowed — do not build on EE. Only the product is renamed: package
names (`docmost`, `@docmost/*`), the DB name, the `MCP_DOCMOST_*` env prefix and the
`@docmost/db/*` aliases stay `docmost`, because the schema is a superset of Docmost's and an
existing instance migrates by swapping the image. Do not rename them.

## Layout

pnpm workspace (`pnpm@10.4.0`) driven by Nx; `build` depends on `^build`.

| Path | Package | Role |
| --- | --- | --- |
| `apps/server` | `server` | NestJS 11 + Fastify, Kysely on Postgres (pgvector required), Redis |
| `apps/client` | `client` | React 18, Vite, Mantine 8, TanStack Query, Jotai |
| `packages/editor-ext` | `@docmost/editor-ext` | Tiptap extensions for client and server; `documentExtensions` is the document schema |
| `packages/prosemirror-markdown` | `@docmost/prosemirror-markdown` | The only ProseMirror↔Markdown converter; the client uses its `/browser` entry |
| `packages/mcp` | `@docmost/mcp` | MCP server (standalone and at `/mcp`) and the tool specs the in-app agent shares |
| `packages/git-sync` | `@docmost/git-sync` | First-party Docmost↔git engine (ESM, loaded through an async import) |
| `packages/token-estimate` | `@docmost/token-estimate` | Token estimator shared by the chat badge and the server history budget |

## Commands

Dev needs Postgres with `pgvector` and Redis per `.env`. Read first: [docs/dev-stand.md](docs/dev-stand.md)
(local stand), [docs/how-to-test.md](docs/how-to-test.md) (UI tests), [docs/reading-ai-logs.md](docs/reading-ai-logs.md).

```bash
pnpm dev                              # client (Vite) + API server (nest --watch) — no collab server
pnpm collab:dev                       # collab server from apps/server/dist (build first), :3001
pnpm build                            # all packages in dependency order
pnpm --filter server lint             # also --filter client; no root lint or test script
pnpm --filter server test             # Jest unit; `-- <file pattern>` or `-- -t "<name>"`
pnpm --filter server test:int         # Jest integration against real Postgres + Redis
pnpm --filter client test             # Vitest, no type check; `typecheck` runs tsc --noEmit
pnpm --filter @docmost/mcp test       # node --test; test:e2e needs a live instance
pnpm --filter server migration:latest # also migration:create --name=x, migration:down, migration:codegen
```

- Package `build/` dirs are gitignored. `server test` builds them in `pretest`; any other
  single-package `tsc` or test needs them built first (editor-ext → prosemirror-markdown →
  token-estimate → git-sync, mcp) or fails with `TS2307 Cannot find module '@docmost/…'`.
- The server loads the compiled `packages/mcp/build`: after editing `src/tool-specs.ts` run
  `pnpm --filter @docmost/mcp build`, or dev/test startup fails with "@docmost/mcp build is stale".
- Migrations (`apps/server/src/database/migrations/YYYYMMDDThhmmss-name.ts`) apply on boot only
  with `NODE_ENV=production`; in dev run `migration:latest` after a pull. A new one must sort
  after the newest on `develop` (CI job `migration-order`) and not depend on another. They add
  tables and columns and never drop Docmost's columns; regenerate `db.d.ts` after a schema change.

## Architecture

### Two server processes
`apps/server` runs as the API server (`dist/main`, `PORT` 3000) and the Hocuspocus/Yjs collab
server (`dist/collaboration/server/collab-main`, `COLLAB_PORT` 3001); both are required, share
state through Redis and need the same `APP_SECRET`.

- `/api` prefix (excluded: `robots.txt`, share pages, `l/:alias`, `mcp`). A `preHandler` in
  `main.ts` 404s `/api` requests without a resolved workspace, except its `excludedPaths`.
  Auth is JWT (cookie + bearer); authorization is CASL (`core/casl`).
- `/mcp` is a Nest controller outside the prefix using the single workspace (`findFirst`). `/git/*`
  is a raw Fastify route in `main.ts`, registered only when git sync and its HTTP host are on; it
  bypasses Nest, resolves the workspace itself and limits Basic auth (`git-http-auth.helpers.ts`).

### MCP and AI chat
- `/mcp` accepts only `Authorization: Bearer <api_key>` and acts as the key's owner; it is off
  until `settings.ai.mcp`; with `MCP_TOKEN` set a matching `X-MCP-Token` header is also required.
- The in-app agent (`core/ai-chat/`) uses the Vercel AI SDK with a per-workspace OpenAI-compatible
  provider; its tools act with the user's CASL rights via a loopback token
  (`tools/docmost-client.loader.ts`). External MCP URLs pass `external-mcp/ssrf-guard.ts` — keep it.
- Each agent turn is a run in `ai_chat_runs`, one active per chat (`409 A_RUN_ALREADY_ACTIVE`).
  A browser disconnect does not stop it, `POST /ai-chat/stop` does (so does a new chat's client
  leaving before the first frame); a reload re-attaches via `POST /ai-chat/run`.
- Single instance only: Stop and the run-stream registry are process-local and git sync's lock has
  no fencing; the server warns at startup when `CLOUD=true`.

### Git sync
Off unless `GIT_SYNC_ENABLED` (with `GIT_SYNC_SERVICE_USER_ID`); per space via
`space.settings.gitSync.enabled`. Each space has a bare vault: `main` + `refs/docmost/last-export`.
A cycle under the space lock (`SpaceLockService`) applies the user's commits since the last export
to Docmost by `gitmost_id` (block 3-way merge; git wins a block both sides changed), then exports
Docmost to `main` with plumbing and a compare-and-swap `update-ref`. The server never runs
`git merge`; a push based on an older `main` is refused as non-fast-forward. Writes go through the
collab layer stamped `lastUpdatedSource = 'git-sync'` (loop guard). `/git` (`GIT_SYNC_HTTP_ENABLED`):
read = fetch, Manage = push; a non-member gets the same 404 as a missing space.

### Client and schema
- Schema changes usually belong in `editor-ext`. The converter schema is `documentExtensions` plus
  `OVERRIDES` in `prosemirror-markdown/src/lib/docmost-schema.ts`; `serializer-contract.test.ts`
  fails for a node with no converter case. No second converter or schema copy.
- Client runtime config: production reads `window.CONFIG`, injected into `index.html` by
  `integrations/static/static.module.ts`; dev reads `process.env` defined in `vite.config.ts` from
  `src/lib/client-config-keys.ts`. A new key goes into that allowlist.

## Invariants

1. Anything that grows has an enforced byte/token budget (a row cap is not one); append, never rewrite.
2. Long-running state has an owner and a terminal write on every path, restart included; AI-chat
   runs and messages get a boot sweep plus the periodic `AiChatService.reconcile`.
3. Every await in a request or agent turn honours the AbortSignal and a deadline; long sync CPU
   work goes to a worker_thread or yields. `Promise.race` does not time out synchronous work.
4. Postgres is the source of truth, in-memory state a lossy cache; the client renders server data.
5. The AI-chat run lifecycle is the reducer in `features/ai-chat/state/run-fsm.ts`
   (`run-fsm.spec.md`): new behaviour is a named state and transitions there, not another ref.
6. Avoid flags that fork a code path; both sides of a fork share abort, error and concurrency code.
7. Duplicated knowledge (schema, tool registry, label lists) is generated from one source or
   guarded by a CI test that fails on drift; a "keep in sync" comment is not a guard.
8. Caches, headers, buffers and FSM transitions get an integration test of the observable property.
9. Client input is validated before it is persisted, so one bad row cannot break a chat or page.
10. Failures are loud: no fire-and-forget without a metric or ERROR log; degraded modes are visible.

## Conventions

- Feature design (a raw idea, «спроектируй», an issue to draft) starts with the
  `orchestrator-feature-designer` skill. After a task ships, delete its plan from
  `docs/backlog/<task>.md`.
- Code comments in English. Never swallow an error or show a generic message: log it in full and
  show the specific reason (server: `describeProviderError` in `integrations/ai/ai-error.util.ts`).
- Server TS is permissive (`strictNullChecks`, `noImplicitAny` off); follow that style.
- Deps are pinned by `pnpm.overrides` and `pnpm.patchedDependencies` (scimmy, `ai`, hocuspocus,
  yjs). Re-create a patch with `pnpm patch`, never edit it (its bytes are the lockfile `patch_hash`);
  `integrations/ai/ai-sdk-*.patch.spec.ts` check the server's `ai` patch. The client's `ai` is unpatched.
- The MCP `<tool_inventory>` is generated from `SHARED_TOOL_SPECS`; only an inline tool registered
  in `packages/mcp/src/index.ts` needs a line in `INLINE_MCP_INVENTORY`.

## Git, CI and release

- CI is GitHub Actions: `test.yml` (migration order, unit + integration suites, client typecheck,
  tool-spec parity) gates `develop.yml` (`ghcr.io/vvzvlad/gitmost:develop` on every push to
  `develop`) and `release.yml` (amd64 + arm64 images and a draft GitHub Release on a `v*` tag).

- `develop` is the integration branch; merging into it happens only on the owner's word. Never
  commit directly to `main` or tag it: `main` only receives `develop` at a release.
- Commit as `claude_code` with the email from `git config --local user.email` (ask the owner if
  unset). Check before pushing: `git log -1 --format='%an <%ae> / %cn <%ce>'`.
- Push only to Gitea (`gitea`, same repo as `origin`: `projects/gitmost`). `github` is a push
  mirror of Gitea where CI runs, `upstream` is Docmost: never push to either.
- Push credentials are in Vaultwarden (`rbw`) and the macOS keychain; pass one to a single push
  via `-c credential.helper=…`, never into the remote URL or git config.
- Before a release, run the test-coverage, code-review and red-team orchestrator skills on
  `develop` and fix their findings.
- Release: on `develop`, bump `version` in the root, `apps/client` and `apps/server` `package.json`
  (not `packages/mcp`), turn `[Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD` with its compare link,
  commit as `X.Y.Z`, tag it `vX.Y.Z` (lightweight), push both (the mirror carries the tag to GitHub
  and `release.yml`), then merge `develop` into `main`. The UI version is `git describe --tags`,
  which on `develop` cannot see a tag put on `main`.
- `CHANGELOG.md` (Keep a Changelog): each change a user or operator would notice goes into
  `[Unreleased]` in the same change, removed env vars, migrations and breaking MCP changes included.

## Limits for agents
- Tests: at most three times the code (`wc -l` of `tests/` against the code). Over the limit,
  still write the test you need, and in the same change go through the old tests: drop or merge
  duplicates and tests of implementation rather than behaviour.
- Comments explain the code as it is and why it is built this way. History ("used to", "after
  the review", "since the incident") goes into the commit message.
- This file stays under ~150 lines: only what an agent would get wrong without it. No decision
  history, incident logs or retelling of the code.

## FPF

Read a pattern through the `fpf` MCP (`read_pattern <ID>`) before applying it.

- Changing git sync, search, shares or MCP reads that serve views derived from the page in Postgres — KCAE.CHANGE "Keep Source Reading and Derived Views Coherent through Change": a search hit, an exported file and the page it points to must come from one version of that page, and deletions and permission changes must reach every derived view.
- Bumping a dependency the fork patches (`ai`, `@hocuspocus/server`, `yjs`, `scimmy` under `pnpm.patchedDependencies`) — SYSE.19 "Revalidate Engineering Decisions When a Relied-on Source Changes": compare what the new version changes against the bug each patch relied on, and keep, narrow or drop each patch on its own.
