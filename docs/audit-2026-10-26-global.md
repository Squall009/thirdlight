# Global audit, 2026-10-26

A read-only review of the whole of `main` at 595fb640. Eight reviewers each took one area: renderer, runtime/game host,
project-model, backend/commands/MCP, editor, pipeline/tools/tests, docs, and cross-package duplication. The lead
checked the high findings against the code. Nothing was run: no service, no browser, no build. Phase 42 (branch
`phase-42`) is out of scope except where its docs collide with `main`.

Findings get ids **G1…** here so they can become D-rows later. They are not in `docs/audit-2026-09-22.md` yet, because
the phase-42 branch has already taken D333–D344 there and new rows on `main` would collide at the merge.

Committed in 44.0 (2026-10-29) as phase 44's reference. The G-ids stay as they are and now live alongside the D-rows
of `docs/audit-2026-09-22.md` (which run to D415 at the start of phase 44): a G finding is cited by its G-id, and new
defects keep taking D numbers. Nothing is renumbered.

## 1. Summary

The architecture rules hold where they matter most:

- **One mutation path.** Every project change runs through the workspace's `runCommand`, and MCP only calls the
  backend over HTTP.
- **Clean export boundary.** Exported games run without the editor, the server or MCP. The exporter checks every
  bundle against an import allowlist (`exporter/src/graph.ts`).
- **No game-specific code** in the engine packages. No history comments in source. Generated files carry drift tests.
- **Shared frameworks** where it counts: one edit-mode framework, one graph editor for all graph documents, one
  dither, one A* (`block-walk.ts`), one `TerrainField`, one block DDA pick (`pickCell`).

The cost of building one phase at a time shows in four places:

1. **Copies instead of imports**, mostly because of the package boundary rules. three-adapter may not import
   project-model, so runtime relays about 53 project-model export lines (`runtime/src/index.ts:237-311`), and
   whatever is not relayed gets copied instead. Counts: `DIGEST_RE` 17 copies, `isPlainObject` about 34, SHA-256 and
   canonical JSON 3, the GLB container parser 5–7, quaternion multiply 6, seeded random and value noise 4–5,
   `deepFreeze` 9, about 21 hand-rolled LRU caches.
2. **Old formats and deprecated paths still running.** The templates are still storage v3, the manifest v1/v2
   writers survive only in tests, the scene v1/v2 branches in the renderer are dead, and the shell scene list and
   restart actions still run (the built-in title screen itself calls `newGame`).
3. **Test-only and dead code inside source:** about 540 lines in the editor session (`media.ts`,
   `property-controls.ts`), most of `scatter-shadows.ts`, the 2D outline-collider path, and about 250 of the 482
   renderer exports.
4. **The docs drift.** STATUS, the roadmap and the charter, which every agent reads first, contradict each other and
   the code. An agent reads about 400 KB before touching any code. About 100 "owner to confirm" defaults from phases
   39–42 are unanswered.

## 2. High: fix soon

| Id | Area | Finding | Evidence |
|---|---|---|---|
| G1 | export | Exports are bundled from the live working tree. The deployed service runs in this checkout, so a user's export compiles whatever an agent has uncommitted at that moment and can differ from the `dist/` that Play uses. D332 is this failure seen in a gate. **Status:** fixed b0bf56b0 (44.1b): exports bundle from `dist/export-engine/`, frozen by `npm run build`. | `backend/src/admin-routes.ts:379`, `deploy/thirdlight.service:13` |
| G2 | backend | A job-export zip written into the game folder checks only `isValidSourcePath`, not `uploadNameProblem`. A zip entry named `*.tlasset`, or named like a scene or resource file, lands in `assets/<stem>/`, and the next file check reads it as project data without any command. **Status:** fixed 6be64ef2 (44.1a). | `workspace/src/service-content.ts:464-482` vs `folder-import.ts:246` |
| G3 | backend / security | Any valid token, including another project's `authoring:` token, can list every project with its server folder path, and can probe arbitrary absolute server paths with `GET /projects/resolve?path=`. **Status:** fixed 2d85017a (44.1a): a project token sees only its own project. | `backend/src/project-routes.ts:74-130` (`openGet`) |
| G4 | model | Both starter templates are stored as storage v3 / scene schema 3. Every new project goes through the whole upgrade chain, gets checked against the old 2D-plane physics rules, and keeps project-v3, types-v2/v3 and the manifest-v1 validator alive. **Status:** fixed cb646f8d (44.2): templates are stored current and copied; the v3 code left is the upgrade-on-open path. | `templates/starter*/captured/project.json:2,6`, `workspace/src/project-create.ts:153,196`, `scene-v3.ts:977` |
| G5 | input | Two mappings for `move`/`jump`. The old side-scroller channels (`mapRawStep`) run on every sample, and `toActionFrame` overrides the generic evaluator's `jump` (and its `move` unless `move2d`), so bindings and processors on those two actions may be bypassed. Inferred from the code, not observed. **Status:** fixed 1e1b2680 (44.6c): reproduced (a `scale` on move read 1); move and jump now come from the action evaluator only, and the raw-snapshot mapping, its step source and fixtures are gone. | `input/src/browser.ts:476-509`, `mapping.ts:44-57` |
| G6 | size | Several files are close to the 2,000-line limit and must be split before their next change: `commands/types.ts` 1,983, `game-host/host.ts` 1,919, `backend/content.ts` 1,917, `three-adapter/material-graph.ts` 1,873, `commands/validate-request.ts` 1,843, `workspace/content-store.ts` 1,834. `TerrainView` (85 members) and `BlockLayerView` (84) are over the 80-member class limit but not on the ratchet. **Status:** fixed 167a4028–271d3c69 (44.9): the six files split by area into eight modules (largest now 1,526 lines); `TerrainView` and `BlockLayerView` were already on the ratchet (since 39b.1). | `tools/check-size.mjs --near` |

## 3. Medium

**Rules**
- **G7: per-project count caps that AGENTS.md forbids:**
  - `MODE_LIMITS.modes` 16 and `behaviorGroups` 32 (`modes.ts:162,176`);
  - `MAX_INPUT_ACTIONS` 64 and `MAX_INPUT_MAPS` 8 (`input.ts:95,60`);
  - `BLOCK_LIMITS.cellFields` 32 (`block-layers.ts:764`).

  `tests/count-caps.test.ts` matches names, so it misses all of them. **Status:** fixed 89816355 (44.8): the four
  are lifted (the whole list is one command, bounded by its bytes); the test now finds caps by shape and found three
  more (D420); `cellFields` is left for 48.
- **G8: selection-sized caps.** `MOVE_ENTITIES_MAX` 64 and `PASTE_ENTITIES_MAX` 256 are applied to whole editor
  selections, which are not split (`validate-request.ts:130`, `paste-ops.ts:23`, `useSceneEditing.ts:135,157,231`).
  **Status:** fixed f314e909 (44.8): no undo group exists, so both counts went; the request's bytes bound them.
- **G9: missing upgrade-checklist entries.** These private three.js hooks are not in
  `docs/three-upgrade-checklist.md`:
  - `see-through.ts:1490` wraps `setupObserver` (with no guard);
  - `local-lights.ts:118,165` wraps `renderObject` and uses `_listeners`;
  - `post-ao.ts:146` calls `library.addLight`;
  - `post-upscale.ts:67-85` patches FSR and SMAA;
  - `block-ao-lighting.ts:24`, `mesh-decals.ts:161` and `terrain-view.ts:1306` use builder internals.

**Parallel paths**
- **G10: three dispatchers per op.** Every op has three hand-written dispatchers: `applyMutation` (`apply.ts:250`),
  `applyInverse` (`history.ts:288`) and `applyForward` (`history.ts:796`). Adding an op takes three matching edits,
  and nothing catches a missing one. **Status:** fixed 9bcac089 (44.6a): one op table, a family module per area holds each op's step, undo and redo; `op-table.test.ts` checks every op.
- **G11: two routes for accept/discard of external edits.** `/admin/.../(accept|discard)-external`
  (`admin-routes.ts:282`) does not send the `workspace.resync` that the project route sends (`external-edits.ts:64`). **Status:** fixed fbbebece (44.6a): both routes take external-edits' one resolve step.
- **G12: three copies of hold → inspect → publish.** The content routes, the file check (`asset-files.ts:167`) and
  packs (`packs.ts:246`) each do it, and texture extraction runs only in the HTTP command route
  (`session-routes.ts:228-271`). **Status:** fixed f1eee815 (44.6a): one publish step (`extractForPublish`) for the command route, the file check and packs, and one bytes inspection (`inspectAssetBytes`) for the file check and packs; the content routes' stage inspection stays theirs (jobs, cancel), and their publish is the command route's.
- **G13: the editor re-implements backend rules:**
  - property-value checks (`property-controls.ts:117` vs `commands/properties.ts:435`);
  - prefab rules (`prefab-authoring.ts:10-21`);
  - room edits computed only in the browser (`room-draw.ts:202,408,537`), with no MCP equivalent (unverified).

  **Status:** fixed ae4ceeb7 (44.6b) for the property and prefab rules: project-model `authoring-rules` holds them, the commands and the editor call the same functions (`tests/authoring-rules.test.ts`). Room edits are architecture, left for phase 48.
- **G14: deprecated level-change and restart paths still live:**
  - shell scene list and `nextScene` (`runtime/scene-list.ts:39`, `game-host/shell.ts:325`);
  - `lifecycle.restart`;
  - `restartLevel`, `newGame` and `quitToTitle`;
  - the legacy save `world`.

  The engine's own title screen calls `newGame` (`shell.ts:401`), and Sprout still falls back to `ctx.shell`.

  **Status:** title fixed 96544a26 (44.6c): the title's confirm leaves the title into the start scenes without a restart (it never reached the shell before: the focused screen swallowed it). The deprecated paths stay until the games drop them.
- **G15: two ways to publish a script.** `BehaviorPanel` still has a raw-JSON publish UI in Project Settings, and its
  header claims to be the Script tab, which is now `ScriptDocument` (`BehaviorPanel.tsx:13,153`). **Status:** fixed 7b1f7092 (44.6b): the raw-JSON source panel and its state machine are gone; Project Settings → Scripts lists, declares and creates, the Script tab publishes.
- **G16: about 6 commit-on-Enter/blur inputs** that disagree on clamping, rejecting and Escape (`GraphInspector.tsx:212`,
  `TrimSheetTable.tsx:244`, `AnimatorInspector.tsx:479`, `Inspector.tsx:184`, `DescriptorFields.tsx:95`). **Status:** fixed 8f130267 (44.6b): one `CommitField`/`NumberField` (Enter/blur commits, Escape reverts, out of range refused or clamped per field) in these five and the UI editor's and lighting panel's boxes.
- **G17: renderer copy-paste:**
  - a page-flag parser copied 13 times (`*FromUrl`);
  - the material-variant-per-draw machinery copied twice (`local-lights.ts:111` / `projected-decals.ts:527`);
  - three identical raw-data-texture node classes;
  - three `setupObserver` wrappers, whose install order depends on which feature runs first;
  - the LOD pick loop inlined twice instead of calling `pickLodLevel` (`instance-lod.ts:222`, `copies-gpu.ts:680`).

**Dead code**
- **G18: dead and test-only code:**
  - three-adapter: the scene v1/v2 path (`adapter.ts:131` `isV3` is always true, `lights-shadows.ts:345-551`) and most
    of `scatter-shadows.ts` (lines 29, 71-107);
  - editor: `session/media.ts:86-418` and `property-controls.ts:452-662` are test-only, and the 2D outline collider
    (`useEntityEditing.ts:211`, `outline.ts`) is unreachable;
  - project-model: `captureManifest` and `captureManifestV2` are test-only (`captureManifest` retired ef3f6d99, 44.2; `captureManifestV2` kept as the v4 reader's test writer, see the 44.2 decision);
  - workspace: the `LEGACY_SESSION_PAGE` branch (`full-state.ts:27`) and `envelopeBytes` (retired bf1faada, 44.2).
  **Status:** fixed (44.7: 53171674 the v1/v2 light branch, 417d32ea the editor's test-only planners and the outline
  collider). `scatter-shadows.ts` is a scatter path and left for 48; `captureManifestV2` as in 44.2.
- **G19: the early demo module is still the default module set** (`runtime/runtime-config.ts:19`), together with the
  old module shape and `legacyTransformOwners` it needs.
  **Status:** fixed (44.7: 45a2e775): no default modules, the demo, its module id and `legacyTransformOwners` gone; a
  module without phases may no longer join a phased set. The phase-less shape stays for a set of its own (the plain
  step, which a game with no modules runs); the protocol's `demo` play option is accepted and ignored.

**Constants**
- **G20: constants and lists copied across packages**, each needing one owner:
  - `DIRECTIONAL_SHADOW_DEFAULTS`, `SURFACE_PRESETS` (3 copies), `ANIMATION_ROLE_KEYS` (4), `REQUEST_ID_RE` (3);
  - the manifest identity (`project-model/manifest.ts` and `protocol/delivery.ts`), `ENGINE_VERSION`,
    `PROJECT_SAVE_FORMAT`, `MESSAGE_LIMIT`, `MOVE_QUANTUM` and `quantizeMove`;
  - the import extension map (`editor/session/media.ts:18` vs `workspace/content-store.ts:1203`);
  - the toolchain pins (`behavior-build/limits.ts:29`, `manifest*.ts`, `check-deps.mjs:37`);
  - `SHELL_SCREENS` and `ENGINE_ACTIONS` (`UiFields.tsx:346`);
  - the module ids typed as strings (`game-host/host.ts:660-702`).
  **Status:** fixed (44.5: 3f9764bd, 4558f922, cf3d1c6b, d50ef8ac, 73429812, 844c2bb6; `REQUEST_ID_RE` in 44.4b): each has one owner in project-model, and the redefinition check owns the names; tools/check-deps.mjs checks the recorded toolchain against the pins.

**Tooling**
- **G21: misleading perf metrics:**
  - `frame-probe` `info` is labelled per frame but counts since page start (`frame-probe.ts:42,240`);
  - `instancedMeshes`/`batchedMeshes` always read 0 because the engine draws its own instances
    (`frame-probe.ts:226`);
  - indirect draws count 0 triangles (`instrument.ts:437`);
  - the vitest perf baseline is SwiftShader/WebGL 2 from 2026-09-28 (`tests/perf/baseline.json`).
- **G22: `gate.sh rerun` re-runs only the build and the last failed e2e**, not lint or vitest
  (`tools/gate.sh:203-212`).

## 4. Low (batch them)

- **Duplicated algorithms.** One home each in project-model would delete about 100 copies (44.3: generic ones get the
  `@thirdlight/shared` leaf, a build check stops new copies, today's 163 are on its ratchet list; 44.4a moved SHA-256, canonical JSON, GLB/PNG/KTX2/CRC-32, quat/mat4, random and noise: 82 left; 44.4b moved the rest below, 23 left, 20 of them in retired areas):
  - SHA-256 and canonical JSON (`asset-pipeline/sha256.ts`, `behavior-build/canonical.ts`);
  - the GLB container parser (5–7 sites);
  - KTX2 and PNG signatures, encoders, CRC-32;
  - quaternion and mat4 helpers;
  - mulberry32 and value noise;
  - `isPlainObject`, `deepFreeze`, `utf8Length`, a bounded LRU, a strict JSON parser;
  - the error constructors shared by commands and workspace.
- **Version naming.** `*V2`/`*V3` names mean the current format (`ProjectManifestV2` = schema 8). There are 62
  `version === 3|4` forks, and `KNOWN_VERSIONS` in `errors.ts:162` is wrong.
- **Milestone names in identifiers:** `M2_*`, `*M3`, `export-bootstrap-m3.ts`, `preview-m3.ts`, `m23-*` test
  folders. 36 "M1/M2" mentions in runtime comments slip past `history-comments.mjs`. (44.7: `export-bootstrap.ts`
  and the m23 folders renamed; left: `preview-m3` (the served bundle's name), `play-m3.ts`, `export-m3.ts`,
  `protocol/m3.ts`, the `M2_*`/`M3_*` constants and `*M3` functions, `isM2`, the other `m<N>-` folders.)
- **Public surfaces wider than their users.** About 250 three-adapter exports, about 273 runtime and 187 game-host
  exports, and about 45 commands exports are imported nowhere outside their package.
- **Stale rules and tools:**
  - `check-boundaries.mjs:415` names the removed `export-bootstrap.ts` (fixed 51e6cf83, 44.3);
  - the unused `tools/dev/*` (removed 3446265a, 44.7);
  - `generate-phase9-icons.sh`, which writes to `/tmp` (removed 3446265a);
  - a committed `tools/__pycache__/*.pyc` (removed and ignored 3446265a);
  - `character.glb` committed twice in the templates (fixed cb646f8d: the 3D starter links to the 2D starter's file);
  - `package.json` dependencies left out by exporter, game-host and physics-rapier.
- **Tests:**
  - 24 package tests default to `/tmp` (`TMPDIR ?? '/tmp'`) (fixed 494d1877, 44.7: `testTempBase()`);
  - four env-gated e2e files run in no gate (5349b08b: by-hand, editor-look and perf-harness removed; the
    editor-workers measuring windows stay, the file runs in every gate);
  - `job-export-import.e2e.ts` needs no browser and belongs in vitest (moved 616f98a1);
  - `tests/evaluations/m3-browser` is a packet-era leftover (removed 5349b08b).
- **Small items:**
  - `copies-gpu.ts:74` silently caps LOD levels at 8 per group (unverified against the model);
  - the editor disables "Directional light" when any open scene has one (`menus.ts:78`);
  - "New project…" and "Open project…" do the same thing;
  - about 25 hand-rolled localStorage try/catch blocks;
  - the 1e5 and 1e6 world-extent bounds differ (`architecture.ts:37`, `spline.ts:29` vs `validate.ts:44`).

## 5. Docs

**Outdated**
- `STATUS.md`:
  - the header says "Updated 2026-09-24, phases 14–22";
  - the verdict row says "28b onward wait for the owner";
  - the defect counts are wrong (the table holds 94 open, 10 watch, 212 fixed, 13 superseded, 3 won't fix);
  - rows still call D52, D57–D59, D83, D84, D145, D148, D150, D227, D281, D67, D90, D182 and D253 open, though all
    have since been fixed, superseded or closed as won't fix;
  - row 8 still says "mostly done";
  - row 42 says "planned".
- The charter (`architecture/charter.md:3`) says "Planning draft; no implementation started". Its deferred list, its
  §6 physics choice and its §11 are all past.
- `environment.md` is a 2026-09-16 snapshot: it says no GPU, 6 CPUs and the pi-web harness, and names files that do
  not exist.
- Decisions 0002–0005: 0005 is "binding until phase 41", which is done. 0002–0004 cite `docs/handoffs/` and
  `docs/contracts/`, which do not exist.
- `audit-engine-game-separation.md:6` names `packages/character`, which is gone.
- D138, D212, D213, D292 and D301 cite removed files or the removed "2D project" kind.

**Contradictions**
- When the full gate runs: AGENTS.md says once per phase; the roadmap and plan-14 §3 say per item.
- Sprout commits: AGENTS.md says the game repos are never edited from here; the roadmap says "commit there".
- STATUS line 7 says a row is done only after the owner's look, yet 35 rows say "done, owner look pending".
- Each phase's goal is kept in three places (roadmap, STATUS, plan) and they drift.
- The roadmap's order table has no rows for 28c and 37.

**Defect list:** 332 rows (D1–D332).
- 94 open (23 M, 71 L) and 10 watch.
- No commit has ever cited 30 of the open rows.
- D33 has one sighting in 30 days and its evidence is gone; close it.
- Eight rows are feature requests: D146, D166, D203, D204, D205, D231, D286, D301.
- About 17 rows are missed soft performance targets.
- 14 rows bundle review leftovers.

**Unanswered owner defaults:** about 100 on `main`. Approximate counts per phase:

| Phase | 39 | 39b | 39c | 40 | 41 | 42 |
|---|---|---|---|---|---|---|
| Unanswered | 6 | ~25 | 19 | 25 | 23 | 3 (8 on the branch) |

The ones with the most effect:
- 41: upgraded 2D projects get the Z plane and the arcade profile; every mesh collider is two-sided.
- 40: clouds are on in every procedural sky, existing projects included.
- 39b: old formats are refused.
- 39c: prefab edit mode works in the scene.

**Sprawl:** `docs/` is 6.1 MB. The audit list alone is 236 KB, STATUS 107 KB (one row is 12 KB), and 34 plan files
add up to 2.3 MB. The manual is accurate and its reference is generated and checked.

## 6. Recommended order

1. **Safety, small:**
   - G2: apply `uploadNameProblem` in `writeAssetFolder`;
   - G3: scope `GET /projects` and `/projects/resolve` to admin, or to the token's project;
   - G1: bundle exports from a built, frozen copy, not the live tree.
2. **Docs reset, no code:**
   - STATUS rows cut to two lines with the current counts;
   - the roadmap's "How every phase is worked" replaced by a pointer to AGENTS.md;
   - charter §1/§3/§11 and `environment.md` brought up to date or archived;
   - plans 9 and 14–38 archived after their work rules move into AGENTS.md;
   - the defect list split into open and closed;
   - one owner session for the ~100 unanswered defaults.
3. **Consolidation phase (39b-style), after 42 merges:**
   - G4 (templates to the current format, then retire the v3 paths);
   - G18/G19 (dead code);
   - G20 and the low duplicate algorithms through one "shared" set of project-model subpaths;
   - G10 (each op's forward, inverse and redo in one place);
   - G6 splits;
   - G7 and G8 caps (decide or lift);
   - G9 checklist entries;
   - G21 and G22 tooling.

   The root fix for the copies is a boundary rule: let three-adapter take a value edge to project-model (or a narrow
   shared subpath). That stops runtime acting as a relay.
4. **G5 and G14:** fold the input character channels into the action evaluator. Move the built-in title screen off
   `newGame`, then remove the deprecated level-change paths once Sprout drops its `ctx.shell` fallback.
