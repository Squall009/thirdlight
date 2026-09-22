# Repair note — CC-L-1 (Gate L P2-A): animated reimport must move the recorded version

**Outcome: REPAIRED** (green bar below). HEAD stays `5b746ee` — no commits.
Checkpoint per `docs/handoffs/gate-l-rereview.md` §3.5/§4: before packet 53.

## The defect (reproduced at Gate L, confirmed P2)

`publishAsset{mode: "reimport", animation}` (commands.md §8.5.1,
presentation.md §41.3.4) is the only way a version-local role mapping is
written. The engine wrote `components.modelAnimation = { ...component, roles }`
— **the recorded `version` was untouched** — and the change/inverse recorded
the `roles` value only. Consequences:

1. After a reimport to version 2 the entity still recorded version 1; capture
   resolves the binding's **recorded** version (project-model §19.2, CC-44-6:
   the recorded version wins over `currentVersion`), so the reimported bytes
   were never delivered for that entity — a **silent no-op success**.
2. This contradicted the accepted semantics: presentation.md §41.3.4 rules
   5–6 ("the runtime loads the new version against the new mapping"; reordered
   clips must work) and §41.3.1 (the binding is owned by that
   `(assetId, version)` — a `roles` value is only valid against the clip list
   of the version it is recorded with).
3. The recorded contract (commands.md §8.5.1 change shape,
   `previous/next: ModelAnimationRoles`) was internally inconsistent with the
   §41.3.4 rules it claimed to implement.

## The repair (the direction adjudicated at Gate L, implemented exactly)

The reimport now moves the entity's **full** `modelAnimation` component in
the same transaction: `version` advances to the newly appended version and
`roles` is replaced with the submitted mapping. The change/inverse carry the
**full** `ModelAnimationComponent` (project-model §23.3.6: `assetId`,
`version`, `roles`) in both directions, so:

- **forward**: the resulting state records `version == currentVersion` — the
  v3 gate validator (`asset_version_invalid`, "a binding is never silently
  moved", `packages/project-model/src/project-v3.ts`) accepts it and capture
  now resolves the entity to the reimported bytes;
- **undo**: the previous record (rolled-back `currentVersion`) and the full
  previous component are restored together — the old `version` binding is
  exactly what keeps the component valid (`1 ≤ version ≤ currentVersion`); a
  roles-only restore would have left the NEW version recorded above the
  rolled-back record (an invalid binding);
- **redo**: re-applies the recorded full `next` component (recorded-value
  rule, commands.md §9.1) — version and roles together.

### Files

- `packages/commands/src/types.ts` — new `ModelAnimationComponentValue`
  (`assetId`, `version`, `roles`); `PublishAssetChange.animation` re-typed
  from `previous/next: unknown` (roles) to full components.
- `packages/commands/src/content-ops.ts` — `applyPublishAsset`: the entity
  write is `{ ...component, version: <new currentVersion>, roles }` (one
  revision, one history entry — unchanged); the change records the full
  previous/next components.
- `packages/commands/src/history.ts` — undo restores the full recorded
  previous component; redo re-applies the full recorded next component.
- `packages/commands/src/m3-commands.test.ts` — the pinned assertions updated
  to the full-component shape + regression checks: after apply the entity
  records `version 2` with the new mapping; after undo `version 1` + the
  placeholder mapping; redo re-applies `version 2` + the new mapping.
- `tests/integration/m3-content/content-v3.test.ts` — the packet-48
  integration test (real backend + MCP transport, reordered-clip reimport)
  updated the same way, with the entity component re-checked through
  `tl_inspect` after apply and after undo.
- No fixture file modified; the M2/M3 frozen fixtures pin no
  `publishAsset{animation}` change shape (verified by inspection — the M3
  contracts fixtures carry only the envelope-level component rows, which the
  repair does not touch).

### Contract diff (recorded, applied — the adjudicated CC-L-1)

- **commands.md §8.5.1** — "Effect and atomicity": the op now "updates the
  entity's `modelAnimation` component — `version` advances to the newly
  appended version and `roles` is replaced with `args.roles`"; the
  `PublishAssetChange.animation` interface is
  `{ entityId, previous: ModelAnimationComponent, next: ModelAnimationComponent }`;
  the inverse restores the previous `modelAnimation` component (full value).
- **presentation.md §41.3.4 rule 3** — the change shape carries full
  components; the inverse restores the full previous component; the rule
  records why a roles-only update is a silent no-op (capture resolves the
  recorded version) and marks the roles-only wording as superseded (CC-L-1).
- **presentation.md §41.3.1** — the "never moves the recorded binding" clause
  (which §41.3.4's rules 1/5/6 contradicted) now reads: a `roles` value is
  only valid against the clip list of the version it is recorded with, so an
  atomic reimport moves the entity's component — `version` and `roles`
  together — to the newly appended version in the same revision; nothing
  else about the entity moves.

The §9.1 recorded-value rule, the §6.5 no-change definition, the presence
rule, the validation order (steps 1–8, unchanged), and the "one revision, one
history entry" atomicity are untouched. The `setComponent` generic owner path
for `modelAnimation` (authoring A3) is unchanged — it writes the full
component and has always been able to; the v3 gate validator bounds its
`version` against `currentVersion` on every resulting state.

## Commands run (all from the repo root)

| Command | Exit | Result |
|---|---|---|
| `npm test` | 0 | **156 files / 1948 tests** (unchanged count; assertions repaired) |
| `npm run typecheck` | 0 | 16 packages |
| `npm run check-deps` | 0 | green |
| `npm run check-boundaries` | 0 | 16 pkgs / 307 files / 1195 specifiers, 0 violations |
| `npm run build` | 0 | 4 built, 0 skipped |
| M2 contracts/input/course/runtime/behaviors/physics checkers | 0 | all green |
| M3 gameplay/contracts/media/delivery/storage checkers | 0 | all green |
| M3 audit + promotion checkers | 0 | 8/8; all green |
| M3 media `generate-fixtures.mjs --check` | 0 | 65 files reproduce exactly |

## Limitations

None known. The repair is engine-internal + two contract-paragraph diffs;
the behavior was verified at the unit level (the real command engine) and the
integration level (real backend + MCP transport, through the packet-48
role-aware reimport stages 5–7).

**Next: packet 53 — Rigid runtime animation roles and blending** (the
pre-53 checkpoint is now clear; carried item: 53 adds placeholder
`modelAnimation.roles` fixtures per Gate L P3 — the real-roles fixtures land
with 53's `setRoles` evidence).