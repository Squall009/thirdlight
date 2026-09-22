# M4 distribution contract — the portable pinned engine kit and independent build

**Status:** ACCEPTED at Gate Q (2026-09-22) — promotion applied per
`docs/handoffs/m4-promotion.md` (owner pre-approval under the standing M4
authorization; final owner manual review pending). Packet 66. Owner
(2026-09-22): "continue until all of M4 is implemented — do not stop until
it is finished."

**Acceptance rows:** C08 (independent game + its engine copy), C12 (exact
pins + build-only-vs-runtime boundary + no new dependencies).

## 0. Framing

The independent game (m4-plan §2.3) gets a **local, integrity-indexed
engine kit** vendored into its own directory — using the existing
npm-workspaces toolchain internally. It is **not** a registry release, not
an SDK rewrite, and carries **no public publishing or license grant**
(m4-plan §2.3): the root workspace is `license: "UNLICENSED"`, `private:
true`; a kit of that source is for the owner's local use, and public
redistribution requires a separate license decision (recorded, not taken).

The pin is the kit **identity** — never a fabricated release tag or
version (m4-plan §2.3): the engine version stays `0.1.0` in all
`engineVersion` fields, and the kit is identified by digests (§3) because
**a commit alone cannot identify this working tree** (it is dirty: the M2/M3
tree is uncommitted — the packet's "dirty tree falsely identified by
commit" failure mode).

## 1. Kit tree (the allowlisted set — frozen for M4)

```
engine-kit/                        (vendored into the game directory)
  kit.json                         identity record (§3; the kit's own data)
  NOTICE                           license/provenance record (§8)
  package.json                     root workspace manifest (byte copy)
  package-lock.json                the EXACT lockfile (byte copy — 235 entries)
  tsconfig.base.json (+ tsconfig*.json present at the root)
  packages/**                      the 17 private workspace packages (source;
                                    NO node_modules — §4)
  tools/**                         the 4 accepted tooling scripts + their tests
                                    (check-deps, check-boundaries, typecheck,
                                    build) — the frozen build pipeline
  templates/platformer-starter/    the M4 template (packet 65: descriptor,
                                    base scene, recipe, sources, NOTICE)
  docs/contracts/**                the required contract/scan data (byte
                                    copies — the normative text the build,
                                    boundary checks and bundle scans cite)
```

**Excluded by rule** (never in a kit — the negative inventory): `node_modules/`,
`dist/`, `.git/`, `fixtures/`, `samples/`, `tests/`, user project data,
anything under a data root (`.thirdlight/` claim/ownership/marker files,
caches, backups, export outputs), credentials/tokens/origins, and any
symlink (the kit is copied as plain files; a symlink in a source directory
fails the kit assembly — §7).

The allowlist is a **closed rule** (top-level entries above; `packages/*`
limited to the 17 units of dependencies.md §2; `tools/*` limited to the 8
named files; `docs/contracts/*` limited to the files present at
kit-assembly time), evaluated by the kit assembler and the independent
checker — an extra path outside the rule is a kit defect, not a kit file.

## 2. Game layout and the pin (game.json)

```
game/
  engine-kit/                      the vendored kit (IMMUTABLE once pinned —
                                    re-hashed before every build, §7)
  data/                            the game's data root: projects/ +
                                    templates/platformer-starter/ (installed
                                    from the kit, verified)
  build/                           derived outputs (the export closure per
                                    game.json's projectId@revision)
  game.json                        the game's AUTHORITATIVE identity (owned
                                    by the game — m4-plan §2.3):
```

```json
{
  "v": 1,
  "gameId": "game-<32hex>",
  "projectId": "demo-0001",
  "template": { "templateId": "platformer-starter", "version": 1,
                "contentDigest": "<template content digest — packet 65>" },
  "enginePin": { "engineVersion": "0.1.0",
                 "kitDigest": "<kit inventory digest — §3>",
                 "lockfileDigest": "<sha256 of package-lock.json bytes>" },
  "buildEntry": "engine-kit/tools/game-build.mjs",
  "buildOutputs": "build/"
}
```

- The game owns this file (its authoritative identity + the documented
  build entry). Editing game sources never touches the kit.
- **Kit upgrade** = vendor a second kit directory + point `game.json` at the
  new identity (an explicit, future procedure); a pinned kit is never edited
  in place (a changed kit byte = `kit_tampered`, §7).
- `gamePin` mismatch (game.json's identity ≠ the vendored kit's actual
  identity) refuses the build: `game_pin_mismatch`.

## 3. Kit identity (kit.json)

```json
{
  "v": 1,
  "engineRef": { "kind": "working-tree", "recordedAt": "<date>",
                 "dirtyPathCount": 365, "note": "commit alone cannot identify
                 a dirty tree — the digests are the identity" },
  "engineVersion": "0.1.0",
  "lockfileDigest": "sha256:<64hex of package-lock.json bytes>",
  "fileCount": "<n>",
  "inventory": [ { "path": "packages/backend/package.json",
                   "byteLength": "<n>", "sha256": "<64hex>" }, … canonical
                  ascending path order … ],
  "kitDigest": "sha256:<blockDigest of the inventory minus kit.json>"
}
```

- `engineRef.kind` is `working-tree` (this M4 baseline) or `commit` (`sha`
  when the source tree is clean at assembly). A kit with `kind: "commit"`
  **still carries the full digests** — the commit is supplementary, never
  the identity (m4-plan §2.3).
- The inventory covers **every** kit file (positive inventory: §1's
  allowlist resolved against the source tree at assembly time, plus the two
  generated data files).
- `kitDigest` = the accepted block-digest rule over the canonical
  `{"path","sha256"}` rows of the **allowlisted source files only** — the
  generated data (`kit.json`, `NOTICE`) is excluded from the computation
  because it is derived (NOTICE embeds `kitDigest`); it is still a member of
  the inventory with its own verified sha256 (the same self-exclusion
  family as the template `contentDigest` — packet 65).
- Re-derivation is cheap and mandatory: every build re-hashes the vendored
  kit and compares `lockfileDigest` + `kitDigest` (§7).

## 4. node_modules and machine-dependent binaries — never vendored

The lockfile carries 25 `@esbuild/<platform>` binary packages (the esbuild
0.28.2 platform split) and other platform-bound entries: `node_modules` is
**machine-dependent and is never part of the kit**. The kit installs its
dependencies from the EXACT lockfile:

- Install command (the frozen working directory — no reliance on the
  caller's cwd, §6): `npm ci --prefix <game>/engine-kit` (lockfile-
  authoritative: **no re-resolution → a transitive floating dependency is
  impossible by construction**; any manifest/lockfile disagreement fails the
  install).
- `npm ci` fetches pinned tarballs (registry) or uses a warm cache
  (`--offline`). **Registry unavailability is a structured, documented
  failure** (`kit_install_unavailable` — the operator provides registry or a
  warm cache), never a silent skip or a partial install.
- The installed tree is verified by its lockfile identity (npm's own
  integrity hashes) — the kit's identity covers the lockfile bytes, which
  pin every transitive version + integrity.

## 5. Build-only vs runtime dependencies (C12 — exact, normalized)

| Dependency (exact pin) | Class | Where it runs / is bundled |
|---|---|---|
| `three@0.186.0` | runtime (browser) | preview, preview-m3, export bundles (the §4.2 browser graph) |
| `react@19.3.0`, `react-dom@19.3.0` | runtime (browser) | editor bundle only (decision 0001 §10 scope rule) |
| `@dimforge/rapier2d-compat@0.20.0` | runtime (browser) | preview, preview-m3, export bundles (the gameplay physics) |
| `ws@8.21.3` | runtime (node) | backend deployment bundle (bundled) |
| `@modelcontextprotocol/sdk@1.30.0` | runtime (node) | mcp-adapter bundle (bundled) |
| `esbuild@0.28.2` | **build-only at runtime** (an `exporter`/`behavior-build` *dependency*, never a browser-bundle member) | resolved from `node_modules` at export/compile time; the backend bundle keeps it **EXTERNAL** (tools/build.mjs) — present in the kit's installed tree, absent from every browser bundle |
| `typescript@5.9.3` | build-only | typecheck (the kit build pipeline) |
| `vitest@5.0.1` | build-only (test) | kit verification (the `npm test` smoke step) |

**Normalized graph paths (frozen):** the browser bundles' import graphs are
exactly the dependencies.md §4.2 sets (editor / preview / preview-m3 /
export, plus the M3 `three-adapter/gltf-loader` subpath for the M3 bundles —
packet 64 C64-6) — the accepted export.md §5.2/§5.4 scans enforce this at
every build; the Node artifacts (backend / mcp) bundle their workspace
packages with `esbuild` the only external (backend) / none (mcp). No new
graph member is introduced by the kit (M4: the three platformer packages
and game-host ride the M3 rows; nothing new).

## 6. The public Node build tool (the game's build entry)

`engine-kit/tools/game-build.mjs` — a **new reviewed tooling unit** (plain
Node, `node:*` only — **no new package, no new dependency** — C66-1). It is
the only build entry a game may document in `game.json.buildEntry`:

1. **Resolve paths from its own file location** (`import.meta.url`), never
   `process.cwd()` (the "reliance on cwd" failure mode — the engine's
   `tools/build.mjs` is cwd-rooted by design and is invoked only via
   `npm run build`, where npm fixes the working directory to the kit root;
   the game tool never invokes it with an ambient cwd).
2. **Verify the kit** (§7): re-hash the vendored tree → `kit_tampered` /
   `kit_inventory_missing`; verify `game.json.enginePin` matches →
   `game_pin_mismatch`.
3. **Install** (`npm ci --prefix <kit>`) → `kit_install_unavailable` on
   registry/cache failure (structured; the build never proceeds on a
   partial install).
4. **Build the engine** (`npm run build --prefix <kit>` = the accepted
   pipeline: check-deps → check-boundaries → typecheck → build.mjs) —
   any step's failure is the structured build failure (forbidden runtime
   imports, boundary violations, type errors — all caught here, before any
   game output exists).
5. **Install the template** into `<gameDataRoot>/templates/` (verified copy
   per packet 65 — identity mismatch refuses: `template_content_mismatch`).
6. **Export** via the kit backend: spawn the deployment bundle
   (`node <kit>/dist/backend/backend.mjs`) with the game's data root,
   `THIRDLIGHT_ENGINE_ROOT=<kit>`, an admin token and a loopback bind (all
   derived by the tool — no checkout paths, no secrets on disk), then call
   the **accepted public admin export route** (`POST
   /api/v1/admin/projects/:id/export`) — the same public surface the export
   contract defines; the game build is a build, not a protocol invention.
7. **Verify the output**: the static closure exists under
   `<game>/build/<projectId>@r<revision>/` with its metadata (the export.md
   §4 shape) — otherwise a structured export failure.

Every path the tool uses is under the game directory or derived from
explicit arguments (absolute, explicit) — **no absolute checkout path, no
symlink escape** (§7). The tool is idempotent (re-runs rebuild the same
outputs; the export metadata digest proves stability).

## 7. Path containment, tamper and forbidden content

- **Tamper:** before every build, the vendored kit is re-hashed against
  `kit.json` (digest + per-file on any digest mismatch). Any difference:
  `kit_tampered` (the build refuses; the operator re-vendors). A missing
  inventory-listed file: `kit_inventory_missing`. A lockfile whose bytes
  differ from `lockfileDigest`: `kit_lockfile_mismatch` (a "stale pin" or a
  hand-edit — refused; a clean upgrade goes through §2's explicit
  procedure).
- **Symlink escape / absolute checkout path:** the kit assembler and the
  build tool reject any symlink whose realpath leaves the game directory
  (`kit_path_rejected`), and any *functional* path reference to the original
  checkout in the kit's **generated data** (`kit.json`, `NOTICE`,
  `game.json`) (`kit_path_rejected`). The `docs/contracts/**` copies are
  byte-identical engine source: they may *record* evidence paths from the
  original machine (documentation, never resolved by the build/scan
  pipeline) — the exemption is normative here and a Q-recorded CCR (CCR-66-1);
  tampering with them is caught by the digest, so the exemption cannot
  smuggle changes.
- **Secret/license omission:** the kit's generated data and the tool source
  contain no credentials, tokens, or origin literals (the same forbidden-
  content class as export.md §5.4, applied to kit data — a violation is
  `kit_path_rejected` at assembly); `NOTICE` is REQUIRED in every kit (its
  absence: `kit_notice_missing` — the "license omission" failure mode).

## 8. License and NOTICE (no grant, no publish)

The kit `NOTICE` records, from the lockfile (never asserted beyond the
package manifests): the engine source's status (`UNLICENSED`, private —
local owner use only), the self-generated content license
(`thirdlight-sample-generated-content` — the template sources and their
NOTICE), and the table of pinned third-party dependencies with their
declared licenses (three MIT, react/react-dom MIT, ws MIT,
rapier2d-compat Apache-2.0, MCP SDK, esbuild MIT, typescript Apache-2.0,
vitest MIT — the exact per-entry license names are re-derived by the
generator from `package-lock.json` and pinned in the fixtures). **No license
grant and no public publishing** (m4-plan §2.3) — the kit mechanism exists
for the owner's local independent games; C12's "no new dependencies" is
asserted by the inventory (kit deps = the accepted pins exactly).

## 9. New error codes (closed list — kit/build-tool surface)

`kit_tampered`, `kit_inventory_missing`, `kit_lockfile_mismatch`,
`kit_install_unavailable`, `kit_path_rejected`, `kit_notice_missing`,
`game_pin_mismatch`, `template_install_mismatch` — plus the reused
`template_content_mismatch`, `content_quota_exceeded`, and every accepted
build/export code (the pipeline steps 4–7 surface their own failures
unchanged).

## 10. Owned contract diffs (Gate Q — PROPOSED)

- **C66-1 — dependencies.md (no new package/dependency + one tooling edge):**
  the kit is a data + tooling distribution of the EXISTING workspace (the
  17 units, unchanged); `tools/game-build.mjs` is a plain-Node script
  (`node:*` only) — recorded as a NEW tooling unit edge (not a package; no
  lockfile change; Q attention per the packet). Build-only vs runtime: §5's
  table is normative and replaces no accepted row (it re-states §4.2/§7).
- **C66-2 — export.md (no change, adjudicated):** the game's build entry is
  the ACCEPTED admin export route; the kit directory satisfies the
  `THIRDLIGHT_ENGINE_ROOT` requirement by shape (the installed lockfile tree
  + `packages/` + `dist/` — deployment.md's engineRoot layout); the
  §5.2/§5.3/§5.4 build/scan rules apply unchanged to kit-built exports.
- **C66-3 — workspace.md (no change, adjudicated):** the game's project
  lives under the game's data root owned by the kit's backend instance
  (the accepted workspace service, unmodified); the template operator
  (packet 65 C65-3) runs against the kit's `templates/` set; no new artifact
  class (`build/` outputs are the accepted export closure; `game.json` is
  game-owned data outside the workspace).

## 11. Isolated install/build smoke procedure (enumerated — C08/C12 evidence)

Executable by the owner / packet 75 (this packet records the procedure; its
full run is the 75 evidence on the reference device):

1. Create an UNRELATED directory (e.g. `~/tl-games/dark-rift/` — not under
   the checkout).
2. Assemble the kit from the checkout (the generator's assembly rule, §1) →
   `game/engine-kit/` (+ `kit.json` + `NOTICE`).
3. Create the project from the template (kit backend admin route — packet
   65) → `game/data/projects/<projectId>/`.
4. Write `game/game.json` (the identity, §2).
5. Run `node game/engine-kit/tools/game-build.mjs --game <gameDir>`.
6. Assert: kit digests verified; install from lockfile; the 4 browser
   bundles + 2 Node artifacts built; the export closure under `game/build/`;
   the metadata `engineVersion` = `0.1.0` + the kit identity recorded.
7. **Positive inventory:** a kit of the §1 shape passes. **Negative
   inventory:** each of — a `node_modules` directory in the kit, a symlink
   leaving the game dir, a hand-edited lockfile, a missing template blob, a
   kit assembled from a DIFFERENT tree (digest), `game.json` pointing at a
   superseded kit — fails with its exact code (§9).
8. **Cwd-independence:** the build tool run from `/`, from the game root and
   from the checkout produces identical verified outputs.

## 12. Fixtures (packet 66 — `fixtures/m4/distribution/`)

The kit **assembly specification** (the allowlist resolved against the
current tree: the exact file inventory with per-file sha256 + the
classification), the identity record (working-tree kind + digests), the
license inventory (extracted from the lockfile), the `game.json` pin cases,
the build-tool verification-order cases (step → failure code), the
cwd/symlink/absolute-path negative controls, and the positive/negative kit
inventories. The independent checker re-derives the inventory from the live
tree and asserts the negative-inventory rules (no node_modules/dist/.git/
fixtures/samples; no symlinks; no functional checkout paths in generated
data; NOTICE present).

## 13. CCRs

- **CCR-66-1** — the `docs/contracts/**` absolute-evidence-path exemption
  (documentation text, never resolved; digests still bind) — Q record.
- **CCR-66-2** — the kit assembler is a reviewed tooling script (plain
  Node) shipped with the packet-75 tooling, not a committed product package
  — Q record (the "new tooling unit edge" the packet requires).