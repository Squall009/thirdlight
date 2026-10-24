# Phase 39c — Linked prefabs

Status: planned 2026-10-22.

Goal: prefabs become linked assets, as in Unity and Godot:
- editing a prefab updates every copy, except what a copy deliberately
  overrides;
- prefabs open in their own edit mode;
- prefabs can nest and have variants;
- anything, including a player with its controller, can be a prefab.

Today's prefabs are snapshot templates: a placed copy is a plain copy that
only remembers where it came from. The October engine audit rated this "a big
gap" and the likely next blocker for games. Read `docs/roadmap.md` first.

Order: after 39b (consolidation) and before 40, which builds a placement
pipeline that can place prefabs.

## 1. Owner decisions (2026-10-22)

The owner named every one of today's problems and approved the plan:
- **Copies are linked.** A placed copy stores the prefab's id and its
  **overrides**. Editing the prefab updates every copy, except the fields a
  copy overrides.
- **Prefab edit mode:** a prefab opens on its own, in isolation, for editing.
- **An overrides UI:**
  - overridden fields are marked;
  - revert or apply works per field, per object, or for all of a copy;
  - each copy has a list of its overrides.
- **Nesting and variants.** A prefab can contain linked copies of other
  prefabs. A variant is a prefab made from a base plus overrides, and it
  follows the base.
- **Unpack** turns a copy back into plain objects, for when a game wants that.
- **Anything can be a prefab:** players with controllers, cameras, lights,
  spawn points. The "player prefab" is the normal pattern.
- **Migration keeps every look.** Existing copies become linked. Wherever a
  copy differs from today's prefab, the difference is kept as an override, and
  a Problems line lists copies that came out with overrides.

## 2. Design

### Data model

- **A prefab stays its own asset** (`assets/prefabs/<name>.prefab.json`, one
  resource per prefab, with addresses and labels as today). Default chosen,
  owner to confirm: keep the separate asset (Unity) rather than making a
  prefab a scene (Godot). That's less change to scenes, streaming and the
  editor. The behaviour is the same either way.
- **A copy** in a scene is one object carrying
  `prefab: {prefabId, overrides}`, plus any objects added to it.
- **Overrides** are a list of differences, keyed by the prefab's stable
  local ids (`localId`, never reused, as 38.6 made sure):
  - a changed component field (by its path);
  - a changed transform (on any part; the root's transform is always the
    copy's own);
  - an added component or child object;
  - a removed part.
- **Nesting.** A prefab's entity may itself be a copy of another prefab, with
  overrides. Cycles are refused (a prefab can't contain itself through any
  chain).
- **A variant** is a prefab whose root is a copy of its base with overrides.
  It's the same mechanism: a variant is a prefab made of one nested copy.

### Where copies are assembled

- **The backend assembles** prefab + overrides into ordinary objects when it
  builds a scene for Play, export or the editor's view. Assembly is recursive
  for nesting and variants. The runtime keeps seeing plain objects, exactly as
  today: no runtime cost, and determinism unchanged.
- **Ids.** An assembled part's scene id is derived from the copy's id and the
  part's local-id path. It's stable across prefab edits, so scripts, saves
  and `entityRef`s that name a part keep working.
- **Editing the prefab** reassembles every copy that uses it. The editor
  receives the changed objects through the normal change feed.
- **`ctx.spawn(prefabId)`** spawns the assembled prefab, including nesting and
  variants. Spawned copies are runtime-only, as today.

### Editing

- **One command path.** Commands for: setting or reverting an override on a
  copy's part; applying a copy's overrides to the prefab (one field, one
  object, or all); unpacking; creating a variant; nesting. MCP gets the same
  commands. Every change is one undo step.
- **Editing a copy's part** in the Scene view or Inspector writes an override,
  not a change to the prefab.
- **`updatePrefab`** (38.6) becomes "apply all overrides from this copy". The
  old command stays as an alias.
- **Prefab edit mode:**
  - double-click a prefab (Project window or a copy) to open it in the
    full-screen edit-mode shell, with only the prefab shown;
  - edits change the prefab and reach every copy;
  - Esc or Done leaves.
- **Inspector:**
  - overridden fields are marked, with right-click "Revert" and "Apply to
    prefab";
  - a copy's header shows its prefab (with variant and base), an
    **Overrides** dropdown listing every override (revert or apply each, or
    all), **Open prefab** and **Unpack**.
- **Hierarchy:** copies and their parts are marked as prefab parts. Nested
  copies show their own prefab.
- **Project window:** prefabs with thumbnails, a "Create variant" action, and
  drag into the scene to place a copy.

### What can be in a prefab

- The limits on cameras and controllers go. A prefab can hold any component a
  scene object can.
- The rules that stay are the scene's own: one active camera per view, a
  player character per controller.
- A prefab with a controller placed twice makes two players, which is
  allowed: several players per view exists since phase 28.16.

### Migration (schema 8, shared with 41's bump if both land; otherwise
additive)

- Every existing copy (`prefab: {prefabId, localId}` on its parts) becomes a
  linked copy. Its overrides are the differences between its parts and the
  prefab's current contents, so nothing changes look or behaviour.
- Parts whose prefab is gone stay plain objects, with a Problems line.
- One Problems line per copy that came out with overrides (grouped), so game
  teams can tidy them up.

### Features built on prefabs

- **Live blocks and block looks** use the assembled prefab, including nesting.
  Their existing rules stay: a live block's root may not move.
- **`ctx.decals.spawn(prefabId)`** is unchanged.
- **Phase 40's placement** can place prefabs (scatter sets of a prefab), via
  the assembled prefab.

## 3. Items

**E2E budget:** no new e2e file. The prefab editor steps extend existing
prefab e2e files (`delete-content`, the prefab authoring flow), and assembly,
overrides and migration are tested in vitest against the real workspace and
backend.

| Item | What |
|---|---|
| 39c.0 | **Release checks.** Measure first: scene build time for a scene with 1,000 copies of 10 prefabs (today, as copies), the baseline for assembly cost. |
| 39c.1 | **Data model and assembly:** the override format, linked copies, recursive assembly with nesting and variants, stable part ids, cycle refusal, and reassembly on prefab change through the change feed. Vitest at the workspace boundary. |
| 39c.2 | **Commands:** override set and revert, apply (field, object, all), unpack, create variant, nesting, and `updatePrefab` as an alias. One undo step each. MCP docs. |
| 39c.3 | **Migration:** existing copies become linked with their differences kept as overrides. A fixture shaped like each game's prefab use (spawned enemies, placed props, live blocks); looks and digests unchanged; grouped Problems lines. |
| 39c.4 | **Prefab edit mode** in the edit-mode shell: open from the Project window or a copy, edit in isolation, changes reach copies live. |
| 39c.5 | **Inspector, Hierarchy and Project window:** marked overrides, the Overrides dropdown, Open prefab, Unpack, prefab marks in the Hierarchy, thumbnails, Create variant, drag to place. |
| 39c.6 | **Anything in a prefab:** the camera and controller limits go; a player prefab placed twice makes two players; the scene's own one-camera rules apply. |
| 39c.7 | **Runtime and features:** `ctx.spawn` of nested prefabs and variants; live blocks and block looks on assembled prefabs. |
| 39c.8 | **Performance:** scene build with 1,000 linked copies within 10 % of the 39c.0 baseline. A prefab edit reaches 1,000 copies in the editor in ≤ 1 s. |
| 39c.9 | **The manual:** prefabs concept and guide rewritten (linking, overrides, edit mode, nesting, variants, unpack, the player-prefab pattern) and migration notes. |
| 39c.10 | **Acceptance** in a real browser on both renderers: make a door prefab, place five, override one's colour, edit the prefab (four change, the overridden one keeps its colour), make a "locked door" variant, nest a handle prefab, make a player prefab and Play with it. Owner look pending. Full gate, then the phase review. |
| 39c.11 | **Review fixes.** |

**Done when:**
- Copies are linked, with overrides that can be reverted and applied.
- Prefabs open in an edit mode.
- Nesting and variants work.
- A player is a prefab.
- Existing projects keep their look.
- `tools/gate.sh full --both-renderers` is green.

## 4. Progress

| Item | Status |
|---|---|
| 39c.0 | Done. three 0.186.1 and Rapier 0.21.0 are still the latest (0.21 stays planned for phase 41). Baseline (`TL_BENCH=1 npx vitest run packages/backend/src/prefab-scene-build.bench.test.ts`, 10 prefabs × 4 parts, 1,000 plain copies = 4,003 objects, medians of 5): editor view (`queryEntities`) 21 ms, Play start backend 105 ms (closure 100 ms, its scene stage 14 ms). Placing the 1,000 copies by command took 56 s. |
| 39c.1 A | Done: the link format (`prefab: {prefabId, overrides}`, overrides by part path: field set/remove, component add/remove, part removal; added objects carry `parentPart`), nested copies and variants in definitions, catalog cycle refusal (`prefab_cycle`), and `createPrefabAssembler` / `assembleSceneEntities` in project-model (flattened once per prefab, part ids `prefabPartId(copyId, path)`). Vitest at the workspace boundary (`packages/workspace/src/prefab-links.test.ts`, 3 tests). No e2e touched (`delete-content` ran in the fast gate, green; village at the cap: p95 16.7 ms, 0 missed, both renderers). `scan-bounded-log` timed out under load twice and passed alone (D307 watch). Part B (reassembly through the change feed, Play/export/editor wiring) is next. |
| 39c.1 B | Done: the backend assembles linked copies wherever it builds a scene (workspace `prefab-view.ts`, kept per session: per copy while the copy and its prefab chain are unchanged, per scene): the captured read (Play, export, every check) and the editor's `queryEntities`/`queryEntity`/full state hold plain objects with derived part ids; the spawnable prefabs ship with nested copies and variants flattened. A command's result and its `mutation.applied` carry `change.assembled` (only the copies' objects that differ, whole, and the ids gone), which the editor's projection applies; assembly problems are grouped Problems lines (`prefab_override_stale`, …). Vitest over HTTP/WS (`tests/integration/m39c-linked-prefabs`, 3 tests: editor view, Play, export, a prefab edit reaching every copy and a variant through the feed into the real projection, a deleted copy, `ctx.spawn` of a variant in the runtime). Bench (1,000 copies, medians of 5): plain copies view 19 ms / Play 107 ms, linked copies view 15 ms / Play 103 ms (baseline 21 / 105). No e2e touched. |
| 39c.2 | Done: one command path. `instantiatePrefab` places a linked copy (one stored object; its parts' ids derived; property overrides become field overrides). Any command naming a copy's part (setComponent, setBehaviorProperties, setTransform, updateEntity, createEntity under a part, deleteEntity of a part, …) runs on the copy's assembled objects and is stored as overrides (project-model `relinkCopy`, proven exact; change `prefabLinkEdit`); a part moved elsewhere or given flags is refused (`prefab_override_unsupported`). New ops `revertPrefabOverrides`, `applyPrefabOverrides` (field, part, all; an added object or copy named alone becomes a part, i.e. nesting), `unpackPrefab`, `createPrefabVariant`; `updatePrefab` from a linked copy = apply all; captures nest linked copies; cycles refused (`prefab_cycle`). One undo step each; MCP docs and the reference regenerated. Vitest over HTTP/WS `tests/integration/m39c-linked-prefabs/prefab-commands.test.ts` (3 tests, ~0.5 s; projection advanced by frames = fresh read after every command), m38 update-prefab and the commands' prefab tests rewritten for linked copies. No e2e touched.
| 39c.3 | Done: schema 8. A 7 (and a 6 after its own step) upgrades on open through `upgradeToSchema8` (project-model `upgrade-schema-8.ts`, named steps; 41 adds its own): `linkPrefabCopies` turns each plain copy into a link whose overrides are its differences from today's prefab, its objects keeping their ids (`partIds`), objects under a part getting `parentPart`; a copy is linked only if the link assembles to exactly the stored objects (else it stays plain), objects of a gone prefab drop the name. One `project_upgraded` line per prefab and outcome. A 7 without copies: only project.json says 8 (no new revision). Vitest: `upgrade-linked-copies.test.ts` (game-shaped scene) and over HTTP `tests/integration/m39c-linked-prefabs/migration.test.ts` (editor view, export, shipped prefabs and 40 step digests of a run with a spawning script and live door blocks equal before/after; grouped lines; reopen writes nothing). e2e: `project-upgrade` assertion only (schemaVersion 8; 8.4 s → 5.9 s), `delete-content` 5.4 s; fast gate green (village at the cap p95 16.8/16.7 ms, 0 missed, both renderers); `scan-bounded-log` timed out once more under load and passed alone (D307). |
| 39c.4 | Done: a prefab opens in the edit-mode shell (`prefab` mode) on its **stage**: a copy no scene holds (project-model `prefabStageId`), read with `queryPrefabs {prefabId, stage: true}` (MCP `tl_content_query` `stage`). Any ordinary command naming stage objects runs on the stage copy (a copy-part edit) and is applied to the prefab (`applyPrefabOverrides all`), stored as a `prefabLinkEdit` of the prefab only (commands `prefab-stage-edit.ts`): one undo step, every copy follows through the feed, a nested copy's edit is an override on it, the root's place/name/tags refused. Opens by double-click (project window; a copy in the Hierarchy or Scene view), the prefab's **open prefab**, a copy's **Open prefab**; column = the prefab's objects + the one Inspector (moved there); Esc/Done leave. Vitest over HTTP/WS (`prefab-commands`, +1 test). e2e: `project-items` (open, change a field, the copy shows it, Esc) file 10.2 s → 10.2 s (that test 3.6 → 3.7 s); `project-window` (prefab double-click now opens the editor, Esc leaves) 13.3 → 14.0 s. Fast gate green (village at the cap p95 16.7/16.8 ms, 0 missed, both renderers). Seen on WebGPU (`acceptance/39c.4-prefab-mode.jpg`); WebGL2 unverified. |
| 39c.5 | Done: `queryEntity` answers `prefabCopy` (the copy as stored: linked prefab, part, every override, part ids; commands `describePrefabCopy`); an assembled copy's root (and a nested copy's) names the prefab it links, a variant's copy the variant. Inspector: copy header (prefab, variant of base, **Open prefab**, **Unpack**, **Overrides** list with Revert/Apply each or all), overridden fields marked with a right-click Revert / Apply to prefab; Hierarchy: prefab parts tinted, a copy's row shows its prefab; Project window: prefab tiles show their model's thumbnail, **Create variant** (right-click, Inspector), drag into the Scene view places a linked copy; Create prefab from selection lets a copy through. The four ops left the API-only list (`updatePrefab` joined it: an alias). Vitest: `prefab-commands` (+queryEntity, variant provenance). e2e (no new file): `project-items` chosen-item test 3.7 → 3.7 s (+override, mark, revert, apply, Unpack), `project-window` double-click test → 4.5 s (+thumbnail, variant, drag), `delete-content` 5.4 → 5.0 s. Seen (WebGPU): `acceptance/39c.5-inspector-overrides.jpg`, `39c.5-hierarchy-variant.jpg`; WebGL2 unverified. |
| 39c.6 | Done: a v4 prefab part carries any component a scene object can, validated and canonical by the scene's own rules (`validateEntityComponentsV3`, `canonicalComponentsV3`; existing prefabs keep their bytes), less what the scene holds (`PREFAB_EXCLUDED_COMPONENTS`: blockLayer, instances, terrain, vertexPaint, folder → `prefab_component_forbidden`); capture no longer refuses a controller. Component references (`COMPONENT_ENTITY_REFS`, kept equal to the descriptors' entity fields by a test: a camera's target, a rail's path, a socket's model, …) naming a part map to each copy's part in assembly, capture, apply and `ctx.spawn`. The scene's counted limits (spawns, lights, fog volumes, collider points) count linked copies' parts (`composeSceneV4`); a spawned prefab with a controller is a new player (as a loaded scene's). Vitest: `prefab-v4`, `prefab-ops-v4` (a player + camera prefab placed twice), `descriptors`, and over HTTP into the runtime `tests/integration/m39c-linked-prefabs/anything-in-a-prefab.test.ts` (2 tests, ~0.5 s: Play holds two players each with its camera on itself, they walk from their own actions in the game host with Rapier, one camera live over two camera-prefab copies; a second hemisphere-light copy refused). No e2e touched.
| 39c.7 | Done: `ctx.spawn` of a variant whose nested copy carries overrides (in the nested copy and again in the variant), a live block whose look is that variant, and `ctx.decals.spawn` of a variant of a decal prefab all use the assembled prefab (the shipped prefabs are flat); block looks are checked and drawn assembled (project-model `blockLookEntities`: `composeBlockContent`, the renderer's prefab model), so a variant or a nested prefab can be a look. The 39c.2 refusal of moving a part with a block footprint is gone: footprints are written from what the scene shows (`writeSceneFootprints`: placing, moving, deleting a copy, moving a part, editing the prefab rewrite every copy's cells; one undo step). Vitest: `footprint-ops` (+1), `block-live` (+1), over HTTP into the game host `tests/integration/m39c-linked-prefabs/prefab-runtime.test.ts` (1 test, ~0.4 s). No e2e touched.
| 39c.8 | Done. Bench moved to `tests/integration/m39c-linked-prefabs/prefab-scale.bench.test.ts` (+ prefab edit timed over WS into the editor's projection; `TL_BENCH_PREFABS`, `TL_BENCH_FOOTPRINT`). 1,000 linked copies (medians of 5): view 16 ms, Play backend 110 ms (baseline 21 / 105: within 10 %). A stage edit reaching 1,000 copies: 70 ms command → projection (one 271 KB `mutation.applied`, 1,000 objects); in a real browser at the cap, command → second frame after the Scene view shows it 105 ms (WebGPU) / 83 ms (WebGL2), seen in screenshots. The 1 MiB frame is passed at ~3,800 copies of one prefab: 4,000 copies resync in 380 ms (vitest) / ~350 ms (browser, status bar's new revision + 2 frames), so no chunking. Fixed: a prefab with a footprint could not be edited on its stage when the scene has a block layer (`reference_missing`; the stage now drops the scene's cells); footprint writes keep each copy's assembly (per prefab list, per stored copy): a command on a 1,000-copy scene with a footprinted prefab 50 → 35 ms (33 ms with the footprint pass off: the rest is the block layer). Vitest: `footprint-ops` (+stage edit). No e2e touched. |
| 39c.9 | Done: manual rewritten. `concepts/prefabs.md` (linked copies, overrides with marks / Overrides list / revert-apply per field, part, all, prefab edit mode, nesting and variants, unpack, what can be in a prefab and the player prefab, spawn / live blocks / block looks / footprints / decals, editor, API and MCP incl. `queryPrefabs stage` and `updatePrefab` alias, older projects); `guides/prefabs.md` (override, edit, revert/apply, variant, nest, unpack steps in the editor and through the API; pitfalls); `features/migration.md` (prefab Problems codes, linked-copy behaviour); `features/scripting.md` (prefabs may hold controllers/cameras/lights). Docs only: manual-links, gen-reference, skill tests green. Left: the MCP tool text in `packages/mcp-adapter/src/tool-docs.ts` still says a prefab holds "never the player controller or scene wiring" (source, not docs). |
| 39c.10 | Browser acceptance done (both renderers, 1920×1080, editor UI), owner look pending; full gate + review by lead. Door prefab, five copies, one colour override kept through a prefab-mode edit (four changed), "Locked door" variant with a Lock part, Handle nested via the copy's Overrides list, player prefab (character + follow camera) walked in Play (4 m, Run, camera followed). Fixes found on the way (`f5660db2`, `3d496157`): prefab rename (`updatePrefab` without `fromEntity`, Project window name field), GameObject menu makes objects inside the open prefab (was: hidden in the scene) and selects them, added objects listed in Overrides with Apply (was: no UI path to nest), Scene view camera restored after prefab mode; MCP tool text fixed (`eab46d31`). On WebGPU the Lock and the handle nesting went through MCP (before the fixes); on WebGL2 everything through the UI. Logged D308 (Surface doesn't colour models), D309 (notice styling, variant header name, dropped copies sink). `project-items` chosen-item test 3.7 → 4.4 s. Screenshots `acceptance/39c.10-*.jpg` (9). |
| 39c.11 | Review fixes done (2a74a616..ad2610cc): H1 refs resolve assembled, H2 Duplicate/Paste keeps the link, M1 footprints in every scene, M2 a destroyed spawned player leaves, M3 results bounded (64 objects), D309, L1. +5 vitest steps in existing m39c files (~+1 s); no e2e touched (0 s). Fast gate (edit-copy, project-window, delete-content, window-tools + menus): GREEN at ad2610cc (9 min, 35 e2e passed, village at 60 Hz p95 16.7 ms, 0 missed, CPU 4.9/4.5 ms on WebGPU/WebGL2); `scan-bounded-log.test.ts` failed once and passed alone (D307 watch). Drop-rest, info notices and the variant heading are unverified in a browser. |

## 5. Decision log

- 2026-10-22: Planned from the owner's prefab discussion. The owner named all
  of today's problems (copies don't update, no edit mode, no nesting or
  variants, limits on what can go inside) and approved linked prefabs with
  overrides, an edit mode, nesting, variants, unpack and anything-in-a-prefab.
  Default chosen, owner to confirm: prefabs stay a separate asset (not
  scenes).
- 2026-10-24 (39c.1 A): **Schema: schema 8, introduced with the migration.** The link is not
  additive on 7: schema 7's validator refuses `overrides` and a `prefab` without `localId`, and
  a stored copy changes meaning (from a plain copy that remembers its prefab to a link), so
  a loader must know which a file holds. The model accepts the link shape now; the version
  bump and its load upgrade land together with the migration (39c.3), so no file is ever
  written as 8 before its copies are converted. Phase 41 extends the same version. Until then
  no command writes links (39c.2 must not ship links without the bump).
- 2026-10-24 (39c.1 A): **Part paths.** Overrides name a part by local ids joined by `/`,
  relative to the copy's prefab: the root is its local id, a nested copy's parts are
  `L/<path in the nested prefab>` and the nested prefab's root is the nested copy itself (`L`).
  A variant is a prefab whose root `V` is a copy of its base, so the base's parts are `V/…` and
  never meet the variant's own. A part's scene id is the copy id plus an 11-character hash of
  the path (stable across prefab edits, ≤ 64 characters); the copy's root keeps the copy's id.
  Default chosen, owner to confirm.
- 2026-10-24 (39c.1 A): **Objects added to a copy** stay ordinary scene objects: `parentId` is
  the copy and the new `parentPart` names the part (the stored scene validates without the
  prefab; assembly re-parents them, and to the copy's root, with a problem, if the part is gone).
  The copy's own name, tags and flags are its root's; a stale override (its part or field gone)
  is skipped and reported, never fatal. Default chosen, owner to confirm.
- 2026-10-24 (39c.1 B): **The editor sees assembled objects; commands still address stored ones.**
  The editor's view (full state, `queryEntities`, `queryEntity`) holds a copy's parts with their
  derived ids, as Play does. Until 39c.2 writes overrides, a command on a part's id is refused
  (`entity_not_found`); no project holds links before 39c.3, so nothing reaches that. Default
  chosen, owner to confirm.
- 2026-10-24 (39c.1 B): **The change feed.** A command's acknowledgement (HTTP and `mutation.applied`)
  carries `change.assembled: {upsert: [{sceneId, entities}], removedIds}` worked out from the views
  before and after; it is never recorded (history, retry records): it follows from the stored state.
  A part an edit left as it was keeps its object, so only differing objects travel. A prefab edit
  reaching thousands of copies can pass the 1 MiB frame bound and make the editor re-read the
  project; 39c.8 measures it against the ≤ 1 s target.
- 2026-10-24 (39c.1 B): **Spawnable prefabs are flattened** in Play and export: a prefab that nests
  copies (a variant included) ships as plain parts, the root keeping its local id and every other
  part taking the id a copy whose id is the root's local id gives it. A spawned part's provenance
  names the spawned prefab with that id. Default chosen, owner to confirm.
- 2026-10-24 (lead): order 39c.1 → 39c.3 → 39c.2: schema 8 lands with the migration (39c.3), and
  commands must not write linked copies before that bump.
- 2026-10-24 (39c.3): **One schema 8 upgrade, named steps.** `SCHEMA_8_STEPS` in project-model
  `upgrade-schema-8.ts` runs in order on the raw documents before validation (a 6 runs its own
  step to 7 first); phase 41 adds its step to the list and shares the version. The open writes the
  result back as the 6 → 7 upgrade did (a 7 that needs nothing gets only the new number in
  project.json, no new revision); the notes are `project_upgraded` Problems lines.
- 2026-10-24 (39c.3): **Migrated copies keep their objects' ids** (`partIds` in the link, by part
  path; the root keeps the copy's id), so scripts, saves and entityRefs naming a part keep working.
  New copies derive part ids as 39c.1 decided. `partIds` is refused on a copy nested in a prefab.
  39c.2's commands must address parts through the assembled ids (`partIds` first). Default chosen,
  owner to confirm.
- 2026-10-24 (39c.3): **Exact or plain.** A copy is linked only when its link assembles to exactly the
  objects stored (ids, values, order); otherwise (an object between its parts, parts out of order)
  it stays plain objects, named in a Problems line. A part moved under another part of its copy
  becomes an object hanging from that part, its place in the copy removed. Strictness means a copy
  placed before a behavior property was added keeps "no value" as an override (assembly fills
  declared defaults): tidying is the game's (the Problems line names the copies). Objects of a
  prefab that is gone drop the `prefab` name (a 7 naming a missing prefab does not load), with a
  line. Default chosen, owner to confirm.
- 2026-10-24 (39c.3): Assembly now re-parents a linked copy placed under another copy's part
  (`parentPart` on a copy root), which the upgrade produces for copies nested in the hierarchy.
  Until 39c.2, `instantiatePrefab` still writes plain copies, which stay plain objects on 8.
- 2026-10-24 (39c.2): **Editing a copy's part is the ordinary commands.** The copy is assembled, the command
  runs on those objects through the one pipeline, and the copy is linked again from the result (the migration's
  diff, `relinkCopy`, proven to assemble back exactly); the change stored is the stored objects replaced
  (`prefabLinkEdit`, both sides, so undo and redo swap them; `removedIds` for the socket, which drops `previous`).
  Refused rather than lost (`prefab_override_unsupported`): a part moved to another parent or scene, a part's own
  flags (prefab parts carry none), an edit that changes more than the copy's objects (a part's block footprint,
  until 39c.7). Default chosen, owner to confirm.
- 2026-10-24 (39c.2): **Revert and apply** take `{entityId (the copy or a part), part?, path?, all?}`: the copy's
  root alone means all. Revert keeps objects added to the copy (Unity deletes them; deleting is a separate edit),
  and reverts the root's own name or tags only when `path` names them. Apply writes into the copy's own (outermost)
  prefab: an override inside a nested copy becomes that nested copy's override there (Unity's "apply to outer").
  `all` also makes the objects added to the copy parts (new local ids; this copy keeps their scene ids in
  `partIds`); an added object (a linked copy too) named alone becomes a part, which is how a copy nests one. An
  apply is proven: the applying copy must look exactly as before. Undo puts the definition back exactly (part
  counter included). Default chosen, owner to confirm.
- 2026-10-24 (39c.2): **Unpack is complete** (nested copies too): plain objects with the same ids and no prefab
  component, so a deleted prefab no longer counts them. **A variant's root** takes the base root's local id and
  transform. **`updatePrefab`** from a linked copy of that prefab is "apply all"; from other objects it is the
  capture it was, which now nests the linked copies among them (cycles refused, `prefab_cycle`). A copy placed under
  another copy's part reports `placed` (root and mapping) in its `prefabLinkEdit`. Deletes also check references
  held by copies' parts; kept part ids are never minted again. Default chosen, owner to confirm.
- 2026-10-24 (39c.2): For 39c.4/39c.5: the editor's own capture pre-check (`prefab-authoring.ts`) still refuses a
  selection holding a copy (`prefab_nested_forbidden`); the backend now nests it. The assembled root's provenance
  names the innermost prefab (a variant's copy shows its base): the Inspector needs the stored link for its header.
- 2026-10-24 (39c.4): **The prefab editor edits a stage.** A prefab opens as a copy no scene holds (root id
  `prefab-stage_<hash of the prefab id>`, parts derived from it as any copy's); a command naming its objects runs on that
  copy and its result is applied to the prefab (apply all), stored as the prefab replaced (no scene object). One command path
  (the ordinary commands, and MCP through `queryPrefabs stage`), one undo step each. The root's place, name and tags are
  each copy's own and are refused in the stage (Unity lets the root's transform be edited there; here it would reach no copy).
  The stage is drawn at the prefab root's own place with everything else hidden, in the active scene's look (Context shows
  the scene around it), not in a separate neutral environment. Default chosen, owner to confirm.
- 2026-10-24 (39c.4): **Opening.** A double-click in the project window now opens a prefab in its editor (a single click
  still shows its Inspector, which has **open prefab**). A double-click on a copy (Hierarchy, Scene view) or a copy's
  **Open prefab** opens the prefab its clicked object came from: a nested copy's object opens the nested prefab, and a
  variant's copy its base until the Inspector reads the stored link (39c.5). Inside the editor a double-click on a nested
  copy's object opens that prefab. The editor re-reads the stage after every applied change while open (one bounded
  query each), so undo, MCP edits and nested prefabs' edits show in it. Default chosen, owner to confirm.
- 2026-10-24 (39c.5): **The editor reads a copy's link with `queryEntity`** (`prefabCopy`), once per selection and after each change,
  not through the change feed: the overrides travel only for the object looked at. **An assembled copy's root names the prefab
  the copy links** (a variant's copy: the variant, with its root local id), and a nested copy's root the prefab it links; parts
  keep the prefab part they come from. So the Hierarchy, double-click and scripts see a variant's copy as the variant. Default
  chosen, owner to confirm.
- 2026-10-24 (39c.5): **Marks and thumbnails.** An overridden field gets a bar in the prefab colour and a bold label, its
  component's title a dot (Unity: bold plus a blue bar); behavior values and transform overrides show in the Overrides list.
  A prefab tile shows its first model's import thumbnail (its own objects, else a nested copy's or its base's), the prefab
  icon when it has none, rather than rendering the prefab (no new renderer job). A variant made from the Project window is
  named "<base> Variant". The copy header's **Open prefab** replaces the copy's edit-mode button. Default chosen, owner to confirm.
- 2026-10-24 (39c.6): **A prefab holds what a scene object can, less what the scene keeps.** Parts are validated by the scene
  object's own rules, so the limits that stay are the scene's: a controller is a root, one live camera per view (the
  enabled one with the highest priority), several players per view. Left out: block layers (their cells are the scene's),
  instance sets, terrains and vertex paint (blobs kept and collected with the scene) and folders. Component entity references
  naming a part follow each copy (Unity remaps in-prefab references the same way); others are kept as written. A scene's
  counted limits count its linked copies' parts, so a second copy of a hemisphere-light prefab is refused like a second
  hemisphere light. A spawned prefab with a controller adds a player (a destroyed one stays in the player list, as a player
  unloaded with its scene does). Default chosen, owner to confirm.
- 2026-10-24 (39c.7): **Footprints follow what the scene shows.** A linked copy's parts write their block footprints as plain
  objects do: the command layer compares the assembled scene before and after each command (only when some prefab carries a
  footprint) and writes the cells into the stored scene in the same undo step. So a part with a footprint can be moved inside a
  copy (an override; 39c.2 refused it), and a prefab edit rewrites every copy's cells (Unity has no such feature; this follows
  "a copy is its objects"). A live block's root still may not move; its look and a block look are read assembled, so a variant
  or a prefab with nested copies can be a look. Default chosen, owner to confirm.
- 2026-10-24 (39c.8): **A prefab edit's change stays one frame, else the resync.** One `mutation.applied` carries every
  changed assembled object (~270 bytes each); past the 1 MiB bound (about 3,800 objects) the editor re-reads the project,
  which stays well inside 1 s at 16,000 objects (~350 ms in the browser). No chunked frames or "reassemble locally" message:
  the editor would need the assembler and the prefabs, for a case that already meets the target. Each such resync still adds
  a `ws_frame_too_large` Problems line (by design: a resync is never silent). Default chosen, owner to confirm.
- 2026-10-24 (39c.11): **Phase review (independent agent, at ea083106).** Full gate at ea083106: GREEN, 387 passed,
  0 flakes, 29 min (e2e 23.6 min), against 27 min in phase 39 and 33 min (RED) in 39b. Findings: 2 High, 3 Medium,
  5 Low. Fixed: **H1** references (behavior entityRefs, transition and shell spawns) resolve against the assembled
  scene, so a schema-7 project naming a copy's non-root part upgrades and opens and a spawn-point prefab copy is a
  spawn (2a74a616); **H2** Duplicate and Copy/Paste of a linked copy make a linked copy with its overrides, a lone
  part pastes as an ordinary (added) object (148c5751); **M1** a prefab edit writes its copies' footprint cells in
  every scene, undo by the same pass (e6726f50); **M2** a destroyed spawned player leaves the controllers, the
  physics world and the blocks; the next player becomes the first (3202ff7c; replaces 39c.6's "stays in the player
  list"; default chosen, owner to confirm); **M3** HTTP/MCP results carry `change.assembled` whole up to
  `RESULT_ASSEMBLED_MAX` (64), else counts, the first 64 ids and `truncated`, while the WS feed carries everything
  (2b8a521b); **L1** one canonicalJson, ID_MAX_LENGTH and namedList (5 names) (ad2610cc); **D309** dropped copies
  rest on the surface (lifted in the same undo step), the variant's prefab mode names the variant, success notices
  use an info style (6743a2d1). Open: L2 (kept `partIds` of gone parts never pruned), L3 (new assembled parts go to
  the end of the editor's order until a full read), L4 (per-command assembly not memoized; `prefabCopyCountErrors`
  now shares the per-scene memo with the reference checks), L5 (`prefab-stage_` ids not reserved) → D310; the H2
  e2e step was skipped (the behaviour is tested at the backend through the editor's value builder). Rule checks: no
  new per-project caps (64 is a result-size bound, not a content cap); no copied constants left from the review;
  no file past 2,000 lines, ratchet only shrank (both Rapier `createAdapter`s); no history comments. Owner's eyes:
  the acceptance screenshots (door, variant, nesting, player prefab, both renderers), the drop rest, the info
  notice style and the variant heading (unverified), D308, and whether 16 local lights per scene still fits now
  that lamp prefabs count.
