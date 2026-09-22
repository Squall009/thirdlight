# Packet 12 independent review — round 1 of max 3

VERDICT: **ACCEPTED** (single-session review per the owner's RESUME-2026-09-18 mode;
worked strictly from the committed tree — `a6feab1` impl + `8936213` record — plus
contract text: export.md (all), sessions.md §6.3/§13.7, project-model.md §12.2/§7.2,
runtime.md §2/§9, dependencies.md §3/§4.1/§4.2/§4.3/§7, m1-acceptance.md §2.2 — plus
FRESH independent probes, not implementation memory).

One **P2 (hygiene) finding**, fixed this round and re-verified: the exporter declared
`@thirdlight/protocol` as a dependency but never imported it (an unused declaration).
Removed; `npm install` re-run; check-deps/check-boundaries/tests re-run green. No P1.

## Re-verified from the committed tree (normative reads)

- **Same runtime as play mode — no separate gameplay implementation.** The export
  bundle entry `packages/exporter/src/export-bootstrap.ts` imports ONLY
  `@thirdlight/runtime` + `@thirdlight/three-adapter` (→ `three`); it instantiates the
  runtime with the built-in registry + the fixed `modules:
  ["thirdlight.demo:box-motion"]` (export.md §5.1), the single relative
  `fetch("./snapshot.json")` (§5.3/§5.5 step 1, IIFE-safe `.then()` chain — no
  top-level await, matching the pinned `format: "iife"`), `createSceneAdapter` on the
  page canvas, `start()`, structured on-page runtime errors, and NO stop/dispose path
  (§5.5 step 5). It makes no backend/MCP/authoring call (verified at the byte level,
  below).
- **Export operation = `exportProject(ctx)`, admin-scoped, not MCP, not a browser
  command.** `packages/exporter/src/index.ts` exports exactly `exportProject` +
  `ERROR_CODES` + types (dependencies.md §3 row); the `exports` map exposes only `.`;
  the browser bundle entry is NOT a public export (reached by file path at build time
  — §4.2). The backend route `POST /api/v1/admin/projects/:projectId/export` uses
  `requireAuth(req, projectId, true)` (admin only; never a browser editor command —
  sessions.md §6.3).
- **The 6-step pipeline in order, stable codes (export.md §4/§4.1).** `export.ts` runs:
  1 load+validate (queryProject + paged queryEntities → `validateScene` → manifest
  cross-checks → runtime.md §2 boundary re-validation of the CONSTRUCTED snapshot →
  deep-freeze) `export_scene_invalid` (≤ 10 error objects carried); bundle build
  (pinned §5.3 option set verbatim: bundle/iife/browser/treeShaking:false/sourcemap:
  false/minify:false, `write: false`, `metafile: true`); 2 revision re-read
  `export_snapshot_mismatch` (conflict; frozen vs current carried); 3 output-path
  containment (realpath of exportRoot/repoRoot/authoringRoot; target must be under
  exportRoot and outside both trees) `export_output_path_invalid`; 4 metafile graph
  check (exactly the §5.2 set; ≤ 8 offending modules) `export_bundle_graph_forbidden`;
  5 the §5.4 scan over ALL FOUR files with the §5.4.1 binding (identity = version +
  lockfile registry integrity; reference full-core re-scan to exactly the table's
  counts; real-bundle exact counts: a/b/c/e/g/i = 0, d = 3+the one engine literal,
  f/h/j = table) `export_bundle_forbidden_content` (≤ 4 hits `{pattern, byteOffset,
  context ≤ 80}`); 6 temp dir + atomic replacement (backup → rename → remove backup;
  failure restores the previous tree; temp removed on any failure)
  `export_output_not_writable`. Any failure ⇒ structured `{ok:false,error{code,cls,
  message ≤ 256, detail}}`, temp removed, previous tree untouched.
- **Output layout + canonical bytes (export.md §3).** `index.html` carries
  `<canvas id="game">` + `<script src="./js/main.js" type="module">` + the HUD line
  (filled at RUNTIME — §7) with relative references only; `snapshot.json`/`meta.json`
  are canonical (fixed key order, 2-space, LF, one trailing newline, no BOM —
  `canonical.ts`, the §12.2-style serializer); `meta.json` is the §6 exact field set
  with `exportedAt` the only time-varying field (UTC second, §7.2 regex verified) and
  `dependencies` carrying the REAL installed versions (three/typescript read from
  `node_modules/*/package.json`, esbuild from the `version` export) + the fixed
  `runtime: { fixedStepHz: 120, modules: [demo] }`.
- **Pure-Node exporter (dependencies.md §4.1 `node: []`).** 0 `node:` imports in the
  package's own source (fresh grep, `ambient.d.ts` excluded — it is type-only
  declarations for the workspace SOURCE the program typechecks, mirroring the
  backend's pattern). All I/O is the injected `ExportFs`; the workspace service is
  injected types-only (fresh boundary probes: a normal exporter file importing
  `@thirdlight/runtime` or `@thirdlight/backend/services` FAILS `forbidden-edge`; the
  §4.2 entry override applies to `export-bootstrap.ts` ONLY — the transitive graph is
  enforced at export time by the metafile check, §4 step 4).
- **No second mutation engine / no service dependency in the output.** The exporter
  reads via the injected service (never opens a second authority); the exported
  bundle's only engine-initiated network mechanism is the single relative
  `fetch("./snapshot.json")` (byte-level verified below).

## FRESH evidence this round (not implementation memory)

1. **Boundary override scoping (fresh, temp files, removed after):** a normal
   exporter production file importing `@thirdlight/protocol` ⇒ OK (allowed node-side
   edge); importing `@thirdlight/backend/services` ⇒ FAIL `forbidden-edge`
   (exporter → backend); importing `@thirdlight/runtime` ⇒ FAIL `forbidden-edge`
   (node-side) — the §4.2 override is correctly scoped to the bootstrap file only.
2. **Fresh scan probes (temp suite, 11/11, removed after):** reference build NOT
   produced ⇒ binding fails closed and the unmodified strict scan applies (an
   exception-pattern occurrence is a failure, reason recorded); wrong lockfile
   integrity ⇒ identity void; a token VALUE inside the bundle fails (pattern i is
   absolute, not excepted); canonical invariants on a fresh document (no BOM, exactly
   one trailing LF, LF-only, own insertion order, 2-space indent, JSON escaping of
   newline+quote, re-serialization stability).
3. **Fresh on-disk export tree re-verification (12/12, the real export from the
   static-server probe):** exactly 4 files; index.html relative-only refs; bundle has
   exactly one `fetch("./snapshot.json")` and `fetch(` = 4 (3 pinned-three + 1
   engine); exact §5.4.1 table counts (`process.` 3, `http://` 3, `https://` 23,
   `XMLHttpRequest` 3, `WebSocket` 0, `__dirname` 0); no `node:`/`/api/v1/`/`/mcp`/
   either origin/any token value anywhere in the four files; snapshot.json a valid
   canonical document (`demo-0001@r1`); meta.json the exact §6 field set with the
   recorded versions + fixed demo module + §7.2 `exportedAt`. (One initial probe
   "FAIL" was a sort-order bug in MY probe — the tree is correct.)
4. **Independent static server (re-verified in the impl round; the packet's step 12):**
   real export through the real backend; the backend STOPPED (its authoring port
   refused connections); `python3 -m http.server` serving ONLY the export tree: `/`
   200 (canvas + relative script, no absolute URLs), `/js/main.js` 200 (1,859,113 B),
   `/snapshot.json` 200, `/meta.json` 200, `/nope.js` 404.
5. **Full toolchain (fresh):** `npm test` 66 files / 840 passed; `npm run typecheck`
   exit 0 (10 packages); `npm run check-deps` OK; `npm run check-boundaries` OK
   (10 packages, 150 files, 513 specifiers); `npm run build` exit 0 (3 built — the
   export bundle is built at export time by the exporter, per §4.2, not by the
   workspace build).

## Findings

- **P2 (fixed this round):** unused declared dependency `@thirdlight/protocol` in
  `packages/exporter/package.json` (never imported — the exporter builds its own
  structured errors and validates via project-model). Removed; lockfile updated;
  check-deps/check-boundaries/full suite re-run green. No contract/boundary impact.
- Non-gating carried:
  - **Browser visual/network UNVERIFIED** (no browser/WebGL in this container — the
    packet-08 constraint carries forward): the served export's WebGL render, the demo
    oscillation, the HUD selected-backend line, the console/network inspection, and
    the export-page bootstrap executing on a real canvas are UNVERIFIED with exact
    manual steps in handoff 12.md.
  - **Contract change requests (documented, not silently changed):** (1) sessions.md
    §13.7 — optional `engineRoot` config field (+ `THIRDLIGHT_ENGINE_ROOT` env var):
    the export route needs the engine installation root and no config field exists
    for it; implemented additive/optional, fail-closed (structured `unavailable`)
    without it. (2) export.md §5.4.1 — the literal reference entry
    `import * as THREE from 'three';` elides to a 15-byte empty IIFE under pinned
    esbuild 0.28.2 (unused namespace imports are dropped even with `treeShaking:
    false`; verified empirically), making binding 3 unsatisfiable; the implemented
    interpretation references the namespace (`console.log(THREE.REVISION)`) to
    materialize the full-core bundle (1,777,839 B — consistent with the contract's
    re-measurement note) which re-scans to EXACTLY the table's counts (unchanged,
    still binding).
  - Concurrent same-target exports are not serialized (operator-driven M1; the
    atomic replacement guarantees the tree is always either the old or the new
    complete tree — never partial).
  - The `engineRoot`-derived paths assume the M1 single-repo layout (decision 0001
    §6).

## Acceptance (m1-acceptance.md §2.2 packet-12 rows)

- Export of an immutable valid snapshot using the SAME runtime as play mode — PASS
  (bootstrap imports only runtime/three-adapter; built at the pinned versions; the
  fixed demo module).
- Static browser files with relative asset references + recorded engine/build
  metadata — PASS (layout + §6 meta.json, real installed versions; canonical bytes).
- No separate gameplay implementation — PASS (fresh read of the entry).
- Validate references/supported components before a successful artifact — PASS (the
  6-step pipeline; a failed export writes nothing and leaves the previous tree
  untouched — tested).
- Exclude editor/backend/MCP packages, credentials, source-workspace paths,
  authoring-service calls — PASS (metafile graph check + §5.4 scan; fresh on-disk
  re-verification: 0 hits on origins/tokens/`/api/v1/`/`node:`/`/mcp`).
- `file://` not implied; plain static HTTP serving documented — PASS (handoff 12).
- Verified through an independent static server with the backend stopped — PASS
  (static-server probe: backend port refused; python3 http.server served the tree).
- Reproducibility scope (repeated builds of the same snapshot) — PASS (byte-identical
  main.js/snapshot.json/index.html; meta.json identical except `exportedAt`).
- No publishing to the internet — PASS (no upload/CDN code path).
- Browser network/errors inspection — UNVERIFIED (no browser; manual steps recorded).

**PACKET 12 ACCEPTED** (with the P2 dep-hygiene fix committed in this round).
Next: packet 13 (M1 integrated acceptance + local deployment; Gate D prerequisite:
Gate C accepted).