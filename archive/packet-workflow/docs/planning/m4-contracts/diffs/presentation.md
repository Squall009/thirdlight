# Owned diff rows — `presentation.md` (packet 64)

Proposal: `../delivery.md` §2 (delivered rendering). Gate Q.
**PROPOSED — not accepted.** Single owner: the `presentation.md`
sections are owned by this packet's rows; no other M4 packet edits
`presentation.md`. No frozen number is changed (the constants
`RUN_SPEED_EPS = 0.05`, `ANIMATION_CROSSFADE_SECONDS = 0.2`, the
§41.7.1 limits are restated, not changed).

## C64-3 — `§41.3.6` rule 7 clarification + non-player selection

### Row 1: `presentation.md` §41.3.6, rule 7 (clarification; the normative
selector behavior is unchanged, the sentence's scope is fixed)

OLD:

```text
7. **Invalid or absent mapping is a hard presentation failure, not a fallback.**
   `setRoles` returns `animation_role_unresolved` when the loaded clips do not
   satisfy the committed mapping (stage 5–6 re-check). The host then renders
   the model **statically at its committed transform** (no animation), records
   one bounded diagnostic, and does not run gameplay — a corrupt/undeclared
   declared asset is never silently mislabelled. Absent `modelAnimation` on an
   entity means "no selector"; that is not an error.
```

NEW (the bolded rule is unchanged; the ambiguous clause "does not run
gameplay" is scoped explicitly, and the non-player input rule is added —
the committed `GameView` carries only the **player's** motion, so a
non-player animated entity's selection input must be fixed):

```text
7. **Invalid or absent mapping is a hard presentation failure, not a fallback.**
   `setRoles` returns `animation_role_unresolved` when the loaded clips do not
   satisfy the committed mapping (stage 5–6 re-check). The host then renders
   the model **statically at its committed transform** (no animation), records
   one bounded diagnostic, and the **role selector for that model does not run**
   (the runtime's run proceeds with the model static — the model itself loaded
   successfully; the residual case is digest-gated defense-in-depth, the accepted
   load-time re-check of the publish-validated mapping). A corrupt/undeclared
   declared asset is never silently mislabelled. Absent `modelAnimation` on an
   entity means "no selector"; that is not an error.
   **Non-player input (clarification).** The committed view carries the
   player's motion only. For a **non-player** animated entity the selector's
   view is the constant neutral motion `{ speed: 0, grounded: true }`, so the
   accepted pure selection yields `idle` with no blending and no
   `run`/`airborne`. No new selector API, no tuning key, no second motion
   source.
```

## C64-4 — `§41.9` public-surface additions (the `models` block)

### Row 2: `presentation.md` §41.9 (the `three-adapter` row — additive)

OLD (the `three-adapter` row of the §41.9 table):

```text
| `three-adapter` | `.` (existing root, loader-free) | `createAnimationRoleController`/`AnimationRoleController` + the profile/state types (§41.3.6); shadow/light realization options on the accepted `createSceneAdapter` options; `AnimationRoleBinding`-shaped input types validated against `PreparedVisualResource.clips`; `animation_role_unresolved` in `ERROR_CODES`; the `SceneAdapterDiagnostics.shadows`/`shadowReason` fields. All on the existing root subpath — **no new subpath, no new three subpath, no pin change** |
```

NEW (one additive sentence + the two new codes, same row, same "no new
subpath/pin" binding):

```text
| `three-adapter` | `.` (existing root, loader-free) | `createAnimationRoleController`/`AnimationRoleController` + the profile/state types (§41.3.6); shadow/light realization options on the accepted `createSceneAdapter` options; `AnimationRoleBinding`-shaped input types validated against `PreparedVisualResource.clips`; `animation_role_unresolved` in `ERROR_CODES`; the `SceneAdapterDiagnostics.shadows`/`shadowReason` fields; the **M4 `models` block on `createSceneAdapter` options** (the resolved model-asset map, the per-`modelAnimation`-entity committed mappings, and the injected byte resolver — the accepted packet-26 `AssetByteSource` shape; the adapter realizes `model` entities as attached `ModelInstance`s under the entity holders and drives one role controller per animated entity from the single `renderFrame` loop, `delivery.md` (M4) §2), with `models_config_invalid` / `models_asset_unresolved` in `ERROR_CODES` (new, closed set) and the `SceneAdapterDiagnostics.models` counters block (`assets`/`instances`/`pending`/`animations`/`failed` — counters only, no paths/tokens/IDs; absent when `models` is absent). All on the existing root subpath — **no new subpath, no new three subpath, no pin change** |
```

### Row 3: `presentation.md` §41.7.2 D (the adapter code set — two additions)

OLD:

```text
**D. `three-adapter` code addition:** `animation_role_unresolved`
(validation-class, hard) — the loaded version's clips do not satisfy the
committed mapping (§41.3.6 rule 7). The accepted adapter code set is otherwise
unchanged (no `shadow_*` error: degradation is a diagnostic, not an error).
```

NEW:

```text
**D. `three-adapter` code addition:** `animation_role_unresolved`
(validation-class, hard) — the loaded version's clips do not satisfy the
committed mapping (§41.3.6 rule 7); `models_config_invalid` (validation-class,
hard) — the M4 `models` block is structurally invalid against the snapshot
(scene without `modelAnimation`/`model` mismatch, or present on a non-v3
scene) (M4 `delivery.md` §2.2); `models_asset_unresolved` (validation-class,
bounded diagnostic) — a `model` entity's `assetId` resolves to no declared
asset row (defensive residual; unreachable for a well-formed capture) (M4
`delivery.md` §2.3). The accepted adapter code set is otherwise unchanged
(no `shadow_*` error: degradation is a diagnostic, not an error).
```

**No other `presentation.md` change.** The §41.6 lifetime table is
satisfied by the accepted packet-26 primitives (per-instance material
cloning is the accepted rule 3's requirement, not a new row); §41.7.1
limits are untouched.