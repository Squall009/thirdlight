# Owned diff rows — `export.md` (packet 64, packet 66)

Proposal: `../delivery.md` §6.4. Gate Q. **PROPOSED — not accepted.**
**Owner scope decision requested** (CCR-64-5): clerical correction of
accepted text to match the accepted behavior, or deferral to a bounded
re-review if the owner reads it as a section reopening. The packet-64
position: correct the text — the scan/graph evidence of record
(packets 58/60 re-measurement, the packet-62 owner procedure) already
binds the actual bytes.

## C64-5 — the M3 entry file row (exact old/new)

### Row 1: `export.md` §5.2, the M3 entry block

OLD (the accepted text as written today):

```text
**M3 entry (packet 58).** For an M3 (`manifestVersion 2`) export the graph adds
`game-host` and `platformer-game` and the composition lives in the public
`game-host` entry, not in an `exporter` internal:

```text
packages/exporter/src/export-bootstrap-m2.ts   the page bootstrap/wrapper
@thirdlight/game-host                          the shared composition + HUD/control/audio
@thirdlight/platformer-game                    the pure run/zone/camera module
```
```

NEW (the M3 entry file is `export-bootstrap-m3.ts` — the accepted
implementation, and the M3 exporter file list is exactly one file):

```text
**M3 entry (packet 58).** For an M3 (`manifestVersion 2`) export the graph adds
`game-host` and `platformer-game` and the composition lives in the public
`game-host` entry, not in an `exporter` internal. The M3 exporter file list is
**exactly one file** (no M2 three-file list, no wildcard):

```text
packages/exporter/src/export-bootstrap-m3.ts   the M3 page bootstrap/wrapper
@thirdlight/game-host                          the shared composition + HUD/control/audio
@thirdlight/platformer-game                    the pure run/zone/camera module
```
```

Evidence of record for the correction (no behavior change): the M3 graph
check enforces `M3_EXPORTER_FILES = ['packages/exporter/src/export-bootstrap-m3.ts']`
(`packages/exporter/src/graph.ts`), the M3 preview entry is
`packages/editor/src/preview/preview-m3.ts` (`tools/build.mjs`), and the
packet-58/60 re-measurement + packet-62 owner procedure ran on exactly
these entries.

### Row 2: `export.md` §5.2, the following sentence (unchanged — recorded
for completeness)

The sentence "`packages/exporter/src/export-composition.ts` may remain as
the accepted M2 entry for M2 exports; an M3 export must not require an
`exporter` internal for gameplay wiring" is **unchanged** and remains true
under the correction (the M3 list is one file; `export-composition.ts` is
an M2-only entry).

**No other `export.md` change.** The §5.4.1 recorded-exception table, the
§5.5 bootstrap behavior and the §3 layout are untouched; the M4
`./gltf-loader` subpath rows (dependencies.md, C64-6) apply the existing
GLTFLoader row of §5.4.1 without widening it.

## C66-2 — the game's build entry is the accepted admin export route; the
kit satisfies `THIRDLIGHT_ENGINE_ROOT` by shape (no change)

Proposal: `../distribution.md` §6, §10. Gate Q. **NO `export.md` CHANGE** —
adjudication, recorded so the promotion handoff has the exact position:

- The game build tool (distribution.md §6) exports through the **accepted
  public admin route** (`POST /api/v1/admin/projects/:id/export` —
  sessions.md §6.3's admin group, the export.md §2/§4 surface): the game
  build is a build, not a protocol invention. No route, payload, error code
  or metadata field changes.
- **`THIRDLIGHT_ENGINE_ROOT` requirement:** the export route resolves
  three/typescript/esbuild + the workspace packages from the engine root
  (deployment.md: "the engine checkout root (three/typescript/esbuild
  install + workspace packages)"). A kit directory after install +
  `npm run build` satisfies this shape exactly: `node_modules/` (from the
  exact lockfile), `packages/`, `dist/`. The route is checkout-agnostic by
  design (it takes a path) — no `export.md` text change.
- **Scan rules unchanged:** the kit-built export bundles pass the accepted
  §5.2 (esbuild 0.28.2 + the §5.3 pinned options) and §5.4 (forbidden
  content; the §5.4.1 recorded-exception table, incl. the C64-6
  `./gltf-loader` subpath rows) scans exactly as in-checkout exports do —
  the C08 evidence (packet 75) re-runs the same scans on the game-built
  bundle and the two must agree byte-for-byte in scan verdicts.
- The `dist/` artifacts are kit-local build outputs (reproducible from the
  pinned toolchain); the kit ships no `dist/` (it is excluded from the
  inventory) — an old `dist/` in a vendored kit fails the inventory check
  (`kit_tampered` class), never the scan.

**No other `export.md` change (packet 66).**