PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# PROPOSED section-level diffs — `docs/contracts/dependencies.md` (packet 18)

**PROPOSED — pending Gate E.** Packet 18 (`docs/planning/m2-packets.md` §18)
output. This file contains *no* accepted text: it names the exact destination
sections of `docs/contracts/dependencies.md`, gives `OLD → NEW` text for every
existing section that changes, and gives insertion instructions (anchor +
normative text source) for new material.

Read with: [`../behaviors.md`](../behaviors.md) (§1 unit table, §5.3 pinned
module set, §5.4 purity, §9.7 forbidden capabilities), [`runtime.md`](runtime.md)
§"Packet 18 additions" (R19–R30) and [`project-model.md`](project-model.md)
§"Packet 18 additions" (P18-A1…P18-A9). Packet 17's change request R18 to this
same file (units `input`, `platformer`, `physics-rapier` and its `runtime`
exports) is **unchanged and remains in force**; packet 18 adds the two behavior
units on top of it. Promotion is docs-only, per diff, at Gate E; nothing here is
applied by packet 18.

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.** (A pre-approval, not an independent
review.)

Convention: `OLD` is the accepted text exactly as it reads today (shortest
unique quote); `NEW` is the replacement. `+` blocks are pure insertions at the
stated anchor.

---

## A. Summary of required changes

| # | Destination | Kind | Normative text |
|---|---|---|---|
| D18-1 | §2 "Units" (after R18's rows) | insert rows | `../behaviors.md` §1 |
| D18-2 | §3 "Public export surface per unit" (after R18's rows) | insert rows | `../behaviors.md` §11 |
| D18-3 | §4.1 "Node-side" (after R18's rows) | insert rows | `../behaviors.md` §5.4 |
| D18-4 | §4.2 "Browser-bundle graphs" (after R18's rows) | reword rows + insert | `../behaviors.md` §8.7/§9.7 |
| D18-5 | §4.3 "Forbidden edges" | insert bullets | `../behaviors.md` §9.7 |
| D18-6 | §5 "Enforceable boundary checks" | insert two negative probes | `../behaviors.md` §4/§9.7 |
| D18-7 | §6 "Module registration mechanism" (after R18's reword) | insert paragraph | `../behaviors.md` §9.1 |
| D18-8 | §7 "Approved M1 stack" | **no change** — recorded explicitly | `../behaviors.md` §5.4/§12.4 |
| D18-9 | §8 "What is deliberately not in M1" | insert bullets | `../behaviors.md` §15 |
| D18-10 | §9 "Change rules" | insert bullets | this file |

Not changed: §1 (scope wording still applies), §4.2's existing three bundle rows
except as amended by D18-4, §5's existing checks 1–7, §7's pins (no new
dependency; see D18-8).

---

## B. Existing sections

### D18-1 — §2 "Units (suggested initial set; created only when implemented)": insert rows

Anchor: after R18's rows for `input`, `platformer`, `physics-rapier`.

```diff
+| `behavior-compiler` | **Node-side only**, pure: the behavior source parser, the static import/dynamic-code analysis, the canonical `BehaviorManifest`, `compileBehavior` — no I/O, no evaluation, no server source execution (`../behaviors.md` §5.4) |
+| `behaviors` | **Browser-safe**: the `BehaviorSpec`/authored-module types, the host-side spec factory and registry helpers, the bounded intent API types and validators, `BEHAVIOR_API_VERSION` (`../behaviors.md` §9) |
```

Notes (append to the section's note list):

```diff
+- Neither unit creates a second mutation path: `workspace.runCommand` stays the
+  sole command executor and `behavior-compiler` produces no authoritative state
+  (its output is a derived cache, `../behaviors.md` §8.4).
+- `behavior-compiler` is not a browser unit and is never linked into a bundle;
+  `behaviors` is browser-only and is never imported by the workspace/backend
+  except as types.
```

### D18-2 — §3 "Public export surface per unit": insert rows

```diff
+| `behavior-compiler` | `.` → `compileBehavior`, `COMPILER_LIMITS`, `COMPILER_ID`, and the types `BehaviorCompileInput`, `BehaviorCompileResult`, `BehaviorManifest`, `CompileDiagnostic`, `PinnedModuleRef` (`../behaviors.md` §11) |
+| `behaviors` | `.` → `BEHAVIOR_API_VERSION`, `BEHAVIOR_MODULE_PREFIX`, `behaviorModuleId`, `defineBehaviorSpec`, `validateIntent`, `INTENT_LIMITS`, and the types `AuthoredBehaviorModule`, `BehaviorSpec`, `BehaviorSpecMeta`, `BehaviorStepContext`, `BehaviorIntent`, `IntentSet`, `IntentValidation` (`../behaviors.md` §11) |
+| `project-model` (added to packet 16/17's rows) | `BehaviorSourceRecord`, `BehaviorTrust`, `SourceGraphContainer`, `validateBehaviorSource`, `parseSourceGraphContainer`, `BEHAVIOR_SOURCE_LIMITS` (`../behaviors.md` §11) |
+| `runtime` (added to packet 17's rows) | types `BehaviorSpec`, `BehaviorStepContext`, `BehaviorIntent`, `IntentSet`, `IntentValidation`; no runtime function resolves, compiles or imports behavior code (`../behaviors.md` §9/§11) |
+| `workspace` (packet 33) | `prepareBehaviorSource(projectId, stageId \| { bytes }, declaration)` — preparation layer, injected compiler instance; no new authoritative operation (`../behaviors.md` §8.4/§11) |
+| `commands` (packet 33) | `acknowledgeBehaviorTrust` (`../behaviors.md` §7) |
```

### D18-3 — §4.1 "Node-side": insert rows

Anchor: after R18's rows.

```diff
+| `behavior-compiler` | `project-model` (types + `parseSourceGraphContainer`/`validateDeclaration`), `esbuild` (the pinned parser/transformer, §7) |
+| `behaviors` | `runtime` (types), `project-model` (types) — **browser** unit; it appears in this table only because `exports` maps are declared node-side |
+| `workspace` (added) | `behavior-compiler` (**types only** — the compiler instance is **injected** at service construction, like the exporter's injected workspace service; §4.3's "no hidden global services" applies) |
+| `backend` (added) | `behavior-compiler` (constructs the compiler and injects it into the workspace, mirroring `backend → exporter`) |
```

### D18-4 — §4.2 "Browser-bundle graphs": reword + insert

Reword the two runtime-bundle rows (after R18's amendments):

```diff
-| **play-preview bundle** (`dist/preview/`) | `editor/src/preview/**` (that directory only), `protocol` …, `runtime`, `three-adapter`, `project-model`, `three` |
+| **play-preview bundle** (`dist/preview/`) | `editor/src/preview/**` (that directory only), `protocol`, `runtime`, `three-adapter`, `project-model`, `behaviors`, `input`, `platformer`, `physics-rapier`, `three`, plus the **linked behavior outputs** of the snapshot (same pipeline, same pins; the linking rule below) |
-| **export bundle** (export output) | `exporter/src/export-bootstrap.ts` (that file only), `runtime`, `three-adapter`, `project-model`, `three` |
+| **export bundle** (export output) | `exporter/src/export-bootstrap.ts` (that file only), `runtime`, `three-adapter`, `project-model`, `behaviors`, `input`, `platformer`, `physics-rapier`, `three`, plus the **linked behavior outputs** of the snapshot (same pipeline, same pins) |
```

and append the linking rule:

```diff
+- **Linked behavior outputs are static bundle inputs, never dynamic imports.**
+  A behavior output is an artifact produced by `compileBehavior` and consumed by
+  the per-snapshot bundle build (packet 33): the generated entry statically
+  includes each published output for the snapshot's `outputDigest`s. The emitted
+  bundle therefore contains **no `import()`**, no behavior-specific `fetch`, and
+  no behavior source text; the forbidden-graph check applies to the whole graph
+  including the linked outputs (`../behaviors.md` §5.5/§8.7,
+  [`export.md`](export.md) E18-2).
+- The editor bundle must not include `behavior-compiler` or any behavior output:
+  the editor edits declarations, never code (`../behaviors.md` §9.7).
```

## C. Forbidden edges and checks

### D18-5 — §4.3 "Forbidden edges (normative, any plane)": insert bullets

```diff
+- `behavior-compiler → runtime | three | three-adapter | editor | backend | workspace | commands | mcp-adapter` (the compiler is a pure parser; it does not know the engine, the runtime or any service) and `behavior-compiler → any browser global or Node I/O builtin other than what §4.1 lists`.
+- `behaviors → three | three-adapter | editor | react | react-dom | backend | workspace | commands | mcp-adapter | protocol | exporter | behavior-compiler` (the browser host knows the runtime's types and the project-model's types only; it never compiles, never renders and never talks to a service).
+- `runtime → behaviors` and `runtime → behavior-compiler` (the runtime receives a registered module spec and an `IntentSet`; it never loads, links or compiles behavior code — the host bootstrap composes them, exactly as with `input`/`platformer`/`physics-rapier` in packet 17).
+- `workspace → behavior-compiler` at any subpath other than the types-only edge in §4.1, or a workspace-constructed compiler **instance** (the instance is injected by its host; a hidden global compiler is forbidden by §4.3's second paragraph).
+- Behavior source may not import engine modules as values and may not use `fetch`/`XMLHttpRequest`/`WebSocket`/`eval`/`import()` (`../behaviors.md` §4/§5.5). This is enforced by the compiler's static analysis and output scan, **not** by the boundary checker (the compiled output is not a package graph); the boundary checker additionally forbids the unit edges above.
```

## D. Checks, registration and pins

### D18-6 — §5 "Enforceable boundary checks": insert two negative probes

Anchor: after R18's probe, in the packet-04/10/12 check list.

```diff
+8. **Behavior unit edges** (`tools/check-boundaries.mjs` extension, packet 33): a
+   probe that makes `behaviors` import `three` fails the check, and a probe that
+   makes `runtime` import `behaviors` fails the check. Both probes are removed
+   after verification (disposable, per the packet instructions).
+9. **Compiler purity probe** (packet 33): a probe that lets
+   `behavior-compiler` import `workspace` or `backend` fails the check; a
+   fixture-level probe asserts `compileBehavior` reads no path by running it
+   with a filesystem accessor that throws (the compiler takes bytes only).
```

No check is disabled: the §5 checks 1–7 stay as accepted, and the two runtime
bundles' graph checks keep their exact-input rule with the linked outputs added
as inputs.

### D18-7 — §6 "Module registration mechanism": insert paragraph

Anchor: after R18's recorded M2 registry table.

```diff
+**Behavior modules** register through this same mechanism, one spec per
+`behaviorId`, with `id = "thirdlight.behavior:" + behaviorId`
+(`^thirdlight\.[a-z0-9]+:[a-z0-9-]+$` still holds because behavior IDs match
+project-model §5.1's ID syntax), phases `["intent"]` or `["intent","transform"]`
+and `transformOwners` = the container's `ownedTransforms`
+(`../behaviors.md` §9.1/§9.6). Registration is still compile-time code with no
+string-to-code resolution and no dynamic `import`: the spec for a published
+behavior is produced by the host bootstrap from the **already linked** output
+(`../behaviors.md` §8.4/§9.1). `source: null` behaviors register nothing. There
+is no file-, URL- or content-loaded module in M2, and this registry remains
+deliberately insufficient for untrusted code (`../behaviors.md` §2.4).
```

### D18-8 — §7 "Approved M1 stack": **no change** (recorded)

Packet 18 introduces **no new pin and no lockfile change**:

- the compiler uses the already-pinned `esbuild@0.28.2` (with
  `typescript@5.9.3` for its type-level contract) — D18-8 adds no row;
- `behaviors` has no runtime dependency other than `runtime`/`project-model`
  types (no `three`, no UI library, no physics package);
- the Rapier pin remains packet 17's proposal (lockfile at packet 31);
- the React scope rules are unchanged: `editor` is still the only package with a
  UI framework, and no behavior code may import React (`../behaviors.md` §9.7).

A version change to `esbuild`, `typescript`, `runtime`'s `apiVersion` or the
`export.md` §5.3 option set changes the compiled output bytes and therefore the
`outputDigest`/`manifestDigest` of published behaviors: it is a reviewed contract
change (`../behaviors.md` §12.4), announced in `meta.json`
([`export.md`](export.md) E18-3).

### D18-9 — §8 "What is deliberately not in M1": insert bullets

```diff
+- No behavior compiler, no behavior host package and no behavior source of any
+  kind in M1. M2 declares them here and implements them at packets 33–36
+  (`../behaviors.md` §15).
+- No `npm`-installed or URL-loaded project modules, no build plugins, no shell
+  hooks and no server-side source evaluation (`../behaviors.md` §2.2/§5.4).
```

### D18-10 — §9 "Change rules": insert bullets

```diff
+- Adding a behavior unit edge, changing `behavior-compiler`'s allowed imports,
+  weakening §4.3's behavior bullets or making `runtime` load/link/compile
+  behavior code is a reviewed contract diff (AGENTS.md: accepted contracts are
+  binding).
+- `compileBehavior`'s purity (bytes in, bytes out; no filesystem, network,
+  clock, randomness, evaluation or shell) is contract material: relaxing it is
+  the "server-side source evaluation/build hook" the packet-18 acceptance line
+  forbids, not a performance optimisation (`../behaviors.md` §5.4).
+- The bundle-linking rule (D18-4: static inputs, no `import()`) may not be
+  relaxed into a runtime loader: that would change `export.md` §5.3/§5.4's
+  single-fetch and scan binding and is a reviewed change with a re-measured
+  scan table.
```

---

# Packet 19 additions — approved M2 units, pins, edges and the delivery packages

**PROPOSED — pending Gate E.** Appended by packet 19
(`docs/planning/m2-packets.md` §19) to the same diff file. **Packet 18's
`D18-1`…`D18-10` above and packet 17's R18 change request remain in force,
except where a naming/supersession item below explicitly resolves them** (see
[`../contract-diffs.md`](../contract-diffs.md) §3). Nothing here is installed:
Gate E approves per diff; the lockfile changes only at the implementing packet.

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending** (a pre-approval, not an independent
review).

Normative text sources: [`../delivery.md`](../delivery.md) §§2/4/5/6/8/14,
[`../assets.md`](../assets.md) §12, [`../content-storage.md`](../content-storage.md)
§14, [`../input.md`](../input.md) §8, [`../physics.md`](../physics.md) §11,
[`../platformer.md`](../platformer.md) §12, [`../prefabs.md`](../prefabs.md) §12,
[`../properties.md`](../properties.md) §12, [`../behaviors.md`](../behaviors.md)
§11, [`sessions.md`](sessions.md) §"Packet 19", [`export.md`](export.md)
§"Packet 19 additions".

## D19. Summary

| # | Destination | Kind | Normative text |
|---|---|---|---|
| D19-1 | §2 "Units" | insert rows + NAMING RESOLUTION | this file §D19-A |
| D19-2 | §3 "Public export surface per unit" | insert rows | this file §D19-B |
| D19-3 | §4.1 "Node-side" | insert rows | this file §D19-B |
| D19-4 | §4.2 "Browser-bundle graphs" | reword rows + insert notes | this file §D19-B |
| D19-5 | §4.3 "Forbidden edges" | insert bullets | this file §D19-B |
| D19-6 | §5 "Enforceable boundary checks" | insert probes | this file §D19-B |
| D19-7 | §6 "Module registration mechanism" | insert the M2 registry table | `../platformer.md` §2/§10, `../behaviors.md` §9.1 |
| D19-8 | §7 "Approved M1 stack" | insert rows (Rapier; GLTFLoader note) | this file §D19-C |
| D19-9 | §8 "What is deliberately not in M1" | insert bullets | this file §D19-C |
| D19-10 | §9 "Change rules" | insert bullets | this file §D19-C |

## D19-A — Naming resolution (binding for the inventory)

Packet 17's R18 and packet 18's D18-1/D18-2/D18-3/D18-5/D18-6 used the unit
names `behavior-compiler` (Node-side) and `behaviors` (browser-safe). `m2-plan.md`
§4 names one Node unit **`behavior-build`** and no browser behavior package
(runtime owns "action/physics/behavior service types and lifecycle"). Packet 19
resolves this as one decision:

1. **`behavior-build` is the single Node-side unit name** (plan §4). Every
   `behavior-compiler` row/bullet in R18/D18 is re-read with this name.
2. **The browser-safe behavior host surface lives in `runtime`** (the behavior
   types + spec/intent validators). There is **no `behaviors` package**; every
   `behaviors` row/bullet in D18 is folded into the existing `runtime` rows.
3. Packet 18's normative text (behaviors.md, diffs) is otherwise unchanged: only
   the unit/package label moves. `COMPILER_ID` stays
   `'thirdlight.behavior-compiler'` as a stable string constant, but the package
   is `@thirdlight/behavior-build`.
4. **Promotion instruction (GE-2 repair, binding).** The D18 items are inserted
   **only** in their resolved form, never verbatim, so no destination contract
   ever contains both a `behavior-compiler`/`behaviors` row and its
   `behavior-build`/`runtime` replacement:
   - the `behavior-compiler` unit/export/edge/check rows of
     D18-1/D18-2/D18-3/D18-5/D18-6 are replaced by the `behavior-build` rows of
     D19-1/D19-2/D19-3/D19-5/D19-6 (they are **superseded, not added**);
   - D18-1's `behaviors` **unit** row, D18-2's `behaviors` export row, D18-3's
     `behaviors` node-side row and D18-5's `behaviors` forbidden-edge bullets
     are **folded into the existing `runtime` rows**, and D18-4's `behaviors`
     bundle-graph entry is dropped in favour of D19-4's reworded rows;
   - D18-2's `behaviors` exports (`BEHAVIOR_API_VERSION`,
     `BEHAVIOR_MODULE_PREFIX`, `behaviorModuleId`, `defineBehaviorSpec`,
     `validateIntent`, `INTENT_LIMITS`, and the types `AuthoredBehaviorModule`,
     `BehaviorSpec`, `BehaviorSpecMeta`, `BehaviorStepContext`,
     `BehaviorIntent`, `IntentSet`, `IntentValidation`) are added to the
     `runtime` §3 public-surface row.
   Nothing else in D18 changes: the behaviors.md normative rules and fixtures
   are untouched by the rename.

## D19-B — Rows, edges and checks

### D19-1 — §2 "Units": insert rows (after R18's and D18-1's rows)

```diff
+| `asset-pipeline` | pure bounded GLB inspection + import recipe over **supplied bytes** (`../assets.md` §7/§8) — no I/O, no cache writes, no asset-ID decisions (packet 24) |
+| `input` | pure action mapping/sampling plus the explicit browser attachment entry (`../input.md` §4/§5/§8) — imports runtime types; no authoring transport (packet 30) |
+| `physics-rapier` | the concrete 2D collision world + kinematic character adapter over the approved Rapier pin (`../physics.md` §5/§6/§11) — imports runtime types; no second frame driver (packet 31) |
+| `platformer` | the controller algorithm over injected input/physics ports (`../platformer.md` §4/§12) — runtime types only; no concrete physics, no three.js (packet 32) |
+| `behavior-build` | Node-side, pure: the behavior source parser, static import/dynamic-code analysis, the canonical `BehaviorManifest` and `compileBehavior` — the single shared compiler for play and export (`../behaviors.md` §5.4/§8.7) — no I/O, no evaluation (packet 33) |
```

Note to append:

```diff
+- `asset-pipeline`, `input`, `physics-rapier`, `platformer` and `behavior-build`
+  are the plan-§4 units; `runtime` carries the browser-safe behavior types
+  (naming resolution D19-A). None of them is a second mutation path:
+  `workspace.runCommand` stays the sole executor, and `behavior-build` produces
+  a derived artifact, never authoritative state.
```

### D19-2 — §3 "Public export surface per unit": insert rows

```diff
+| `asset-pipeline` | `.` → `inspectGlb(bytes, options)`, `ImportProposal`/`ImportDiagnostic`, `M2_GLTF_EXTENSION_ALLOWLIST`, `M2_GLTF_PROFILE_LIMITS` (`../assets.md` §12) |
+| `input` | `.` → `mapRawInput`, `attachBrowserInput`, `DEFAULT_KEYBOARD_MAP`, `GAMEPAD_DEAD_ZONE`, `RawInputSnapshot`, `InputBindingOptions` (`../input.md` §8) |
+| `physics-rapier` | `.` → `createPhysicsPort(config, signal?)`, `RAPIER_PIN`, `PHYSICS_IMPLEMENTATION` (`../physics.md` §11) |
+| `platformer` | `.` → `platformerSpec`, `PLATFORMER_MODULE_ID`, `CONTROLLER_CONSTANTS` (`../platformer.md` §12) |
+| `behavior-build` | `.` → `compileBehavior`, `COMPILER_LIMITS`, `COMPILER_ID`, `BehaviorCompileInput`, `BehaviorCompileResult`, `BehaviorManifest`, `CompileDiagnostic`, `PinnedModuleRef` (`../behaviors.md` §11) |
+| `runtime` (additions) | `ActionFrame`, `JumpPhase`, `ActionSource`, `createRecordedActionSource`, `SimulationPhase`, `StepContext`, `GameplaySettings`, `PhysicsPort`, `PhysicsStepClient`, `BehaviorSpec`, `BehaviorStepContext`, `IntentSet`, `IntentValidation`, `CONTROLLER_CONSTANTS`/window constants (`../input.md` §8, `../physics.md` §11, `../platformer.md` §12, `../behaviors.md` §11) |
+| `project-model` (additions) | `ContentCatalog`, `AssetRecord`, `AssetVersion`, `ImportRecipe`, `AssetMetrics`, `CapturedContent`, `captureContent`, `captureManifest`, `validateContent`, `validateProjectV2`, prefab/property/behavior validators, `resolveGameplaySettings`, `CONTROLLER_CAPSULE`, `M2_SETTINGS_KEYS` (`../assets.md` §12, `../prefabs.md` §12, `../properties.md` §12, `../physics.md` §11) |
+| `workspace` (packets 23/33) | `stageContent`, `inspectStage`, `publishBlob`, `discardStage`, `readBlob`, `contentIntegrity`, `captureContentView`, `captureManifest`, `migrateProjectCopy`, `prepareBehaviorSource` (`../content-storage.md` §14, `../behaviors.md` §11) |
+| `commands` (additions) | `publishAsset`, `createPrefab`, `instantiatePrefab`, `setComponent`, `setSettings`, `setBehaviorProperties`, `publishBehavior`, `acknowledgeBehaviorTrust` request/change/inverse types + `queryAssets`/`queryPrefabs`/`queryBehaviors` (`../prefabs.md` §12, `../properties.md` §12, `../behaviors.md` §11) — packet 16's op/inverse shapes carry forward unchanged (the interface note packet 15/16 left to packet 19) |
+| `three-adapter` (additions) | the GLB realization/resource-owner helpers + an injected byte resolver (`../delivery.md` §5): the adapter accepts **bytes or a resolver function**, never a token/URL/fetch; GLTFLoader/AnimationClip preview helpers |
+| `protocol` (packet 25/35) | the packet-19 route/message/error types + strict validators (asset-byte reads, content/job/query, locator, bridge v2, input relay) — the sole wire-shape home |
+| `backend` `/services` (packet 25/35) | content-upload/job coordination, verified asset-byte reads, the locator artifact serving and the relay routing (through the existing application-services surface) |
+| `exporter` (packet 36) | the shared manifest/closure builder + the packet-19 `meta.json` fields (`../delivery.md` §9) |
```

### D19-3 — §4.1 "Node-side": insert rows

```diff
+| `asset-pipeline` | `project-model` (types: `ImportProposal`/recipe/metrics shapes) — pure, **no** `three` and no GLTFLoader (packet 24 inspects bytes itself) |
+| `behavior-build` | `project-model` (types + `parseSourceGraphContainer`/`validateDeclaration`), `esbuild` (the pinned parser, §7) — the D19-A rename of D18-3's `behavior-compiler` row |
+| `workspace` (additions) | `behavior-build` (**types only** — the compiler instance is **injected**, like the exporter's workspace service) and `asset-pipeline` (**types only**, injected job port) |
+| `backend` | `asset-pipeline` (constructs the inspector and injects it), `behavior-build` (constructs/injects the compiler), `exporter` (already) |
+| `exporter` (additions) | `asset-pipeline` (types only; closure resolution via the injected workspace reads bytes as blobs) |
+| `three-adapter` (additions) | `runtime` (unchanged), `three` incl. the GLTFLoader/animation subpaths (D19-8's no-new-pin note) — still **no** network/storage edge |
```

and record the two runtime-related rows:

```diff
+| `input` | `runtime` (types) |
+| `platformer` | `runtime` (types) |
+| `physics-rapier` | `runtime` (types) + `@dimforge/rapier2d-compat` (the approved pin, §7) |
```

> **C33-7 (accepted with diff, Gate I; applied to `docs/contracts/dependencies.md`
> §4.1).** The `behavior-build` row above named
> `parseSourceGraphContainer`/`validateDeclaration`, which do not exist in
> `@thirdlight/project-model` (a leaf; packet 33's may-edit set excludes it).
> The actual edge is `project-model` (**types** + `parseDocumentBytes`, a value
> edge used for the strict parse) + the pinned `esbuild`. `COMPILER_LIMITS`
> additionally carries `ownedTransforms`, `properties` and `declarationBytes`
> (the declaration-bound limit names the compiler re-checks itself) beside the
> contract's nine bounds.

### D19-4 — §4.2 "Browser-bundle graphs": reword + notes

Reword the three rows:

```diff
-| **editor bundle** (`dist/editor/`) | `editor/**`, `protocol`, `runtime`, `three-adapter`, `project-model`, `commands`, `three`, `react`, `react-dom` |
+| **editor bundle** (`dist/editor/`) | `editor/**`, `protocol`, `runtime`, `three-adapter`, `project-model`, `commands`, `three` (incl. the GLTFLoader subpath for viewport/preview realization), `react`, `react-dom` |
-| **play-preview bundle** (`dist/preview/`) | `editor/src/preview/**` (that directory only), `protocol`, `runtime`, `three-adapter`, `project-model`, `behaviors`, `input`, `platformer`, `physics-rapier`, `three`, plus the **linked behavior outputs** of the snapshot |
+| **play-preview bundle** (`dist/preview/`) | `editor/src/preview/**` (that directory only), `protocol`, `runtime`, `three-adapter`, `project-model`, `input`, `platformer`, `physics-rapier`, `three` (incl. the GLTFLoader subpath), plus the **linked behavior outputs** of the snapshot |
-| **export bundle** (export output) | `exporter/src/export-bootstrap.ts` (that file only), `runtime`, `three-adapter`, `project-model`, `behaviors`, `input`, `platformer`, `physics-rapier`, `three`, plus the **linked behavior outputs** of the snapshot |
+| **export bundle** (export output) | `exporter/src/export-bootstrap.ts` (that file only), `runtime`, `three-adapter`, `project-model`, `input`, `platformer`, `physics-rapier`, `three` (incl. the GLTFLoader subpath), plus the **linked behavior outputs** of the snapshot and the **declared asset artifacts read as relative runtime resources** |
```

Append notes:

```diff
+- **`behavior-build` is never in a bundle graph** (Node-side only, D18-5);
+  neither is `asset-pipeline` (inspection happens at authoring/import time, the
+  preview/export read committed bytes).
+- **GLTFLoader is the pinned `three@0.186.0` package's own subpath** — no new
+  dependency, no new pin (D19-8). Only `three/examples/jsm/loaders/GLTFLoader.js`
+  (+ the animation loader used for clip preview) may appear; a different
+  `examples/jsm` module is a reviewed addition.
+- **Preview/export artifact reads are not imports.** `content/sha256/<digest>`
+  and `behaviors/<digest>.js` enter the closure as build inputs
+  ([`export.md`](export.md) E19-5); at runtime the bundle fetches only the
+  manifest-declared relative artifact paths ([`../delivery.md`](../delivery.md)
+  §4.3). The bundle-graph check therefore still forbids `backend`, `workspace`,
+  `commands`, `mcp-adapter`, `editor`, `behavior-build`, `asset-pipeline` and
+  every Node builtin.
```

### D19-5 — §4.3 "Forbidden edges": insert bullets

```diff
+- `asset-pipeline → any I/O | three | three-adapter | runtime | editor | backend | workspace | commands | behavior-build` (bytes in, proposal out).
+- `behavior-build → runtime | three | three-adapter | editor | backend | workspace | commands | mcp-adapter | any browser global` (D18-5 renamed: pure parser only).
+- `input → editor | protocol | backend | workspace | commands | three | three-adapter | physics-rapier | platformer | behavior-build` (pure mapping + one browser attachment entry; it knows `runtime` types only).
+- `platformer → three | three-adapter | physics-rapier | input | editor | backend | workspace | commands` (injected ports only).
+- `physics-rapier → three | three-adapter | editor | backend | workspace | commands | protocol` (runtime types + the approved Rapier pin only).
+- `runtime → asset-pipeline | behavior-build | physics-rapier | input | platformer` (the runtime receives injected ports/specs; it never imports a concrete adapter or compiler — R18/D18-5 retained).
+- `three-adapter → workspace | backend | protocol | editor | asset-pipeline | behavior-build` (the adapter gets bytes or an injected resolver; it holds no token, no URL and no fetch — `../delivery.md` §5).
+- `exporter → backend | editor | asset-pipeline` (closure resolution stays on the injected workspace reads).
```

### D19-6 — §5 "Enforceable boundary checks": insert probes

```diff
+10. **Runtime port isolation** (packets 29–32): a probe that makes `runtime`
+    import `input`, `platformer`, `physics-rapier`, `asset-pipeline` or
+    `behavior-build` fails check 1; the three adapter/compiler units are also
+    probed against importing `runtime` **as a value** (types only).
+11. **Artifact-read containment** (packets 25/35): a probe that makes
+    `three-adapter` or the preview bootstrap perform a non-relative fetch, or
+    fetch an undeclared path, fails the bundle/manifest closure check
+    ([`../delivery.md`](../delivery.md) §4.3).
+12. **Locator read-only probe** (packet 35): a probe requesting a locator path
+    outside the declared manifest set (traversal, listing, another `contentId`)
+    must yield `path_rejected` and no bytes.
```

## D19-C — Pins, non-goals and change rules

### D19-7 — §6 "Module registration mechanism": insert the M2 registry table

Anchor: after D18-7's behavior paragraph.

| Module ID | Phases | Transform owners | Registered when |
|---|---|---|---|
| `thirdlight.demo:box-motion` | (M1 single-phase) | its own box entities | M1 demo selected |
| `thirdlight.platformer:controller` | `["controller","transform"]` | the controller entity | the scene has exactly one controller entity |
| `thirdlight.behavior:<behaviorId>` | `["intent"]` or `["intent","transform"]` | the container's `ownedTransforms` | the snapshot declares the behavior with a non-null `source` and the host linked its `outputDigest` |

Plus the note: `physics-rapier` and `input` are **injected ports**, not registered
modules; registration remains compile-time code with no string-to-code resolution.

### D19-8 — §7 "Approved M1 stack": insert rows

```diff
+| 2D physics | `@dimforge/rapier2d-compat@0.20.0` (Apache-2.0; integrity `sha512-FFYwGrfJov7d5kn4fxblG/ip5C+sYQL+Jl/hqLvDvu4BcMD/Mhrz7cTvnZTtuIRDXY8CLuraObqB/prip4wdWQ==`) | `physics-rapier` (bundles: preview, export) | **PROPOSED, pending Gate E + packet-14 desktop evidence; lockfile only at packet 31** — selection per decision 0002 §1, owner pre-approval |
+| GLB loading | **no new pin**: the pinned `three@0.186.0` package's `examples/jsm/loaders/GLTFLoader.js` (+ its animation subpath) | `three-adapter` (bundles: preview, export) | decision 0001 §3; version-bound to the existing `three` pin — a `three` change re-measures export.md §5.4.1 |
+| Behavior compiler | **no new pin**: the already-pinned `esbuild@0.28.2` + `typescript@5.9.3` | `behavior-build` (Node) | packet 18 D18-8; no lockfile change |
```

Also reword the `Physics | none` row:

```diff
-| Physics | none | — | explicitly unselected (M2 evaluation — decision 0001 §3) |
+| Physics | see the Rapier row above | `physics-rapier` | M2 selection proposed by decision 0002 §1; Gate E approves, packet 31 installs |
```

**Exact integrity value (copy verbatim; not abbreviated):**
`sha512-FFYwGrfJov7d5kn4fxblG/ip5C+sYQL+Jl/hqLvDvu4BcMD/Mhrz7cTvnZTtuIRDXY8CLuraObqB/prip4wdWQ==`
(decision 0002 §1.2, recorded at packet 14).

### D19-9 — §8 "What is deliberately not in M1": insert bullets

```diff
+- No GLB importer, no asset pipeline, no packet-17/18/19 package: M2 declares
+  `asset-pipeline`, `input`, `physics-rapier`, `platformer` and `behavior-build`
+  here and implements them at packets 24/30/31/32/33.
+- No locator, no content byte route, no input relay and no v2 bridge in M1
+  (`sessions.md` §16–§18); M1's single-fetch/no-content-fetch policy is
+  unchanged until the packet-19 export diff is accepted.
```

### D19-10 — §9 "Change rules": insert bullets

```diff
+- Adding a unit, an edge, a bundle-graph row or a pin, weakening a forbidden
+  edge, or making a runtime bundle fetch a non-declared resource is a reviewed
+  contract diff (AGENTS.md). The Rapier pin is approved at Gate E and installed
+  only at packet 31; no packet installs it incidentally.
+- `behavior-build` is the single behavior compiler for play and export (naming
+  resolution D19-A); adding a second compiler or a runtime loader reopens this
+  diff and `behaviors.md` §5.4's purity rule.
```
