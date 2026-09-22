# M4 templates contract — template, initialization, module requirements and layout

## (packet 65 proposal; Gate Q)

**Status: ACCEPTED at Gate Q (2026-09-22).** Promoted per
`docs/handoffs/m4-promotion.md` (owner pre-approval under the standing M4
authorization; final owner manual review pending). Later packets
(72/73/74/76/81) consume the promoted text.

## 0. Relation to the accepted contracts (PR-M4-1)

Accepted text this document builds on (binding; no re-specification):

- `workspace.md` §8 (project creation: two-file non-atomic sequence,
  deterministic crash completion, idempotency), §10 (startup scan), §11
  (operator table + error-code table), §13 (content storage/publication,
  blob classes), §15 (backup classification), §16.5 (the v2→v3 migration
  operator: marker + completed-steps + resume pattern), §6 (ownership claim).
- `project-model.md` §6 (version taxonomy), §7 (project manifest,
  schemaVersion 1, canonical order, immutability), §15 (default scene —
  the accepted "initial envelope is a pure function of the manifest"
  pattern), §23 (v3 scene/storage, the `content.game` block, the
  `modelAnimation` component).
- `commands.md` §2 (the closed M1–M3 command set), §6 (execution pipeline,
  retry dedup), §8 (per-operation semantics: deterministic `<kind>-NNNN`
  ID allocation, `createPrefab`/`instantiatePrefab`, `setComponent`).
- `sessions.md` §6.3 (admin-scoped operator routes).
- `dependencies.md` §4 (package/bundle graph; no new package is introduced
  by this contract — see §12).
- The accepted public workflow: `samples/beacon-reach/recipe/commands.json`
  (26 commands replayed through `@thirdlight/commands` `applyMutation` from
  a fresh v3 scene + baseline camera — `m3-sample.md` §1: "This is a sample
  recipe, not an M4 general template engine"; `m4-plan.md` §2.1: the
  template is "data plus a bounded recipe, not downloaded executable
  scaffolding").

New surface introduced here (all PROPOSED): the template descriptor and its
digests (§1), the template directory/installation/integrity rules (§2), the
normative v3 template base scene (§3), the starter-recipe format (§4), the
`createProjectFromTemplate` operator with its reservation/staging/publication
phases and crash table (§5), the manifest `schemaVersion 2` + `template`
block (§6), the revision/retry/history identity rules for initialization
(§7), the finite M4 module registry + requirement resolution semantics
(§8), the panel-visibility local-preference contract (§9), provenance rules
(§10), the new error codes (§11), and the creation authorization (§12).

## 1. The template descriptor

### 1.1 Shape (exact)

A template is a **directory** with exactly these files:

```
templates/<templateId>/
  descriptor.json          # §1.2 (the only JSON that names itself)
  base/scene.json          # §3 (the v3 base scene document)
  recipe/commands.json     # §4 (the bounded starter recipe)
  sources/**               # starter source blobs (the template's own assets)
  NOTICE                   # provenance/license text (§10)
```

`descriptor.json` (canonical key order — the digest input of §1.3):

```ts
interface TemplateDescriptor {
  schemaVersion: 1;
  type: "thirdlight-template";
  templateId: string;        // project-model §5.1 ID syntax
  name: string;              // 1–128 chars, no control chars
  version: number;           // integer ≥ 1; advances on any content change
  engineVersion: string;     // exact engine version the template was built for (§1.4)
  recipeDigest: string;      // §1.3
  baseDigest: string;        // §1.3 (the base scene document)
  contentDigest: string;     // §1.3 (the descriptor identity)
  blobs: TemplateBlob[];     // sorted ascending by `path`
  modules: { required: string[]; optional: string[] };  // §8
  layout: TemplateLayout;    // §9 (the initial panel-visibility preset)
  provenance: { derivedFrom: string; note: string };    // §10
}
interface TemplateBlob { path: string; digest: string; byteLength: number; }
```

Unknown fields ⇒ `template_descriptor_invalid` (`reason: "field_unexpected"`);
a `blobs` entry whose `path` escapes the template root, is a symlink path, or
contains `..` ⇒ `template_path_rejected` (§2.3). `schemaVersion` exactly 1
(known `[1]`); `type` exactly `"thirdlight-template"`.

### 1.2 The shipped template (the M4 built-in)

One template ships in M4: `templates/platformer-starter/`,
`templateId: "platformer-starter"`, `version: 1`,
`engineVersion: "0.1.0"` (the accepted engine baseline — the engine version
is not bumped by M4). `name: "Platformer Starter"`. It is derived from the
accepted Beacon Reach recipe (m4-plan §2.1): the 26 accepted sample commands
with the template's own game text, plus the packet-65 additions — one
`modelAnimation` binding on the courier model, one `createPrefab` (a beacon
pillar) and **two independent `instantiatePrefab` instances** (closes the
Gate P F4 / B17 carry-forward "no two independent decoration prefab copies"),
and **visible animated content** (the courier's `Idle`/`Run`/`Airborne` clips
bound through `modelAnimation`). The concrete recipe and all values are the
committed fixture (§14: `fixtures/m4/templates/`); this section fixes only
the identity: `provenance.derivedFrom: "samples/beacon-reach"`,
`provenance.note`: the derivation statement (the fixture's README repeats it).

### 1.3 Digests (exact; the accepted block-digest rule)

Block digest (sessions.md §17.1.1 rule, restated): for a value `v`,
`sha256(JSON.stringify(v, null, 2) + "\n")` over the **parsed document** in
its canonical key order (the serialization the committed file uses — the
digest binds the committed bytes, not a re-canonicalization):

- `recipeDigest` = blockDigest(the parsed `recipe/commands.json` document);
- `baseDigest` = blockDigest(the parsed `base/scene.json` document);
- `contentDigest` = blockDigest(the parsed `descriptor.json` document **with
  the `contentDigest` field removed**).

Verification (three independent checks, all at install-load and again at
creation): (1) re-hash the descriptor minus its digest field ⇒ equals
`contentDigest`; (2) re-hash the recipe file's parsed document ⇒ equals
`recipeDigest`; (3) re-hash each `blobs[i]` file ⇒ equals `blobs[i].digest`
and the byte length equals `blobs[i].byteLength`. Any mismatch ⇒
`template_content_mismatch` (carries the failing file/field); the template is
refused for creation and the install scan reports it. No field is ever
"fixed up" from another field — a tampered descriptor is refused, not
repaired.

### 1.4 Engine version rule

Creation requires `backend.engineVersion === descriptor.engineVersion`
(exact string match). Mismatch ⇒ `template_engine_version_mismatch`
(carries the expected and actual versions). A future engine version that
needs a different starter ships a **new template version** (higher `version`,
new digests); the engine never rewrites or re-derives an installed template.

## 2. Installation and integrity

- **Location:** the backend config field `templatesRoot` (new; default
  `<engineRoot>/templates/`). The engine ships the built-in template
  directory there (the monorepo's `templates/` tree — engine content,
  versioned with the engine, not per-project state).
- **Load:** at backend startup the scan (§10 of workspace.md, extended in
  §5.6) enumerates `templatesRoot/*/descriptor.json`, validates each
  descriptor (§1.3) and caches the valid set. An invalid or tampered
  installed template is **reported and excluded** (it never poisons other
  templates); a creation naming it fails `template_not_found`.
- **No archives, no execution:** a template is a plain directory of data
  files. There is no zip/7z extraction, no `postinstall`/script step, no URL
  fetch, no code path that executes template bytes (charter §3 "Genre
  templates"; m4-plan §2.1 "No arbitrary template scripts, URLs,
  postinstall hooks"). The **only** interpreter involved is the accepted
  command engine applying the recipe's **JSON commands** (§4).
- **No traversal / no symlinks:** every template file path is verified
  before use: relative, no `..` component, no symlink in any component,
  `realpath` contained under `templatesRoot` (the accepted `path_rejected`
  semantics, workspace.md §11, applied to template paths). A template
  directory containing a symlink is refused (`template_path_rejected`).
- **Copy, never link:** creation copies template blob bytes into the
  destination project (fresh file writes via the accepted `W` procedure);
  no hardlink, no bind mount, no shared inode — "Copy bytes, do not
  hardlink mutable state" (m4-plan §2.1). A later edit of the installed
  template cannot affect a created project because the destination holds
  its own bytes (C05; §5.4 removal/replacement rule).

## 3. The template base scene (normative)

The base scene is the accepted "pure function of the manifest" initial
envelope pattern (workspace.md §8.3, project-model §15) in v3 form, and is
template data (committed at `base/scene.json`, digested by `baseDigest`):

```json
{
  "schemaVersion": 3,
  "sceneId": "scene-main",
  "revision": 0,
  "entities": [
    {
      "id": "br-cam-main",
      "name": "Gameplay camera",
      "components": {
        "transform": { "position": [0, 4, 12], "rotation": [0, 0, 0, 1], "scale": [1, 1, 1] },
        "camera": { "type": "perspective", "fovY": 45, "near": 0.1, "far": 100 },
        "cameraFollow": {
          "deadZone": { "x": 0.5, "y": 0.5 },
          "smoothing": 0.2,
          "bounds": { "minX": 0, "maxX": 48, "minY": -10, "maxY": 8 }
        }
      }
    }
  ]
}
```

Rules:

- Exactly one camera entity (project-model §10.3), carrying
  `cameraFollow` (so the recipe's `setGameConfig` reference rules pass
  without a separate add — §23.4 `cameraId` requires
  camera+cameraFollow). The camera position `z = 12` is the platformer
  fixed view depth (gameplay.md §7.1 `CAMERA_Z`); `fovY 45` is the
  platformer camera convention (the accepted sample baseline camera —
  `samples/beacon-reach/tools/capture-project.mts` `CAMERA_ENTITY`, whose
  cameraFollow `bounds` equal the game `level` bounds: §23.5 reference
  consistency).
- The initial envelope at creation = **this base scene** at `revision 0` +
  the empty v3 content block (`assets: [], prefabs: [], behaviors: [],
  settings: {}, behaviorTrust: { entries: [] }, game: null`) — written
  directly as one `W` (not a command replay; the base scene is data,
  exactly as the project-model §15 default scene is data). A v3 envelope
  with `game: null` is loadable and editable (the accepted post-migration
  state before `setGameConfig`); Play of it is refused by the accepted M3
  host precondition (game-block required) — that refusal is the accepted
  behavior, not a template defect.
- The base camera ID is a **template constant** (`br-cam-main`, the
  accepted sample baseline ID — the template derives from that recipe and
  its `setGameConfig` references it). It is never created by a recipe
  command (a camera cannot be created: the closed `createEntity` kinds are
  `group|box|model`, commands.md §2).

## 4. The starter recipe (format)

The recipe is the accepted public workflow shape (`samples/beacon-reach/
recipe/commands.json`), frozen as a contract:

```ts
interface TemplateRecipe {
  templateId: string;     // must equal the descriptor's
  baseScene: "base/scene.json";  // fixed: the recipe replays from the base scene
  commands: RecipeCommand[];
}
interface RecipeCommand { op: string; args: Record<string, unknown>; }
```

Rules (normative):

1. **Command whitelist (closed):** `op` ∈ { `publishAsset`, `createEntity`,
   `setTransform`, `setComponent`, `createPrefab`, `instantiatePrefab`,
   `setGameConfig`, `setSettings` } — the accepted M3 command subset the
   starter content needs. Anything else (undo/redo, queries,
   `publishBehavior`, `setBehaviorProperties`, `acknowledgeBehaviorTrust`,
   `deleteEntity`, `applySurfacePreset`) is `template_recipe_invalid`
   (`reason: "op_not_allowed"`). The M4 built-in template is
   behavior-free (packet-64 §6.1 built-in-only profile), so the recipe can
   never reference a behavior; a template whose content requires one
   refuses resolution at creation (§8.4) — the recipe whitelist is the
   data-level expression of that boundary.
2. **No request envelope fields in the recipe:** recipe commands carry
   `op` + `args` only. The creation operator injects the envelope fields
   (projectId = the destination, origin = `{ kind: "template", clientId:
   "<templateId>@<version>" }`, the deterministic requestIds of §7.1) —
   the recipe is never a raw mutation request (no `expectedRevision`, no
   client requestId, no `origin` in the file).
3. **Deterministic replay:** the replay is a pure function of (base scene,
   recipe) under the accepted command semantics (commands.md §6/§8):
   entity IDs are the deterministic `<kind>-NNNN` allocations, `createdId`
   values are **resolved at authoring time** and committed into later
   `args` (exactly the accepted sample recipe convention: "Entity IDs are
   generated; … reference the generated IDs (resolved at authoring
   time)"). A committed recipe that does not replay cleanly (any command
   fails validation) is `template_recipe_invalid` (carries the 1-based
   command index + the command error) — verified by the fixture checker
   (§14) and re-verified at every creation (defense in depth; the replay
   cannot fail at creation if the install-load digest checks passed and
   the engine is unchanged).
4. **Bounds:** `commands.length` ≤ 128 (fits the accepted retry-record
   retention of 128 — §7.2); total recipe file ≤ 256 KiB; `blobs.length`
   ≤ 64; total template source bytes ≤ the project content quota (the
   creation checks the destination quota before the `blobs` phase —
   `content_quota_exceeded`, the accepted code, `kind: "device_space" |
   "project_quota"`).
5. **Every template value has a command authoring path (invariant):** every
   content value the final project carries (entity, asset record, prefab
   definition, setting, game field) is produced either by the base scene
   (the one accepted camera) or by a recipe command through the accepted
   command engine — the creation never writes content bytes directly
   (m4-plan §2.1: "Replay starter edits through the same command engine,
   not a parallel JSON mutator"). The fixture checker asserts the
   invariant by re-deriving the final envelope from (base scene + recipe)
   through `@thirdlight/commands` and requiring byte-identical
   scene+content values.
6. **Asset bytes are data, references are digests:** recipe
   `publishAsset` commands carry the accepted `sourceDigest` /
   `sourceByteLength` / `importRecipe` / `metrics` (the accepted sample
   recipe shape); the **bytes** live in `sources/` (the `blobs` inventory).
   Creation copies them to the destination's content store
   (`.thirdlight/sources/sha256/<digest>`, the accepted layout —
   workspace.md §13.1) before the replay, so every `publishAsset`
   reference resolves against on-disk, digest-verified blobs.

## 5. `createProjectFromTemplate` (the operator)

### 5.1 Request / result

Workspace operator (admin-scoped — §12), a **new** row in workspace.md §11:

```
createProjectFromTemplate(projectId, name, templateId)
```

Preconditions: `projectId` matches project-model §5.1; `name` 1–128 chars,
no control chars (`field_*`); the template is installed and verified
(§1.3/§2: else `template_not_found` / `template_content_mismatch` /
`template_engine_version_mismatch`). Result on success:

```json
{ "ok": true, "created": true, "projectId": "<id>", "revision": <N>,
  "template": { "templateId": "<id>", "version": 1, "contentDigest": "<64 hex>" } }
```

`revision` = the final envelope revision (N = the recipe command count —
§7). The idempotent form (same destination + same identity — §5.2) returns
`created: false` with the recorded identity.

### 5.2 Idempotency and destination collision (exact rules)

- **Destination absent** ⇒ create (the phase sequence below).
- **Destination present, loadable project, manifest `template` block equals
  the requested `(templateId, contentDigest)` and manifest `name` equals the
  requested `name`** ⇒ **idempotent no-op** — the creation already
  succeeded (a retry after a publication crash converges):
  `{ ok: true, created: false, revision: <current>, template: <recorded> }`.
  A retried creation can never create two destinations (C04).
- **Destination present, otherwise** (a different template/digest, a
  different name, a non-template project, a partially-initialized
  destination of a *different* identity, or an unloadable directory) ⇒
  `template_destination_exists` (carries `existing: "project" |
  "partial" | "unloadable"`). Nothing is written; the existing project is
  never overwritten, renamed or upgraded (accepted rule — m4-plan §2.1
  "Existing projects are never overwritten or upgraded on open";
  workspace.md §8.1's no-op idempotency applies only to the identity-
  matching case because template creation is a pure function of
  `(projectId, name, templateId, contentDigest, engineVersion)`).

### 5.3 Concurrent destination claim

The `reserved` phase claims the destination with the **atomic `mkdir`** of
`projects/<id>` (the filesystem rename/mkdir atomicity, not a lock file):
the first creator wins; a concurrent same-identity creator observes the
marker and converges to the §5.2 no-op after publication (or reports
`template_initialization_incomplete` with `phase` while creation is still
in flight — the accepted "resumable, reported, never half-ready" stance);
a concurrent different-identity creator gets
`template_destination_exists` (`existing: "partial"`). The reservation
marker carries the request identity (§5.5), so "same identity" is
decidable without a live channel.

### 5.4 Removal / replacement of the installed template

An operator may remove or replace the installed template directory (engine
update or operator copy) at any time. Rules (C04/C05 evidence in 76/81):

- **Created projects are unaffected:** they hold their own blob copies and
  their own manifest `template` block; reopen/build/Play/export read no
  template state after creation (the template identity is provenance data,
  not a live reference — no "template must be installed to open a
  template-created project" rule exists or may be added).
- **New creations record the replacement's identity** (the new
  `contentDigest`/`version` in their manifest `template` block).
- **An in-flight creation** whose reservation marker's `contentDigest` no
  longer matches the installed template (a replacement landed across a
  crash) **cannot resume** — resuming from a different template would
  silently change the content. It is reported by the scan as
  `template_source_unavailable` (marker + phase retained) and is resolved
  by the operator restoring the original template directory (then retry/
  resume) or deleting the partial destination. Never auto-completed, never
  re-pointed.

### 5.5 The reservation marker

`.thirdlight/reservation.json` (the template analog of the accepted
migration marker, workspace.md §16.5.3 — non-authoritative, never restored
over an envelope, excluded from every backup, workspace.md §15):

```ts
interface TemplateReservation {
  schemaVersion: 1;
  type: "thirdlight-template-reservation";
  projectId: string;
  templateId: string;
  templateVersion: number;
  templateContentDigest: string;   // the identity the reservation was made for
  name: string;
  engineVersion: string;
  startedAt: string;               // UTC second (the §7.2 manifest timestamp rule)
  phase: "reserved" | "blobs" | "envelope" | "replayed" | "published";
  recipeApplied: number;           // redundant with the envelope revision (cross-checked)
}
```

Written via `W` (durable) at each phase transition; the phase field
advances monotonically; `recipeApplied` must equal the on-disk envelope
revision whenever the phase is `replayed` or later (a mismatch ⇒
`template_marker_conflict` — the marker and envelope disagree and no
automatic resolution is attempted).

### 5.6 The phase sequence (normative; the crash table)

| Phase | Action (exact) | Durable effect | Crash ⇒ completion |
|---|---|---|---|
| `reserved` | atomic `mkdir projects/<id>` (EEXIST ⇒ §5.2/§5.3); `mkdir .thirdlight[,.thirdlight/sources/sha256]`; `W(reservation.json, phase "reserved")` | marker only | scan: reservation without manifest ⇒ reported; same-identity retry resumes from the marker; different identity ⇒ conflict. Operator may delete the directory (no other effect). |
| `blobs` | for each descriptor blob in inventory order: read the template file (re-verified §2), `W(bytes → projects/<id>/.thirdlight/sources/sha256/<digest>)`, post-write digest check; then `W(marker, phase "blobs", recipeApplied 0)` | blob copies (digest-verified) | resume: re-hash existing destination blobs (`alreadyPresent` per blob, the accepted §16.5 semantics), copy the rest. |
| `envelope` | `W(project.json)` — manifest v2 (§6) with the `template` block; `W(scenes/main.json)` — the initial envelope (base scene §3 at revision 0, empty v3 content); then `W(marker, phase "envelope")` | manifest + revision-0 envelope | resume: if the manifest exists, re-verify it (digest of the canonical bytes ⇒ equals the re-derivation from the reservation identity; a different manifest ⇒ `template_marker_conflict`); if the envelope is missing, write it (a pure function of the reservation identity — the §8.3 accepted deterministic-completion property); then advance to `replayed`. |
| `replayed` | open the destination for writes **under the creation context** (the directory is unowned — the scan refuses ordinary opens of a partial destination, so no live owner can race); apply the recipe commands `recipeApplied+1 … N` through the accepted command pipeline (each: validation → revision +1 → history entry → retry record → envelope `W`); then `W(marker, phase "replayed", recipeApplied N)` | a valid envelope at revision K (0 ≤ K ≤ N) after every command (the accepted §5 durability protocol per command) | resume: K = the on-disk envelope revision (the marker's `recipeApplied` is cross-checked against it — mismatch ⇒ `template_marker_conflict`); replay commands K+1…N; the recipe's deterministic requestIds make every applied command dedup-safe (§7.1) — no command is ever applied twice. |
| `published` | claim ownership (workspace.md §6.3, the creation-context claim); `rm reservation.json`; log the completion | an ordinary project (marker gone) | if the claim crashed after the `W` of the claim file but before the marker unlink: the scan sees `phase "published"` + revision N + a claim file ⇒ **deterministic completion**: verify the owner record is the creation context's (same backendId/epoch rule as §6.3), unlink the marker, log. If the marker says `published` but the envelope revision < N ⇒ the phase marker is corrupt (`template_marker_conflict` — no auto-completion). |

**Invariant (C09):** at no crash point is a partially-initialized
destination advertized as ready: the startup scan and the project list
treat a destination with a reservation marker (any phase < `published`)
as **not a project** — the editor's project list (query) and Play refuse
it (`template_initialization_incomplete`, carries `phase`, `recipeApplied`,
the resume/delete hint). Only the complete validated envelope + the
published claim + the removed marker constitute a ready project
("Only a complete validated envelope and verified source closure may be
advertised as ready" — m4-plan §2.1). The source closure is verified at
the `published` transition: every recipe-referenced blob digest exists in
the destination store (a missing one ⇒ the phase is not marked
`published`, `blob_missing`, resumable).

### 5.7 Disk-full

A `W` failure (ENOSPC/EIO) in any phase: the accepted `write_failed`
semantics apply to the in-replay commands (the retry records make the
re-execution safe, commands.md §7.3); in the `blobs`/`envelope` phases the
operation returns `content_publish_failed` / `content_quota_exceeded`
(`kind: "device_space"`) with the marker retained at the last completed
phase — the destination stays resumable (or operator-deletable), never
half-claimed, never ready.

## 6. Manifest `schemaVersion 2` and the `template` block (named schema bump)

The packet-65 schema bump is **exactly** this (m4-plan §2.1: "Any schema
bump names exact combinations and migration"):

- `project-model.md` §6/§7: the manifest `schemaVersion` known set becomes
  `[1, 2]`. `schemaVersion 2` = the v1 field set **plus one required field**
  `template`:

```ts
template: {
  templateId: string;      // ID syntax
  version: number;         // the template version used (descriptor `version`)
  contentDigest: string;   // 64 lowercase hex (the descriptor contentDigest)
  engineVersion: string;   // the template's declared engine version (provenance)
}
```

  Canonical key order (v2): `schemaVersion, engineVersion, id, name,
  createdAt, scenes, template` (additive, `template` last). Unknown fields
  ⇒ `field_unexpected` as today. The manifest remains **immutable after
  creation** (the accepted §7 rule — the template block is written once at
  creation and never edited; title/objective edits are `setGameConfig`
  edits of the envelope, never manifest writes).
- **Named combinations:** `(manifest 2, storage 3, scene 3)` — **valid**,
  the only new row (template-created projects are always v3).
  `(manifest 2, storage ≤ 2)` ⇒ `version_combination_unsupported` (new
  reason `manifest_storage_mismatch`; the combination check of
  workspace.md §4.3/§16.2 applies to the manifest too). `(manifest 1,
  storage 3)` stays valid (migrated v2→v3 projects — §16.5 keeps the
  manifest at schemaVersion 1: "the authoring manifest is never
  re-versioned" — that accepted rule is unchanged: **migration never
  re-versions; only the new template-creation path writes a v2
  manifest**). Plain `createProject` (workspace.md §8) still writes a
  **v1** manifest with the project-model §15 v1 default scene — unchanged.
- **Migration:** none. A v2 manifest is only ever written by
  `createProjectFromTemplate`; there is no v1→v2 or v2→v1 conversion, no
  upgrade-on-open, and a v2-only engine reading a v1 manifest is the
  unchanged accepted path (loading is not gated by the manifest version —
  the envelope is authoritative). An older (pre-M4) engine meeting a v2
  manifest reports the accepted `manifest_invalid` / unknown-field
  refusal (the standard schema-bump consequence — a template-created
  project is not openable on the older engine, exactly as a v3 envelope is
  not openable on a v2 engine).
- **`queryProject`** (commands.md §5.6) carries "the full normalized
  manifest" — the v2 manifest (incl. `template`) flows through with **no
  query-shape change**; the template identity is thus observable over the
  accepted query path (C04/C05 "new creation records the template
  identity").

## 7. Revision, retry and history identity rules (frozen)

1. **Recipe requestIds (deterministic, accepted shape):** the accepted
   requestId shape is exactly `^req-[0-9a-f]{32}$` (commands.md §3) — the
   creation therefore injects, for recipe command `i` (1-based),
   `requestId = "req-" + the first 32 hex chars of
   sha256("<templateId>@<templateVersion>#" + i)`. Deterministic given the
   template identity (a re-executed command after a crash derives the
   **same** id — the accepted §6.2/§6.3 dedup/replay semantics then return
   the recorded result, never re-apply); unique per `(template, i)` (the
   128-bit truncated digest keeps the accepted collision analysis). The
   origin is `{ kind: "template", clientId: "<templateId>@<version>" }`
   (the accepted origin kinds — `browser | mcp | admin` — gain exactly one
   documented value, `template`; sessions.md audit row, C65-7). Until the
   C65-7 promotion the accepted engine's origin validation rejects
   `template`; the fixture replay against the accepted engine therefore
   substitutes `kind: "admin"` (the creation context's accepted scope,
   §12) with the same `clientId` — origin is an audit tag with no semantic
   effect on the accepted pipeline (commands.md §3), so the substitution
   changes nothing except the recorded audit value.
2. **Retry records:** each applied recipe command writes one retry record
   (the accepted §7.1 shape). Because N ≤ 128 (the §4.4 bound), the whole
   starter history fits the retention window and is dedup-visible: a
   re-executed command (crash re-execution, §5.6 `replayed` resume)
   returns the recorded result and never re-applies (commands.md §6.2/
   §6.3 replay semantics).
3. **History:** each recipe command is one ordinary history entry
   (undoable individually, in order). There is **no composite
   "undo the template"** and no special initialization marker in the
   history — "do not casually call initialization one undoable user
   edit" (m4-plan §2.1) is honored in the strong form: it is N ordinary
   edits. Undoing all N returns the base scene (valid, editable,
   Play-refused by the accepted host precondition). The deterministic
   `req-<32 hex>` ids of §7.1 (derivable from the manifest `template`
   block + recipe index) are the only machine-distinguishable fact (the
   editor may group the starter entries in the status bar — presentation
   only, packet 74).
4. **Post-creation edits** use ordinary client requestIds; they interleave
   with the starter history by the accepted linear history rules (undo of
   a starter entry after a user edit follows the accepted undo/redo
   semantics — the starter entries are not privileged).
5. **Identity distinctness (C05):** two projects created from the same
   template share **internal** entity/asset/prefab IDs (the deterministic
   replay — project-scoped IDs "may be reused only where project-scoped",
   m4-plan §2.1; every reference resolves inside the destination) but
   differ in everything identity-bearing: `projectId`, manifest `name`,
   `createdAt`, manifest `id`, the envelope's `projectId`, and the
   ownership record. No cross-project reference is expressible (the
   accepted ID model is project-scoped).

## 8. Module requirements (finite registry, resolution semantics)

### 8.1 The finite M4 approved module registry (closed)

| Module ID | Kind | Availability |
|---|---|---|
| `thirdlight.platformer:controller` | engine (platformer movement/physics/controller) | the v3 platformer core — required by any project with `content.game !== null` (the game block's `playerId` reference rules force the controller entity, project-model §23.4/§23.5) |
| `thirdlight.platformer-game:session` | engine (game session: zones, checkpoints, cues, HUD state) | required by `content.game !== null` (the cues/checkpoint/goal machinery — gameplay.md §3) |
| `thirdlight.platformer-game:camera` | engine (camera follow) | required by `content.game !== null` (the cameraFollow reference rule, §23.3.3/§23.4) |
| `thirdlight.demo:box-motion` | engine (M1 demo) | optional; selected only if the snapshot declares it (the M1 default — unchanged) |
| `thirdlight.behavior:<behaviorId>` | behavior reference | **referenced only** when `content.behaviors` declares that behavior with a non-null source **and** the host links the compiled output (runtime.md §2 `modules` rule) — unavailable in the M4 built-in-only delivery profile (packet-64 §6.1): a delivery capture of a behavior-bearing scene fails resolution (§8.4), never silently drops the module (C14) |

The registry is **finite and closed** for M4 (no plugin loading, no
dynamic module registration beyond the accepted runtime registry —
runtime.md §7; the table is the approved set). Adding a row is a contract
change (Gate Q diff); the descriptor's `modules` lists may only name
rows of this table.

### 8.2 Declared vs content-derived requirements

- **Declared:** the descriptor's `modules.required` (the M4 built-in
  template: exactly the three platformer core IDs; `optional: []`).
- **Content-derived (transitive, at every evaluation point):**
  - `content.game !== null` ⇒ the three platformer core IDs (above);
  - a `components.behavior` with a linked output ⇒
    `thirdlight.behavior:<behaviorId>` (per record);
  - `content.game.cues` referencing `kind: "audio"` assets ⇒ the session
    module (cues are its responsibility — subsumed by the game rule);
  - `model` / `modelAnimation` components ⇒ **no module** (model
    attachment is adapter-owned — packet-64 §2; the adapter's
    `models` block carries the bytes; no simulation module is involved);
  - `light`/`surface`/`box`/`collider` ⇒ **no module** (rendering/physics
    are the platformer core's accepted responsibilities).
- **Resolution (the packet-72 pure resolver, specified here):**
  `selected = declared.required ∪ content-derived`, canonical order =
  registry-table order (deterministic). Validation, fail-fast, all at
  every evaluation point: unknown ID ⇒ `module_unknown` (carries the ID);
  duplicate ⇒ `module_duplicate`; a declared `optional` that the content
  does not reference is **not selected** (optional = "may appear in the
  registry", not "always included"); an exclusion pair (platformer.md
  §2.3) ⇒ `module_combination_unsupported`; a dependency cycle in the
  registry edges ⇒ `module_cycle` (the M4 registry is flat — no edges —
  so the check is a registry-integrity check that always passes for the
  shipped registry; it is specified so a future row cannot smuggle a
  cycle in).

### 8.3 Evaluation points (C06)

Resolution runs, and must run, at: **(a)** creation (before the
`published` phase — a failing resolution aborts the creation at the
marker, reported, nothing advertised); **(b)** every capture (Play
snapshot build and export snapshot build — the accepted snapshot `modules`
field is the resolver output, runtime.md §2); **(c)** after subsequent
authoring edits (the editor's bounded status observation: a post-edit
scene whose resolution fails is Play/export-refused with the exact code —
"post-edit missing/unknown/cyclic/incompatible requirements fail clearly",
C06). The layout/panel state is **never an input** to resolution
(§9.4) — a required module cannot be disabled by hiding a panel.

### 8.4 The behavior-bearing boundary (explicit refusal)

A template-created project that later gains `components.behavior` (via the
accepted `publishBehavior`/`setBehaviorProperties`) is a **user edit**,
allowed by the accepted contracts; its delivery resolution then requires
the behavior module, which the M4 built-in-only profile cannot link ⇒ the
capture fails `module_unresolved` (new code: `thirdlight.behavior:<id>`
referenced but not linkable under the delivery profile — the
packet-64 §6.1 explicit-refusal rule made machine-readable) — never a
silent omission (C14) and never a silent fallback (the host's accepted
fail-closed behavior, CC-55-3a, is the same boundary at the host layer).

## 9. Panel visibility and local layout preferences (C06)

### 9.1 The frozen panel registry (M4 v1, closed)

| Panel ID | Editor surface (packet 74) |
|---|---|
| `hierarchy` | the scene hierarchy panel |
| `inspector` | the entity inspector |
| `assets` | the asset browser |
| `media` | the media import/roles panel |
| `prefabs` | the prefab panel |
| `behaviors` | the behavior panel |
| `gameplay` | the game-config/settings panel |

The viewport canvas, toolbar and status bar are **fixed chrome** — not
panel-registry entries; hiding them is not representable. The registry is
closed for M4; adding a row is a contract change. (The registry lists
**existing** panel surfaces — m4-plan §2.2 "a fixed, versioned list of
existing panel IDs"; packet 74 wires the toggles.)

### 9.2 The preference shape (exact)

```ts
interface LayoutPreference {
  layoutVersion: 1;
  panels: { [panelId: PanelId]: { visible: boolean } };  // every registry panel present
}
```

Missing a registry panel ⇒ the default (`visible: true`) for that panel;
an unknown panel ID ⇒ that entry is **dropped** (the rest kept); a wrong
`layoutVersion` or any structural corruption (bad JSON, non-object,
non-boolean `visible`) ⇒ the **whole preference resets to the default**
(safely, silently — no dialog, no error state, no backend call). "Unknown
or corrupt preferences reset safely" (m4-plan §2.2).

### 9.3 Storage and lifecycle (local-only, disposable)

- **Where:** browser-local `localStorage`, key `thirdlight.layout.v1.` +
  the `projectId` (per-project scope — one project's layout never leaks
  into another). Nothing else: **never** an authoring envelope field, a
  scene revision, a `content` key, a workspace file, a runtime option or a
  build/export input (m4-plan §2.2 — the invariant, testable as: the
  layout preference is byte-absent from the envelope, the snapshot
  document, the export bundle and the backup set).
- **Template seed:** the creation **result** carries the template's
  `layout` block (§1.1). The editor seeds the local preference for the new
  projectId **iff none exists** (first open in that browser); a stored
  preference always wins (user overrides are durable locally). Non-
  template projects seed the default (all visible).
- **Toggles and Reset Layout:** a toggle writes the local preference only
  (no command, no revision, no network mutation — a read-only session may
  still toggle panels). **Reset Layout** restores the template's `layout`
  for template-created projects (from the creation-result cache the editor
  keeps locally — the manifest `template` block carries the identity, not
  the layout; the editor re-derives the reset target from the last
  known-good creation result or falls back to the default) and the default
  otherwise.
- **Reloading** re-reads the local preference; a different browser (clean
  localStorage) gets the seed again — disposability is the design (two
  origins may show different layouts of the same project; the project is
  identical).

### 9.4 The invariants (C06, normative)

Hiding/showing/resetting panels **must not**: delete components, change
the scene or content bytes, advance the revision, disable or change any
simulation module or the module closure, change asset state, change the
emitted runtime closure or the export, or emit any backend write. Panel
visibility is **not module inclusion** (m4-plan §2.2; charter §3 "Panel
visibility and runtime module inclusion are separate settings. Existing
content cannot silently lose behavior when a panel is hidden.").

## 10. Provenance and licensing

- The template's source content is **original generated content** of the
  engine campaign: the M4 built-in template reuses the accepted Beacon
  Reach self-generated assets (the committed `samples/beacon-reach/assets/`
  bytes — the provenance JSON + generation scripts are committed there)
  byte-identically. No downloaded asset, no third-party bytes, no license
  asserted over external material (the m3-sample.md rule, extended to the
  template).
- `NOTICE` states: the content is engine-generated, derived from the
  Beacon Reach sample recipe (path), the asset digests are the descriptor
  `blobs` inventory, and the template is part of the engine distribution
  (the kit's licensing decision of packet 66 covers redistribution).
- The descriptor's `provenance` block is **data, not a claim of rights**
  (m4-plan §2.3's source-digest caution applies: a digest identifies
  bytes; it is not a review claim).

## 11. New error codes (closed set for this contract)

| Code | Where | Raised when |
|---|---|---|
| `template_not_found` | workspace op / install scan | the `templateId` is not an installed, verified template |
| `template_descriptor_invalid` | install scan / creation | the descriptor fails the §1.1/§1.3 shape or digest checks (carries `reason`) |
| `template_content_mismatch` | install scan / creation | a recipe/base/blob re-hash ≠ its digested value (carries the file/field) |
| `template_engine_version_mismatch` | creation | backend engine version ≠ the descriptor's (carries both) |
| `template_path_rejected` | install scan / creation | a template path escapes the root, uses `..`, or is a symlink |
| `template_recipe_invalid` | install scan / creation / replay | the recipe fails §4 (op not in the whitelist, bound exceeded, or a replayed command fails — carries the 1-based index + the command error) |
| `template_destination_exists` | creation | §5.2 (carries `existing: "project" | "partial" | "unloadable"`) |
| `template_reservation_conflict` | creation | a concurrent/foreign reservation marker with a different identity for the same destination (§5.3) |
| `template_marker_conflict` | scan / resume | the marker and the on-disk state disagree in an unrecoverable way (§5.5/§5.6) |
| `template_initialization_incomplete` | open / query / Play / project list | the destination carries a marker with phase < `published` (carries `phase`, `recipeApplied`, the resume/delete hint) — the destination is **not** a project |
| `template_source_unavailable` | scan / resume | an in-flight creation's marker digest no longer matches any installed template (§5.4) |
| `module_unknown` / `module_duplicate` / `module_cycle` / `module_unresolved` | resolution (§8.3) | a selected/declared ID is not in the registry / appears twice / the registry carries a cycle / a referenced behavior module is not linkable under the delivery profile (§8.4) |
| `manifest_storage_mismatch` | workspace load | a manifest `schemaVersion 2` paired with `storageVersion ≤ 2` (§6) |

The accepted codes (`content_quota_exceeded`, `content_publish_failed`,
`blob_missing`, `path_rejected`, `project_exists_invalid`, …) are reused
unchanged where their semantics already cover a phase (§5.7, §5.2).

## 12. Authorization, transport and MCP surface (spec; 73/74 implement)

- **Service:** one backend service (the workspace operator of §5) — the
  browser UI and MCP route into the **same** service (m4-plan §2.1). No
  second creation path.
- **Permission:** creation is **admin-scoped** (sessions.md §6.3): an
  admin token (the operator's). A project-scoped MCP token (scope
  `authoring:<projectId>`) **cannot** create projects — "Do not give a
  project-scoped MCP token global admin privileges" (m4-plan §2.1). The
  editor UI's creation flow uses the deployment's configured admin token
  (a deployment value, never logged); if the deployment has no admin
  token, the creation UI is disabled with a bounded message (no silent
  failure, no token downgrade).
- **Route (new, admin-scoped):** `POST /api/v1/admin/templates/projects`
  body `{ projectId, name, templateId }` ⇒ the §5.1 result or the §11
  error set (the accepted operator-route auth rules of sessions.md §6.3).
- **MCP tool (new, 73):** `tl_project_create` (admin-scoped token only;
  args `projectId`, `name`, `templateId`; the tool echoes the result
  identity; the tool list gains the row — dependencies.md §7 tool
  surface note, no package change: the mcp-adapter tool is a routing
  wrapper into the admin route, the accepted "no alternate mutation
  engine" rule). `tl_templates_list` (read-only, any authoring scope: the
  installed verified template list — descriptor summaries only, never
  bytes) is the bounded discovery surface.
- **Packages/dependencies (no change):** the template logic lives in the
  accepted packages — the workspace service (the operator), the editor
  (the UI), the mcp-adapter (the tool routing), the backend (the route).
  **No new package, no new dependency, no new browser bundle entry**
  (dependencies.md: no-change adjudication — the `templates/` tree is
  engine *data*, not a package; it is excluded from the package graph and
  from every browser bundle).

## 13. Query surface

- `queryProject` — carries the full normalized manifest (v2 incl.
  `template`) — **no shape change** (commands.md §5.6).
- The project list / creation-status observations (the editor's project
  picker, 74) report partial destinations as `template_initialization_
  incomplete` (§11) — a query observation, not a project.
- No new query operation (the template identity is manifest data; the
  settings values come from the packet-64 `querySettings` proposal —
  independent).

## 14. Fixtures (fixtures/m4/templates) — obligations

The committed fixture set (packet 65, this packet) must specify:

1. **The complete `platformer-starter` template** (descriptor + base scene
   + recipe + sources + NOTICE) — original/self-generated content only
   (the reused sample assets are the committed self-generated bytes).
2. **Command recipe validity:** the checker **re-derives** the final
   envelope from (base scene + recipe) through the real
   `@thirdlight/commands` engine (the accepted capture-tool pattern) and
   asserts: every command applies (revision 0→N), the final scene/content
   validate (the v3 rules), the two `instantiatePrefab` instances exist
   with distinct entity IDs and the prefab provenance component, the
   `modelAnimation` binding matches the courier asset's clip names/
   indices, the `content.game` references resolve, and the template
   descriptor's digests re-derive (§1.3) — byte-for-byte.
3. **Identity independence:** two creations (same template, different
   `projectId`s) — same internal IDs (deterministic), distinct
   project/manifest identity; a template **replacement** case (version 2,
   changed game text + digest) — new creations record the new identity, an
   old created project's envelope stays byte-identical.
4. **Every failure phase** (§11): one case per code with the exact marker/
   on-disk state that raises it (the checker re-derives the pure parts —
   digests, replay, resolution, layout reset — and pins the workspace-
   phase states for the 72/73 evidence).
5. **The hidden-panel invariant:** the preference transformation cases
   (toggle/reset/corruption ⇒ the §9.2 reset rules; the invariant that no
   transformation touches the envelope/revision/module closure — asserted
   as data, evidenced in-browser by 74/81).
6. **Bounds:** the N ≤ 128 / blobs ≤ 64 / 256 KiB recipe bounds (a
   deliberate over-bound negative).

## 15. Numbered diff rows and CCRs

Owned diff rows (proposed; `docs/planning/m4-contracts/diffs/`):

| Row | Contract | Change |
|---|---|---|
| C65-1 | project-model.md §6/§7 | manifest `schemaVersion 2` (known `[1, 2]`) + the required `template` block (§6); canonical order; immutability restated |
| C65-2 | project-model.md §12.6/§13 | `manifest_storage_mismatch` + the named combination `(2, 3, 3)` (§6) |
| C65-3 | workspace.md §8 (new §8.4) | the `createProjectFromTemplate` operator: request/result, idempotency, collision (§5.1–5.3) |
| C65-4 | workspace.md §10/§11/§15 | scan rows for partial destinations + the crash-completion table (§5.6); the §11 operator row + the §11 new-code table; the reservation-marker backup exclusion (with the accepted migration-marker rule) |
| C65-5 | workspace.md §13 | template blob publication reuses the accepted content-store layout (no new artifact class — adjudication row) |
| C65-6 | sessions.md §6.3 | the new admin route `POST /api/v1/admin/templates/projects` + the admin-scope creation permission rule (§12) |
| C65-7 | sessions.md §14/§15 (MCP) | the `tl_project_create` / `tl_templates_list` tool rows (admin-scoped create; bounded discovery) + the `origin.kind: "template"` audit value (§7.1) |
| C65-8 | dependencies.md | no-change adjudication: no new package/dependency/bundle entry; `templates/` is engine data (§12) |
| C65-9 | commands.md | no-change adjudication: the starter recipe uses only the accepted command set; `queryProject` carries the v2 manifest with no query-shape change (§4.1, §13) |
| C65-10 | runtime.md | no-change adjudication: the snapshot `modules` field is the §8 resolver output under the accepted runtime.md §2 rules (the behavior-module rule is unchanged; §8.4 is its delivery-profile consequence) |

CCR (owner decisions at Gate Q):

- **CCR-65-1 (behavior scope):** the M4 built-in-only delivery profile
  (packet-64 §6.1) makes `thirdlight.behavior:*` unresolvable at delivery
  (C14 explicit refusal, §8.4). This packet **does not implement**
  behavior linking (CC-55-3a stays deferred with the packet-64 record).
  Owner decision at Q: keep the refusal (proposed) or open the linking
  scope (a separate, larger contract change — not this packet).
- **CCR-65-2 (template engine-version rule):** exact-match
  (`backend.engineVersion === descriptor.engineVersion`, §1.4) vs a
  compatibility range. Proposed: exact match (no speculative upgrade
  semantics — m4-plan §2.3 "No invented release tag/version"; the engine
  version is `0.1.0` throughout M1–M4, so the rule is inert but frozen).

**Out of scope (explicit):** the 72 resolver implementation, the 73
route/MCP/UI wiring, the 74 panel UI, the 66 engine kit (the template
directory's distribution inside the kit is 66's layout problem), the 76
independent-game evidence, any template **engine** (charter §3), and any
change to the M1/M2/M3 accepted data schemas beyond the named bump (§6).