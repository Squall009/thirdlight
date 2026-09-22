**PROPOSED — not accepted.** Packet 39, part **39-A**
(`docs/planning/m3-packets.md` §39). This document proposes normative text for
**workspace §16 (v3 envelope and v2→v3 copy migration)** and the small edits to
§§3/4.2/4.5/11/13.9/14/15 listed in
[`diffs/workspace.md`](diffs/workspace.md). Nothing in `docs/contracts/**` is
changed; Gate K records accept/reject per diff, and a separate docs-only
promotion applies accepted rows before packet 44. The scene data model is
[`model.md`](model.md) (project-model §23); the command surface is
[`authoring.md`](authoring.md).

Read basis: as `model.md`, plus `workspace.md` §§3/4.1/4.2/4.3/4.4/4.5/5/6/7.6/8/
11/13/13.9/14/15 and `content-storage.md` §§2/3/4/6/9/11/12 (M2 house style).

---

## 16. Storage v3 and the v2→v3 copy migration

### S1 Scope and non-goals

This section defines the v3 authoring envelope, its durable/blob consequences and
the explicit v2→v3 **copy** migration. It does not define scene data
([`model.md`](model.md)), commands ([`authoring.md`](authoring.md)), publication
internals (accepted §13), the WAV import profile or audio bytes (packet 41), or
the runtime-content export `manifest.json` (`manifestVersion` 1→2, **packet 42**).

Non-goals (unchanged from §§12/13.10 and M2): in-place upgrade, downgrade,
garbage collection, blob deletion, version eviction, a second mutable document,
a catalogue side-car, multi-file authoring transactions, remote/URL content, and
any authoring path outside the project tree.

### S2 Envelope version compatibility (v3)

`storageVersion` known set is `[1, 2, 3]`. The exhaustive table of §4.5 gains
exactly one passable row (`manifest 1 + scene 3 + storage 3`); all other new
pairs are single-error refusals checked **before** scene/content field
validation. The v3 combination's envelope carries the six-key `content` block of
§S3.

| `manifest.schemaVersion` | `scene.schemaVersion` | `storageVersion` | Result |
|---|---|---|---|
| 1 | 1 | 1 | **valid** — M1, unchanged |
| 1 | 2 | 2 | **valid** — M2, unchanged |
| 1 | 3 | 3 | **valid** — **v3** (`content.game` present) |
| 1 | 1 | 2 | `version_combination_unsupported` (accepted, unchanged) |
| 1 | 2 | 1 | `scene_invalid` → `schema_version_unsupported` (accepted, unchanged) |
| 1 | 1 or 2 | 3 | `version_combination_unsupported` |
| 1 | 3 | 1 or 2 | `version_combination_unsupported` |
| 2 | any | any | `manifest_invalid` → `schema_version_unsupported` |
| any | any | ≥ 4 or ≤ 0 | `storage_version_unsupported` |
| any | ≥ 4 | any | `schema_version_unsupported` for that document |

Non-destructive refusal rule (normative, restated for v3): the refusal is exactly
one error at the envelope's `storageVersion` (or the document's
`schemaVersion`) path; deeper scene/content checks stop; the on-disk bytes are
retained **byte-identically**; the startup scan, open and every query perform no
normalization, upgrade, downgrade, repair or write. An unsupported project is
reported under `project_unavailable.reason` with that code. A v3 project opened
by a v2-only engine behaves exactly as an M2 project opened by an M1 engine:
`storage_version_unsupported`, bytes retained.

### S3 Storage v3: the authoring-state envelope

The envelope file, atomic replacement and durability guarantees are unchanged
(§§4/5). `storageVersion` **3** has the same top-level key set as v2:
`{storageVersion, type, projectId, scene, content, retry}`.

```json
{
  "storageVersion": 3,
  "type": "authoring-state",
  "projectId": "demo-0003",
  "scene": { "schemaVersion": 3, "sceneId": "scene-main", "revision": 0, "entities": ["…"] },
  "content": {
    "assets": [],
    "prefabs": [],
    "behaviors": [],
    "settings": {},
    "behaviorTrust": { "entries": [] },
    "game": null
  },
  "retry": { "retention": 128, "records": [] }
}
```

Differences from §4.2's v2 row (additive only):

| Aspect | v3 rule |
|---|---|
| key set | exactly the six keys above; a missing or unknown key ⇒ `envelope_invalid` |
| `scene.schemaVersion` | must be exactly `3` (combination check §S2 precedes field validation) |
| `content` keys | exactly `assets, prefabs, behaviors, settings, behaviorTrust, game` |
| `content.game` | **required key**; `null`, or a `GameConfig` value ([`model.md`](model.md) §23.4) |
| everything else | unchanged: `scene.revision` is the sole revision; `retry` unchanged; `projectId` = directory name = manifest `id`; canonical §4.4 serialization extended with the v3 content key order and the §23.7 component/field orders |
| buffers | the backend holds the normalized v3 scene, the normalized content catalog (including the normalized `game` block or `null`), `currentVersion` maps, integrity report, retry map, last-written hash, empty history |

`content` byte budget: §13.9's 1 048 576 B stands, unchanged. The `game` block
adds its own ≤ 16 384 B bound (`game_bytes`, [`model.md`](model.md) §23.10) and
is counted inside `content_bytes`. No new envelope size class exists.

### S4 Load validation pipeline (v3 branch, normative order)

The §4.3 pipeline dispatches on `storageVersion`. The v3 branch is the v2 branch
with these substitutions; every other step (strict parse, `envelope_invalid`,
retry block, manifest, cross-document, ownership, external change) is unchanged:

1. step 2: envelope structure/`type`, v3 six-key set ⇒ `envelope_invalid`;
2. step 3 (§4.5): `scene.schemaVersion === 3` and `storageVersion === 3` ⇒ else
   exactly one `version_combination_unsupported`, deeper checks stop;
3. step 4: `scene` → v3 scene validation ([`model.md`](model.md) §23.8) ⇒
   `scene_invalid` (≤ 10 model errors);
4. step 4: `content` → `validateContent` for the six-key v3 block ⇒
   `content_invalid`, and canonical `content` bytes ≤ 1 048 576 ⇒
   `content_invalid` (`limits_exceeded` `content_bytes`), `content.game` bytes ≤
   16 384 ⇒ `limits_exceeded` `game_bytes`; both error sets are reported when
   both fail;
5. step 4: cross-block check `validateProjectV3` = accepted v2 cross-block check
   **plus** the §23.5/§23.8-step-6 game/cue/animation reference checks ⇒
   `asset_reference_missing` / `asset_kind_mismatch` / `game_reference_missing`
   (`document: "scene"` or `"content"` as appropriate);
6. steps 7–8 unchanged: retry block, manifest (must be `schemaVersion` 1),
   `manifest_scene_mismatch`, `manifest.id === envelope.projectId === directory
   name`.

A v3 combination mismatch stops before any scene/content field validation. A v2
envelope is loaded by the unchanged v2 branch; no v3 code path runs on it.

### S5 Migration: v2 project → v3 project copy

Migration is **explicit, operator-driven and non-destructive**. It is never an
open-time side effect and is never exposed to the browser or MCP as a mutation.

#### S5.1 Preconditions

- The source project ID exists and is loadable under the **v2 pipeline**
  (`storageVersion 2`, scene `schemaVersion 2`, manifest `schemaVersion 1`), and
  is not currently owned by a live *other* backend (the migration reads it; it
  never edits, claims, releases or rewrites it).
- The destination project ID is a new, valid ID-syntax value, and
  `<root>/projects/<newProjectId>` contains neither a loadable project nor a
  migration marker for different IDs.
- A v1 source is **refused** by this operator (`migration_version_unsupported`,
  `sourceVersion: 1`). v1 projects use the accepted v1→v2 copy
  (`migrateProjectCopy`, §14) **first**, then this v2→v3 copy on the resulting
  destination; chaining two copy operators is the only supported v1 route. There
  is no direct v1→v3 operator and no in-place upgrade.
- An unsupported **new** mix is refused: a destination request that would have to
  write a combination outside §S2 fails before any write with
  `migration_version_unsupported`.

#### S5.2 Result and identity/revision policy

| Aspect | Policy |
|---|---|
| destination identity | **new project** (`newProjectId`); new manifest, `id = newProjectId`, source `name` carried over, new `createdAt` |
| manifest `schemaVersion` | stays **1** (the authoring manifest is never re-versioned) |
| scene | `schemaVersion` 2 → **3**; every entity value/order/ID/hierarchy/transform/component carried **verbatim** (byte-identical values) |
| content | carried **verbatim** — `assets` (records, versions, recipes, metrics, timestamps), `prefabs`, `behaviors`, `settings`, `behaviorTrust` are copied unchanged; `game` is added as **`null`** |
| storage | `storageVersion` 2 → **3** |
| revision | **reset to 0** (`revisionPolicy: "reset-to-zero"`) |
| retry records | **cleared** (`retry.records: []`), `retention: 128` |
| history | not carried (in-memory only); the destination starts with empty history |
| source project | **retained byte-for-byte** after success **and** after refusal (`sourceTreeHash` recorded before and after by the operator; the executable test hashes every source file) |
| reported | `{ sourceProjectId, newProjectId, sourceRevision, newRevision: 0, revisionPolicy: "reset-to-zero", historyReset: true, retryCleared: true, blobsCopied, blobsAlreadyPresent, resumed, sourceVersion: 2, newVersion: 3 }` |

Rationale for reset-to-zero is the accepted §14.2 rationale, unchanged: a new
project identity starts its own revision history, and snapshot identity
(`<projectId>@r<revision>`) already distinguishes the projects. Carrying
`assets` verbatim (rather than re-importing) is required because blobs are
immutable and content-addressed: the destination's catalog names the same
digests, so the copy can re-verify bytes instead of re-inspecting them.

#### S5.3 Ordered write sequence and crash completion

Writes go **destination-first, authoritative-last** — the same discipline as §6
and accepted §14.3:

1. `mkdir <dest>`, `mkdir <dest>/.thirdlight` (0755).
2. **Write `.thirdlight/migration.json`** (marker):
   `{ storageVersion: 3, type: "migration-copy", sourceProjectId, newProjectId,
   sourceVersion: 2, newVersion: 3, phase, startedAt }`; `phase` records the last
   completed step (`created` → `manifest` → `blobs` → `envelope`). The marker is
   non-authoritative, is never restored over an envelope, and is excluded from
   every backup (§15).
3. Write the destination manifest (`project.json`) via `W`.
4. Copy every **reachable and unreachable** source blob
   (`sources/sha256/<digest>` for every version of every asset record) via `W`,
   verifying each digest after write; an existing destination blob with the same
   digest is verified and counted `alreadyPresent`. Audio blobs use the same
   layout — there is **no new artifact class**.
5. **Write the destination envelope last** (`scenes/main.json`, §S5.2 values via
   `W`). This is the commit point: before it the destination is not a loadable
   project.
6. **Remove the marker.** The destination is reported complete only after this.

Crash completion (normative):

- A directory containing a valid v3 migration marker and **no envelope** is
  reported by the startup scan as an interrupted migration destination. The §8.3
  deterministic default-envelope completion is **suppressed** for it (creating an
  empty default project would destroy the migration intent).
- `migrateProjectCopyV3(sourceProjectId, newProjectId)` is **idempotent and
  resumable**: it re-verifies existing destination files against their expected
  canonical bytes, re-verifies/copies blobs, and continues from the recorded
  `phase`. Alternatively the operator deletes the destination directory — always
  safe because nothing in it was ever authoritative.
- Marker mismatch (`sourceProjectId`/`newProjectId`/`sourceVersion` not matching
  the request) ⇒ `migration_marker_conflict`; an existing loadable destination ⇒
  `migration_destination_exists`; a v1 or unknown source ⇒
  `migration_version_unsupported`; all refuse **without writing** and leave both
  trees byte-identical.
- `phase: "envelope"` with a loadable v3 envelope means step 5 succeeded and only
  step 6 was interrupted: the resume path verifies the envelope equals the
  expected canonical bytes and removes the marker without rewriting.
- `phase: "blobs"` with all expected blobs present verifies digests and skips to
  step 5. `phase: "created"` with an unexpected non-marker file ⇒
  `migration_destination_exists` unless the file is a temp file (§5.4), which is
  cleaned.

#### S5.4 No silent upgrade, no downgrade, no mixed state

- Opening a v1 or v2 project under M3 uses the unchanged v1/v2 pipeline; M3 never
  rewrites it and never writes a v3 envelope into it.
- Migration always creates a **new** project; there is no in-place conversion, no
  partial manifest/envelope upgrade and no "upgrade on save".
- Downgrade does not exist: v3 writes only `storageVersion 3` envelopes, and a
  v2-only engine reports `storage_version_unsupported` while retaining the bytes.
- There is no supported state in which a project holds a v2 envelope with v3
  scene data or a v3 envelope with v2 scene data: the combination check of §S2
  refuses such a document and the migration operator never writes one.
- M1/M2 loading, editing, publication, capture and export paths are unaffected by
  this section (acceptance rows B01/B18).

### S6 Durable/blob consequences

1. **One mutable file.** The v3 envelope is still the only mutable authoritative
   file; `content.game` lives inside it. There is no `game.json`, no
   `settings.json` and no side-car.
2. **Blob layout is unchanged.** `sources/sha256/<digest>` remains the only
   authoritative content path; audio bytes are content-addressed exactly like
   model bytes. Publication ordering, lock scope and the crash-point table
   (accepted §13.3) are unchanged.
3. **Integrity.** `contentIntegrity` covers every version of every record,
   `model` and `audio` alike; there is no new integrity state. `readBlob` is
   unchanged and kind-agnostic.
4. **Captured view.** The captured content view (`project-model` §19) is
   extended, not re-versioned: `captureContent` collects references from the
   captured scene's `model` **and** `modelAnimation` components, and from the
   captured `content.game` cues/activation references, resolves them to
   `(version, sourceDigest, sourceByteLength, importRecipe)`, sorts by `assetId`
   and computes `contentDigest` unchanged. `contentVersion` stays `1`; the view
   has no new field, so play/export pinning keeps working by revision
   (§19.3 unchanged). A `modelAnimation` binding pins its recorded `version`
   explicitly in addition to the asset's `currentVersion`.
5. **Backup classification** (§15) is unchanged: manifest + envelope +
   every `sources/sha256/<digest>` (model and audio) are included; staging,
   derived caches, ownership, recovery and the migration marker are excluded.
6. **Retention.** v3 has no GC and no version eviction (accepted rule). A
   `modelAnimation` binding to an older version is therefore always deliverable.

### S7 Bounds (storage-side v3 additions)

Scene/component bounds are [`model.md`](model.md) §23.10. Storage adds:

| Class | Bound | Value | Failure |
|---|---|---|---|
| byte | canonical `content.game` | 16 384 B | `content_invalid` (`limits_exceeded` → `game_bytes`), no envelope write |
| byte | canonical `content` (incl. `game`) | 1 048 576 B (unchanged) | as accepted |
| job | migration copy wall clock | 120 s | `content_publish_failed` (`timeout`), destination not authoritative |
| count | migration marker phases | 4 (`created`, `manifest`, `blobs`, `envelope`) | malformed marker ⇒ `migration_marker_conflict` |

These are finite defaults and are **reviewable at Gate K**.

### S8 Workspace operations and error codes (v3 additions)

One operation is added, mirroring accepted `migrateProjectCopy` (§11/§14):

| Operation | Kind | Success result | Failure codes |
|---|---|---|---|
| `migrateProjectCopyV3(sourceProjectId, newProjectId)` | operator (§S5) | the §S5.2 reported object | `migration_version_unsupported`, `migration_source_invalid`, `migration_destination_exists`, `migration_marker_conflict`, `path_rejected`, `content_publish_failed` |

New codes (additive; surfaced via `project_unavailable.reason` or as operation
results): `migration_version_unsupported` (source/new version pair not a v2→v3
copy), plus the model codes of [`model.md`](model.md) §23.9 (`game_reference_missing`,
`game_reference_in_use`, `zone_transform_unsupported`,
`spawn_transform_unsupported`,
`zone_checkpoint_count_invalid`, `zone_goal_missing`, `asset_kind_mismatch`,
`game_config_invalid`), which join the permitted `project_unavailable.reason` set
and the `commands.md` §5.4 table.

### S9 Public exports (proposed; not implemented)

No new package. Proposed additions to the existing public surfaces:
`project-model` — `SCENE_VERSIONS_BY_DOCUMENT`/`KNOWN_VERSIONS` gain `3`;
`migrateSceneV3`, `validateSceneV3`/`validateContentV3`/`validateProjectV3`
(names mirroring the accepted v2 entry points), `GAME_ZONE_ROLES`,
`SURFACE_PRESETS`, `GAME_ZONE_LIMITS`, and the v3 types (`GameZoneComponent`,
`PlayerSpawnComponent`, `CameraFollowComponent`, `LightComponent`,
`SurfaceComponent`, `ModelAnimationComponent`, `GameConfig`, `CueRef`).
`commands` — the §A2–§A6 ops/args/change/inverse types and
`GAME_CONFIG_FIELDS`. `workspace` — `MigrationResultV3` and the
`migrateProjectCopyV3` service method. Exact exports are fixed by packets 44–48;
Gate K accepts the names before implementation.

### S10 Compatibility and change rules

- v3 is a new known combination, not a same-version extension: v1/v2 documents
  stay valid and unmodified, and no v2 field changes meaning.
- The accepted `content` key order gains `game` **after** `behaviorTrust`; every
  v3 envelope fixture carries all six keys. A v2 envelope keeps its five-key set
  and never carries `game`.
- The added limits and codes are contract material because fixtures and the
  checker reference their exact values.
- Every v3 field, op, code, limit and artifact has exactly one owner
  (`model.md` / this file / `authoring.md`); no downstream packet invents a
  missing field or lifetime rule.

### S11 Fixture index

`fixtures/m3/contracts/envelope/valid/*.json` (byte-exact v3 envelopes),
`envelope/invalid/*.json` (one rule each), `migration/{v2-source,expected-v3-destination,
interrupted-copy}/*` (identity/reset/crash outcomes), `commands/*` (legal
edit/inverse/redo, no-change, reachable failures). `index.json` records every
fixture's expectation and SHA-256; `tools/check-fixtures.mjs` replays them and
has a deliberate-corruption negative control.
