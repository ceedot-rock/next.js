---
name: next-browser-initial-load-optimizer
description: >
  Investigate and reduce browser initial-load work in Next.js applications using
  a versioned analyzer NDJSON graph dump. Use for bundle audits, slow routes,
  dependency/import graphs, lazy-loading candidates, duplicate packages, large
  Client Component boundaries, graph cuts and clustering explorations.
---

# Browser initial-load optimizer

Investigate **why** a route emits code, without decoding private UI binary files or mistaking build-time provenance for observed browser requests. The v1 record contract is documented in the Next.js source repository at `packages/next/src/build/analyze/GRAPH-DUMP.md`; the record summary below also works when only the installed package and this skill are available. The dump is evidence, not a query solver: use small disposable scripts or `jq` for the question at hand. Check `meta.schema_version === 1`; discard any incomplete dump or command with a nonzero exit.

## Choose a mode

- **Audit (default):** Do not modify application source, dependencies or lockfiles. Generate or replay analyzer data, report scoped candidates and verification gaps, then stop. `--output=json` generates build artifacts on a fresh run, but does **not** authorize fixes.
- **Fix (explicit request only):** Audit the scope, make one behavior-preserving change at a time, regenerate and compare data, test behavior and keep or revert it. Ask before changing visible behavior, timing, compatibility or a trust boundary.

## 1. Obtain versioned graph evidence

In the application, use its package manager (`npx next`, `yarn next`, `bunx next`, etc. also work):

```bash
pnpm exec next analyze --output=json > /tmp/analyze-before.ndjson
```

To replay a snapshot saved by `next analyze --output` or `next build --analyze`, read its exact ID from `.next/diagnostics/analyze/history/history.json`:

```bash
pnpm exec next analyze --output=json --snapshot '<snapshot-id>' --route '/dashboard' > /tmp/dashboard.ndjson
```

`--route` selects the exact route key and keeps the whole-app module graph; repeated route keys are distinguished by `route_index`. Replay does not build, serve or write an NDJSON sidecar. Progress/errors are on stderr, and stdout has JSON objects only. Plain `next analyze` serves the optional UI, bare `--output` writes the existing UI artifacts, and plain `next build --analyze` saves a replayable snapshot but never prints NDJSON. Redirect large output and filter it rather than pasting a whole graph into a model context.

A fresh analysis may still require TCP binding, even with `--output=json`. If the sandbox cannot bind ports, request a permitted environment or a snapshot produced elsewhere and replay it. Do not bypass restrictions or claim that analysis/browser checks ran if they did not. Unversioned old snapshots, corrupt data and unknown versions must be regenerated. Keep before/after dumps separate and compare like routes and metrics. Snapshot IDs and output filenames are snapshot-scoped, not stable across rebuilds; `module_index_hash` is an ordered-index fingerprint, **not** proof of identical graphs or builds.

## 2. Read records and inspect application source

- `module`: exact `ident`/`path`, plus `dependencies.sync`, `.async` and `.traced` identity lists pointing **importer → imported**. Reverse ordinary edges to find importers; track visited identities across cycles. Traced edges are file-tracing relationships, not browser imports. Different `ident` variants may share a path, so never silently join by path alone.
- `route`: route key and snapshot-scoped occurrence index. `output`: emitted filename, joined `modules` identities, and `coverage` (`exact`, `unsupported`, `not_a_chunk`, `unknown`). Only `exact` asserts all enumerable JS/CSS chunk members joined. An unsupported empty row is **not** an empty chunk; `unjoined` records preserve unmatched module identities, including worker payloads from separately compiled graphs. `output.unresolved_references` counts references whose runtime load type is not explicit; a positive count blocks claiming edge coverage is exhaustive. Its absence is unknown, **not** zero. Module membership is not part/source size attribution or a request claim. `part`: output filename, reconstructed source path, attributed `size` and `compressed_size`. Sum each part **once** for the selected route/outputs; do not add directory and descendant totals together. Parts are attribution weights, not predicted savings or measured transfer bytes. Verify the `[client-fs]/` client output convention on the chosen artifact; server/traced outputs are not browser work.
- `route.entries` (when present): verified endpoint roots with `route_entry_id`, exact `module_ident`, `module_path`, role, runtime and optional `entry_kind` (`server` or `client_bootstrap`). App RSC roots can carry nested `client_references` with their own identities and `ecmascript`/`css` roles. **References are not additional endpoint roots or observed initial browser requests.** Pages shared roots may appear on an API artifact even though they are not necessarily browser work for that API. Join to modules only by exact identity; preserve unknown roles and unmatched references. `route.coverage.entries === 'exact'` means the producer supplied these typed roots, not that browser request timing is known.
- `group` (when `route.coverage.groups === 'exact'`): direct emitted `outputs` filenames for build-time `bootstrap`, `render_dependent`, `async` or `worker` groups. A `trigger_module_ident` has `trigger_join` of `joined`, `unjoined` or `none`. A single output can belong to multiple groups. App layout groups can be cumulative; their members are **not** the exact contribution or initial request set of one client reference. Bootstrap identifies a direct client build group, not every cold navigation request. Render-dependent outputs may load during the first render or later; worker registration only happens when its code runs.
  Where available, `load_edge` supplies typed `source_output` → `target_output`, `kind` and joined/unjoined `trigger_module_ident`; `unresolved` preserves uncertain/out-of-route targets with reason and optional source/trigger. `async` / `async_manifest` edges come from loaders/manifests, `worker_registration` from an importer traced to a worker output; `asset_reference` is only a generic asset reference, **not** proof of a request. A missing `load_edge` record does not establish that no load is possible, especially with unresolved references. A group/edge can support a **conditional build-time** cut only if coverage is complete for the selected route/render scenario; it cannot prove observed cold browser requests.
- A module graph is whole-app. Intersect candidate import paths with route output/part evidence and inspect exact importers in source; a source path is not necessarily a module identity. `null`/`unknown` means missing evidence, **not** an empty path. Some newer v1 producers add optional provenance and coverage, but never presume a record exists if the selected dump omits it.

Record the route, snapshot, client/server scope, target, metric and whether the question means all emitted output or **observed initial requests**. A cold browser network trace is required for request timing, prefetch and transfer bytes. A type-only import may already be erased; an already-async boundary is not a reason to add another split.

## 3. Choose a fitting analysis

Start with named routes or rank meaningful client-output contributions by attributed size, repetition, likely parse/execute cost, need before interaction and correctness risk (for example duplicate runtimes). Avoid a universal byte threshold or trivial churn. Before proposing a lazy boundary, inspect the exact importer and **all** synchronous importer paths, alternate roots and cycles. No graph solver is needed if a few reverse paths and parts explain the problem.

- **Conditional min cut:** Choose a route/render scenario, verified client roots and heavy target; use directed synchronous importer→imported edges and exact output→module memberships. Check every relevant output's coverage, `unjoined`/`unresolved` records, positive or unknown `unresolved_references`, and overlapping/cumulative `group` memberships; unsupported/unknown output memberships or a group that cannot isolate one reference block a definitive cut if they could supply another path. Output membership and group role alone do not establish cold browser request scope. If any possibly relevant root→target path, edge, trigger or client role is unknown, refuse a definitive/exhaustive cut and label a cut of the **known subgraph** provisional, with a verification plan. For a sufficiently evidenced scenario, connect all selected roots to a super-source and targets to a sink, choose unit-edge versus size/edit-cost capacities deliberately, condense SCCs if needed and verify every synchronous path is severed. A mathematical cut is not automatically a safe `import()` or a measured saving: check side effects, runtime behavior, shared routes and a cold browser trace before claiming an initial-load cut.
- **Clustering:** On scoped, deduplicated client modules, optionally symmetrize ordinary imports for Louvain/Leiden or a comparable method; document weights, resolution, seed and stability. A community is neither an emitted chunk nor a valid client/server boundary. Never conflate async/traced edges with synchronous browser imports.

For `/dashboard` contributions, group selected client-output `part` records by source/package and report scoped attribution, not initial requests. For an editor, find project importers using the reverse graph and inspect source; multiple root→editor paths require multiple cuts. Defer initial-request and transfer claims until runtime evidence exists.

## 4. Make one safe change and measure it

**Fix mode only.** For interaction-gated editors/charts/dialogs, confirm the feature is not already async; add one lazy boundary with a stable placeholder and preserve loading/error states, keyboard/focus, direct visits and client/server behavior. Use `ssr: false` in a Client Component only when browser-only APIs require it. Preload on intent only after measuring; idle preloading can waste data/battery and contend with important requests.

For duplicate packages, verify shipped browser versions and the package-manager graph (`pnpm why`, `npm ls`). Don't confuse module variants or server/client copies with duplicated shipped JS. Prefer compatible direct-range/parent upgrades and dedupe before overrides; never force cross-major consolidation based on a matching name alone. Check React/singleton peer and hydration behavior, and review lockfile churn. For Markdown/MDX, parsers, registries and display-only work in a Client Component, move only work that does not require live editing, offline use or browser-only inputs. Prefer server-rendered display plus a small interactive island or a lazy editor parser; keep sanitizer and authorization on the right side and verify hydration. Inspect polyfills, barrels, layout imports, CSS/fonts/media/WASM only when evidence warrants it; a generic asset source is not a proven request.

Record a baseline dump, importer, candidate edit and behavior coverage. Make **one** change; generate an after dump, compare the same route/output class/metric, run targeted behavior tests and type-check. Lazy loading can preserve eventual output bytes: require source/build evidence **and** a cold browser trace before claiming initial-load improvement. Revert ineffective or breaking changes; use the accepted after snapshot as the next baseline.

## 5. Report and stop

Audit reports candidates without application edits; fix reports accepted edits. Include baseline/after snapshot IDs, scoped attribution deltas, exact source/importer, change, behavior checks and blockers. Distinguish source facts, build provenance, heuristics and observed requests. State route/render conditions, roots/target and unknowns for any graph cut. If evidence or port binding is blocked, say so rather than inventing a win.

## Related skills

- `next-dev-loop` — inspect the browser and verify behavior after an edit.
- `next-cache-components-optimizer` — optimize the route's static App Shell.
- `next-partial-prefetching-optimizer` — optimize navigation prefetch work.
