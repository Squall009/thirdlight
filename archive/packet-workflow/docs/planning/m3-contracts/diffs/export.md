**PROPOSED — not accepted.** Packet 42 (`docs/planning/m3-packets.md` §42)
output. Section-level diffs for `docs/contracts/export.md`. Normative rule text
lives in [`../delivery.md`](../delivery.md) §§2–3, §6; this file names the exact
destination, the shortest unique OLD quote and the NEW text. Convention (same as
[`../../m2-contracts/diffs/export.md`](../../m2-contracts/diffs/export.md)):
`OLD` is accepted text exactly as it reads today; `NEW` is the replacement; `+`
blocks are pure insertions. Accepted section numbers are never renumbered.
Superseded text is called out explicitly — no accepted sentence is silently
redefined.

Read basis: accepted `export.md` §§2–7 (incl. §4 pipeline, §5.2 entry rule, §5.4/
§5.4.1, §5.5, §6 `meta.json`, §7 reproducibility); `m3-plan.md` §3.4;
`m3-packets.md` §58/§60; handoffs 40 (C40-9), 41 (C41-5); packet-38 evidence
(`acceptance/evidence-m3/38/raw/engine*.json`). No product code, no dependency
upgrade.

---

## A. Summary of required changes

| # | Destination | Kind | Normative text |
|---|---|---|---|
| E42-1 | §3 output layout | insert a serving-policy bullet | delivery.md §6.3/§6.4 |
| E42-2 | §3 replacement semantics | insert the non-root relative-closure rule | delivery.md §6.4 |
| E42-3 | §5.1 same runtime | insert the shared host composition | delivery.md §3.2 |
| E42-4 | §5.2 exact import graph | insert rows/entry note | delivery.md §3.1/§3.4 |
| E42-5 | §5.4.1 binding 4 | insert the M3 no-change statement + remeasure duty | delivery.md §6.5 |
| E42-6 | §5.5 bootstrap behavior | reword steps 1–4 | delivery.md §3.1/§3.3 |
| E42-7 | §6 `meta.json` `manifest` block | insert the v2 fields | delivery.md §2.3 |
| E42-8 | §7 reproducibility | append the M3 two-tree rule | delivery.md §2.5 |
| E42-9 | §2 input | insert the manifest-v2 pointer | delivery.md §2 |

Not changed: §1, §4 pipeline steps (5a already validates the manifest and its
`buildId`; the M3 block digests are read under that step), §4.1 codes, §5.3
pinned options, §5.4 pattern letters a–j, §8 non-goals, §9 change rules (the
packet-42 additions are covered by delivery.md §11).

---

## B. Existing sections

### E42-1 — §3 "Output layout": insert the serving-policy bullet

Anchor: after the bullet ending "…packet 12 documents this explicitly. The
backend is never a runtime dependency of the output."

```diff
+- **The export declares its own policy.** `index.html` carries a
+  `<meta http-equiv="Content-Security-Policy">` with
+  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self';
+  img-src 'self' data:; style-src 'self'; font-src 'none'; worker-src 'none';
+  object-src 'none'; base-uri 'none'; form-action 'none'`. The static host is
+  **not** relied on to send a CSP header, so the game boots under a plain
+  `python3 -m http.server`/nginx. `'wasm-unsafe-eval'` is required so the pinned
+  Rapier WASM compiles (packet-38 evidence, delivery.md §6.1) and permits
+  WebAssembly compilation only — never `eval`. `frame-ancestors` is omitted: it
+  is ignored in a meta policy and the export is never framed by the engine.
+- **MIME classes.** The serving host must send `text/html; charset=utf-8`,
+  `text/javascript; charset=utf-8`, `application/json`, `application/wasm`,
+  `model/gltf-binary` and `audio/wav` for the corresponding files, plus
+  `X-Content-Type-Options: nosniff`. The export ships no server config; an
+  incorrect MIME is a deployment failure, not a silent fallback.
```

### E42-2 — §3 "Replacement semantics": insert the non-root closure rule

Anchor: after the paragraph ending "…A failed export leaves the previous tree
untouched and removes its own temp directory (no partial "successful"
artifacts, ever)."

```diff
+- **Non-root static closure.** The whole tree is servable under an arbitrary
+  non-root prefix (acceptance example `/games/beacon-reach/`): every reference is
+  relative (`./…`), there is no leading-`/` reference, no `<base>` element and no
+  absolute locator. The declared-artifact set of `manifest.json` **is** the
+  emitted closure (every declared artifact present, every present artifact
+  declared), including model and audio bytes; the M3 manifest v2 keys add **no**
+  side-car file and therefore no new path.
```

### E42-3 — §5.1 "Same runtime as play mode": insert the shared host

Anchor: after the paragraph ending "…the same engine modules behave identically
in play and in the exported game."

```diff
+- **One shared host composition.** The export and the play preview build the game
+  through the same public browser-safe entry `createGameHost` (delivery.md §3.1):
+  one registry/module set (runtime built-ins + `platformer` + `platformer-game` +
+  linked behavior outputs), one host update loop, one HUD/control/audio owner.
+  The wrappers differ only in platform specifics (page config, relative reads,
+  canvas, bridge). No gameplay logic, controller, camera or run-state owner is
+  duplicated, and the resolved manifest settings are passed to **both** the
+  runtime and the physics configuration (delivery.md §3.3) — the M2
+  `export-composition.ts` wiring is reused behind this entry, not forked.
```

### E42-4 — §5.2 "Exact import graph": insert rows/entry note

Anchor: after the M2 entry paragraph ending "…they are build inputs, never
runtime fetches."

```diff
+**M3 entry (packet 58).** For an M3 (`manifestVersion 2`) export the graph adds
+`game-host` and `platformer-game` and the composition lives in the public
+`game-host` entry, not in an `exporter` internal:
+
+```text
+packages/exporter/src/export-bootstrap-m2.ts   the page bootstrap/wrapper
+@thirdlight/game-host                          the shared composition + HUD/control/audio
+@thirdlight/platformer-game                    the pure run/zone/camera module
+```
+
+`packages/exporter/src/export-composition.ts` may remain as the accepted M2
+entry for M2 exports; an M3 export must not require an `exporter` internal for
+gameplay wiring (delivery.md §3.2). The forbidden list below is unchanged and
+now also forbids `game-host` importing `exporter` internals.
```

Anchor 2: the forbidden list sentence.

```diff
-Forbidden in the graph (any node): `backend`, `editor`, `workspace`,
-`commands`, `mcp-adapter`, `protocol`, `exporter` (anything beyond its
-bootstrap file), and any `node:` builtin (browser platform).
+Forbidden in the graph (any node): `backend`, `editor`, `workspace`,
+`commands`, `mcp-adapter`, `protocol`, `exporter` (anything beyond the exact
+per-profile file list), `asset-pipeline`, `behavior-build`, any `node:` builtin
+(browser platform), and — for M3 — an `exporter` internal reachable from
+`game-host`.
```

### E42-5 — §5.4.1 binding 4: the M3 no-change statement and remeasure duty

Anchor: the sentence in binding 4 beginning "**Real-bundle exact counts:**".

```diff
+**M3 addition (packet 42):** `game-host` initiates **no** fetch and adds **0**
+occurrences for patterns a/b/c/e/g/i and 0 additional for d/f/h/j; Web Audio
+(`AudioContext`) is not a scanned pattern (pattern j covers `XMLHttpRequest`/
+`WebSocket` only). `content.game`/`settings`/`media` are **embedded** in
+`manifest.json`, so there is no `game.json` side-car and no extra fetch. The
+count remains the recorded baseline + the applicable exception rows + the
+counted per-bundle call sites; no new exception row and no blanket allowance are
+proposed. Packets **58/60** must re-measure this table and the §17.5 fetch list
+on the real bundles and record the result; if the measured text differs, they
+request bounded re-review rather than widening an exception.
```

### E42-6 — §5.5 "Bootstrap behavior": reword steps 1–4

Anchor: the numbered list.

```diff
-1. `fetch("./manifest.json")` (relative; a failure ⇒ a structured on-page
-   message with the error, no silent blank page).
-2. `instantiateRuntime` with the frozen snapshot, the built-in registry,
-   `modules: ["thirdlight.demo:box-motion"]`, the default clock/driver
-   (runtime.md §3.1).
-3. `createSceneAdapter` on the page canvas (WebGL 2 path; the selected
-   backend is reported on the HUD line — packet 12 records the actual
-   browser/render backend).
-4. `start()`. Runtime errors surface on-page with the runtime.md error code
-   (structured, not a stack dump).
+1. `fetch("./manifest.json")` and `fetch("./scene.json")` (relative,
+   digest-verified; a failure ⇒ a structured on-page message with the error, no
+   silent blank page). The M1 single-fetch rule is unchanged for an M1 export
+   (`./snapshot.json`).
+2. Resolve the M3 module set and registry and build the game through
+   `createGameHost` (delivery.md §3.1): the frozen snapshot, the resolved
+   `manifest.settings` passed to `instantiateRuntime({ settings })` **and** to
+   the physics configuration, the manifest-declared asset reads, and the
+   manifest's cue/role identity. The M1 demo module selection is unchanged for an
+   M1 export (`modules: ["thirdlight.demo:box-motion"]`).
+3. `createSceneAdapter` on the page canvas (WebGL 2 path; the selected backend is
+   reported on the HUD line — packet 12 records the actual browser/render
+   backend) and inject it into the host; the host owns no renderer import.
+4. The host starts in `awaitingStart`: the title/HUD is rendered, no movement
+   step runs, and the menu channel accepts start/replay/mute without awaiting a
+   tick (delivery.md §4.5). Runtime errors surface on-page with the runtime.md
+   error code (structured, not a stack dump). Ready means the title screen
+   loaded — not that gameplay started.
```

### E42-7 — §6 `meta.json`: insert the v2 manifest fields

Anchor: the accepted `manifest` block in the example.

```diff
   "manifest": {
-    "manifestVersion": 1, "snapshotId": "demo-0001@r12", "revision": 12,
-    "contentDigest": "<64 hex>", "buildId": "<64 hex>",
-    "buildOptionsDigest": "<64 hex>"
+    "manifestVersion": 2, "snapshotId": "demo-0001@r12", "revision": 12,
+    "sceneDigest": "<64 hex>", "contentDigest": "<64 hex>",
+    "gameDigest": "<64 hex>", "settingsDigest": "<64 hex>",
+    "mediaDigest": "<64 hex>",
+    "buildId": "<64 hex>", "buildOptionsDigest": "<64 hex>"
   },
```

Rule appended to the file's M2 additions paragraph:

```diff
+For an M3 export `manifest.manifestVersion` is `2` and the block carries the
+three block digests; they are copies of the manifest's own fields, never
+re-derived independently (the manifest is authoritative — delivery.md §2.3).
+`buildId` stays distinct from `snapshotId` and `outputDigest`.
```

### E42-8 — §7 "Reproducibility scope": append the M3 two-tree rule

Anchor: after the paragraph ending "…the alternative (dropping `capturedAt` from
the preimage) is not applied."

```diff
+**M3 two-tree rule (packet 42, normative).** The accepted claim is checked by
+exporting twice into **two separate output trees** and hashing each tree **before
+any overwrite**. Only the contracted timestamp carriers are normalized —
+`manifest.json#capturedAt` and `meta.json#exportedAt` — and `buildId` is then
+re-derived; the trees must be byte-identical afterwards. The M3 additions
+(`gameDigest`, `settingsDigest`, `mediaDigest`, `settings`, `game`, `media`) are
+timestamp-free and must match **without** normalization. `outputDigest`
+(excluding `meta.json`) remains a separate identity and is never equated with
+`buildId`.
```

### E42-9 — §2 "Input: one immutable snapshot": insert the manifest-v2 pointer

Anchor: after the paragraph ending "…a revision or resolved-digest change after
capture is `export_snapshot_mismatch` (§4 step 2)."

```diff
+**M3: the manifest is `manifestVersion` 2** (delivery.md §2). It additionally
+binds the resolved six-key gameplay settings, the frozen `content.game` block
+and the media identity (audio cue/role resolution) by digest, so one captured
+envelope fixes every runtime-affecting value. A v1 manifest keeps its accepted
+meaning and is never upgraded in place; a re-capture writes a new v2 document
+with a new `capturedAt`/`buildId`. Late edits, reimports and failed/cancelled
+builds follow delivery.md §2.6 — the previous output and every pinned Play
+artifact set stay byte-unchanged.
```

## C. Explicitly not changed by packet 42

- §4's pipeline order and codes (5a's `export_manifest_invalid` already covers a
  v2 `buildId`/block-digest mismatch), §4.1, §5.3's pinned option set, §5.4's
  pattern letters a–j, and §8's non-goals.
- The export is still an admin-scoped operation invoked by the backend; nothing
  here adds an MCP export tool or a browser command.
- No new file class, no new side-car document, no new third-party dependency.
