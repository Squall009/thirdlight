# Phase 44 — Consolidation after the lighting phases

Status: **in progress** (planned in the owner session of 2026-10-28; started 2026-10-29 at fb338eab, the end of
phase 43). 44.0 committed this plan and the global audit.

Goal: pay down the debt found by the global audit (`docs/audit-2026-10-26-global.md`, findings G1–G22) and reset the
docs, without adding features. The result is a smaller, stricter codebase for the voxel phases (45–49,
`docs/plan-phase-45.md`) to build on. Read `AGENTS.md` and the audit first.

## 1. Owner decisions (2026-10-26 to 2026-10-28)

- **Consolidation comes after 43, before the voxel work** (owner, 2026-10-26).
- **Leave block-layer, terrain and generated-architecture internals alone** wherever phase 48 retires them: their
  meshing, storage, sculpt/paint/scatter paths, the architecture generator's mesh and collider code, and their e2e
  specs. Change them only if a game needs a fix now. Work on code that phase 48 deletes is wasted. (Owner, 2026-10-28,
  relayed earlier as the memory note "phase44-voxel-scope".)
- **Duplicate helpers get one home, and a build check stops copies coming back** (owner, 2026-10-26):
  - generic helpers go into one zero-dependency leaf package;
  - domain constants stay in project-model, and three-adapter gets a value edge to its constants and limits;
  - the build fails when an owned name is redefined elsewhere, with existing copies on a ratchet list that only
    shrinks;
  - AGENTS.md gains a line: "If you can't import something, change the boundary rule in its own commit; never copy."
- **Docs stay current on every commit without growing** (owner, 2026-10-26). A build check enforces size limits on
  STATUS rows and plan progress rows, the same way `check-size` does for code.
- **Unanswered "owner to confirm" defaults count as approved** (owner, 2026-10-26). About 100 in plans 39–42 are
  recorded as approved in one place. Changes come back as new requests when a game runs into one.
- **Not in this phase:** release packaging and a local install (shelved by the owner, 2026-10-27), cross-browser
  testing, the memory-leak re-sweep, and any change to game repos.

Owner to decide (default used if the phase starts without an answer):
- **Commit the global audit:** default yes, in 44.0, as the phase's reference (done; default chosen, owner to
  confirm). `docs/plan-phase-45.md` is already committed (e52e891d) and is read-only during 44.

## 2. Items

Work through the items in order. Run the fast gate per commit. Each helper family or finding is its own commit, so a
regression points at its cause.

| Item | What |
|---|---|
| 44.0 | **Start.** Check for a newer three.js release (checklist). Commit this plan and, per the default, the audit. Record the full gate's time and memory peak from the end of 43 as this phase's baseline. |
| 44.1 | **Safety fixes (audit high).** G2: `writeAssetFolder` applies `uploadNameProblem`. G3: `GET /projects` and `/projects/resolve` limited to admin, or to the token's own project. G1: exports bundle from the built, frozen engine, not the live working tree (also closes D332's cause). One test each, at the HTTP boundary. |
| 44.2 | **Templates in the current format (G4).** Store both starter templates as current storage and schema versions. Then retire whatever only they kept alive: the v3 project and scene validation used for new projects, the manifest v1/v2 writers (test-only), and the `LEGACY_SESSION_PAGE` branch. Keep only upgrade-on-open code that real projects still need. |
| 44.3 | **The shared leaf package and the redefinition check.** Create the package and change the boundary rules (three-adapter value edge to project-model constants and limits; runtime stops relaying them). Add the build check with its ratchet. Byte-identical tests come **before** any move for SHA-256 and canonical JSON (content digests must not change) and for the seeded random and noise functions (saved worlds must not shift). Copies that differ are kept as named variants, not "fixed". |
| 44.4 | **Helper families moved, one commit each:** SHA-256 and canonical JSON; GLB, KTX2 and PNG readers and CRC-32; quaternion and matrix math; random and noise; `isPlainObject`, `deepFreeze`, `utf8Length`, `DIGEST_RE`, `REQUEST_ID_RE`; a bounded LRU; strict JSON parsing; the error constructors shared by commands and workspace. Files in the retired areas keep their copies; the ratchet lists them and phase 48 deletes them. |
| 44.5 | **Constants and lists with one owner (G20):** shadow defaults, surface presets, animation roles, manifest identity, `ENGINE_VERSION`, save format, message limit, move quantum, the import extension map, toolchain pins, shell screens and engine actions, and module ids. |
| 44.6 | **Parallel paths (G10–G16, outside the retired areas).** G10: each op's forward, inverse and redo in one module. G11: the admin accept/discard routes send `workspace.resync`. G12: one shared "hold, inspect, publish" step. G13: the property and prefab rules move into project-model and the editor uses them (room editing is architecture, so it is left for 48). G15: retire the raw-JSON script publish panel. G16: one commit-on-Enter/blur field. G5: fold the input character channels into the action evaluator. G14: the built-in title screen stops calling `newGame`; the deprecated paths stay until the games drop them. |
| 44.7 | **Dead and test-only code (G18, G19), outside the retired areas:** the scene v1/v2 renderer branch; the test-only parts of `session/media.ts` and `property-controls.ts`; the 2D outline collider; the demo module as a default; the stale boundary rule; `tools/dev/*`; the committed `.pyc`; package tests that default to `/tmp`. |
| 44.8 | **Caps (G7, G8).** Lift or justify the per-project caps on modes, behaviour groups, input actions and input maps, and extend the cap test so it can catch them (the block `cellFields` cap is left for 48). Selection-sized caps: the editor splits large moves and pastes into several commands, or the caps are raised to the request size limit. |
| 44.9 | **Size splits (G6), outside the retired areas:** `commands/types.ts`, `game-host/host.ts`, `backend/content.ts`, `three-adapter/material-graph.ts`, `commands/validate-request.ts`, `workspace/content-store.ts`. Split before they grow; the ratchet only shrinks. |
| 44.10 | **Tooling (G9, G21, G22):** add the missing private three.js hooks to the upgrade checklist; fix the perf probe's counters (per-frame `info`, the engine's own instancing, indirect draws); make `gate.sh rerun` re-run lint and vitest when those failed. |
| 44.11 | **Docs reset.** STATUS: header, defect counts, two-line rows. Roadmap: "How every phase is worked" replaced by a pointer to AGENTS.md; Future list updated (water and the voxel phases). Charter: current status, built features out of the deferred list, §11 dropped. `environment.md` corrected or archived. Decisions 0002–0005 get superseded notes. The work rules from plans 9 and 14 move into AGENTS.md, then plans 9 and 14–38 move to `archive/` with `git mv`. The defect list is split into open and closed. The roughly 100 open defaults are recorded as approved. |
| 44.12 | **Docs-on-commit check** in `npm run build`: a STATUS row or plan progress row longer than its limit (e.g. two lines or about 400 characters) fails the build, with a ratchet for today's long rows. Add the AGENTS.md lines (boundary rule; game answers go in `docs/requests/<game>-<date>.md`; a branch reserves a block of D numbers). |
| 44.13 | **Close.** Full gate (detached), with its time and memory against 44.0's baseline. Fewer lines and files is the expected outcome; record the counts. Then the phase review, then review fixes. |

## 3. Progress

| Item | Status |
|---|---|
| 44.0 | done (ece9b2ab + this row): three.js 0.186.1 is still the newest (npm, 2026-10-29), no upgrade; plan and audit committed; baselines in **44.0 baseline**; D413 closed (WebGL 2 walkers' shadow cost +0.67 / +1.03 → +0.20 / +0.23 ms, low / medium). |
| 44.1a | done: G2 job-export zips refuse names an upload may not have (6be64ef2; writeAssetFolder's body moved to folder-import, contentOps 443 → 421 lines); G3 project list and resolve scoped (2d85017a; MCP adapter's message for a refused project token). Vitest over HTTP; no e2e touched; fast gates green (one D311 watch miss, passed alone). |
| 44.1b | done: G1 exports bundle from `dist/export-engine/`, the engine sources `npm run build` freezes beside Play's bundles (b0bf56b0; D332's cause). Exports byte-identical bar capture time; export ms 1300/1229/1601 → 1362/1262/1566 (side view/3D/village, noise); code size unchanged; +13 MB in dist. New vitest over HTTP with a broken live tree; e2e play-export 5.9 → 5.7 s, shell-scenes 6.9 → 7.1 s, job-export-import 1.7 → 1.7 s. Fast gate green (D311 watch miss, passed alone). |
| 44.2 | done: G4 templates stored current (cb646f8d: schema 8 / storage 5+4 as game folders, made once by the engine's own creation path; new project = copy, no upgrade; 3D character a link, not a 2nd copy), legacy session page + `envelopeBytes` field (bf1faada), v1 `captureManifest` (ef3f6d99). Code −866 / +220 lines (tests included), one module gone. New vitest over HTTP: each template's project opens with nothing upgraded. e2e projects 17.2 → 16.5 s, starter-game 6.4 → 6.7, starter-capabilities 17.9 → 17.5, folder-projects 9.8 → 10.1, instance-brush 38.8 → 38.5. Fast gates green (one D307 watch miss, passed alone). |
| 44.3 | done: leaf `@thirdlight/shared` (20624218), every package may import it (40ade512), three-adapter value edge to project-model (4b1341ff: 412 of 657 runtime relays gone, runtime index −232 lines), stale export-bootstrap rule (51e6cf83); goldens before any move (895a351d); `check-redefinitions` in the build (a6887409): ratchet starts at **163** copies, 15 retired; AGENTS line (059b4bca). e2e play-export 5.7 → 5.3 s. Fast gates green. |
| 44.4a | done: shared leaf owns SHA-256 + canonical JSON (51013afc: 34 copies, −1000/+626 lines, ratchet 163 → 129), GLB/PNG/KTX2/CRC-32 (94797c66: 18 named + ~35 inline writers/readers, −934/+413, → 111), quaternion/mat4 (f9936e96: 9, −270/+215, → 102), random/noise (67796e74: 20, −369/+272, → 82); goldens unchanged. e2e play-export 5.3 → 4.7 s; village at the cap unchanged. Fast gates green (v4-limits timed out once under load, passed alone). |
| 44.4b | done: objects/utf8 (5cbcf50e: 85 copies, −870/+719, ratchet 82 → 40), digest + request id (2f9a728a rule, fae753d6: 41 copies incl. 20 inline literals, −102/+85, → 25), LruCache (4b7c8cb7: 5 LRUs, −42/+90), strict JSON (aa69ea2c: 4 parsers + 6 pointer escapes, −843/+370, → 23; 200k-text differential identical), errors (74d5dca2: 2 copies, 5 named variants). e2e play-export 4.7 → 4.9 s. Fast gates green (D307 watch miss, passed alone). |
| 44.5 | done: one owner each in project-model, 12 families in `check-redefinitions`: shadow/surface/role lists (3f9764bd, 9 copies, +32/−117), manifest identity, engine version, save format, message clip, move quantum (4558f922, 17, +85/−152), import extensions (cf3d1c6b, 8, +63/−55), toolchain pins + check-deps agreement (d50ef8ac, 7, +64/−8), engine actions/shell screens/save slots (73429812, 4, +17/−11), typed module ids (844c2bb6, 25 literals, +76/−36). e2e s: play-export 4.9 → 5.1, input 11.6 → 11.6, project-saves 9.0 → 7.9 (alone, WebGL 2), import-extensions 19.8 → 19.2, folder-import 3.2 → 3.3, ui-editor 10.3 → 10.4, shell 17.0 → 16.5, character-3d 15.4 → 15.1; village at the cap unchanged. Fast gates green (start.e2e's stop exited 1 once, D307 once; both passed alone). |
| 44.6a | done: G10 op table (9bcac089: 7 family modules hold each op's step, undo and redo; apply.ts + history.ts 2,174 → 484 lines, 2,232 with the families; 3 ratchet entries gone; 3,979 traced commands byte-identical), G11 admin accept/discard resync (fbbebece), G12 one publish step (f1eee815: packs and the file check extract as uploads do). e2e s: authoring-loop 1.9–4.0, hierarchy 7.2, delete-content 5.6, edit-copy 2.9, project-window 3.4–4.9, loadable 3.4, external-edit 4.3/1.9, editor-chrome 6.3, assets 16.9, asset-files 5.0, folder-assets 17.4, import-extensions 19.8 (19.2 at 44.5); village at the cap unchanged. Fast gates green (start.e2e watch miss once, passed alone). |
| 44.6b | done: G13 one set of authoring rules (682a9094 rule, ae4ceeb7: project-model `authoring-rules` = property value rule, prefab subtree/external ref, transform check, name rule; commands and editor call them, code −461/+311), G15 raw-JSON publish panel retired (7b1f7092, −499/+95, useScripting off the size ratchet), G16 one `CommitField`/`NumberField` in 7 editors (8f130267, −235/+185). Room drawing left for 48. e2e s (43 full → 44.6b): inspector 14.9 → 15.2 (with the Escape/blur step), animator 10.5 → 10.4 (with the clamp step), graph 14.7 → 13.9, lightmaps 60.6 → 56.1, ui-editor 10.3 → 10.2, script-properties 7.7 → 7.3, project-settings 4.1 → 4.9, script-editor 10.7 → 11.0, project-window 15.0 → 13.1; village at the cap unchanged. Fast gates green (D307 watch miss once, passed alone). |
| 44.6c | done: G5 (1e1b2680: bypass reproduced, a `scale` on move read 1; move/jump only from the action evaluator, fresh activation and consumed-confirm rules moved into it; raw-snapshot mapping, step source and m2 input fixtures gone, −2491/+221; frame v2 unchanged), G14 (96544a26: title confirm plays the start scenes, no `newGame`; a screen with nothing to focus passes the confirm on). e2e s: starter-game 6.7 → 6.3 (Enter + no-deprecation check), shell 16.5 → 16.2, input/rebind/relay/replay/playtest/sim-worker/character-3d untouched; village at the cap unchanged. Fast gates green (D311 watch miss once, passed alone). |
| 44.7 | done: G18 v1/v2 lights (53171674, −32/+13), editor test-only planners + 2D outline collider (417d32ea, −1179/+21, 1 module), G19 demo module (45a2e775, −365/+88), tools/dev + phase-9 icons + .pyc (3446265a, 5 files), `testTempBase()` for 23 tests (494d1877), m3-browser + by-hand/editor-look/perf-harness e2e (5349b08b, −1505), job-export to vitest (616f98a1), 3D starter pack reproduced (834b264c), renames (7f7bbf45, e2545add). e2e s: lights 27.0, character-3d 11.9, colliders 6.2, starter-capabilities 17.5, job-export-import 1.7 → 0 (vitest); village at the cap unchanged. Fast gates green (two vitest misses under load, passed alone: D418, D419). |
| 44.8 | done: G7 (89816355: no count of modes, behaviour groups, input actions, maps, glyphs; input settings ≤ one request's 64 KiB, frames carry the derived 1,236 actions; count-caps test finds caps by shape, catches the four on a scratch revert, found D420), G8 (f314e909: move/paste counts gone, request bytes bound them). e2e s: count-caps 22.8 → 22.7, edit-copy 2.6 → 3.8 (270-object step), game-modes 8.4/4.9 → 8.5/4.7, input 5.1/2.9/3.6 → 5.2/2.7/3.6, hierarchy 6.9 → 7.2; village at the cap unchanged. Fast gates green (D417 watch miss once, passed alone). |
| 44.8b | done: D420 (2c3db8df: no count of `shell.hud`, save settings fields, save migrations; one command's bytes bound them; runtime stored-settings key count dropped; cap test's not-yet-lifted list gone). e2e s: shell 7.9 → 7.6 (20 HUD docs in Play), project-saves 9.0 → 8.1 (81 settings fields, Play/reload/export; runs only with TL_E2E_ALL_VARIANTS=1 on a GPU host, run alone), ui-editor 7.8/2.7 → 7.9/2.7, count-caps 22.7 → 22.5. Fast gate green; village at the cap unchanged. |
| 44.9 | done (167a4028–271d3c69, pure moves, one commit per file): lines types 1,983 → 906, validate-request 1,813 → 1,120, material-graph 1,914 → 1,521, host 1,913 → 1,469, content 1,866 → 1,526, content-store 1,824 → 1,310 (+8 modules). Ratchet 35 → 35. e2e s: material-graph-render 4.8 → 4.7, folder-import 3.3 → 3.2, play-export, assets, asset-files unchanged. Fast gates green; village at the cap unchanged. |
| 44.10 | done: G9 (a4fa4136: 75 hook sites the checklist missed, 196 in all, now in rows; `tools/three-hooks.mjs` lists them with file:line, its test fails on a new one; see-through's `setupObserver` wrap guarded; terrain-view's builder use is gone), G21 (33bb7921: probe `info` per frame, village 208 calls/123k tris; instanced 0 → 237, batched 0 → 255; indirect draws counted apart; SwiftShader baseline + opt-in test retired), G22 (107dd94b: rerun from the failed step, tried lint → vitest → green), perf CLI (64247a97: `--help`, memory-cap refusal). No e2e touched; fast gate green, village at the cap unchanged (D419 again once). |
| 44.11 | done (23838ca9 … fbac056b, then the defect split): STATUS 108.7 → 8.8 KB, two-line rows; roadmap, charter, environment, decisions 0002–0005 current; plans 9, 14–38 → `archive/plans/`, rules → AGENTS.md Traps; 143 defaults approved (`decisions/owner-defaults.md`); defects split: 136 open+watch / 284 closed (`audit-closed.md`). docs/ 219 files 6.33 MB → 193 / 4.24 MB. |
| 44.12 | done: `tools/check-docs.mjs` in the build: a STATUS or progress row ≤ 400 characters; ratchet `tools/docs-ratchet.json` 155 rows (39–42 all, 43 19, 44.1b–44.10 14); STATUS plan links and defect lists checked (all pass). AGENTS: D blocks, closed rows, game answers. No e2e. |

### 44.0 baseline

What the end of 44 is measured against (44.13).

- **Full gate at the end of 43** (15472037, 2026-10-29): 32 min, memory peak 7.7 GB, 381 e2e, both renderers; RED (two real
  failures, D407/D408, fixed in e8c5ec3a; D409–D411 watch). Logs ~/.cache/thirdlight-logs/gate-full-20261029-132952.
- **Perf** at fb338eab: 60 Hz cap, Iris Xe, 1080p, medium tier, 2 rounds interleaved (22:10–22:54, load 1.9–4.1).
  44's end must not exceed these. GPU ms at full clock; WebGL 2 has no GPU timer.

| Scene | Renderer | p95 ms | missed | main ms | GPU ms full |
|---|---|---|---|---|---|
| village | WebGPU | 16.7 / 16.8 | 0/600, 0/600 | 5.48 / 5.51 | 5.66 / 5.68 |
| village | WebGL 2 | 16.8 / 16.7 | 0/600, 0/600 | 3.96 / 3.97 | - |
| landscape | WebGPU | 16.7 / 16.7 | 0/600, 0/600 | 4.94 / 4.88 | 10.42 / 10.44 |
| landscape | WebGL 2 | 16.7 / 16.7 | 0/600, 0/601 | 3.37 / 3.43 | - |
| interior | WebGPU | 16.7 / 16.7 | 0/600, 0/600 | 3.14 / 2.99 | 6.87 / 6.92 |
| interior | WebGL 2 | 16.7 / 16.8 | 0/600, 0/600 | 1.86 / 1.86 | - |

- **Size** (`git ls-files <dir>`, all files, `wc -l`) at fb338eab: packages 2,111 files / 518,342 lines (of which
  `.ts`/`.tsx` 1,981 / 511,165); tools 125 / 29,598; tests 474 / 99,289.
- **D413 re-measure** (`run.mjs lights --counts 64 --walkers 8 --tiers low,medium --renderers webgl2`, against
  `--shadowed 0`, same rounds as above): WebGL 2 main ms, control → walkers, low 1.41 → 1.58 / 1.39 → 1.62
  (+0.17 / +0.23), medium 1.86 → 2.00 / 1.82 → 2.13 (+0.14 / +0.31); p95 16.7–16.8, 0 missed. 43.6c read +0.67 /
  +1.03, so 5bc436c4's atlas fix took this case too.

## 4. Decision log

- 2026-10-28 (owner, planning session): plan drafted from the global audit and the owner's decisions of 2026-10-26
  to 2026-10-28 (§1). The retired-area rule comes from the voxel world plan (`docs/plan-phase-45.md` §5b, §4).
- 2026-10-29 (44.0, default chosen, owner to confirm): the global audit is committed as the phase's reference (§1's
  default); its G-ids stay and are cited beside the D-rows, nothing renumbered.
- 2026-10-29 (44.1a, default chosen, owner to confirm): G3 scope. The owner (admin) token, or a trusted network, keeps
  the full project list and folder resolve. A project-scoped token lists only its own project (as the session list
  already filters) and gets a resolve answer only for a path inside that project; any other path is a 401 with no
  reason or folder, so it cannot probe the server. The editor's picker and the MCP adapter use the owner token (or a
  project token from its own folder) and are unchanged.
- 2026-10-30 (44.2, default chosen, owner to confirm): a template is a game folder in the current format (`thirdlight/`
  + `assets/`); it is changed by making a project from it and copying its files back, so the v3 authoring scripts went
  (the build scripts keep only the generated pillar, textures, grass and setup packs). A template file that would
  overwrite a different file already in a game folder refuses the creation instead of picking a new name. Kept: the
  v3 → v4 upgrade (its validation, the old plane rules for v2/v3 documents, the empty new project built through it),
  because projects on disk may still be v3 (all four game repos are already v4); and `captureManifestV2`, the
  writer of the v4 manifests the still-live v4 reader (`readRuntimeContentSync` reads old exports) is tested with:
  retiring it means committed fixture documents for those tests, left for the version-naming cleanup.
- 2026-10-30 (44.3, default chosen, owner to confirm): the leaf is `@thirdlight/shared` (`docs/plan-phase-45.md` names
  none). Algorithms go there; domain constants stay in project-model (`DIGEST_RE` in `content-helpers.ts`,
  `REQUEST_ID_RE` in a new project-model `request-id.ts`, since commands and workspace cannot import protocol).
  three-adapter takes a value edge to all of project-model (pure, no I/O) rather than a subpath list; the 245 relays
  the editor and game host still read through the runtime stay until those edges are looked at.
- 2026-10-30 (44.3, default chosen, owner to confirm): the redefinition check matches owned names (declarations at
  any depth, aliases excluded) plus a numeric fingerprint per algorithm for renamed copies; tests and tools count.
  Copies with no shared name (the ~21 inline LRU caches, the error constructors, GLB parsing inside
  `glbClipDurations`/`scanGlbContainer`/`readContainerGuard`/`gltf-rules`) are not caught by name: 44.4 names them
  when it gives them a home. The retired marker comes from path patterns (block, terrain, architecture, arch-,
  spline-mesh), checked on every build. Variants kept apart in the goldens: canonical JSON by code point (4 copies)
  vs by UTF-16 unit (workspace, differs on astral keys) vs the exporter's indented, unsorted text; not golden-tested:
  the GPU mulberry32 (TslRng), the visual-script prelude's (source text), terrain erosion's (retired) and the
  size-only sorted copies in `timelines.ts`/`ui-documents.ts`.
- 2026-10-30 (44.4a, default chosen, owner to confirm): the backend keeps node:crypto for whole-file digests as
  `sha256HexNative` (ten times the pure hash on 64 MB, same digests, golden-tested beside it) and the zip writer uses
  node:zlib's crc32: platform calls, not copies. The quaternion product sums in three.js's order (the look-at copy's);
  camera shake, compound bounds and the physics compound top move to it (last-bit, nothing stored). One lenient GLB
  reader (first JSON object + first BIN chunk); the importer, loader guard and export scan keep their diagnostics and
  take the constants. Noise hashes stay named variants (`latticeHash`, `latticeHash4`, `seedCellHash`, `tileHash`);
  the shader copies (TslRng, material-graph `valueNoise`) stay, ground cover's shader takes the lane constants. The
  check now owns the GLB, image-signature, PNG-writer, mat4/quat and noise-hash names and the GLB JSON chunk type as
  a fingerprint. Left: the visual-script prelude's mulberry32 (source text), 44.4b's families.
- 2026-10-30 (44.4b, default chosen, owner to confirm): variants kept by name where copies differ: `isPlainObjectStrict`
  (prototype check: commands, workspace), `deepFreezeAll` (walks into frozen parents), `deepFreezeExceptViews` (workspace
  boundary), `utf8LengthPairingAnyHigh`/`utf8LengthPairingHigh` (scene and save sizes; differ only on lone high
  surrogates). Merged as equal on the data they get: deepFreeze's pre/post-order and `getOwnPropertyNames` copies, and
  the compile memo's re-set of a key two compiles finished at once. Only true LRUs moved; the 13 insertion-order (FIFO)
  caches and the type checker's file cache keep their code. Strict JSON: one parser with options (duplicates,
  after-syntax, null prototype, finite numbers, raw control characters, lone surrogates); the exporter's syntax
  messages now come from it instead of `JSON.parse` (values still `JSON.parse`'s). Digest format: project-model
  `content-helpers` and `request-id` are value subpaths for protocol, backend, MCP adapter and editor; the game host
  reads `isDigest` through the runtime. Workspace error constructors that differ from the command ones were renamed
  (`envelopeInvalidRequest`, `queryFieldUnexpected`, `queryEntityNotFound`, `behaviorPreparationUnavailable`,
  `behaviorTrustUnacknowledgedToPrepare`; `terrain-query.ts` only follows the rename). Left: retired-area copies
  (20 ratchet entries), `tools/check-deps.mjs`'s `isObj` (tools cannot import the TS leaf), the scatter drawer's
  inline digest check.
- 2026-10-30 (44.5, default chosen, owner to confirm): every G20 constant is owned by project-model, read by the packages
  that may only take its subpaths through `limits` (as `ASSET_KINDS` already was), so no boundary rule changed. Where
  copies differed: `quantizeMove` clamps to [-1, 1] (the input's and the intent commit's; the frame validator range-checks
  first, so only a direct caller of the runtime export sees it); the audio owner's message clip ends in `…` at 256 like
  every other (was `...` at 253); the UI editor offers the model's engine actions, so `cancelRebind`/`resetBindings`
  appear and `rebind` (it names an input action the field cannot pick) only for an action that already is one;
  `UI_ENGINE_ACTIONS` takes the editor's order. protocol's v1 manifest identity had no user and went. The pins stay a
  TypeScript table; `check-deps` reads its text. Kept: the v4 reader's pin table (three 0.186.0, never read for three)
  and the GLTF recipe's loader line (0.186.0: every model's recipe digest depends on it).
- 2026-10-30 (44.6a, default chosen, owner to confirm): a pack's models now take the publish step uploads take, so a new project's
  pack models record `extractTextures: true` (Basic Kit and starter-3d models hold no images, so nothing else changes), and a
  pack with an image inside brings its textures with one more command in its undo step; `packs.add`/`install` became async. The
  file check decides extraction by the shared rule (record setting or the project's "every model"), so a converted GLB with
  generated levels in an "every model" project is now extracted on re-import too. The folder import keeps its own batched
  extraction (one `importAssets` for the folder). G10's records (op → change type, inverse kind) were checked once against
  every command the suites run; the test checks each op has a step and every recorded kind an undo and a redo.
- 2026-10-30 (44.6b, default chosen, owner to confirm): G13: the commands' value rule is the one rule, so the editor no longer
  refuses a stored `entityRef`/`assetRef` that is a string but not ID-shaped (the model's validation keeps such values out of
  a project), and a placed copy's out-of-range transform shows the backend's `number_out_of_range` (was `field_value`).
  Typed input still parses as before (a reference field takes ID text only). G15: Project Settings → Scripts keeps the tiles,
  + New behavior, + Visual script, the declaration editor and the trust notice; code is published only in the Script tab.
  G16: a field shows the stored value whenever it is not being edited, so a refused or not-yet-applied commit shows the old
  value until the backend answers; Escape never commits; multi-line boxes commit on Enter (Shift+Enter is a new line), the
  graph inspector's comment box included. Out of range: refused by default, clamped where the field clamped before (animator
  state speed and transition times, lighting budgets). Fields elsewhere in the editor (about 30 files with their own
  `onBlur` commits, e.g. the color widget, brush and block panels) are not moved: block/terrain/architecture ones go in 48,
  the rest when touched.
- 2026-10-30 (44.6c, default chosen, owner to confirm): G5: `move` and `jump` read only their own bindings, like every
  action. An action with no pad binding no longer gets the standard pad layout (A jumps, D-pad and left stick move); every
  game and both templates bind their pads, and the virtual pad already read only the bindings. A tap between two samples
  now moves for one sample (it jumped already). Any pad button or stick past the dead zone wakes a pad, not only the
  move/jump controls. A consumed menu confirm still held is hidden from every action outside the `ui` map (was: jump only);
  after focus returns or the pad changes, every action already down reads `held`, then `none` on release (was: jump only).
  G14: the title's confirm (a shell title without a button) leaves the title and plays; the run behind it already is the
  start scenes (first start, or the restart `quitToTitle` made), so no reload or restart is queued. A game on the shell's
  scene list (deprecated) not at its first entry is moved there with the list's own move (`nextScene` line). A focused
  document with nothing focusable now passes the confirm to the shell (it swallowed it, so the engine title never started
  on Enter in a browser).
- 2026-10-30 (44.7, default chosen, owner to confirm): G19 kept the phase-less module shape for a set of its own (the
  plain step every game without modules runs; folding it into the phased step changes run diagnostics and timing, a
  runtime change of its own) and refuses it inside a phased set, where without the demo's transform claim it would own
  nothing. The protocol's `demo` play option (already selecting nothing) is still accepted and ignored, so MCP clients
  that send it keep working. The 3D starter's build script stays the writer of its setup pack (44.2's workflow) and the
  pack was regenerated with it (graph node positions and edge ids only). Env-gated e2e: by-hand and editor-look were
  owner-screenshot runs (graph, effect-editor and timeline e2e cover the controls) and perf-harness duplicated
  `tests/perf/regression.test.ts`; all three removed rather than added to a gate. Renamed: `export-bootstrap.ts`,
  the m23 folders; the rest of the milestone names are listed in the audit.
- 2026-10-30 (44.8, default chosen, owner to confirm): G7: game modes, behaviour groups, input actions, input maps and
  glyphs have no count, and a mode's own maps, documents and groups none either (they name distinct things the
  project has). Each whole list is one command, so the request's 64 KiB bounds it; the input settings are held to
  the same bytes on load, and the frame, snapshot, input-status and relay bounds follow from them (1,236 actions,
  derived from the smallest valid action). The environment presets' descriptor still said 64 (the validator was
  lifted earlier) and lost it. The cap test finds caps by shape (a project-wide descriptor list or map with a
  most-items bound): kept with a reason are tags (32-bit mask), collision layers (Rapier's 16 group bits), light
  layers (mask width), save sections (a fixed list) and `cellFields` (48); not yet lifted, D420: `shell.hud` 8,
  save settings fields 64, save migrations 256. G8: no undo group exists, so the editor does not split a move or a
  paste (that would make several undo steps); the counts went and the request's bytes bound them (a move names
  about 3,000 ids; a paste of large objects, e.g. 300 meshes with many components, is still refused whole for its
  bytes, with the backend's message: an undo group for split commands is the fix if a game needs it).
- 2026-10-30 (44.8b, default chosen, owner to confirm): D420: HUD documents, save settings fields and save
  migrations have no count. Each list is written whole by one command (setShell, setSaveSchema), so the request's
  64 KiB bounds it; HUD layers are made one per entry (drawn in list order), migrations are one per older version
  and run one at a time, and the settings document is read through the schema's fields, so nothing at runtime is
  sized from a fixed count. No byte check on load was added (unlike the input settings, no runtime bound derives
  from these lists). The cap test now has no not-yet-lifted list.
- 2026-10-30 (44.9): `TerrainView` (85 members) and `BlockLayerView` (84) were already on the size ratchet since 39b.1
  (G6 said not), so nothing was added; they stay unsplit as retired-area classes. A split module that needs a helper
  of its parent imports it (function-level cycles only) rather than copy it.
- 2026-10-30 (44.10, default chosen, owner to confirm): the vitest perf baseline (`tests/perf/baseline.json`,
  SwiftShader WebGL 2 relative metrics of 2026-09-28) and its opt-in `regression.test.ts` are retired rather than
  re-recorded: they were never run since, a CPU renderer's times say nothing about the GPU host, and perf is measured
  only at the 60 Hz cap, where the fast gate's village check against `village-baseline.json` is the regression gate.
  The perf runner refuses to start unless a cgroup it is in caps memory at 7 GiB or less with that room plus 2 GiB
  available (the host rule), `--no-memory-cap` to override. Node-builder members (`builder.geometry`, `.material`,
  `.context`, …) are listed as hooks: TSL leaves them undocumented and a change there fails silently.
- 2026-10-30 (44.12, default chosen, owner to confirm): a row's limit is 400 characters (code points) of its markdown
  source line, about two rendered lines; the row key is its first cell. Long rows of 39–44.10 are ratcheted, not
  rewritten. The defect check holds the closed list to closed rows and a D-number to one row; a row closed in the
  open list may wait there until the phase end (44.11's tidy rule), so it is not failed. A branch reserves D numbers
  with a `Reserved: D<first>–D<last> for branch <name>` line in the open list; none is reserved yet.
