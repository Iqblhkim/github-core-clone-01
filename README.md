# GitHub-Compatible Git Forge

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Iqblhkim/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Iqblhkim/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

One standalone Node process that is a GitHub-compatible git forge: git smart HTTP (protocol v2 and v0), REST v3, GraphQL v4, and MCP, all backed by its own in-memory store. No UI, no dependencies, no git binary, no network at run time — Node's standard library only.

Built by an AI agent for make.fun's "Build a GitHub-compatible git forge" bounty, $500 in USDC.

## Run

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later. The entry binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`, serves until `$MAKEFUN_ENV_URL/done` says `true`, then exits 0.

## Layout

- `main.ts` — the lifecycle (starter file, kept as-is).
- `app.ts` — the HTTP router: `/healthz`, `/api/v3/*`, `/api/graphql`, `/mcp`, `/<owner>/<repo>.git/*`.
- `scenario.ts` — the scenario's identity derivation (fnv1a64/mix64/Rng, ported from the kit), so the server knows the token owner's login.
- `gitcore.ts` — git primitives: object hashing/parsing/building, pkt-line codec, packfile read (with delta resolution) and write (plain objects).
- `store.ts` — the in-memory forge: repositories, objects, refs, issues, labels, comments, pull requests; contents commits, three-way merges, diffs; a deterministic logical clock.
- `githttp.ts` — git smart HTTP: v2/v0 advertisements, ls-refs, fetch (with shallow/deepen and haves), receive-pack pushes with fast-forward checks and per-ref reports.
- `rest.ts` — REST v3: repos, branches, commits, contents, git refs, labels, issues, comments, pulls, merges.
- `graphql.ts` — GraphQL v4: a small parser and executor for the `gh` / `github-mcp-server` documents, including `node(id:)` and the five mutations.
- `mcp.ts` — MCP over streamable HTTP: `server/discover` (2026-07-28 era), `initialize`, `tools/list`, `tools/call` for the six github-mcp-server tools.
- `httputil.ts` — shared HTTP helpers: request ids, bearer auth, JSON bodies, pagination.

## Design notes

- **Deterministic.** Every timestamp comes from `MAKEFUN_TRIAL_NOW` plus a monotonic counter — never the wall clock. Object ids are opaque base64url of a namespaced string, never the plain database id. Two runs that receive the same requests produce the same state.
- **Plain packs out, full packs in.** Fetches send plain (undelted) version-2 packfiles; pushes resolve OFS_DELTA and REF_DELTA, including thin packs.
- **Fast-forward only.** A push update is refused with `ng <ref> non-fast-forward` unless the old tip is an ancestor of the new one; objects are stored even for refused refs, and a mixed command list applies only its ok half.
- **One store, four surfaces.** REST, GraphQL, MCP and git all read and write the same in-memory state, so a pull request merged over MCP is visible over REST and vice versa.

Referral code: amsc6jjj
