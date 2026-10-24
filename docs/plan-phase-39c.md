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

