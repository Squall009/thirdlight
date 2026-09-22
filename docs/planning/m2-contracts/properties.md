PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# Thirdlight — Declared Properties, Component/Settings Edits and Behavior Declarations

**PROPOSED — pending Gate E.** Packet 16 output
(`docs/planning/m2-packets.md` §16). Companion documents:

- [`prefabs.md`](prefabs.md) — prefab definitions, capture, materialized
  instantiation, deterministic ID allocation, `queryPrefabs`.
- [`assets.md`](assets.md), [`content-storage.md`](content-storage.md) — packet 15
  (asset identity, staging, one authoritative publication pipeline).
- [`diffs/commands.md`](diffs/commands.md) — exact section-level changes to
  `docs/contracts/commands.md`.
- [`diffs/project-model.md`](diffs/project-model.md) §"Packet 16 additions".

Nothing in `docs/contracts/` or `docs/decisions/` changes until the Gate E
promotion step. Owner pre-approval: **owner pre-approval (autonomous M2 build
instruction, 2026-09-18); final manual review pending.**

Normative keywords **must**, **must not**, **should**, **may** are used in the
RFC 2119 sense.

---

## 1. Scope and ownership

This contract owns:

- The **declared-property vocabulary**: `DeclaredProperty` schemas and
  `PropertyValue` values — types, defaults, ranges, lengths, enums and bounds.
- Where schemas live (`content.behaviors[].declaration.properties`), the
  `components.behavior` value component, and every-field default/type/range.
- `publishBehavior` (**declaration** publication; source publication is
  unavailable, §5.2), `setBehaviorProperties`, `setComponent`, `setSettings`.
- Declaration compatibility rules (never silently drop stored values).
- The bounded content queries `queryAssets` and `queryBehaviors`.
- The change/inverse/projection additions for all of the above.

It does not own:

- Prefab definitions and instantiation (including how overrides address
  definition local entities) — [`prefabs.md`](prefabs.md).
- Behavior **source** capture, compilation, sandbox boundary, execution,
  scheduling, runtime intents and diagnostics — packets 18/33/34.
- Gameplay **settings keys** and their meanings — packet 17 (this contract fixes
  the container, command, value vocabulary and bounds; the key registry is
  packet 17's).
- Asset records/blobs/staging — packet 15.
- The final v2 component registry and any v2 component beyond this contract's
  pinned set — packet 20.

| Unit | Proposed ownership |
|---|---|
| `project-model` | `DeclaredProperty`, `PropertyValue`, `BehaviorRecord` (declaration part), `components.behavior` validation, `validateProjectV2` extension, the new codes/limits |
| `commands` | `publishBehavior`, `setBehaviorProperties`, `setComponent`, `setSettings` request validation, change/inverse data, projection data |
| `workspace` | sole executor/commit (accepted `runCommand`) |
| `mcp-adapter`/`editor` | the same commands plus bounded queries; no direct writes |

## 2. Property type vocabulary

Exactly seven types. No functions, no arbitrary object graphs, no accessor
execution, no schema discovery by evaluating code, no JSON-Schema machinery, no
unions, no arrays-as-values (a `vec3` is a fixed-length numeric triple, not a
general array), no `null` except as the declared default/unset value of
`entityRef` and `assetRef`.

```ts
type PropertyType = 'number' | 'boolean' | 'string' | 'enum' | 'vec3' | 'entityRef' | 'assetRef';
type PropertyValue = number | boolean | string | [number, number, number] | null;

interface DeclaredProperty {
  key: string;            // ^[a-z][a-z0-9_]{0,63}$ (1–64 chars), unique in its declaration
  label: string;          // 1–64 chars, no control chars
  type: PropertyType;
  default: PropertyValue; // must satisfy this property's own constraints
  min?: number;           // number: finite, |v| ≤ 1e12
  max?: number;           // number: finite, |v| ≤ 1e12; min ≤ max
  step?: number;          // number: > 0, ≤ 1e6 (UI increment only; never validated as a grid)
  maxLength?: number;     // string: integer 1–1024 (default 256)
  values?: string[];      // enum: 1–32 members, each 1–64 chars, no control chars, unique
  bounds?: { min: Vec3; max: Vec3 }; // vec3: finite, component-wise min ≤ max, |v| ≤ 1e6
}
```

Canonical field order: `key, label, type, default, min, max, step, maxLength,
values, bounds` (only present fields are emitted). Declaration key order is
`properties`; the array preserves declaration order, which is the canonical
order of `values` maps everywhere (a value map always contains **every** declared
key, in declaration order).

| Type | Value constraint | Absent/`null` default | Failure codes |
|---|---|---|---|
| `number` | finite; `min ≤ v ≤ max` when given; JSON number | no | `property_type`, `property_value` |
| `boolean` | exactly `true`/`false` | no | `property_type` |
| `string` | string; `length ≤ maxLength` (code points); no control chars; the empty string is allowed | no | `property_type`, `property_value` |
| `enum` | string, exactly one member of `values` | no | `property_type`, `property_value` |
| `vec3` | array of exactly 3 finite numbers; component-wise within `bounds` when given | no | `property_type`, `property_value` |
| `entityRef` | entity ID (project-model §5.1) present in the same scene, or `null` | yes (`null`) | `property_type`, `reference_missing` |
| `assetRef` | `assetId` present in `content.assets`, or `null` | yes (`null`) | `property_type`, `asset_reference_missing` |

Normative notes:

- `entityRef`/`assetRef` are **whole-reference** values (like
  `components.model.asset.assetId`): no sub-entity, submesh, material-slot or clip
  references exist anywhere in M2 (`assets.md` §3.3).
- Enum membership and lengths are validated as data; no value is ever `eval`'d or
  used to look up code.
- A `number` with a `step` is still validated by `min`/`max` only; `step` is a UI
  hint and never a rounding rule on the stored value.
- Inside a **prefab definition**, an `entityRef` value must name a `localId` of
  that definition or be `null` (`prefabs.md` §3); in a scene it must name an
  existing scene entity.
- Values are stored in canonical form with defaults filled: a persisted
  `components.behavior.values` always contains all declared keys.

## 3. Where schemas and values live

1. **Schemas** live in `content.behaviors[i].declaration.properties`
   (this contract's record part; the rest of the behavior record is packet 18's).
2. **Values** live in the scene component `components.behavior`:

```ts
interface BehaviorComponent {
  behaviorId: string;                     // must resolve in content.behaviors
  values: Record<string, PropertyValue>;  // every declared key, declaration order
}
```

Canonical key order: `behaviorId`, `values`; `values` in declaration order;
`components` in registry order (`transform, model, box, camera, behavior,
prefab`).

3. **Prefab-definition entities** may carry `components.behavior`; their recorded
   `values` are the materialization source for instantiation
   ([`prefabs.md`](prefabs.md) §7.3).
4. `components.behavior` is validated on every load: an unresolvable
   `behaviorId` is `behavior_reference_missing`; an undeclared key is
   `property_unknown`; a type/value failure is `property_type`/`property_value`.
   A document is **invalid**, not silently repaired: unknown keys are never
   dropped.
5. **One mutation path per component.** `transform` is owned by the accepted
   `setTransform`; `behavior` by `setBehaviorProperties`; `prefab` is written only
   by `instantiatePrefab` and is read-only afterwards; `box`, `camera` and `model`
   by `setComponent`. No operation accepts a component it does not own
   (`field_value`).

## 4. Bounds

Exact proposals; pinned at Gate E.

| Class | Bound | Value | Failure |
|---|---|---|---|
| request | canonical request JSON bytes (all packet-16 ops, `prefabs.md` §5) | ≤ 65 536 | `limits_exceeded` (`request_bytes`) |
| behaviors | `content.behaviors` length | ≤ 64 | `limits_exceeded` (`behaviors`) |
| declaration | properties per declaration | ≤ 32 | `limits_exceeded` (`properties`) |
| declaration | enum members | ≤ 32 | `limits_exceeded` (`enum_values`) |
| declaration | string `maxLength` | ≤ 1024 | `number_out_of_range` |
| declaration | `label` / `key` / enum member length | ≤ 64 | `property_value` |
| declaration | canonical declaration bytes | ≤ 32 768 | `limits_exceeded` (`declaration_bytes`) |
| values | keys per `components.behavior.values` | = declared count | `property_unknown` / `property_value` |
| settings | keys in `content.settings` | ≤ 32 | `limits_exceeded` (`settings_keys`) |
| settings | key length / syntax | ≤ 64, `^[a-z][a-z0-9_]{0,63}$` | `setting_unknown` / `field_value` |
| query | `limit` for `queryAssets`/`queryBehaviors` | 1–128 (default 50) | `field_value` |
| query | `queryAssets` versions included per record | ≤ 32 (accepted per-asset cap) | — |

## 5. `publishBehavior`

### 5.1 Declaration modes

```json
{
  "op": "publishBehavior",
  "projectId": "demo-0003",
  "expectedRevision": 2,
  "requestId": "req-60100000000000000000000000000000",
  "origin": { "kind": "browser", "clientId": "browser-demo" },
  "args": {
    "behaviorId": "behavior-0001",
    "displayName": "Lantern Glow",
    "mode": "declaration-create",
    "declaration": { "properties": [ /* DeclaredProperty[] */ ] }
  }
}
```

| Field | Type / constraint | Required |
|---|---|---|
| `behaviorId` | ID syntax; unique for `declaration-create`; must exist for `declaration-update` and `source` | yes |
| `displayName` | 1–128 chars, no control chars | yes |
| `mode` | `"declaration-create"` \| `"declaration-update"` \| `"source"` | yes |
| `declaration` | `{ properties: DeclaredProperty[] }`, 1–32 properties | yes |
| `source` | `{ sourceDigest, sourceByteLength }` — only with `mode: "source"`; the digest-bound preparation record is packet 33's | only for `source` |

`mode` is explicit: a create never silently upgrades into an update. The record
written for a declaration mode is:

```ts
interface BehaviorRecord {
  behaviorId: string;
  displayName: string;
  declaration: { properties: DeclaredProperty[] };
  source: null;         // M2: only null is writable (see §5.2)
  publishedRevision: number; // == the resulting revision of the publishing command
}
```

Canonical key order: `behaviorId, displayName, declaration, source,
publishedRevision`; `content.behaviors` in ascending `behaviorId` codepoint
order. Packet 18 extends this record (source/build fields); it must not change
the declaration part or its canonical order without a reviewed change.

### 5.2 Source mode is unavailable in M2

`mode: "source"` fails with `behavior_publication_unavailable`
(`cls: unavailable`, `reason: "preparer_unavailable"`) — **always**, before any
stage lookup, digest check or validation of the supplied `source` value. It is
not an unchecked write path and it is not a "coming soon" success:

- `m2-plan.md` §3.5 and `docs/planning/m2-packets.md` §18 fix the order: stage
  source → validate/compile the captured graph → prepare a digest-bound
  successful result → atomic publication through `runCommand`.
- Until packet 33 supplies that preparation path, only the **declaration** part of
  a behavior can be published, and `source` stays `null`. A behavior with
  `source: null` executes nothing (packet 18 defines that); it exists so that
  declared properties, prefab behavior components and property editing are
  representable and testable now.
- Staging itself remains available and non-authoritative
  (`content-storage.md` §5): bytes may be staged and inspected without becoming
  authoritative.

### 5.3 Validation order (`declaration-create` / `declaration-update`)

1. Envelope: request bytes ≤ 65 536, then `args` schema (unknown fields ⇒
   `field_unexpected`; `source` present without `mode: "source"` ⇒
   `field_unexpected`).
2. `mode` ⇒ `source` short-circuits to §5.2.
3. `behaviorId` syntax (`id_invalid`); existence: create ⇒ absent
   (`behavior_id_duplicate`), update ⇒ present (`behavior_not_found`).
4. `displayName` shape (`field_value`); declaration bounds
   (`limits_exceeded` `properties`/`enum_values`/`declaration_bytes`).
5. Every property: key syntax/uniqueness (`property_value`), label, type, default
   and constraint coherence — a `default` that violates its own constraints is
   `property_value`; `min > max`, a negative `maxLength`, duplicate enum members,
   missing `bounds` on a vec3 default are all rejected as data.
6. **Compatibility** (update only, §6.4): for every existing
   `components.behavior` value and every prefab-definition behavior value that
   references this `behaviorId`, the new declaration must accept the stored
   values (same key set plus any new defaulted keys, same type, still in range).
   A failure is `property_declaration_incompatible` carrying
   `{ behaviorId, reason, uses: [{ entityId, key }] }` — nothing is written and no
   stored value is dropped.
7. Resulting-state validation + no-change over scene **and** content.
8. Durability write, publish, ack.

### 5.4 Result, change and inverse

```ts
interface PublishBehaviorChange {
  type: 'publishBehavior';
  behaviorId: string;
  previous: BehaviorRecord | null; // null for a create
  next: BehaviorRecord;            // the full new record (publishedRevision == result revision)
}
```

Inverse: `{ kind: 'publishBehavior', behaviorId, restore: previous }` — undo
restores the previous record value (`null` for a create removes the record); redo
re-applies the recorded `next` verbatim. A record removed by undo is invisible to
`setBehaviorProperties`, prefab capture (its declaration is gone) and validation
until restored.

## 6. Declaration lifecycle and compatibility

### 6.1 Stable keys

`key` is the stable identifier for a property value; `label` is display-only and
renameable without affecting values. Renaming a `key` is a **removal + addition**
and is therefore governed by §6.4 (it cannot silently drop stored values).

### 6.2 Defaults

A default is part of the schema and is materialized when a value map is created
(`setBehaviorProperties` and instantiation). Changing a default affects **new**
values only; existing stored values are untouched (canonical form stores values,
not "unset" markers).

### 6.3 Unknown overrides are never dropped

Every entry point — `setBehaviorProperties`, instantiation overrides, load
validation and `publishBehavior` updates — fails on an undeclared key
(`property_unknown`) rather than discarding it. There is no "ignore extra keys"
mode in M2.

### 6.4 Compatibility rules

`declaration-update` is accepted only if **all** of the following hold for every
existing use (scene components and prefab-definition components that reference
this `behaviorId`):

1. Every stored key remains declared with the same `type`.
2. Every stored value still satisfies its constraints (range, length, enum
   membership, reference resolution).
3. A changed `entityRef`/`assetRef` default may not be applied to a stored value
   (stored values win); changing a default is compatible because it only affects
   new values.
4. Removing a declared key is compatible **only if no stored value uses it**; the
   failure carries the offending `(entityId|localId, key)` pairs.
5. `properties: []` (an empty declaration) is invalid for both modes: a behavior
   with no declared properties executes nothing meaningful and would make every
   stored value unknown.

This is what makes "definition/source compatibility changes cannot silently erase
user data" observable: the update either validates every use or fails with the
list of uses it would have broken.

## 7. `setBehaviorProperties`

Attach, update or remove one entity's behavior component. This is the **only**
mutation path for `components.behavior`.

```json
{
  "op": "setBehaviorProperties",
  "projectId": "demo-0003",
  "expectedRevision": 3,
  "requestId": "req-60200000000000000000000000000000",
  "origin": { "kind": "mcp", "clientId": "pi-harness" },
  "args": {
    "entityId": "model-0001",
    "behaviorId": "behavior-0001",
    "values": { "speed": 4.5, "target": "group-0001" }
  }
}
```

| Field | Type / constraint | Required |
|---|---|---|
| `entityId` | existing entity ID | yes |
| `behaviorId` | existing behavior ID, or `null` to remove the component | yes |
| `values` | partial map of declared keys; omitted keys take their declaration default | no (default `{}`) |

Validation order:

1. Envelope: request bytes ≤ 65 536, then `args` schema.
2. `entityId` resolves (`entity_not_found`). The camera entity may not carry a
   behavior component: `entityId` naming the camera ⇒ `field_value`.
3. `behaviorId` resolves (`behavior_not_found`), or is `null` (removal).
4. Every provided key is declared (`property_unknown`) and type-checks
   (`property_type`/`property_value`); `entityRef`/`assetRef` resolve
   (`reference_missing`/`asset_reference_missing`).
5. Application **replaces the whole component**: `components.behavior =
   { behaviorId, values }` with defaults filled for omitted keys, in declaration
   order. Switching `behaviorId` on an entity keeps only the keys declared by the
   new declaration (an undeclared stored key cannot exist because it would have
   failed step 4).
6. Resulting-state validation + no-change over scene and content (`no_change`
   when the component value is byte-identical).
7. Durability, publish, ack.

Change data:

```ts
interface SetBehaviorPropertiesChange {
  type: 'setBehaviorProperties';
  id: string;
  previous: BehaviorComponent | null;   // full previous component
  next: BehaviorComponent | null;       // full next component (null = removed)
  changedKeys: string[];                // declaration order
}
```

Inverse: `{ kind: 'setBehaviorProperties', id, restore: previous }` (restore
`null` removes the component). Self-inverse in the direction actually applied,
exactly like `setTransform`.

## 8. `setComponent`

Typed partial edit of one **owned** component on one entity. It is the only
mutation path for `box`, `camera` and `model`.

| `component` | Accepted fields (partial replacement, per field) | Notes |
|---|---|---|
| `box` | `size` (3 finite numbers, `0 < v ≤ 1e6`), `material` (`{ color: ^#[0-9a-fA-F]{6}$ }`, lowercased canonically) | accepted project-model §10.2 |
| `camera` | `type` (`"perspective"`), `fovY` (`0 < v < 180`), `near` (`0 < v ≤ 1e6`), `far` (`near < v ≤ 1e6`) | only the single camera entity can carry it; this is a field edit, never add/remove |
| `model` | `asset` (full `{ assetId }` replacement, must resolve) | packet 15 pinned `components.model.asset.assetId`; packet 20 may extend `model` |
| `transform` | — | rejected (`field_value`): owned by `setTransform` |
| `behavior` | — | rejected: owned by `setBehaviorProperties` |
| `prefab` | — | rejected: read-only provenance |

Request: `{ entityId, component, value }` where `value` is a non-empty partial
object of that component's fields. A present field **replaces** the whole field
(like `setTransform`); absent fields are unchanged; unknown fields ⇒
`field_unexpected`; an empty `value` ⇒ `field_value`.

Validation order: envelope → `entityId` resolves → `component` is one of the three
owned names → the target entity actually carries that component
(`component_missing`) → field validation (including `component_conflict` for the
resulting entity and, for `camera`, the exactly-one invariant) → resulting-state
validation + no-change → durability.

Change data:

```ts
interface SetComponentChange {
  type: 'setComponent';
  id: string;
  component: 'box' | 'camera' | 'model';
  previous: unknown;   // full previous component value
  next: unknown;       // full next component value
  changedFields: string[]; // canonical field order (box: size, material; camera: type, fovY, near, far; model: asset)
}
```

Inverse: `{ kind: 'setComponent', id, component, restore: previous }`.

Normative non-goals: no component add/remove in M2 (`model`/`behavior` presence is
created by placement/instantiation and `setBehaviorProperties` respectively); no
undo of a component removal; no material graph, texture or submesh editing.

## 9. `setSettings`

Bounded typed project settings live in `content.settings`:

```ts
type SettingsValue = number | boolean | string;
interface SettingsMap { [key: string]: SettingsValue }  // ≤ 32 keys, key ^[a-z][a-z0-9_]{0,63}$
```

Request: `{ settings: SettingsMap }` — a partial map applied field-wise (a present
key replaces its value; absent keys are unchanged; there is no removal in M2, and
an empty object ⇒ `no_change`/`field_value` as configured below: an empty
`settings` object is `field_value`).

**The key registry is packet 17's.** Packet 17 owns which settings exist, their
value types and defaults. Until Gate E pins that registry, `M2_SETTINGS_KEYS` is
**empty**, so every key is `setting_unknown` and `setSettings` can only ever fail
— which is the honest state of the contract at packet 16: the command shape,
container, value vocabulary, bounds and failure semantics are fixed now; gameplay
keys are not invented here. Packet 16's fixtures pin the container shape, the
`setting_unknown` rejection and the value vocabulary through a constructed case;
packet 17 fills the registry and adds the success fixtures in the same promotion
step (recorded as change request P16-A8 in `diffs/project-model.md`).

Change data: `{ type: 'setSettings', previous: SettingsMap, next: SettingsMap,
changedKeys: string[] }` (both are full maps; `changedKeys` in ascending key
codepoint order). Inverse:
`{ kind: 'setSettings', restore: previous }`. No-change compares the full
`content.settings` value.

## 10. Deletion and references

Entity-reference property values are the first cross-entity references beyond
parent links, so deletion needs an explicit rule (the accepted contract defers it:
project-model §11.3 "future cross-referencing components must define their own
deletion policy").

1. **Subtree deletion** (`deleteEntity`) computes the closure as accepted, then
   checks every `entityRef` property value in the scene (and inside
   prefab-definition behavior values, which are local and cannot leak):
   - a value that names an entity **inside** the closure is fine (both disappear);
   - a value that names an entity **outside** the closure blocks the whole
     deletion with `reference_in_use`, carrying
     `{ entityIds: <closure ids>, referencingEntityIds: [<entity ids>] }`.
2. The result document therefore never contains a dangling `entityRef`
   (`reference_missing` would be a load failure) — the invariant is maintained by
   rejection, not by silent clearing.
3. Removing a behavior component (`setBehaviorProperties` with `behaviorId: null`)
   removes its values, so it also removes any references it held; that is an
   ordinary edit and needs no special deletion rule.
4. `assetRef` values are unaffected by entity deletion; M2 has no asset deletion.
5. `components.prefab` references follow `prefabs.md` §8 (no deletion in M2).

## 11. Change, inverse and projection

Every authoritative change carries `expectedRevision`/`requestId`, has a defined
inverse, a no-change rule, retry/replay semantics and projection data. The full
table is in [`diffs/commands.md`](diffs/commands.md) §A6/§A15; summary:

| Op | change type | inverse | no-change reachable |
|---|---|---|---|
| `publishBehavior` | `publishBehavior` | restore previous record | yes (identical declaration) |
| `setBehaviorProperties` | `setBehaviorProperties` | restore previous component | yes (identical component) |
| `setComponent` | `setComponent` | restore previous component | yes (identical component) |
| `setSettings` | `setSettings` | restore previous map | yes (identical settings) |
| `createPrefab` | `createPrefab` | remove definition | no |
| `instantiatePrefab` | `instantiatePrefab` | delete subtree | no |

Projection: a client updates from `change` alone. `setComponent`/`setSettings`
carry full `previous`/`next`, `setBehaviorProperties` full component values,
`publishBehavior` full records, so no client needs to re-query. `change` never
carries bytes, metrics or derived data. `no_change` is judged on the **whole
durable state**: scene **and** content canonical bytes (`commands.md` §6.5
extension). Queries never mutate and carry no revision token.

Bounded projection/query additions:

- `queryAssets`: `{ limit 1–128 (50), offset, includeVersions (default false),
  assetId? }` → `{ ok, projectId, revision, total, offset, limit, assets }`;
  summaries are `{ assetId, kind, displayName, currentVersion, versionCount }`,
  with `includeVersions: true` adding `versions: [{ version, sourceDigest,
  sourceByteLength }]` (never bytes, never metrics arrays).
- `queryBehaviors`: `{ limit 1–128 (50), offset, includeDeclaration (false),
  behaviorId? }` → summaries `{ behaviorId, displayName, propertyCount, hasSource,
  publishedRevision }`, with `includeDeclaration: true` adding the exact
  `declaration` value.
- `queryProject` gains the `content` count summary (`prefabs.md` §10).

## 12. Public exports (proposed)

`@thirdlight/project-model`:

```ts
export type { PropertyType, PropertyValue, DeclaredProperty, BehaviorComponent, BehaviorRecord, SettingsValue, SettingsMap } from './property-types';
export function validateDeclaration(doc: unknown): ModelResult<{ properties: DeclaredProperty[] }>;
export function declarationAccepts(declaration: { properties: DeclaredProperty[] }, values: Record<string, PropertyValue>): ModelResult<Record<string, PropertyValue>>;
export function fillPropertyDefaults(declaration: { properties: DeclaredProperty[] }, provided: Record<string, PropertyValue>): Record<string, PropertyValue>;
export const M2_SETTINGS_KEYS: readonly string[]; // empty at packet 16; packet 17 fills it
```

`@thirdlight/commands`:

```ts
export type { PublishBehaviorArgs, SetBehaviorPropertiesArgs, SetComponentArgs, SetSettingsArgs, PublishBehaviorChange, SetBehaviorPropertiesChange, SetComponentChange, SetSettingsChange } from './types';
export function queryAssets(state: CommandState, args: QueryAssetsArgs): QueryResult<AssetSummary>;
export function queryBehaviors(state: CommandState, args: QueryBehaviorsArgs): QueryResult<BehaviorSummary>;
```

`@thirdlight/editor` (packets 28): property inspector generated from the
declaration (label, type, range, enum, defaults, validation messages) — never from
evaluating code; the "no hard timeout" trust warning text belongs to packets 18/34,
not here.

`@thirdlight/mcp-adapter` (packet 25): the same commands/queries; property values
in MCP tool schemas are typed data with the same bounds, never free-form JSON.

## 13. Observable failure outcomes

| Class | Observable outcome | Durable effect |
|---|---|---|
| undeclared key (values/overrides/update) | `property_unknown` (`behaviorId`, `key`) | none |
| wrong type | `property_type` (`key`, `found`, `expected`) | none |
| out of range/length/enum | `property_value` (`key`, `found`, `expected`) | none |
| unresolved `entityRef` | `reference_missing` | none |
| unresolved `assetRef` | `asset_reference_missing` (`assetId`) | none |
| unresolved `behaviorId` | `behavior_not_found` / `behavior_reference_missing` | none |
| duplicate `behaviorId` on create | `behavior_id_duplicate` | none |
| incompatible declaration update | `property_declaration_incompatible` (`uses`) | none |
| source-mode publication | `behavior_publication_unavailable` (`reason`) | none |
| unknown setting key | `setting_unknown` (`key`, registry note) | none |
| `setComponent` on an unowned component | `field_value` (`path: /args/component`) | none |
| unknown component field | `field_unexpected` (`path`, `found`, `expected`) | none |
| target lacks the component | `component_missing` | none |
| delete of a referenced subtree | `reference_in_use` (`referencingEntityIds`) | none |
| no-op edit | `no_change` | none |
| stale / reused request | `revision_conflict` / `request_id_reused` | none |
| any bound | `limits_exceeded` (`limit`, `current`, `max`) | none |
| resulting document invalid | model codes inside `error.details`, `detailDocument: "result-scene"` | none |

## 14. Compatibility and change rules

- All four ops are **new**; no accepted M1 behavior changes. `setTransform` keeps
  owning `transform`; M1's "no settings edits" exclusion is lifted only by this
  reviewed diff.
- Adding a property type, changing a type's constraints, changing a bound, or
  changing the declaration update rule is a reviewed contract change
  (`storageVersion` bump where it changes meaning).
- Adding a **settings key** is packet 17's diff; adding a behavior **source**
  field is packet 18's/33's; neither may change the declaration part or the value
  vocabulary without a reviewed change.
- Packet 15's statement that `content.behaviors`/`content.settings` are `[]`/`{}`
  in v2 (`assets.md` §4.1/§10.2 step 6) is **superseded** by this contract and
  must be updated in the same Gate E promotion step (change request P16-A8 in
  `diffs/project-model.md`).
- Fixture bytes and expected codes are part of the contract.

## 15. What is deliberately not in M2

- No functions, expressions, computed/derived properties, property bindings,
  arrays beyond `vec3`, nested objects, unions or nullable non-reference types.
- No component add/remove via `setComponent`; no material/texture/clip references;
  no per-subresource identity.
- No behavior source publication, compilation, execution, scheduling, intents,
  sandboxing, worker isolation, watchdog or hard timeout (packets 18/33/34).
- No settings **keys** invented here; no gameplay tuning exposed as settings until
  packet 17 pins them.
- No filesystem paths or staging handles in any argument or persisted value; no
  schema discovery by evaluating code.

## 16. Fixture index (packet 16 additions)

| Fixture | Pins |
|---|---|
| `commands/prefab-scenario.messages.json` | declaration publication, behavior attach with defaults filled, the override at instantiation, ordinary `setComponent` edit, exact redo/retry |
| `commands/prefab-failures.json` | unknown key/type/behavior/asset/setting, incompatible declaration update, unavailable source publication, `setComponent` ownership and unknown-field failures, `reference_in_use`, `no_change`, stale/reused requests |
| `commands/queries.json` | `queryProject` content summary, `queryAssets`, `queryBehaviors` (summary and declaration) |
| `cases/constructed-cases.md` §C9 (packet-16 section) | prefab/property/settings/payload boundaries that need many records |
