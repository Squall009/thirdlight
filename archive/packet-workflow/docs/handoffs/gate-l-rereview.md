# Gate L re-review — GR-L-1, GR-L-2, the reopened sections, the promotion and CC-L-1

**Verdict: ACCEPT WITH BOUNDED FOLLOW-UPS — no P1 open.** GR-L-1 and GR-L-2 are
genuinely repaired and independently re-derived; the reopened
§16.5.1/§16.5.2/§12/§13.2/§18.9.2/§22.2/§23.11 sections are internally
consistent and yield a loadable destination in every reachable case I could
construct; most promoted contract rows landed. Two P2s remain (the recorded
CC-L-1, and a pre-existing `queryProject` content-summary gap the promotion
extended), plus P3 documentation/fixture hygiene. None blocks packet 49.

**This is a session review** — a fresh read-only reviewer subsession that wrote
none of the work and none of the first Gate L review. It is **not owner
approval and not an independent human review**, and it is recorded under the
owner's M3 execution authorization. No contract, fixture or product file was
edited to make a check pass; the only artifact written is this file.

## 1. Scope

Packets 44–48, the Gate L repair + docs-only promotion
(`docs/handoffs/gate-l-repair-promotion.md`, treated as a claim, not proof), the
owed fresh re-review of the reopened sections (`repair-cc44-3-4.md`) and the new
CC-L-1. Current working tree (`5b746ee` + the uncommitted M2/M3 work; M3 is
uncommitted, as at Gate L).

## 2. Commands run (actual results, repo root, Node 22.22.1)

| Command | Result |
|---|---|
| `npm test` | **exit 0 — 147 files / 1867 tests** (41.6 s) |
| `npm run typecheck` | exit 0 (all packages) |
| `npm run check-deps` | exit 0 (exact pins) |
| `npm run check-boundaries` | exit 0 — 15 packages, **297 files / 1167 specifiers, 0 violations** |
| `npm run build` | exit 0 — 4 built, 0 skipped |
| `node fixtures/m2/contracts/tools/check-fixtures.mjs` | exit 0 — **34/34** |
| M2 behaviors/input/course/runtime/physics checkers | exit 0 each |
| `node fixtures/m3/contracts/tools/check-fixtures.mjs` | exit 0 — **39 groups** |
| contracts controls A/B/C/D (byte, key-order, repaired §16.5.1/§16.5.2) | **exit 1** each, expected checks fire (C: `component_unknown`; D: `publishedRevision ≤ revision`) |
| `node fixtures/m3/gameplay/tools/check-fixtures.mjs` | exit 0 — **23 groups / 127 checks** |
| gameplay manual corruption | **exit 1** — **13 failures in 7 groups** |
| `node fixtures/m3/media/tools/check-fixtures.mjs` (+`--corrupt-control`) | exit 0 — **13 groups / 115 checks**; **9/9 detected** |
| `node fixtures/m3/media/tools/generate-fixtures.mjs --check` | exit 0 — **65 files reproduce exactly** |
| `node fixtures/m3/delivery/tools/check-fixtures.mjs` (+control) | exit 0 — **16/153**; both corruptions exit 1 |
| `node fixtures/m3/storage/tools/check-fixtures.mjs` (+control) | exit 0 — **9 groups / 10 checks**; **6/6 detected** |
| `node fixtures/m3/audit/tools/check-{audit,promotion}.mjs` (+controls) | exit 0; controls 3/3 and 3/3 detected |
| `node fixtures/commands/tools/generate-fixtures.mjs --check` | exit 0 — **73 files byte-identical** |
| `npx vitest run tests/integration/m3-content/` | exit 0 — 3 files / **37 tests** |
| CC-46-1 control (my copy, `{ok:true}` retry stub restored) | contracts checker **exit 1** (`[migration] … result must carry a known op string (not a stub)`); real pipeline refuses `retry_records_invalid` |

Independent execution used the real modules via esbuild-bundled probes over
`packages/*/src/index.ts` (not the pure re-implementation checkers) plus the
committed fixtures.

## 3. Re-derived findings

### 3.1 GR-L-1 — **AGREE, resolved**

- `packages/project-model/src/content.ts` `validateBehaviorSource` now accepts
  `published >= 0` (message/`expected` updated, comment naming the two
  provenances); `-1` is still refused.
- `project-model.md` §12.3 step 5 and §22.2 rule 4 already read the bound as
  "`≥ 1` for a record written by the preparation path — `≥ 0` for a record
  written by the `workspace.md` §16.5.2 copy". §13.2 rule 5, §18.9.2 rule 4 and
  §16.5.2's reset row agree.
- **My own probe** (`/tmp/rr/probe-gl1.ts`, committed `migration/v2-source` +
  committed `compiled-example.json` `record` + its real container blob):
  record `source` non-null, `source.publishedRevision` 4, digest `e75ed7cf…`
  equals the real 677-byte container's SHA-256; source `queryProject` **ok,
  revision 6** and `captureContentView` ok; `migrateProjectCopyV3` →
  `{"ok":true, newRevision:0, revisionPolicy:"reset-to-zero", blobsCopied:2}`;
  destination `behaviors[0].publishedRevision === 0`,
  `behaviors[0].source.publishedRevision === 0`, container blob copied, marker
  removed, destination `queryProject` ok (revision 0). A trust-bearing variant
  (entry `acknowledgedRevision` 4 → 0) also migrates and loads. Negative
  control: `source.publishedRevision = -1` still refuses with
  `number_out_of_range`. The committed test
  (`packages/workspace/tests/m3-migration.test.ts`, "carries a prepared
  behavior record") is **non-vacuous**; it matches my probe.

### 3.2 GR-L-2 / CC-48-3 — **AGREE, resolved** (one untested path)

- `packages/workspace/src/session.ts` `queryProject` serves
  `scene.schemaVersion`; `types.ts` `QueryProjectResult.scene` carries it;
  `backend.ts` full-state (line 436) and play snapshot (line 972) read
  `q.scene.schemaVersion` / `state.scene.schemaVersion`.
- The three tests assert real values (v3 storage fixture → **3** with manifest
  **1**; M1 default → **1**; full-state over the real transport → **3** and
  `validateFullStateFrame` passes). My probe of the real workspace service on
  `fixtures/m3/storage/project-v3-demo-0003` returns
  `scene: {"sceneId":"scene-main","schemaVersion":3,"entityCount":9,"cameraId":"cam-main"}`.
- Fixture regeneration is **exactly** the contract-implied shape change:
  `git diff --stat -- fixtures/commands` shows 5 files × 1 line + the generator
  line, adding `schemaVersion` between `sceneId` and `entityCount`, matching
  real key order and the `commands.md` §5.6 example; `--check` 73/73 byte-clean.
- **Disagreement/gap (P3):** the play snapshot's `scene.schemaVersion` has **no
  test** asserting the v3 value (no integration/unit test covers `POST /play`
  with a v3 project). Code-inspected only.

### 3.3 Promoted contract text — mostly landed

Landed and consistent with the code: CC-44-6 (`project-model.md` §19.2 step 1 +
`workspace.md` §16.6 item 4), CC-45-1 (F1 `references`), CC-45-2 (F8/F9/F12
request pointers, strictly asserted by the replay test), CC-45-3 (F10 `ok`),
CC-45-4 (`commands.md` §3.1.1), CC-45-6 (§5.6 v3 keys; but see P2-B), CC-45-8
(§5.4 `game_config_invalid`), CC-47-4 (§41.7.3), CC-47-5 (§41.4.5/§41.7.1
`6` as a structural maximum; `GAME_ZONE_LIMITS.checkpointZones === 1`
verified), CC-48-2 (route exists in `backend.ts`, body `{newProjectId}`, error
set matches), CC-48-3. CC-45-5 (prefab-failures F18) is unchanged and M2 stays
34/34; CC-45-7 is explicitly superseded by CC-L-1 and not applied.

**Wrong about the code (P3-1):** `workspace.md` §16.9 says
`SCENE_VERSIONS_BY_DOCUMENT` — the symbol is
**`SCHEMA_VERSIONS_BY_DOCUMENT`** (no such name exists anywhere); and it lists
`canonicalContentV3` (`project-model` bullet) and `GAME_CONFIG_FIELDS`
(`commands` bullet) as public exports, but neither is re-exported by the
package index (`packages/project-model/src/index.ts`,
`packages/commands/src/index.ts`; each package's only entry is `src/index.ts`).
**Not applied (P3-2):** CC-47-1 (accepted at Gate L "accept") was to add a note
naming every stale packet-41 placeholder fixture; no such note exists in
`docs/contracts/**` (`grep placeholder`) and the promotion table omits CC-47-1.

### 3.4 Reopened sections — **internally consistent, destination loadable**

§16.5.1/§23.11 (v2 registry precondition + superset) match the repaired fixture,
the operator (`component_unknown` → `migration_source_invalid`) and control C.
§16.5.2's reset row matches the operator `deriveV3Content` exactly (assets,
behaviors, `source`, `behaviorTrust` → 0; `game: null`), and §12.3 step 5 /
§22.2 rule 4 / §13.2 rule 5 / §18.9.2 rule 4 agree. Reachable cases I exercised
all produce a loadable destination: behavior-free (byte-equal to the committed
destination), prepared-behavior, prepared-behavior + trust entry. Minor stale
wording (P3): §19.2 step 2 still says "resolve each to `(currentVersion, …)`"
while step 1 gives the binding's explicit version precedence.

### 3.5 CC-L-1 — **CONFIRMED (P2). Reproduction and verdict**

Real command engine (esbuild-bundled `@thirdlight/commands`), envelope
`fixtures/m3/contracts/envelope/valid/demo-0003-media-v3.json`, atomic reimport
of `asset-model-courier` with the §41.3.4 mapping:

```
BEFORE component: {assetId: asset-model-courier, version: 1, roles: {idle/run/airborne: {binding: packet-41-placeholder}}}
AFTER  component: {assetId: asset-model-courier, version: 1, roles: {idle:{clipIndex:0,clipName:idle}, …}}
AFTER  asset currentVersion: 2 (versions [1,2]);  change.animation = {previous, next: <roles only>}
version-moved: false;  roles-replaced: true;  entity version == asset currentVersion: false
undo → roles restored, record back to currentVersion 1, version never moved
```

`packages/commands/src/content-ops.ts` writes
`components.modelAnimation = {...component, roles}` (version untouched) and
records `animation.previous/next` as `ModelAnimationRoles` only; `commands.md`
§8.5.1 says "replaces the entity's `roles` value". This **contradicts**
`presentation.md` §41.3.4 rules 4–6 ("the runtime loads the new version against
the new mapping"; reordered-clip reimports must work) and §41.3.6 rule 7
(`setRoles(roles, version)` re-checks against the loaded clips). `captureContent`
pins the entity's `version`, so the reimported bytes are never delivered for
that entity — a silent no-op success. **The proposed diff's direction is
correct and necessary**; the change/inverse must carry the full
`ModelAnimationComponent` (otherwise undo would leave `version 2` above a
`currentVersion 1`). It is **incomplete as recorded**: it should also update
`commands.md` §8.5.1's `PublishAssetChange.animation` interface (§9.1 inverse),
`commands-md`-backed `packages/commands/src/types.ts`, `presentation.md` §41.3.4
rule 3 (change shape) and reconcile §41.3.1's "a reimport … never moves the
recorded binding" with §41.3.4 rule 1/5/6. **Not a Gate L blocker** (recorded
contract change, owner + checkpoint before the dependent packet), but it must
be fixed **before packet 53** and I recommend it now (it is small), since it
also invalidates CC-45-7's earlier acceptance.

## 4. Remaining findings

- **P2-A — CC-L-1** (above). Owner: packet-45 command owner (bounded repair);
  checkpoint: before packet 53 / Gate N (recommend before 49).
- **P2-B — `queryProject`'s §5.6 content summary is not served.**
  `commands.md` §5.6 documents `queryProject` returning `{assets, prefabs,
  behaviors, settingsKeys}` (v3 + `game/zones/spawns/audioAssets`), and the
  frozen M2 fixture `fixtures/m2/contracts/commands/queries.json` pins it, but
  no served query produces it: my probe (`/tmp/rr/probe-qp.ts`) shows the real
  workspace result keys are `ok, projectId, revision, manifest, scene, history,
  workspace`; the HTTP `/commands` route returns the workspace result verbatim;
  `commands.contentCounts` is exported and never called by product code; no
  test asserts `settingsKeys`. The M1 generator (which mirrors the real
  projection) also omits it. Pre-existing (M2), not caused by the repair, but
  the CC-45-6 promotion extended §5.6 to v3 for a field no client can observe.
  Minimal repair: serve `contentCounts` from the workspace `queryProject` (v2
  4 keys / v3 8 keys) + a test, **or** correct §5.6 and the frozen fixture.
  Owner: packet-46/48 query scope; checkpoint: before M3 acceptance.
- **P3-1 — §16.9 symbol/export names** (above). Owner: next docs-only
  promotion; checkpoint: M3 acceptance.
- **P3-2 — CC-47-1 note unapplied.** Owner: next docs-only promotion;
  checkpoint: M3 acceptance.
- **P3-3 — frozen M2 query example is stale.** `queries.json`'s `queryProject`
  scene is `{sceneId, entityCount, cameraId}` (no `schemaVersion`), so the
  frozen evidence now contradicts the promoted §5.6 example; it also shows the
  unserved content summary. The M2 checker stays 34/34 because it never
  executes this fixture against the product. Owner: fixture owner; checkpoint:
  M3 acceptance.
- **P3-4 — `docs/acceptance/m3-report.md` staleness.** §2 says 1866 tests (now
  **1867**, the GR-L-1 test); §1 header says "implementation is at packet 45 of
  62" while its own table lists 46–48 done; §3 still has the duplicated B17 row
  (Gate L P3). All rows' browser/audio/hardware halves remain honestly
  UNVERIFIED; B01 is now honestly PASS for the behavior-bearing fixture too.
  Owner: acceptance-report owner; checkpoint: M3 acceptance.
- **P3-5 — `fixtures/m3/contracts/README.md` stale placeholder paragraph.**
  It still describes the audio record as `recipeVersion: 0`, empty toolchain
  (no such value remains in any fixture); the `modelAnimation` role placeholder
  half is still accurate. Owner: fixture owner; checkpoint: M3 acceptance.
- **P3-6 — the two contract envelopes' `modelAnimation.roles` are still
  `{"binding":"packet-41-placeholder"}`**, which does not satisfy
  `presentation.md` §41.3.1's `AnimationRoleBinding`; a v3 load accepts them
  only because §23.3.6 requires just a non-empty object. A real-roles fixture
  is owed before packet 53's `setRoles` evidence. Owner: packet 53; checkpoint:
  packet 53 evidence.
- **P3-7 — `commands.md` §3.1.1** now states both "`kind` … **required on
  `create`**" and the CC-45-4 "on a v3 state it is required; on v1/v2 an absent
  `kind` defaults to `model`" — ambiguous as text (the code is unambiguous).
  Owner: next docs promotion.

## 5. Bounded follow-ups (owner → checkpoint)

| Item | Owner | Checkpoint |
|---|---|---|
| P2-A CC-L-1 (complete diff + repair + test) | packet-45 command owner | before packet 53 (recommend before 49) |
| P2-B `queryProject` content summary (serve or correct) | packet-46/48 query owner | before M3 acceptance |
| P3-1 §16.9 symbol/export names | next docs promotion | M3 acceptance |
| P3-2 CC-47-1 note | next docs promotion | M3 acceptance |
| P3-3 M2 `queries.json` staleness | fixture owner | M3 acceptance |
| P3-4 report staleness | report owner | M3 acceptance |
| P3-5 contracts README placeholder text | fixture owner | M3 acceptance |
| P3-6 real `modelAnimation.roles` fixture | packet 53 | packet 53 evidence |
| P3-7 §3.1.1 wording, §19.2 step 2 wording, play-snapshot test | docs/packet-48 owner | M3 acceptance |

## 6. UNVERIFIED

- Everything browser/audio/hardware/physical-input: preview/render visuals,
  `decodeAudioData`, audible output, physical gamepad, display, hardware GPU.
  No browser run was performed in this re-review.
- v3 Play/runtime (packets 49–62), including the play snapshot's v3
  `scene.schemaVersion` (code-inspected only).
- Third-party GLB acceptance (fixtures are repository-generated).
- Byte-level non-modification of the M1/M2 fixture sets against a baseline: the
  whole M2/M3 tree is uncommitted, so no git baseline exists; I can only certify
  the repaired artifacts by content (v2-source retry `records: []`; index 39
  groups; media 65 generated files; 34/34 M2).
- That package-lock/`package.json` edits in the tree belong to earlier packets,
  not this repair (uncommitted tree).

## 7. Final verdict

**ACCEPT WITH BOUNDED FOLLOW-UPS.** GR-L-1 and GR-L-2 are fixed and
independently reproduced; the reopened sections are re-accepted; the docs-only
promotion landed with three naming/omission defects and one pre-existing query
gap; CC-L-1 is a real, reproduced P2 that is recorded (not silently changed) and
must be repaired before packet 53. No P1 is open, so the Gate L block is lifted
and **packet 49 may start**; nothing in this record is owner approval or an
independent human review.
