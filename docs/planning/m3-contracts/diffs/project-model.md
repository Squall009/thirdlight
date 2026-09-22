**PROPOSED — not accepted.** Packet 39 (`docs/planning/m3-packets.md` §39)
output. Section-level diffs for `docs/contracts/project-model.md`. This file
contains no accepted text. Normative text lives in
[`../model.md`](../model.md) (new §23) and [`../authoring.md`](../authoring.md)
(op semantics); this file names the exact destination, the shortest unique OLD
quote and the NEW text. Convention (same as `m2-contracts/diffs/project-model.md`):
`OLD` is accepted text exactly as it reads today; `NEW` is the replacement;
`+` blocks are pure insertions. Accepted section numbers are never renumbered;
new material is appended as **§23**. Superseded text is called out explicitly —
no accepted sentence is silently redefined.

---

## A. Summary of required changes

| # | Destination | Kind | Normative text |
|---|---|---|---|
| PM1 | §3 "Documents and layout" | insert bullet | this file |
| PM2 | §6 "Version taxonomy" (schema row) | reword | this file |
| PM3 | §6 rules (combinations bullet) | insert sentence | this file |
| PM4 | §8 / §8.1 (scene `schemaVersion 3`) | insert paragraph + row value | this file |
| PM5 | §10 preamble (v3 registry) | insert paragraph | this file |
| PM6 | §12.2 "Canonical form" | insert rules | this file |
| PM7 | §12.3 "Validation passes" | insert step 7 | this file |
| PM8 | §12.4 "Migration entry points" | insert paragraph | this file |
| PM9 | §12.6 "Error codes" | insert rows | this file |
| PM10 | §13 "Cross-document validation" | insert §13.2 | model.md §23.5/§23.8 |
| PM11 | §14 "What is deliberately not in this contract" | insert bullet | this file |
| PM12 | §17 "Change rules" | insert bullet | this file |
| PM13 | §18.1 rule 3 | **reserved for packet 41** — note only | packet 41 |
| PM14 | §18.2 `ContentCatalog` | insert row + key order | this file |
| PM15 | §18.3 `AssetRecord.kind` | reword | this file |
| PM16 | §19.2 step 1 (captured closure) | reword | this file |
| PM17 | §20.2 (definition vocabulary) | insert sentence | this file |
| PM18 | §20.10 (deletion rule) | insert rule 6 | model.md §23.6 |
| PM19 | **new §23** | insert section | model.md §§23.0–23.12 |

Not changed: §§1/2/4/5/7/8.1 limits/9/10.1–10.8/11/12.1/12.4 mechanism/12.5/12.7/
15/16/18.4–18.10/19.1/19.3/20.1/20.3–20.9/21/22 (accepted semantics untouched).
§21.4's six-key settings registry is deliberately **unchanged** (no new gameplay
tuning key is proposed by 39).

---

## B. Existing sections

### PM1 — §3 "Documents and layout": insert one bullet

Anchor: after the M2 bullet ending `…a `schemaVersion` 1 document is still
exactly as defined in §7–§10.`

```diff
+- In the M3 workspace the active envelope is `storageVersion` 3 and its embedded
+  scene is `schemaVersion` 3 (workspace.md §4.5/§16): the envelope keeps the M2
+  `content` block and adds exactly one required key, `game`, which is `null` or
+  a bounded game-configuration block (§23.4). It is **envelope state only** —
+  there is still one mutable file, no standalone game document and no JSON blob.
+  `schemaVersion` 1 and 2 documents remain valid exactly as accepted.
```

### PM2 — §6 "Version taxonomy": schema-version row

```diff
-| **Schema version** | `schemaVersion`, integer | The data format of this contract. Known versions are **per document type**: manifest `[1]`; scene `[1, 2]` (M2 adds scene `2`). |
+| **Schema version** | `schemaVersion`, integer | The data format of this contract. Known versions are **per document type**: manifest `[1]`; scene `[1, 2, 3]` (M2 adds scene `2`; M3 adds scene `3`, §23). |
```

(The row's other cells are unchanged. The manifest stays `[1]` in M3 — the
authoring `project.json` is never re-versioned; the runtime-content export
`manifest.json`'s `manifestVersion` is packet 42's.)

### PM3 — §6 rules: extend the combinations bullet

Anchor: the bullet ending `…The manifest stays `schemaVersion` 1 in M2.`

```diff
+- **M3 adds one passable combination, not a new rule.** `manifest 1 + scene 3 +
+  storageVersion 3` joins the two rows above (§23.2, workspace.md §4.5); its
+  envelope carries `content.game`. Every other v3 pair is a single
+  `version_combination_unsupported` (storage side) or `schema_version_unsupported`
+  (per document) and is refused non-destructively with the bytes retained
+  untouched. The authoring manifest still never moves.
```

### PM4 — §8 / §8.1: scene `schemaVersion 3`

Anchor: the paragraph ending `…a standalone interchange file remains
`schemaVersion` 1 until a separate contract change says otherwise.`

```diff
+In the M3 workspace the embedded scene is `schemaVersion` 3: the same top-level
+fields (`schemaVersion`, `sceneId`, `revision`, `entities`) with the §23
+component registry, a superset of the §18(v2) registry. No field or meaning of
+scene `1`/`2` changes.
```

And in the §8.1 field table:

```diff
-| `schemaVersion` | integer | yes | `1` (interchange, M1 workspace) or `2` (M2 active workspace; required there — workspace.md §4.2, §4.5) | — |
+| `schemaVersion` | integer | yes | `1` (interchange, M1 workspace), `2` (M2 active workspace) or `3` (M3 active workspace; required there — workspace.md §4.2, §4.5/§16) | — |
```

### PM5 — §10 preamble: v3 registry

Anchor: after the sentence ending `…packet 20 owns the final registry and its
order).`

```diff
+A `schemaVersion` 3 scene's registry is the v2 registry **plus six components
+appended in this order**: `gameZone`, `playerSpawn`, `cameraFollow`, `light`,
+`surface`, `modelAnimation` (§23.3). No accepted component is renumbered or
+reinterpreted; the canonical v3 component order is exactly §23.3's list.
```

### PM6 — §12.2 "Canonical form": insert rules

Anchor: after the sub-bullet ending `content key order is `assets, prefabs,
behaviors, settings, behaviorTrust` (the earlier order plus one key).`

```diff
+   - **v3 additions.** The content key order becomes
+     `assets, prefabs, behaviors, settings, behaviorTrust, game`; `content.game`
+     is emitted last, as `null` or the canonical §23.4 block. Components are
+     emitted in the §23.3 registry order with the field orders of
+     §§23.3.1–23.3.6 and §23.4. Only the §23.7 defaults are filled (present
+     `surface` fields; `light.castShadow` on a directional light); `activation`
+     sub-fields and a `null` `content.game` are never invented or expanded.
+     `surface.color`, `surface.emissive`, `light.color` and
+     `activation.emissive` are lowercased like §12.2 rule 3.
```

### PM7 — §12.3 "Validation passes": insert step 7

Anchor: after step 6 (`content.behaviorTrust` … `acknowledgedRevision ≥ 0`.)

```diff
+7. **v3 documents add one collected pass** (a v3 scene has no `source`/trust
+   steps unless the catalog contains behaviors, in which case steps 5–6 run
+   unchanged): the registry/combination rules, per-component values, the
+   `modelAnimation` role container, counts/limits, scene-level game references
+   and cross-block cue/animation resolution, in exactly the §23.8 order. This
+   pass is additive; a v1/v2 document never enters it.
```

### PM8 — §12.4 "Migration entry points": insert paragraph

Anchor: at the end of §12.4.

```diff
+- `migrateSceneV3(scene)` is the pure v2→v3 logical migration (§23.11): it sets
+  `schemaVersion: 3` and carries every entity value verbatim (the v3 registry is
+  a superset). It is identity on a v3 input, pure and total, and never touches
+  disk. The envelope-level v2→v3 **copy** operator (new identity, revision/retry
+  reset, resumable crash boundaries) is workspace.md §16.
```

### PM9 — §12.6 "Error codes": insert rows

Anchor: after the `behavior_trust_unacknowledged` row (last row of the table).

```diff
+| `game_reference_missing` | `content.game` names an entity/asset that does not resolve, or a required role is absent; carries `path`, `reason` (`player`/`camera`/`camera_follow`/`spawn`/`safe_spawn`/`cue`) (§23.9) |
+| `game_reference_in_use` | a deletion or component removal would dangle a game/checkpoint reference; carries `entityIds`, `references` (JSON Pointer paths) (§23.6) |
+| `zone_transform_unsupported` | a `gameZone` entity is parented, non-unit-scaled or rotated; carries `path`, `reason` (`parented`/`scale`/`rotation`) (§23.3.1/§23.9) |
+| `spawn_transform_unsupported` | a `playerSpawn` entity is parented, non-unit-scaled or rotated; carries `path`, `reason` (`parented`/`scale`/`rotation`) (§23.3.2/§23.9). Registered by the Gate K repair (B3/FU-3): same conditions and reason vocabulary as `zone_transform_unsupported`, separate code |
+| `zone_checkpoint_count_invalid` | more than one `role: "checkpoint"` zone in the scene; carries `zoneIds` (§23.3.1) |
+| `zone_goal_missing` | `content.game` is non-null and the scene has no `role: "goal"` zone (§23.3.1) |
+| `asset_kind_mismatch` | a reference expects one `kind` and the resolved record has another, or a reimport changes `kind` (§23.3.7) |
+| `game_config_invalid` | `content.game` is malformed at the block level (`configVersion`, missing/wrong-typed field, string bound, `level`/`killY` relation); carries `path`, `reason` (`field_missing`/`field_unexpected`/`field_type`/`field_value`) (§23.4/§23.9) |
```

`limits_exceeded`'s list gains the §23.10 names (`zones`, `player_spawns`,
`lights_directional`, `lights_ambient`, `audio_assets`, `audio_versions`,
`game_bytes`, `animation_profile_bytes`); the row text is otherwise unchanged.

### PM10 — §13: new §13.2

Anchor: after §13.1 (before §14).

```diff
+### 13.2 Three-block composition (`validateProjectV3`, v3 envelopes only)
+
+Normative text: [`../model.md`](../model.md) §23.5/§23.8 step 6 — the v2
+cross-block check (`components.model.asset.assetId` → `kind: "model"`) plus the
+v3 game/cue/animation reference checks. Error objects keep the accepted
+`document: "manifest" | "scene" | "content"` tagging. A v3 project never runs
+the v2-only composition and vice versa.
```

### PM11 — §14: insert bullet

Anchor: at the end of §14's bullet list.

```diff
+- **v3 adds no document and no second mutable file.** The game-configuration
+  block lives inside the envelope's `content` (`content.game`), is typed, bounded
+  and authored only by `setGameConfig` (commands.md). There is no game JSON blob,
+  no script/HTML/expression field, no remote asset reference and no per-entity
+  arbitrary data map.
```

### PM12 — §17 "Change rules": insert bullet

Anchor: after the packet-18 v2-material bullet ending `…(`behaviors.md` §13
C18-8).`

```diff
+- **The packet-39 v3 material (new §23) is a new known version combination**, not
+  a same-version extension: v1/v2 scene documents stay valid and unmodified,
+  `manifest schemaVersion` stays 1, and no v2 field is renumbered or
+  reinterpreted. The added components, the `content.game` block, the reference/
+  deletion rules, the limits and the new error codes are contract material
+  because fixtures, the checker and acceptance rows B02/B03/B12/B16/B17/B18
+  reference their exact values. Every v3 envelope fixture carries the six-key
+  `content` block with `game`.
```

### PM13 — §18.1 rule 3 (reserved)

**Not changed by 39.** The plan's animation profile needs a narrow exception to
§18.1 rule 3 ("No persisted value may reference an internal glTF
name/index/clip"). Packet 41 owns that exact replacement text
(`planning/m3-contracts/presentation.md`, §41 "Explicitly replace §18.1's
no-persisted-subresources rule only for the reviewed version-local mapping").
39 defines the version-bound container ([`../model.md`](../model.md) §23.3.6) and
does **not** write the §18.1 replacement; a reviewer must not read §23.3.6 as a
silent redefinition of §18.1.

### PM14 — §18.2 `ContentCatalog`: insert row and key order

```diff
 | `settings` | object | yes | `{}`, or the ≤ 32 declared keys per §20.9 (an empty container remains valid) |
+| `game` | `GameConfig` or `null` | yes **in a `storageVersion` 3 envelope only** | `null`, or the bounded §23.4 block; ≤ 16 384 canonical bytes (`limits_exceeded` `game_bytes`). Absent in a v2 envelope (where the key set stays exactly five) |
```

```diff
-Canonical key order: `assets, prefabs, behaviors, settings, behaviorTrust`
-(§12.2). Unknown fields ⇒
+Canonical key order: `assets, prefabs, behaviors, settings, behaviorTrust,
+game` (v3; a v2 envelope stops at `behaviorTrust`). Unknown fields ⇒
 `field_unexpected` at any level.
```

### PM15 — §18.3 `AssetRecord.kind`

```diff
-| `kind` | string | yes | exactly `"model"` in M2 (the whole-GLB model kind); other kinds are a future version |
+| `kind` | string | yes | `"model"` (whole-GLB model kind) or `"audio"` (bounded PCM-WAV cue kind; §23.3.7). Fixed at create; a reimport with a different kind is `asset_kind_mismatch`. Any other value is `field_value` |
```

### PM16 — §19.2 step 1: captured closure

```diff
-1. Collect every `assetId` referenced by the captured scene's v2 model
-   components (once prefabs/behaviors exist, their definitions' references join
-   the closure — packets 16/18 keep this rule).
+1. Collect every `assetId` referenced by the captured scene's v2 model
+   components (prefab/behavior definition references join the closure), **plus
+   in v3** every `components.modelAnimation.assetId` and every non-null
+   `content.game` cue / checkpoint `activation.cueAssetId`. A `modelAnimation`
+   binding contributes its recorded `version` explicitly; all other entries
+   resolve through `currentVersion` as accepted.
```

### PM17 — §20.2: definition vocabulary sentence

```diff
 The definition vocabulary is **closed**: `camera`, `prefab`,
 `collider` and `controller` are forbidden in a definition entity and rejected
 as `prefab_component_forbidden` (never silently dropped) — that matches
 `commands.md` §5.4.
+The v3 components `gameZone`, `playerSpawn`, `cameraFollow`, `light`, `surface`
+and `modelAnimation` are likewise **not** in the definition vocabulary and are
+rejected with the same code. No v3 component is capturable; copying a model
+keeps its stable `assetId` and gains no surface or animation profile.
```

### PM18 — §20.10: insert rule 6

Anchor: after rule 5 (`components.prefab` references follow `prefabs.md` §8 …).

```diff
+6. **v3 game references** are the first content→scene references, so
+   `deleteEntity` and component removal consult the game block and reject with
+   `game_reference_in_use` exactly as [`../model.md`](../model.md) §23.6
+   specifies. Values inside the closure disappear with it; the whole deletion is
+   rejected otherwise. No reference is ever silently cleared.
```

### PM19 — New §23

Insert as the last section of the document (after §22), heading renumbered from
`model.md`'s "## 23.": normative text is
[`../model.md`](../model.md) §§23.0–23.12 **verbatim**, with its cross-references
rewritten from `storage.md §S…` to `workspace.md §16` and `authoring.md §A…` to
`commands.md`. No accepted section text is replaced by §23.

---

## Packet 41 additions — presentation media fields and the §18.1 rule-3 replacement

**PROPOSED by packet 41** (`planning/m3-contracts/presentation.md`). This section
is appended by packet 41; it does **not** rewrite any packet-39 row above. It
fills the two items 39 marked as packet-41 placeholders (the audio
`importRecipe`/`metrics` and the `AnimationRoleBinding` shape) and it supplies
the §18.1 rule-3 replacement that PM13 reserved. Where a row below supersedes a
39 note, it says so explicitly.

| # | Destination | Kind | Normative text |
|---|---|---|---|
| PM41-1 | §18.1 rule 3 | **replace** (the PM13 reserved slot) | `presentation.md` §41.3.5; exact OLD/NEW below |
| PM41-2 | §18.5 `ImportRecipe` | extend the profile union | `presentation.md` §41.4.3 (new text below) |
| PM41-3 | §18.6 `AssetMetrics` | extend to a union | `presentation.md` §41.4.3 (new text below) |
| PM41-4 | §18.9.3 / §23.9 error codes + `limits_exceeded` names | insert rows/names | `presentation.md` §41.7.2 (new text below) |
| PM41-5 | §18.7 preamble | insert one cross-reference sentence | `presentation.md` §41.4 (new text below) |
| PM41-6 | §19.2 captured closure | confirm (no text change) | audio versions are reachable assets captured by digest exactly like models; 39's PM16 reword is sufficient |
| PM41-7 | §18.4 `AssetVersion.importRecipe`/`metrics` | **no text change** | the fields keep their names; their types become the §18.5/§18.6 unions. `sourceByteLength` keeps its accepted `1 … 33 554 432` bound, and the `pcm-wav` profile adds the stricter `≤ 192 044` profile bound without replacing the accepted row |

Not changed by packet 41: §§18.0–18.4 field lists, §18.7.1/§18.7.2 GLB rules,
§18.8/§18.8.2 diagnostics, §18.9.2 order, §18.10 outcomes, §20/§22, §23
(39's v3 data). No accepted component field is added: the `light`, `surface`,
`modelAnimation` and `activation` containers stay exactly 39's.

### PM41-1 — §18.1 rule 3: the version-local clip-role exception

**Supersedes PM13's "reserved" note** (PM13's row stays as written for the
historical record; this row is the replacement text it deferred). Anchor: rule 3
of the accepted §18.1 ("Asset identity model"), immediately after rule 2 and
before rule 4. OLD is the accepted rule 3 verbatim:

```diff
-3. **Internal glTF names and indices are not engine IDs.** Node names, mesh
-   names, primitive/material/slot indices, clip names and joint order may change
-   arbitrarily on reimport (including a version bump inside the file). They may be
-   inspected and displayed (from the derived cache), but **no persisted value may
-   reference them** — not in the scene, not in the catalog, not in a prefab, not
-   in an export's identity. Reimport therefore never creates a false persistent
-   reference when internal ordering changes (acceptance row A03).
+3. **Internal glTF names and indices are not engine IDs.** Node names, mesh
+   names, primitive/material/slot indices, clip names and joint order may change
+   arbitrarily on reimport (including a version bump inside the file). They may be
+   inspected and displayed (from the derived cache), but **no persisted value may
+   reference them** — not in the scene, not in the catalog, not in a prefab, not
+   in an export's identity. Reimport therefore never creates a false persistent
+   reference when internal ordering changes (acceptance row A03).
+
+   **One reviewed exception (M3, packet 41).** The scene value
+   `components.modelAnimation.roles[role]` (`presentation.md` §41.3.1) may carry
+   the immutable, version-local clip binding `{ clipIndex, clipName }` for the
+   asset version named by that same component's `assetId` and `version`. The
+   exception is bounded exactly by these rules:
+   (a) **scene data only** — it appears in no `content` block, prefab
+       definition, `AssetRecord`, derived cache, captured manifest, export
+       identity, proposal or diagnostic;
+   (b) **version-scoped and reimport-invalidated** — both fields describe one
+       immutable `(assetId, version)`; a reimport appends a new version and never
+       moves or inherits the binding, and a reimport of a referenced animated
+       asset must submit the new binding with the new bytes in one transaction
+       (`presentation.md` §41.3.4);
+   (c) **validated, never a lookup key** — the pair is validated against the
+       version's real clip list at publication and re-validated at load; the
+       runtime selects exclusively by `clipIndex`, and `clipName` is a bounded
+       consistency/display value that must equal `clips[clipIndex].name`;
+   (d) **no other internal name or index is permitted anywhere**, and adding a
+       role key or a binding field requires a `schemaVersion` change.
```

### PM41-2 — §18.5 `ImportRecipe`: the profile union

Anchor: replace the sentence "`profile` | string | exactly `\"gltf-glb\"` in M2"
row's constraint and the JSON example's preamble. OLD is the accepted profile
row text:

```diff
-| `profile` | string | exactly `"gltf-glb"` in M2 |
+| `profile` | string | exactly `"gltf-glb"` or `"pcm-wav"`. `"gltf-glb"` is the
+  M2/M3 model profile (§18.7); `"pcm-wav"` is the M3 audio profile
+  (`presentation.md` §41.4.3). A recipe's other fields depend on its profile |
```

```diff
-| `extensions` | array of string | ascending codepoint order; the extensions **actually used** by this source, each member of the profile allowlist (§7.3); `[]` when none |
+| `extensions` | array of string | **present iff `profile === "gltf-glb"`**; ascending codepoint order; the extensions **actually used** by this source, each member of the profile allowlist (§7.3); `[]` when none. For `profile === "pcm-wav"` the key is absent (`field_unexpected` if present) — a WAV has no glTF extensions |
```

```diff
+| `toolchain` | object | 1–8 entries `name → exact version string`; keys sorted codepoint order; must name **every** tool whose version can change the inspected result. For `"gltf-glb"` that is `three` (§18.5 accepted); for `"pcm-wav"` it is exactly `asset-pipeline` — the bounded pure inspector, with no decoder/library/`three` in the path (`presentation.md` §41.4.3) |
```

Compatibility: a v2 envelope cannot contain `kind: "audio"` (39 §23.3.7), so a
`pcm-wav` recipe is v3-only in effect; no v2 recipe changes meaning. Condition 8
of the accepted §18.5 rules (unknown profile ⇒ `recipe_invalid`) still applies
to any third profile value.

### PM41-3 — §18.6 `AssetMetrics`: the audio member

Anchor: after the accepted §18.6 table and its notes, insert:

```diff
+**Audio metric member (`presentation.md` §41.4.3).** For `kind: "audio"`
+(`profile: "pcm-wav"`) `metrics` is `PcmWavMetrics`, whose fields are
+`container: "riff-wave"`, `encoding: "pcm-s16le"`, `channels: 1`,
+`sampleRate: 48000`, `bitsPerSample: 16`, `frames`, `durationMs`, `pcmBytes`,
+`dataChunkBytes`, `riffChunkBytes`, in exactly that canonical order. Its caps
+are the exact arithmetic of `presentation.md` §41.4.2: `frames ≤ 96 000`,
+`pcmBytes ≤ 192 000`, `durationMs = floor(frames / 48) ≤ 2000`,
+`dataChunkBytes === pcmBytes`, `riffChunkBytes === 36 + pcmBytes`, and
+`sourceByteLength === 44 + pcmBytes ≤ 192 044`. Like the GLB member, the audio
+member is **re-validated against every cap on load**; a disagreeing record is
+invalid (`limits_exceeded` / `field_value`), never normalized.
```

### PM41-4 — §18.9.3 / §23.9 codes and limit names

Anchor: append to §18.9.3's code table and to the `limits_exceeded` enum line.

```diff
 | `recipe_invalid` | the import recipe is malformed, of an unknown profile/recipe version, or missing a required toolchain entry |
+| `animation_role_out_of_range` | `modelAnimation.roles[role].clipIndex` ≥ the named version's `metrics.animations`; carries `path`, `role`, `clipIndex`, `clips` |
+| `animation_role_duplicate` | two roles of one `modelAnimation` share a `clipIndex`; carries `path`, `clipIndex`, `roles` |
+| `animation_role_mismatch` | `clipName ≠ clips[clipIndex].name` (inspection/publication/load); carries `path`, `role`, `expected`, `found` |
+| `animation_role_ambiguous` | the version's clip list has more than one clip named `clipName`; carries `path`, `role`, `clipName`, `matches` |
+| `animation_skin_unsupported` | the animated-profile GLB carries `skins` or a `JOINTS_0`/`WEIGHTS_0` attribute; carries `path` |
+| `animation_root_motion` | a channel animates a scene root node's `translation`; carries `path`, `role`, `nodeIndex`, `nodeName` |
```

```diff
 'animation_channels' | 'clip_duration' | 'decoded_bytes' | 'json_chunk_bytes' |
-'image_bytes'`.
+'image_bytes' | 'animation_clips' | 'animation_tracks' |
+'animation_track_times' | 'animation_clip_duration' | 'audio_pcm_bytes' |
+'audio_cues'`.
```

### PM41-5 — §18.7 preamble: the audio profile pointer

Anchor: §18.7's opening line ("#### 18.7.1 Accepted subset" is preceded by the
§18.7 heading). Insert one sentence:

```diff
+§18.7 defines the **model** profile (`gltf-glb`) only. The M3 audio profile
+`pcm-wav` is `presentation.md` §41.4: RIFF/WAVE linear PCM, mono, signed
+16-bit little-endian, 48 000 Hz, exactly two chunks, `44 + pcmBytes` bytes with
+`pcmBytes ≤ 192 000`, inspected by pure bounded byte arithmetic in
+`asset-pipeline` (no decoder, no Node built-in, no network). Nothing in §18.7's
+GLB order applies to a WAV.
```
