# Gate G bounded repair (GG-1…GG-8)

2026-09-19. Owner pre-approval: "autonomous M2 build instruction, 2026-09-18;
final manual review pending". No commit/push/install/browser (U-5 open);
browser/WebGL/pixel/network claims **UNVERIFIED**. Packet 29 not started.
Applies exactly the adjudicated diffs in `docs/handoffs/gate-g.md` §5.

## Status

- **GG-1 (C27-1) — applied.** `createEntity` `kind:"model"` +
  `model.asset.assetId` (commands.md §2/§3.1/§5.4/§8.1); commands
  validation/application/ID allocation/change, editor placement and the Place
  control wired. Byte-exact scenario `fixtures/m2/{commands,contracts/commands}/
  model-authoring.messages.json` (create model, undo/redo,
  `asset_reference_missing`) + commands tests + the authoring-flow place-twice
  flow.
- **GG-2 (C28-1) — applied.** `setComponent` component set
  `{box,camera,model,collider,controller}`, add/edit and `value:null` remove for
  the physics components (commands.md §2/§3.1.6/§5.3/§8.10/§9.1; inverse
  `restore: previous | null`); commands/history handle `null`; editor controls
  editable. Fixture covers collider add/edit/remove, controller add/remove,
  `component_conflict`, `controller_count_invalid`, bad shapes. **Clarification
  within the diff:** the field-less `controller` ADD value is exactly `{}`
  (§8.10).
- **GG-3 (C26-2) — applied.** export.md §5.4.1 measured GLTFLoader row
  (`https://` +12→35, `GLTFLoader` ×37, bytes 2 137 831, 2026-09-19) + binding 4
  restated; dependencies.md §5 check 4 references it.
- **GG-4 — applied.** preview generation token in `model-instances.ts`; stale
  successful preview disposed; Node test asserts stale code, holder count,
  ownership 0.
- **GG-5 — applied.** Packet-27 A02 row and packet-28 reopen wording corrected;
  dated repair notes in handoffs 27/28 and the `GestureRunner` source comment.
- **GG-6 — applied.** dependencies.md §3 `./gltf-loader` subpath + loader-free
  root + single-change-point sentence; project-model §18.1/§20.4 `clone(true)`
  skeleton limitation.
- **GG-7 — applied.** sessions.md §9 Rotate/coordinate rows name both
  accumulated axes; rotate helper draws both rings (smaller option).
- **GG-8 — applied.** 2-attempt failed-load guard + Node test.
- **GG-9 — noted.** M1 gizmo accumulated-drag change to re-check in packet 37.

## Files

Contracts (commands, export, dependencies, project-model, sessions); commands
(types/validate-request/validate-content-args/ops/content-ops/history/index);
editor (placement, property-controls, projection, gesture comment;
model-instances, gizmo; App, AssetBrowser, Inspector, PropertyControls);
fixtures + expected.json + checker p27-authoring + prefab-failures union text;
commands `m2-authoring.test.ts`; editor tests; m2-assets/m2-prefabs browser
tests; evidence manifests and handoffs 27/28.

## Commands (actual)

`npm test` 97 files/**1277 passed** exit 0; `npm run typecheck` exit 0;
`npm run check-deps` exit 0; `npm run check-boundaries` 11/217/790 exit 0;
`npm run build` `4 built, 0 skipped` exit 0;
`node fixtures/m2/contracts/tools/check-fixtures.mjs` `check OK: 34 group(s)
passed, 0 problem(s)` exit 0; targeted: commands 13/222, editor 13/130,
m2-content+editor+m2-assets+m2-prefabs 16/180. M1
`request-validation.test.ts` and the accepted packet-16 `prefab-failures.json`
component-set text changed because the contract union changed; all other M1
fixtures/tests byte-unchanged.

## Not applied

`packages/protocol` needed **no** change: it validates the op name only; the arg
union lives in `@thirdlight/commands` types.

## Re-acceptance

The reopened Gate E portions in gate-g.md §5.1/§5.2/§5.3 are **re-accepted as of
this repair** (owner pre-approval tag): C27-1 commands.md §2/§3.1/§5.4/§8.1;
C28-1 commands.md §2/§3.1.6/§5.3/§5.4/§8.10/§9.1; C26-2 export.md §5.4.1 +
dependencies.md §5 check 4; C26-1 dependencies.md §3; C26-4 project-model
§18.1/§20.4; C27-2 sessions.md §9.

**Exact next step: packet 29 (not started).**
