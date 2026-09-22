**PROPOSED — pending Gate K. Nothing here is accepted.** Packet 43
(`docs/planning/m3-packets.md` §43, "Contract drafting and promotion"). This is
the consolidated Gate K diff inventory for packets 38–42: it lists **every**
proposed M3 contract diff exactly once, names its author packet, destination
section, proving fixture(s), consumer packets, version effect and
collision/supersession resolution, and leaves the per-row status **open** for the
Gate K reviewer. It changes no accepted contract, no decision and no package.
House style: `docs/planning/m2-contracts/contract-diffs.md`.

Related packet-43 outputs: [`traceability.md`](traceability.md) (feature →
command → UI/MCP → runtime → export → acceptance, including creation paths) and
`fixtures/m3/audit/**` (the integrated audit checker). Gate K review → bounded
repair → explicit docs-only promotion → packet 44. **Packet 43 does not start
packet 44 and does not promote.**

---

## 1. How to read this inventory

- **Status** was `open` for every row when packet 43 handed the pack to Gate K.
  The Gate K review (`../../../handoffs/gate-k.md`) recorded the verdicts, and
  this bounded repair step (2026-09-19, `../../../handoffs/gate-k-repair.md`) has
  now written them here: **97 rows keep `open`** (the 96 rows Gate K accepted plus
  the one repair-authored row R40-17, none of which needed a change) and **13 rows
  carry `repaired (<repair ids>)`** or, for the one row Gate K rejected and
  PM41-1 supersedes, `rejected (superseded by PM41-1)`. Only the Gate K reviewer
  wrote `accept`/`reject`; the repair changed proposal text, not verdicts. A
  separate docs-only promotion applies the promotable rows into
  `docs/contracts/**` and records the outcome in
  [`../../decisions/0003-m3-sample-game.md`](../../decisions/0003-m3-sample-game.md).
  No packet invents an acceptance and no row is applied silently.
- **Repair ids** are `FU-n` (follow-up) / `K-n` (Gate K decision) / `B3` from
  `gate-k.md`; §8 maps every repaired row to its id and records the one
  coordinator adjudication.
- **Author packet** is the packet whose proposal text owns the row. Where packet
  41/42 appended a section to an earlier packet's diff file, the row's author is
  the appending packet (`PM41-*`, `CMD41-*`, `R41-*`, `R42-*`), not the file's
  original packet.
- **Destination section** is the accepted-contract section promotion edits. Format
  is `contract §section` (contract ∈ project-model, workspace, commands, runtime,
  sessions, export, dependencies) or `new contract` for the two proposed new
  contract homes (`gameplay.md`, `presentation.md`).
- **Proving fixture(s)** are under `fixtures/m3/<packet>/`; `contracts:` =
  `fixtures/m3/contracts`, `gameplay:` = `fixtures/m3/gameplay`, `camera:` =
  `fixtures/m3/camera`, `media:` = `fixtures/m3/media`, `delivery:` =
  `fixtures/m3/delivery`. A fixture is contract-consistency evidence, not a
  product test.
- **Consumer packets** are the implementation packets from
  `docs/planning/m3-packets.md` that read the promoted text.
- **Version effect** names the document version each row moves (or `none`).
- **Collision / supersession** names the accepted or earlier-proposal text the row
  replaces. Unresolved collisions are listed in §4 (open Gate K decisions); rows
  resolved by this packet's reconciliation are `PM43-*` in §2.4.
- The **diff file is the normative proposal text**; `model.md`/`storage.md`/
  `authoring.md`/`gameplay.md`/`presentation.md`/`delivery.md` are the normative
  rule documents those diffs point at.

---

## 2. Master inventory — one row per proposed diff (105 rows; 110 rows including §2.7/§2.8)

§2.1–§2.6 hold the 105 proposed section diffs (104 from packets 38–42 plus the
repair row R40-17); §2.7 adds the 3 packet-43 reconciliation rows and §2.8 the 2
new-contract rows, for **110 inventory rows** in total. Statuses are the Gate K
verdicts as repaired by the bounded repair step (§1, §8).

### 2.1 Packet 39 — `diffs/project-model.md` (PM1–PM19)

| id | author | destination | proving fixture(s) | consumers | version effect | collision / supersession | status |
|---|---|---|---|---|---|---|---|
| PM1 | 39 | project-model §3 | contracts:envelope/valid/*, contracts:migration/* | 44,46 | scene 3 / storage 3 | none (insertion) | open |
| PM2 | 39 | project-model §6 | contracts:envelope/invalid/storage-unknown-4.json, scene-unknown-4.json | 44 | scene [1,2,3] | none (extends row) | open |
| PM3 | 39 | project-model §6 | contracts:envelope/valid/*, contracts:envelope/invalid/combination-* | 44,46 | storage 3 | none (extends combinations bullet) | open |
| PM4 | 39 | project-model §8/§8.1 | contracts:envelope/valid/*, contracts:envelope/invalid/scene-unknown-4.json | 44 | scene 3 | none (adds value) | open |
| PM5 | 39 | project-model §10 | contracts:envelope/invalid/unknown-component.json | 44 | scene 3 | none (v3 registry superset); repair FU-1/K-13 (“six” components) | repaired (FU-1/K-13) |
| PM6 | 39 | project-model §12.2 | contracts:envelope/valid/* | 44 | scene 3 | none | open |
| PM7 | 39 | project-model §12.3 | contracts:envelope/invalid/* | 44 | scene 3 | none | open |
| PM8 | 39 | project-model §12.4 | contracts:migration/expected-v3-destination/envelope.json | 44,46 | scene 3 | none | open |
| PM9 | 39 | project-model §12.6 | contracts:envelope/invalid/*, contracts:commands/failures.json | 44,45 | scene 3 | none (additive codes); repair FU-2/K-4 (`game_config_invalid` `path`+`reason`) and FU-3 (`spawn_transform_unsupported` registered) | repaired (FU-2/K-4; FU-3) |
| PM10 | 39 | project-model §13.2 (new) | contracts:envelope/invalid/cue-*.json, game-dangling-player.json | 44 | scene 3 | none | open |
| PM11 | 39 | project-model §14 | — (wording-only scoping; see PM43-2) | 44 | scene 3 | scopes §14 non-goals; reconciliation PM43-2 | open |
| PM12 | 39 | project-model §17 | contracts:envelope/* | 44 | scene 3 | none | open |
| PM13 | 39 | project-model §18.1 rule 3 | — (reserved note, no text) | 41 | none | **superseded by PM41-1** (explicit); Gate K **rejected** — no text to repair | rejected (superseded by PM41-1) |
| PM14 | 39 | project-model §18.2 | contracts:envelope/invalid/content-missing-game.json, game-missing-key.json | 44 | content key set +`game` (v3) | none | open |
| PM15 | 39 | project-model §18.3 | contracts:envelope/valid/demo-0003-media-v3.json, contracts:envelope/invalid/cue-kind-mismatch.json | 44 | `kind` ∈ {model,audio} | none | open |
| PM16 | 39 | project-model §19.2 | delivery:manifest/manifest-v2-example.json; media:* | 44,58 | capture closure incl. audio | none | open |
| PM17 | 39 | project-model §20.2 | contracts:commands/scenario* | 45 | v3 prefab vocabulary closed | none | open |
| PM18 | 39 | project-model §20.10 | contracts:envelope/invalid/game-dangling-player.json | 45 | deletion rule 6 | none | open |
| PM19 | 39 | project-model §23 (new) | contracts:envelope/*, contracts:catalog/*, contracts:commands/* | 44,45,46 | scene 3 | none (new section); repair FU-3 (`spawn_transform_unsupported` row in §23.9) | repaired (FU-3) |

### 2.2 Packet 39 — `diffs/workspace.md` (W1–W9) and `diffs/commands.md` (C1–C14)

| id | author | destination | proving fixture(s) | consumers | version effect | collision / supersession | status |
|---|---|---|---|---|---|---|---|
| W1 | 39 | workspace §3 | contracts:migration/* | 46 | storage 3 | none | open |
| W2 | 39 | workspace §4.2 | contracts:envelope/valid/* | 46 | storage 3 | none | open |
| W3 | 39 | workspace §4.5 | contracts:envelope/invalid/combination-*, storage-unknown-4.json | 46 | storage 3 | **supersedes** the `≥3` rows and the "exactly two passable combinations" sentence (≥3→≥4) | open |
| W4 | 39 | workspace §11 ops | contracts:migration/interrupted-copy/case.json | 46 | storage 3 | none | open |
| W5 | 39 | workspace §11 codes | contracts:migration/* | 46 | storage 3 | none (additive reason list) | open |
| W6 | 39 | workspace §13.9 | contracts:envelope/invalid/game-instructions-too-long.json | 46 | `game_bytes` 16384 | none | open |
| W7 | 39 | workspace §14 | contracts:migration/v2-source/* | 46 | none (second operator) | none | open |
| W8 | 39 | workspace §15 | contracts:migration/expected-v3-destination/* | 46 | none | none | open |
| W9 | 39 | workspace §16 (new) | contracts:envelope/*, contracts:migration/* | 46 | storage 3 | none | open |
| C1 | 39 | commands §2 op table | contracts:commands/scenario* | 45,48 | new ops | none (reword + 2 rows) | open |
| C2 | 39 | commands §2 non-goals | contracts:commands/failures.json | 45 | none | rewords the accepted add/remove non-goal (C39-4) | open |
| C3 | 39 | commands §3.1 | contracts:commands/scenario.before.json | 45 | createEntity `components` | none | open |
| C4 | 39 | commands §3.1.6 | contracts:commands/scenario* | 45 | setComponent union | none (extends) | open |
| C5 | 39 | commands §3.1.9–§3.1.11 (new) | contracts:commands/scenario* | 45,48 | new args | none | open |
| C6 | 39 | commands §3.1.1 | contracts:commands/scenario*, contracts:catalog/audio-asset-record-v3.json | 45 | publishAsset `kind` | none | open |
| C7 | 39 | commands §4 + §5.6 | contracts:commands/scenario.after.json | 45,48 | new query | none | open |
| C8 | 39 | commands §5.3 | contracts:commands/scenario* | 45 | new change rows | none | open |
| C9 | 39 | commands §5.4 | contracts:commands/failures.json | 45,48 | new codes/limits | none (additive); repair FU-2/K-4 (`game_config_invalid` carries `path`, `reason`) + FU-3 (`spawn_transform_unsupported` row) | repaired (FU-2/K-4; FU-3) |
| C10 | 39 | commands §8.1 | contracts:commands/scenario* | 45 | derived-ID prefixes | none | open |
| C11 | 39 | commands §8.10 | contracts:commands/scenario*, failures.json | 45 | v3 component rows | none; repair FU-3 (`playerSpawn` row names the now-registered code) | repaired (FU-3) |
| C12 | 39 | commands §8.13/§8.14 (new) | contracts:commands/scenario*, no-change.json | 45 | new op semantics | none | open |
| C13 | 39 | commands §9.1 | contracts:commands/scenario* | 45 | inverse specs | none | open |
| C14 | 39 | commands §12 | contracts:commands/* | 45 | fixture index note | none | open |

### 2.3 Packet 41 — `diffs/project-model.md` and `diffs/commands.md` additions (PM41-*, CMD41-*)

| id | author | destination | proving fixture(s) | consumers | version effect | collision / supersession | status |
|---|---|---|---|---|---|---|---|
| PM41-1 | 41 | project-model §18.1 rule 3 | media:glb/profile-cases.json, media:glb/courier-reordered.glb, contracts:envelope/invalid/model-animation-asset-mismatch.json | 44,47,53 | none (bounded exception) | **replaces** PM13's reserved slot; **supersedes** §18.1 rule 3 for the version-local binding only | open |
| PM41-2 | 41 | project-model §18.5 | media:wav/wav-cases.json, contracts:catalog/audio-asset-record-v3.json | 44,47 | recipe profile union | none | open |
| PM41-3 | 41 | project-model §18.6 | media:wav/wav-cases.json | 44,47 | metrics union | none | open |
| PM41-4 | 41 | project-model §18.9.3/§23.9 | media:errors/codes.json, media:glb/profile-cases.json, media:wav/wav-cases.json | 44,45,47 | codes/limits | none (additive) | open |
| PM41-5 | 41 | project-model §18.7 | media:wav/wav-cases.json | 44,47 | none (pointer) | none | open |
| PM41-6 | 41 | project-model §19.2 | delivery:manifest/manifest-v2-example.json; media:* | 44,58 | none (confirm) | confirms PM16; no text change | open |
| PM41-7 | 41 | project-model §18.4 | contracts:envelope/valid/demo-0003-media-v3.json, delivery:manifest/manifest-v2-example.json | 44 | none (confirm) | confirms `sourceByteLength` 1…33554432 + profile bound | open |
| CMD41-1 | 41 | commands §3.1.1 | contracts:commands/scenario*, media:glb/profile-cases.json | 45,47 | publishAsset `animation` | coexist with C6 on the §3.1.1 args block (adds fields, rewrites no C6 row) | open |
| CMD41-2 | 41 | commands §8.5.1 (new) | media:glb/profile-cases.json, contracts:commands/scenario* | 45,47,53 | atomic reimport | none | open |
| CMD41-3 | 41 | commands §5.4 | media:errors/codes.json, media:glb/profile-cases.json | 45,47 | codes/limits | coexist with C9 on the §5.4 code table (appends rows, modifies no C9 row) | open |

### 2.4 Packet 40 — `diffs/runtime.md` (R40-1–R40-16) and new `gameplay.md`

| id | author | destination | proving fixture(s) | consumers | version effect | collision / supersession | status |
|---|---|---|---|---|---|---|---|
| R40-1 | 40 | runtime §1 | gameplay:run/failure-phases.json | 49–51 | none (scope bullets) | none | open |
| R40-2 | 40 | runtime §2 | gameplay:run/game-view.json | 49,58 | snapshot `game` (v3 only) | none (additive, v3-only) | open |
| R40-3 | 40 | runtime §3.2 | gameplay:run/states.json, run/held-jump.json | 49 | none (run-start barrier) | none | open |
| R40-4 | 40 | runtime §4 | gameplay:run/segment-source.json | 49,50 | none (`lastCommitted`) | none | open |
| R40-5 | 40 | runtime §5 | gameplay:run/respawn-timing.json | 49,50 | none (boundary rule) | none | open |
| R40-6 | 40 | runtime §6 | gameplay:run/game-view.json, camera:follow.json | 49,51 | none (frame ordering + camera pose) | none | open |
| R40-7 | 40 | runtime §8 | gameplay:errors/codes.json | 49–51,59 | new runtime codes/reasons | none (additive) | open |
| R40-8 | 40 | runtime §12.1 | gameplay:errors/codes.json, camera:owner.json | 49 | `SimulationPhase` += gameplay/camera | none (M2 lists stay prefixes) | open |
| R40-9 | 40 | runtime §12.2 | gameplay:run/failure-phases.json | 49 | write-guard clause | none | open |
| R40-10 | 40 | runtime §12.3 | camera:owner.json, camera:follow.json | 49,51 | camera transform row | none | open |
| R40-11 | 40 | runtime §12.4 | camera:owner.json | 49 | none (row supersession) | **supersedes** the camera-owner row for M3 sets (M1/M2 unchanged) | open |
| R40-12 | 40 | runtime §12.6 | gameplay:zones/spawn.json, run/failure-phases.json | 50 | restricted reset ops | none | open |
| R40-13 | 40 | runtime §13 | gameplay:run/failure-phases.json | 50 | fail-stop reset/view retention | none | open |
| R40-14 | 40 | runtime §14.5 | gameplay:run/held-jump.json | 49 | effective-frame overrides | none | open |
| R40-15 | 40 | runtime §15 (new) + new contract `gameplay.md` | gameplay:*, camera:* | 49–51 | new contract home | none | open |
| R40-16 | 40 | runtime §11 | — (no section text written) | 49–51 | none | none; body supplied by repair FU-6/K-1 — the §11 bullets are now in `diffs/runtime.md` (rule text `gameplay.md` §12) | repaired (FU-6/K-1) |
| R40-17 | 43 | runtime §15.5 | gameplay:run/game-view.json | 49–51,53 | none (`GameView` field) | resolves C41-1 (K-2/FU-4); rewrites no packet-40 row | open |
| R41-1 | 41 | runtime §9 | media:ownership/ownership-cases.json | 52–54 | none (host-owned resources) | none; repair FU-4/K-2 (committed `playerMotion` wording) | repaired (FU-4/K-2) |
| R41-2 | 41 | runtime §12.3 | media:ownership/ownership-cases.json, media:glb/profile-cases.json | 53 | none (no transform writes) | coexist with R40-10 on the §12.3 writer table; no R40 row modified | open |
| R41-3 | 41 | runtime §13 | media:ownership/ownership-cases.json | 52–54 | none (fail-stop disposal) | coexist with R40-13 on the §13 fail-stop list; additive bullet | open |
| R41-4 | 41 | runtime §2 | media:glb/profile-cases.json | 52–54 | none (confirm: no snapshot field) | confirms R40-2 | open |
| R42-1 | 42 | runtime §3.1 `settings` row | delivery:settings/pinned-run.json, delivery:manifest/variants/settings-variant.json | 58 | C35-5 closure | **supersedes** the C35-5 deferral clause | open |
| R42-2 | 42 | runtime §3.1 C35-5 note | delivery:settings/pinned-run.json, delivery:manifest/* | 58,60 | C35-5 closure | **supersedes** the whole C35-5 blockquote | open |
| R42-3 | 42 | runtime §12.5 | delivery:controls/control-cases.json | 55 | none (menu channel) | none | open |
| R42-4 | 42 | runtime §15 | delivery:wire/* | 55,59 | none (confirm) | confirms R40-15 | open |

### 2.5 Packet 42 — `diffs/sessions.md` (S42-1–S42-12)

| id | author | destination | proving fixture(s) | consumers | version effect | collision / supersession | status |
|---|---|---|---|---|---|---|---|
| S42-1 | 42 | sessions §7.1/§7.2 | delivery:wire/relay-cases.json | 48,59 | new WS events | none | open |
| S42-2 | 42 | sessions §10.5 | delivery:manifest/manifest-v2-example.json | 48,59 | manifestVersion 1→2 | none | open |
| S42-3 | 42 | sessions §11.5 | delivery:wire/*, delivery:closure/scan-rows.json | 48,59 | new constants | none | open |
| S42-4 | 42 | sessions §13.1 | delivery:closure/csp-rows.json (+ evidence-m3/38/raw/summary.json) | 55,59 | none (C38-2) | **extends** the accepted `allow="gamepad"` paragraph | open |
| S42-5 | 42 | sessions §13.5 | delivery:wire/relay-cases.json | 48,59 | bridge rows + bounds | none | open |
| S42-6 | 42 | sessions §13.6 | delivery:controls/control-cases.json | 55,59 | none (fresh host) | none | open |
| S42-7 | 42 | sessions §17.1.1 | delivery:manifest/manifest-v2-example.json, delivery:digests/expected.json | 48,58,59,60 | manifestVersion 1→2 | **extends** the manifest field table; v1 stays readable; repair FU-5/K-5 (real `0.1.0` identity values, marked illustrative, 58 derives) | repaired (FU-5/K-5) |
| S42-8 | 42 | sessions §17.4 | delivery:closure/csp-rows.json (+ evidence-m3/38/raw/engine{,-nocsp,-csp-wasm}.json) | 55,58,59,60 | CSP token (C38-1) | **supersedes** one CSP fence line | open |
| S42-9 | 42 | sessions §17.5 | delivery:closure/fetch-graph.json | 58,60 | none (no new fetch) | none | open |
| S42-10 | 42 | sessions §17.6 | delivery:wire/observe-result.json | 55,59 | none (readiness rule) | none | open |
| S42-11 | 42 | sessions §20 (new) | delivery:wire/*, delivery:runs/run-identity.json | 48,59 | release 1 (relay v1) | none | open |
| S42-12 | 42 | sessions §15 | delivery:manifest/v1-v2-rules.json | 48,58–60 | none (change-rule bullets) | none | open |

### 2.6 Packet 42 — `diffs/export.md` (E42-1–E42-9) and `diffs/dependencies.md` (D42-1–D42-7)

| id | author | destination | proving fixture(s) | consumers | version effect | collision / supersession | status |
|---|---|---|---|---|---|---|---|
| E42-1 | 42 | export §3 | delivery:closure/csp-rows.json, delivery:closure/mime-cache-rows.json | 60 | export meta CSP | none | open |
| E42-2 | 42 | export §3 | delivery:closure/export-tree.json | 58,60 | non-root relative closure | none | open |
| E42-3 | 42 | export §5.1 | delivery:deps/dependency-rows.json | 58,60 | none (shared host) | none | open |
| E42-4 | 42 | export §5.2 | delivery:closure/scan-rows.json | 58,60 | M3 entry graph | none | open |
| E42-5 | 42 | export §5.4.1 | delivery:closure/scan-rows.json, delivery:closure/fetch-graph.json | 58,60 | none (remeasure duty) | none | open |
| E42-6 | 42 | export §5.5 | delivery:manifest/*, delivery:closure/export-tree.json | 58,60 | bootstrap steps 1–4 | none (supersedes M1 wording for M3 exports) | open |
| E42-7 | 42 | export §6 | delivery:manifest/manifest-v2-example.json, delivery:digests/expected.json | 58,60 | meta manifest v2 fields | none; repair FU-5/K-5 (illustrative identity values) | repaired (FU-5/K-5) |
| E42-8 | 42 | export §7 | delivery:manifest/reproducibility.json | 58,60 | two-tree rule | none | open |
| E42-9 | 42 | export §2 | delivery:manifest/v1-v2-rules.json | 58,60 | manifest v2 pointer | none | open |
| D42-1 | 42 | dependencies §2 | delivery:deps/dependency-rows.json | 49,55,58 | two new units | none (PR-5 rows) | open |
| D42-2 | 42 | dependencies §3 | delivery:deps/dependency-rows.json | 49,55,58 | public surface rows | none (PR-5); repair FU-7/K-3 — adopt `platformerGameSessionSpec` + `platformerGameCameraSpec` (coordinator-adjudicated, owner confirmation flagged) | repaired (FU-7/K-3) |
| D42-3 | 42 | dependencies §4.1 | delivery:deps/dependency-rows.json | 49,55,58 | import edges | none (PR-5) | open |
| D42-4 | 42 | dependencies §4.2 | delivery:deps/dependency-rows.json | 55,58,60 | bundle-graph rows | none (PR-5) | open |
| D42-5 | 42 | dependencies §4.3 | delivery:deps/dependency-rows.json | 49,55,58 | forbidden edges + editor-UI rule | none (PR-5) | open |
| D42-6 | 42 | dependencies §5 | delivery:deps/dependency-rows.json | 49,55,58,60 | check 12 | none (PR-5) | open |
| D42-7 | 42 | dependencies §9 | delivery:deps/dependency-rows.json | 49,55,58 | change-rule bullets | none (PR-5) | open |

### 2.7 Packet 43 — reconciliation rows added by this packet (PM43-*)

These resolve obsolete accepted non-goal wording that no packet 38–42 row
addressed. They are **new** proposed diffs authored by packet 43; they add no
requirement and weaken none (each only scopes accepted M1/M2 wording so it
cannot be read as forbidding the reviewed v3 data). Exact OLD quotes and NEW
text are in §5.

| id | author | destination | proving fixture(s) | consumers | version effect | collision / supersession | status |
|---|---|---|---|---|---|---|---|
| PM43-1 | 43 | project-model §1 | — (wording-only) | 44 | none | **supersedes** the M1 non-goal "no lights" for scene v3 | open |
| PM43-2 | 43 | project-model §14 | — (wording-only) | 44 | none | **supersedes** "no lights, and no materials beyond `box.material.color`" for scene v3 | open |
| PM43-3 | 43 | export §8 | — (wording-only) | 60 | none | **supersedes** the M1 non-goals "no GLB/glTF", "no lights, no audio files" for an M3 export | open |

### 2.8 New contract homes proposed by this pack (NC-1/NC-2)

Two **new** contract documents are proposed as homes for rules that have no
accepted section to edit. They are not section diffs of an accepted file; they
are promoted as whole documents (§6 steps 5–6), and every rule they contain is
also reachable through the section rows above.

| id | author | destination | proving fixture(s) | consumers | version effect | collision / supersession | status |
|---|---|---|---|---|---|---|---|
| NC-1 | 40 | new contract `gameplay.md` | gameplay:*, camera:* | 49–51 | new document (M3) | coexist with R40-15 (which inserts runtime §15 and points at this document); repair FU-4/K-2 (§6 `playerMotion`) + FU-7/K-3 (§11 export names) | repaired (FU-4/K-2; FU-7/K-3) |
| NC-2 | 41 | new contract `presentation.md` | media:* | 47,52,53,54,57 | new document (M3) | coexist with PM41-* (which carry the accepted-section edits); §41.5 is the PR-1 activation-appearance home; repair FU-4/K-2 (selector input named) | repaired (FU-4/K-2) |

---

## 3. Gate K routing table — one destination per C38/C39/C40/C41/C42 request

| request | author | exactly one destination row (this inventory) | open conflict? |
|---|---|---|---|
| C38-1 (`sessions.md` §17.4 CSP) | 38→42 | S42-8 | no |
| C38-2 (iframe `allow="gamepad"`) | 38→42 | S42-4 | no |
| C39-1 (scene v3 + components) | 39 | PM2, PM4, PM5, PM7, PM9, PM12, PM19 | no |
| C39-2 (§18.1 rule-3 text) | 39→41 | PM41-1 | no |
| C39-3 (content key set + `game`) | 39 | PM14 | no |
| C39-4 (commands §2 non-goal reword) | 39 | C2 | no |
| C39-5 (workspace §4.5 `≥3`→`≥4`) | 39 | W3 | no (threshold approval, §7.9) |
| C39-6 (`game_config_invalid`/`game_reference_in_use`) | 39 | PM9, C9, W5 | §4 item 4 (carries shape) |
| C39-7 (`manifestVersion` owner) | 39→42 | S42-2, S42-7 | no |
| C40-1 (runtime §12.4 supersede) | 40 | R40-11 | no |
| C40-2 (`SimulationPhase` +=) | 40 | R40-8 | no |
| C40-3 (snapshot `game`) | 40 | R40-2 | no |
| C40-4 (camera pose as entity transform) | 40 | R40-6, R40-10 | no |
| C40-5 (`PhysicsResetPort`) | 40 | R40-12, R40-13 | no |
| C40-6 (`lastCommitted`/boundary/overrides) | 40 | R40-4, R40-5, R40-14 | no |
| C40-7 (no new settings key) | 40 | R40-15 + delivery §3.3 | no |
| C40-8 (**no** commands §5.4 row) | 40 | — (confirmed: no row exists) | no |
| C40-9 (`gameCommand`/`GameView`/`setViewport`, carry `game`) | 40→42 | S42-1, S42-3, S42-8, S42-10, R42-1…R42-4 | no |
| C40-10 (`platformer-game` rows/edges) | 40→42 | D42-1…D42-7 | §4 item 3 (export name) |
| C40-11 (`checkpointActive`/`checkpointId`) | 40→41 | NC-2 (presentation.md §41.5) | no |
| C40-12 (`GameView.stepIndex` definition) | 40 | R40-15 §15.5 | no |
| C41-1 (`GameView.playerMotion`) | 41→40 | R40-17 (repair FU-4/K-2) | no |
| C41-2 (`publishAsset.animation`) | 41→39 | CMD41-1 | no |
| C41-3 (reimport change/inverse + rows) | 41 | CMD41-2, CMD41-3 | no |
| C41-4 (§18.1 exception) | 41 | PM41-1 | no |
| C41-5 (cues `assetId` only; CSP) | 41→42 | S42-5, S42-9 | no |
| C41-6 (`game-host` rows + editor-UI rule) | 41→42 | D42-1, D42-2, D42-3, D42-5 | no |
| C41-7 (`pcm-wav` recipe/metrics/codes) | 41 | PM41-2, PM41-3, PM41-4 | no |
| C41-8 (audio captured by digest) | 41→44/58 | PM16, PM41-6 | no |
| C42-1 (sessions rows; wire tools) | 42 | S42-1, S42-5, S42-11 | no |
| C42-2 (export rows) | 42 | E42-1…E42-9 | no |
| C42-3 (dependencies rows) | 42 | D42-1…D42-7 | no |
| C42-4 (runtime §3.1/§12.5) | 42 | R42-1…R42-4 | no |
| C42-5 (55/59 implement; 58/60 remeasure; 43 fold) | 42 | this file + D42-6, E42-5, S42-9 | no |

Every request above has exactly one destination row (a request may reach several
sections of one coherent diff group, but is routed once). The integrated audit
checker (`fixtures/m3/audit/tools/check-audit.mjs`) fails if a C38/C39/C40/C41/C42
id is missing from this table, appears twice, or names a destination row that is
not in §2.

---

## 4. Gate K open items — exact conflict and repair disposition

All six items below were left open by packet 43 and are **resolved by the Gate K
bounded repair step** (`../../../handoffs/gate-k-repair.md`); none remains open.

| # | request | exact conflict | packet 43 action |
|---|---|---|---|
| 1 | R40-16 (`runtime.md` §11 change-rule bullets) | The `diffs/runtime.md` summary declares `R40-16 \| §11 "Change rules" \| insert bullets`, but the file contains **no `### R40-16` section and no §11 bullet text**. The accepted `runtime.md` §11 "Change rules" therefore gets no M3 addendum, while `gameplay.md` §12 and the other diffs declare their change rules. | **Resolved — FU-6/K-1 (repair, not drop):** `diffs/runtime.md` R40-16 now carries the exact OLD (last accepted §11 bullet) and NEW (+ the three M3 bullets, rule text `gameplay.md` §12) text, so the accepted §11 gets its addendum and the row is promotable. |
| 2 | C41-1 (`GameView.playerMotion`) | `presentation.md` §41.3.6 rule 1 says the role selector consumes `GameView.playerMotion` and §41.3.7 requests the field from `gameplay.md` §6, but `gameplay.md` §6's `GameView` has **no `playerMotion` field** and `diffs/runtime.md` R41-4 confirms packet 41 adds none. The selector's committed input is therefore unnamed. | **Resolved — FU-4/K-2:** `gameplay.md` §6 now declares `readonly playerMotion: PlayerMotion` (`{ speed: number; grounded: boolean }`) with its exact derivation (last completed controller result; no new state, no second writer), R40-17 is the runtime row, the packet-40 `game-view` fixture is extended, and `presentation.md` §41.3.7/§41.11 record C41-1 resolved. |
| 3 | C40-10 / C41-6 (`platformer-game` public export) | Three readings of one export name: `gameplay.md` §11 lists `sessionSpec`/`cameraSpec`; `delivery.md` §3.4 and `diffs/dependencies.md` D42-2 list `platformerGameSpec`; the packet-42 fixture `delivery/deps/dependency-rows.json` lists `platformerGameSessionSpec`. One unit cannot have three names. | **Resolved — FU-7/K-3, coordinator-adjudicated:** adopt `platformerGameSessionSpec` + `platformerGameCameraSpec` (the fixture reading), because `@thirdlight/platformer` already exports `platformerSpec` and a near-identical `platformerGameSpec` would be ambiguous in the shared composition; `PLATFORMER_GAME_MODULE_ID`, `stepZones`, `zoneOverlap`, `followCamera`, `CAMERA_CONSTANTS`, `RUN_LIMITS` are kept. Applied to `gameplay.md` §11, `delivery.md` §3.4, D42-2 and the delivery fixture; D42-2/NC-1 are unblocked. **Flagged for owner confirmation** (§8). |
| 4 | C39-6 (`game_config_invalid`) | `model.md` §23.9 defines the code as carrying `path` **and** `reason`; `diffs/commands.md` C9 gives the carries-shape as `path`; the packet-39 fixture `contracts:envelope/invalid/game-*` validates only `path`. | **Resolved — FU-2/K-4:** adopt `path` + `reason`. C9, the PM9 row, `model.md` §23.9 and `game_config_invalid` references now agree; the packet-39 checker requires a `reason` on every `game_config_invalid` fixture and a new `game-extra-field.json` fixture exercises `field_unexpected`. |
| 5 | C40-13/C41-9 (manifest example identity values) | `delivery.md` §2.2 and `delivery/manifest/manifest-v2-example.json` pinned `@thirdlight/runtime` `0.3.0` `apiVersion 2`, `@thirdlight/platformer` `0.2.0`, `@thirdlight/platformer-game` `0.3.0` and `@thirdlight/three` `0.186.0`; the repository packages are all `0.1.0`. | **Resolved — FU-5/K-5:** the example now uses the repository's real `0.1.0` package versions and is explicitly marked illustrative (both in `delivery.md` §2.2 and here), with packet 58 owning derivation from the real pin table/lockfile. The engine pin id `@thirdlight/three` is **kept**: it is the accepted `sessions.md` §17.1.1 / M2 export convention (evidence `docs/acceptance/evidence-m2/36/artifacts/manifest.json`), so renaming it to `three` would regress an accepted contract. |
| 6 | 39 / 41 component count | `model.md` §23.3 and `diffs/project-model.md` PM5 both said the v3 registry adds “**seven** components” and then list **six** (`gameZone`, `playerSpawn`, `cameraFollow`, `light`, `surface`, `modelAnimation`); the v2 registry has 8 entries and the v3 registry line lists 14, so the correct count is **six**. | **Resolved — FU-1/K-13:** corrected to “six” in `model.md` §23.3, `diffs/project-model.md` PM5 and `delivery.md` (C39-1 row). The wrong word was “seven”; no component was added or removed. |

All six items are resolved by the bounded repair; no naming/ownership/version
question is left open before packet 44 starts.

---

## 5. Packet 43 reconciliation — explicit supersession of obsolete M1/M2 non-goal wording

Packet 43 owns the rows below (PM43-*), which exist **only** to scope accepted
non-goal sentences so a reader cannot take them as forbidding the reviewed M3 v3
data. No requirement is added, removed or weakened. Exact OLD text (as `grep`
shows it today) and the NEW scoping sentence:

| row | file/section | OLD (exact quote) | NEW (replacement/addition) |
|---|---|---|---|
| PM43-1 | `project-model.md` §1 "Explicit non-goals for M1" | `no shader or material graphs, no assets (boxes are procedural primitives with an inline material), no lights, no multi-scene projects.` | `no shader or material graphs, no assets (boxes are procedural primitives with an inline material), no lights, no multi-scene projects — all scoped to M1's schemaVersion 1. Scene schemaVersion 3 adds the bounded `light`/`surface` components of §23.3.4/§23.3.5; this M1 sentence is not a v3 non-goal.` |
| PM43-2 | `project-model.md` §14 "What is deliberately not in this contract" | `still no subresource references, no lights, and no materials beyond box.material.color and the imported GLB's own core-PBR materials.` | append: `That bullet is scoped to scene schemaVersion 1/2. Scene schemaVersion 3 adds the reviewed bounded `light` component (one directional key + one ambient fill, §23.3.4) and the copied-value `surface` component (§23.3.5, §18.1 rule 3's single version-local exception aside); it adds no material graph, no light beyond those two and no linked material resource.` |
| PM43-3 | `export.md` §8 "What is deliberately not in M1" | `No asset pipeline, no textures, no GLB/glTF, no asset identities or reimport (charter §3/M2), no lights, no audio files.` | append: `This §8 list is scoped to an M1 export. An M3 export (manifestVersion 2) delivers declared GLB/WAV artifacts, asset identities and the reviewed light/surface data; it still adds no asset pipeline authoring, no texture pipeline, no background music and no remote/CDN media.` |

These three rows are the **only** accepted-contract text packet 43 changes in
proposal form; they are listed in §2.7 and are open for Gate K like every other
row. No other supersession is unresolved: PM13→PM41-1 (§18.1 rule 3),
W3 (workspace §4.5 threshold), R40-11 (runtime §12.4 camera row) and
R42-1/R42-2 (runtime §3.1 C35-5 deferral) all carry explicit supersession notes
in their own rows above.

---

## 6. Gate K promotion order (accepted rows only)

1. `project-model.md` — PM1–PM19 in order, then PM41-1…PM41-7, then PM43-1/PM43-2.
2. `workspace.md` — W1–W9.
3. `commands.md` — C1–C14, then CMD41-1…CMD41-3.
4. `runtime.md` — R40-*, R41-*, R42-* in numeric order, then new `§15`.
5. `gameplay.md` — new contract (R40-15's target), promoted as one document.
6. `presentation.md` — new contract, promoted as one document.
7. `sessions.md` — S42-1…S42-12, then new §20.
8. `export.md` — E42-1…E42-9, then PM43-3.
9. `dependencies.md` — D42-1…D42-7 **last**, after the units they name exist in §2.
10. `decisions/0003-m3-sample-game.md` — §§2–5 statuses written by the Gate K
    reviewer; packet 43 writes none of them.

Every row keeps its §2 status until the docs-only promotion applies the
promotable rows; the repair itself changed proposal text only. Promotion applies
accepted/repaired rows only; it adds no production code, dependency or install.
**Unblocked by the repair:** D42-2 (step 9) and NC-1 (step 5) are now promotable,
so the whole pack except PM13 can be promoted in this order.

---

## 7. Gate K decisions (numbered; verdicts recorded, repairs applied)

1. **K-1** — R40-16 has no body: **resolved (FU-6/K-1)** — packet 40's §11
   bullets are supplied in `diffs/runtime.md` R40-16.
2. **K-2** — `GameView.playerMotion` (C41-1): **resolved (FU-4/K-2)** — the
   field is added to `gameplay.md` §6 with R40-17 and the `game-view` fixture.
3. **K-3** — the `platformer-game` export name: **resolved (FU-7/K-3),
   coordinator-adjudicated** — `platformerGameSessionSpec` +
   `platformerGameCameraSpec` are adopted and the documents/fixture fixed;
   **flagged for owner confirmation** (§8).
4. **K-4** — `game_config_invalid` carries shape: **resolved (FU-2/K-4)** —
   `path` + `reason` everywhere.
5. **K-5** — the manifest example's `modules`/`enginePins` versions:
   **resolved (FU-5/K-5)** — real `0.1.0` values, marked illustrative, packet 58
   derives.
6. **K-6** — accept or reject the three new `PM43-*` scoping rows (§5).
7. **K-7** — accept or reject the C39-5 workspace §4.5 threshold move
   (`≥3`→`≥4`) and the C40-1 runtime §12.4 camera-row supersession.
8. **K-8** — accept or reject the C38-1 CSP token (`'wasm-unsafe-eval'`) and the
   C38-2 `allow="gamepad"` extension on the packet-38 executed evidence.
9. **K-9** — accept the PR-5 dependency rows for `platformer-game`/`game-host`
   (D42-1…D42-5) including the editor-UI import prohibition.
10. **K-10** — confirm the `manifestVersion` 1→2 ownership (packet 42) and that
    the authoring `project.json` stays `schemaVersion` 1.
11. **K-11** — confirm the two new contract homes (`gameplay.md`,
    `presentation.md`) are accepted as documents.
12. **K-12** — resolve every §4 item; **all six are resolved by the repair**.
13. **K-13** — the v3 registry adds **six** components, not “seven”:
    **resolved (FU-1/K-13)**.

K-6…K-11 were accepted by the Gate K review (`gate-k.md`, verdicts in §2); the
repair applies them as text and records no new acceptance.

---

## 8. Gate K bounded repair — dispositions, final count and coordinator adjudication

**Repair step:** 2026-09-19, `../../../handoffs/gate-k-repair.md`. Docs/proposal/
fixture repair only: no accepted contract (`docs/contracts/**`), package, `tools/`
file, `package.json` or lockfile changed, and no promotion. **Final inventory
count: 110 rows** (105 section-diff rows incl. R40-17 + 3 `PM43-*` + 2
`NC-*`); **97 `open`, 13 repaired/rejected** → every previously accepted row is
promotable.

| repair id | row(s) | disposition |
|---|---|---|
| FU-1/K-13 | PM5 | “seven”→**“six”** in `model.md` §23.3, PM5, `delivery.md` |
| FU-2/K-4 | PM9, C9 | `game_config_invalid` carries **`path` + `reason`** everywhere; fixtures + checker enforce it |
| FU-3 (B3) | PM9, PM19, C9, C11 | `spawn_transform_unsupported` **registered** in `model.md` §23.9 and the §5.4 row, split from `zone_transform_unsupported`; negative fixture `contracts:envelope/invalid/spawn-parented.json` |
| FU-4/K-2 | R41-1, NC-1, NC-2, **R40-17 (new)** | committed `GameView.playerMotion` + derivation + runtime row + `game-view` fixture; C41-1 resolved |
| FU-5/K-5 | S42-7, E42-7 | real `0.1.0` identity values, marked illustrative, packet 58 derives |
| FU-6/K-1 | R40-16 | §11 OLD/NEW bullets supplied in `diffs/runtime.md` |
| FU-7/K-3 | D42-2, NC-1 | export-name rename to `platformerGameSessionSpec`/`platformerGameCameraSpec`; rows unblocked |

**Coordinator adjudication (K-3), flagged for owner confirmation.** The three
readings of the `platformer-game` module-spec export were resolved by adopting
`platformerGameSessionSpec` + `platformerGameCameraSpec` — the packet-42 fixture
`delivery/deps/dependency-rows.json`'s reading — because `@thirdlight/platformer`
already exports `platformerSpec` and a near-identical `platformerGameSpec` would
be ambiguous in the shared `game-host` composition. This is a bounded
coordinator decision (recorded as such, not an owner acceptance); the owner may
reverse it before promotion, in which case `gameplay.md` §11, `delivery.md`
§3.4, `diffs/dependencies.md` D42-2 and the fixture must move together. All other
repairs implement the Gate K review verbatim and are not adjudications.

**Promotion precondition:** with §4 empty and PM13 the only non-promotable row,
the next step may promote the accepted/repaired rows **docs-only** (including
D42-2 and NC-1) — see §6. No production code, install, commit or owner approval
is part of that step.
