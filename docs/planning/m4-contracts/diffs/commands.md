# Owned diff rows — `commands.md` (packets 64, 65)

Proposal: `../delivery.md` §3 (queries). Gate Q. **PROPOSED — not
accepted.** Every row below is the exact old/new text for the promotion
handoff. Single owner per destination: the `commands.md` sections are
owned by this packet's rows; no other M4 packet edits `commands.md`.

## C64-1 — the `querySettings` operation

### Row 1: `commands.md` §2 op table (add one row)

OLD (the query block of §2's table ends with):

```text
| `queryAssets` | query | Paged asset-catalog summaries (optional versions; each summary carries `kind`) | — |
| `queryGameConfig` | query | The full `content.game` block or `null` | — |
| `queryPrefabs` | query | Paged prefab-definition summaries (optional full definitions) | — |
| `queryBehaviors` | query | Paged behavior summaries (optional declarations) | — |
```

NEW (one row added after `queryGameConfig`; the order is
alphabetical-within-kind as the table already reads):

```text
| `queryAssets` | query | Paged asset-catalog summaries (optional versions; each summary carries `kind`) | — |
| `queryGameConfig` | query | The full `content.game` block or `null` | — |
| `querySettings` | query | The explicit and resolved gameplay settings maps at one revision | — |
| `queryPrefabs` | query | Paged prefab-definition summaries (optional full definitions) | — |
| `queryBehaviors` | query | Paged behavior summaries (optional declarations) | — |
```

### Row 2: `commands.md` §3.1 (new `§3.1.12`)

OLD (nothing — the section does not exist; `§3.1.11 queryGameConfig` is
the last query spec).

NEW:

> **§3.1.12 `querySettings`** — `args: {}` (absent or empty; any other
> field ⇒ `invalid_request`). Returns the gameplay settings **values**
> at the current revision, the only source of settings values:
>
> ```json
> { "ok": true, "projectId": "demo-0003", "revision": 26,
>   "explicit": { "run_speed": 5 },
>   "resolved": { "gravity_y": -19.62, "run_speed": 5, "jump_velocity": 7,
>                 "max_fall_speed": -30, "max_slope_climb_deg": 45,
>                 "min_slope_slide_deg": 30 } }
> ```
>
> - `explicit`: the `content.settings` map as authored (written values
>   only, registry key order; never default-filled). A v1 envelope
>   (no `content`) ⇒ `{}`.
> - `resolved`: `defaults ⊕ explicit` over the fixed M2 settings
>   registry (this file §8.11's six keys and ranges, registry order) —
>   the same resolution the capture uses (project-model §21.5). A v1
>   envelope ⇒ `{}`. Never a partial object: a resolution failure is
>   `field_value`.
> - Query semantics: read-only; no `expectedRevision`/`requestId`; never
>   mutates; observes the last acknowledged state; carries the revision
>   the values were read at. Bounds: ≤ 32 keys (the `settings_keys`
>   bound; the registry is 6). Errors: `project_not_found`,
>   `project_unavailable`, `invalid_request`, `field_value`.

### Row 3: `commands.md` §5.6 (query results — add one bullet)

OLD (after the `queryBehaviors` bullet, before "Query failure:"):

```text
- `queryBehaviors`:
  … (the accepted bullet, unchanged) …
- Query failure: `{ ok: false, projectId?, error }` — no `requestId`; `op`
  echoed when present. Codes: …
```

NEW (one bullet added before the "Query failure" bullet):

```text
- `querySettings`:
  `{ ok, projectId, revision, explicit, resolved }` — `explicit` is the
  authored `content.settings` map (registry key order; `{}` for a v1
  envelope or an empty map), `resolved` is `defaults ⊕ explicit` over the
  §8.11 registry in registry order (`{}` for a v1 envelope). No values
  appear anywhere else: the `queryProject` summary's `settingsKeys` is a
  count, and the full-state projection carries the map only through the
  §8 convergence change records.
```

## C64-2 — the accepted `queryProject` content summary (count semantics; P2-B)

### Row 4: `commands.md` §5.6 (the `queryProject` bullet — additive clarification)

OLD:

```text
`queryProject`'s content summary carries `game` (boolean), `zones`, `spawns` and
`audioAssets` counts (commands.md §12).
```

NEW (the accepted shape is unchanged; the count semantics are made
normative — the implementation (P2-B) returns no `content` field at all,
so the exact meanings must be fixed for the packet-71 implementation):

```text
`queryProject`'s content summary carries `game` (boolean), `zones`, `spawns` and
`audioAssets` counts (commands.md §12). Exact count semantics (normative,
clarification — the accepted shape is unchanged): `assets` = the number of
`content.assets` records; `prefabs` = the number of `content.prefabs` records;
`behaviors` = the number of `content.behaviors` records; `settingsKeys` = the
number of authored `content.settings` keys (`0` for an empty map or a v1
envelope); `game` = `content.game !== null`; `zones` = the number of scene
entities carrying a `gameZone` component; `spawns` = the number of scene
entities carrying a `playerSpawn` component; `audioAssets` = the number of
`content.assets` records with `kind: "audio"`. Counts only — never
definitions, declarations or byte lengths (the accepted rule). v1 envelopes
carry no `content` field (the accepted rule).
```

**No other `commands.md` change (packet 64).** The `setSettings` registry
(§8.11), the history model and the error codes are untouched.

---

# Packet 65 rows (proposal: `../templates.md`)

## C65-9 — NO contract text change (adjudication record)

The packet-65 template contract (templates.md) was read against the
accepted `commands.md` text; **no command-surface change is needed**:

- **The starter recipe uses only the accepted command set.** The M4
  built-in template's recipe (templates.md §4.1 whitelist: `publishAsset`,
  `createEntity`, `setTransform`, `setComponent`, `createPrefab`,
  `instantiatePrefab`, `setGameConfig`, `setSettings`) is a subset of the
  accepted §2 op table; the creation operator injects the request envelope
  fields (projectId, the deterministic `req-<32 hex>` requestIds —
  templates.md §7.1, conforming to the accepted `^req-[0-9a-f]{32}$` shape
  — and the `origin.kind: "template"` audit value, sessions.md C65-7).
  No new op, no new args field, no new error code in this file.
- **`queryProject` is unchanged.** The result carries "the full normalized
  manifest" (the accepted §5.6 text); the manifest `schemaVersion 2` +
  `template` block (project-model C65-1) flows through with **no
  query-shape change** — the template identity is observable over the
  accepted query path, which is the C04/C05 "records the template
  identity" requirement. The packet-64 C64-2 content-summary rows and the
  packet-64 C64-1 `querySettings` op are untouched by this packet.
- **History/retry:** the starter replay produces ordinary history entries
  and retry records under the accepted §6/§7 semantics (templates.md §7);
  no history-model change.

**No other `commands.md` change (packet 65).**