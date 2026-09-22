**PROPOSED — not accepted.** Packet 42 (`docs/planning/m3-packets.md` §42)
output. Section-level diffs for `docs/contracts/dependencies.md`. Normative rule
text lives in [`../delivery.md`](../delivery.md) §3.4; this file names the exact
destination, the shortest unique OLD quote and the NEW text. Convention (same as
[`../../m2-contracts/diffs/dependencies.md`](../../m2-contracts/diffs/dependencies.md)):
`OLD` is accepted text exactly as it reads today; `NEW` is the replacement; `+`
blocks are pure insertions. Accepted section numbers are never renumbered.
Superseded text is called out explicitly.

Read basis: accepted `dependencies.md` §§2/3/4.1/4.2/4.3/5/6/9; `m3-plan.md`
§3.4/§4 and the PR-5 repair; `m3-packets.md` §42/§58; handoffs 40 (C40-10) and 41
(C41-6). No product code, no dependency upgrade.

---

## A. Summary of required changes

| # | Destination | Kind | Normative text |
|---|---|---|---|
| D42-1 | §2 units table | insert two rows | delivery.md §3.4 |
| D42-2 | §3 public surface table | insert two rows | delivery.md §3.1/§3.4 |
| D42-3 | §4.1 node-side edges | insert two rows | delivery.md §3.4 |
| D42-4 | §4.2 browser-bundle graphs | insert one rule + adjust two rows | delivery.md §3.2/§3.4 |
| D42-5 | §4.3 forbidden edges | insert two bullets + the editor-UI rule | delivery.md §3.4 |
| D42-6 | §5 checks | insert check 12 | delivery.md §3.4 |
| D42-7 | §9 change rules | insert bullets | delivery.md §11 |

Not changed: §1, §6 (the module registration mechanism is the accepted
code-level registry; `game-host` registers no new mechanism), §7 pins (no new
third-party dependency), §8 non-goals, and every existing §4 row.

---

## B. Existing sections

### D42-1 — §2 "Units": insert two rows

Anchor: after the `behavior-build` row (the last row of the table).

```diff
+| `platformer-game` | `gameplay.md` | 49 | pure run state, swept gameplay-zone geometry and camera math over runtime ports/types; no concrete physics, input, DOM or three |
+| `game-host` | `delivery.md` §§3–5 | 55 | browser-safe DOM HUD, menu/control consumption, injected audio lifecycle and the single shared production module composition; no editor/exporter internals, no fetch, no credential |
```

Both rows keep the table's normative "create only when implemented" rule: the
directories appear in packets 49 and 55, not before. `game-host` is the **only**
shared production composition entry; `preview-bootstrap.ts` and the export
bootstrap are wrappers that call it (delivery §3.2), and `exporter`'s
`export-composition.ts` wiring moves behind it in packet 58.

### D42-2 — §3 "Public export surface per unit": insert two rows

Anchor: after the `behavior-build` row.

```diff
+| `platformer-game` | `.` → `platformerGameSessionSpec`, `platformerGameCameraSpec`, `PLATFORMER_GAME_MODULE_ID`, `stepZones`, `zoneOverlap`, `followCamera`, `CAMERA_CONSTANTS`, `RUN_LIMITS` |
+| `game-host` | `.` → `createGameHost`, `GAME_HOST_API_VERSION`, `GAME_HOST_MESSAGES`, `GameHostConfig`, `GameHostObservation`, `GAME_CONTROL_ACTIONS` (the delivery.md §3.1 surface). Internal files are unreachable: the host's DOM, control, audio and composition modules are **not** subpaths, so a wrapper cannot reach past the entry. |
```

### D42-3 — §4.1 "Node-side": insert two rows

Anchor: after the `behavior-build` row.

```diff
+| `platformer-game` | `runtime` (types) — pure; no concrete physics, input, DOM or three |
+| `game-host` | `runtime` (types + `instantiateRuntime`/`createSimulationRegistry`/`registerSimulationModule` values), `platformer`, `platformer-game`, `input` (types + `attachBrowserInput` value), `three-adapter` (**types only** — the adapter/resource interfaces and the injected byte resolver). The concrete `physics-rapier` port, the `three` canvas and the audio implementation are **injected**, so `game-host` has no value edge to them. |
```

### D42-4 — §4.2 "Browser-bundle graphs": insert a rule, adjust two rows

Anchor 1: after the bullet ending "…the editor edits declarations, never code
(`behaviors.md` §9.7)." (the last bullet of §4.2).

```diff
+- **The M3 runtime bundles share one host composition.** Both the play-preview
+  and the export bundle include `game-host` and `platformer-game` and build the
+  game through the single public `createGameHost` entry (delivery.md §3.1/§3.2);
+  neither bundle may contain `exporter` internals (`export-composition.ts`) or
+  editor internals. The **editor** bundle is unchanged and must not contain
+  `game-host`: the editor UI cannot import it (the §4.3 rule).
```

Anchor 2: the play-preview row's graph list.

```diff
-| **play-preview bundle** (`dist/preview/`) | `packages/editor/src/preview/preview-bootstrap.ts` | `editor/src/preview/**` (that directory only), `protocol` (the pure wire-types package — bridge messages; §3), `runtime`, `three-adapter`, `project-model`, `input`, `platformer`, `physics-rapier`, `three` (incl. the GLTFLoader subpath), plus the **linked behavior outputs** of the snapshot |
+| **play-preview bundle** (`dist/preview/`) | `packages/editor/src/preview/preview-bootstrap.ts` (wrapper; the composition is `game-host`) | `editor/src/preview/**` (that directory only), `game-host`, `platformer-game`, `protocol` (the pure wire-types package — bridge messages; §3), `runtime`, `three-adapter`, `project-model`, `input`, `platformer`, `physics-rapier` (injected by the wrapper), `three` (incl. the GLTFLoader subpath), plus the **linked behavior outputs** of the snapshot |
```

Anchor 3: the export row's graph list.

```diff
-| **export bundle** (export output) | `packages/exporter/src/export-bootstrap.ts` | `exporter/src/export-bootstrap.ts` (that file only), `runtime`, `three-adapter`, `project-model`, `input`, `platformer`, `physics-rapier`, `three` (incl. the GLTFLoader subpath), plus the **linked behavior outputs** of the snapshot and the **declared asset artifacts read as relative runtime resources** |
+| **export bundle** (export output) | `packages/exporter/src/export-bootstrap.ts` (wrapper; the composition is `game-host`) | `exporter/src/export-bootstrap.ts` (that file only), `game-host`, `platformer-game`, `runtime`, `three-adapter`, `project-model`, `input`, `platformer`, `physics-rapier` (injected by the wrapper), `three` (incl. the GLTFLoader subpath), plus the **linked behavior outputs** of the snapshot and the **declared asset artifacts read as relative runtime resources** |
```

The new edges add **no** fetch: the host performs none (delivery §6.5), so the
accepted §17.5 fetch count and the export.md §5.4.1 scan rows are unaffected; 58
and 60 must re-measure them (D42-6).

### D42-5 — §4.3 "Forbidden edges": insert two bullets and the editor-UI rule

Anchor: after the bullet ending "…it holds no token, no URL and no fetch)."
(the `three-adapter` bullet).

```diff
+- `platformer-game → input | physics-rapier | three | three-adapter | runtime concrete adapters | editor | backend | workspace | commands | protocol | DOM | Web Audio` (pure rules over runtime types and injected ports only).
+- `game-host → editor (any subpath) | backend | workspace | commands | protocol | mcp-adapter | exporter (any subpath) | asset-pipeline | behavior-build | physics-rapier (concrete) | three (direct) | any Node builtin` (the browser-safe host receives every concrete dependency by injection).
+- **Editor-UI rule (normative, plan-review PR-5):** `packages/editor/src/ui/**`, `packages/editor/src/session/**` and `packages/editor/src/viewport/**` may **not** import `@thirdlight/game-host`; only `packages/editor/src/preview/**` may. §4.2's `editor/**` wildcard would otherwise admit DOM and Web Audio into the editor bundle. This is a forbidden edge like any other, not a style rule.
```

### D42-6 — §5 "Enforceable boundary checks": insert check 12

Anchor: after check 11 (the locator read-only probe), before the closing prose.

```diff
+12. **Host-composition containment** (packets 49/55/58): check 1 must fail a
+    disposable probe where `packages/editor/src/ui/**` imports
+    `@thirdlight/game-host` (D42-5), and check 3 must fail if `game-host` or
+    `platformer-game` appears in the editor bundle or if an `exporter` internal
+    module appears in a runtime bundle. Both probes are removed afterwards.
+    Packets 58/60 re-measure the export.md §5.4.1 counts and the §17.5 fetch list
+    changed by these edges and request bounded re-review if the measured text
+    differs (delivery.md §3.4/§6.5).
```

### D42-7 — §9 "Change rules": insert bullets

Anchor: after the bullet ending "…`behavior-build` is the single behavior
compiler for play and export …" (the last bullet of §9).

```diff
+- `game-host` and `platformer-game` are the only M3 units added by packet 42; a
+  later unit, subpath, edge or bundle-graph row is a reviewed contract diff.
+- The editor-UI rule of §4.3 and the 58/60 re-measurement requirement are part
+  of the PR-5 acceptance, not guidance: creating `game-host` without them, or
+  widening a §5.4.1 exception instead of re-measuring it, reopens this diff.
```

## C. Explicitly not changed by packet 42

- §6's module registration mechanism, §7's pin table (no new third-party
  dependency), §8's non-goals, and every accepted §4 row for the existing units.
- `runtime`'s edges, `three-adapter`'s edges and the accepted C35-3 preview
  entry rows: the host composition replaces *wiring*, not the package boundary.
- No package is created by this proposal; the directories appear in packets 49
  and 55 only (the §2 "create only when implemented" rule).
