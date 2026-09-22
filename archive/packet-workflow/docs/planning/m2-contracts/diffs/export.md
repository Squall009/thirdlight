PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# PROPOSED section-level diffs — `docs/contracts/export.md` (packet 18)

**PROPOSED — pending Gate E.** Packet 18 (`docs/planning/m2-packets.md` §18)
output. This file contains *no* accepted text: it names the exact destination
sections of `docs/contracts/export.md`, gives `OLD → NEW` text for every existing
section that changes, and gives insertion instructions (anchor + normative text
source) for new material.

Read with: [`../behaviors.md`](../behaviors.md) (§5.4/§5.5 compiler purity and the
output scan, §8.6/§8.7 the publication/build split, §9.7 forbidden
capabilities), [`dependencies.md`](dependencies.md) (D18-4's bundle rows and
linking rule) and [`runtime.md`](runtime.md) §"Packet 18 additions" (R24/R27).
Packet 18 is a **contract-drafting** packet: it does not build an export, does
not measure a bundle and does not change §5.3's pinned option set. Promotion is
docs-only, per diff, at Gate E.

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
| E18-1 | §5.1 "Same runtime as play mode" | insert paragraph | `../behaviors.md` §8.7 |
| E18-2 | §5.2 "Exact import graph" | insert rows/lines | `../behaviors.md` §5.5/§9.7, [`dependencies.md`](dependencies.md) D18-4 |
| E18-3 | §5.4 `meta.json` (§6) | insert fields | `../behaviors.md` §3/§7 |
| E18-4 | §5.4 "Forbidden-content scan" | insert rule | `../behaviors.md` §5.5 |
| E18-5 | §5.3 "Browser-only target — pinned build options" | insert note (the compiled intermediate is **not** a §5.3 bundle) | `../behaviors.md` §5.4 |
| E18-6 | §8 "What is deliberately not in M1" | insert bullets | `../behaviors.md` §15 |
| E18-7 | §9 "Change rules" | insert bullets | this file |

**Not changed:** §3 output layout, §4 validation pipeline and its stable codes
(packet 18 adds behavior checks to the *snapshot* validation, which is
`project-model`'s §13.2 — not a new export code), §5.3's exact option set and
`format: "iife"`/`treeShaking: false` pins, §5.4's pattern table and §5.4.1's
recorded-exception counts and binding conditions, §5.5 bootstrap behavior (the
single `fetch("./snapshot.json")` rule stands), §6's existing `meta.json` fields
(other than E18-3's additions), §7 reproducibility scope.

---

## B. Existing sections

### E18-1 — §5.1 "Same runtime as play mode": insert paragraph

Anchor: after the existing paragraph (the `thirdlight.demo:box-motion` fixed in
`meta.json`).

```diff
+**Behavior modules use the same pipeline in play mode and in the export.** Both
+bundles statically link the same engine modules and the same behavior output
+artifacts for the snapshot's published `outputDigest`s, against the same pinned
+engine versions (`../behaviors.md` §8.7, [`dependencies.md`](dependencies.md)
+D18-4). There is **no separate gameplay implementation** for exported behaviors
+and no runtime loader: a behavior output is a build input, exactly like
+`runtime` and `three-adapter` are. A behavior with `source: null` links nothing
+and contributes nothing, so M1-style scenes and declaration-only behaviors
+export exactly as today. Because the two bundles are produced from the same
+(snapshot, `sourceDigest`s, engine pins, pinned option set), the same engine
+modules behave identically in play and in the exported game.
```

### E18-2 — §5.2 "Exact import graph (verified by the metafile, §4 step 4)": insert rows/lines

```diff
+export-bootstrap (packages/exporter/src/export-bootstrap.ts)
+  → runtime → project-model (pure, inlined)
+  → three-adapter → runtime, three
+  → behaviors → runtime (types), project-model (types)
+  → input / platformer / physics-rapier (packet 17) → runtime (types) [+ the approved physics pin]
+  → the linked behavior outputs of the snapshot (static build inputs, one per published `outputDigest`)
```

Forbidden in the graph (any node), extended:

```diff
+… and any behavior output that transitively pulls `behavior-compiler`, `editor`,
+`backend`, `workspace`, `commands`, `mcp-adapter`, `protocol` or a Node builtin;
+and any behavior output that contains `import(`, `fetch(` (other than the single
+§5.5 `./snapshot.json` bootstrap fetch), `XMLHttpRequest`, `WebSocket`, `eval(`,
+`new Function` or a pinned-path absolute locator (`../behaviors.md` §5.5).
+`behavior-compiler` itself is **never** in this graph: it runs at preparation
+time, not at export time.
```

The metafile check keeps its exact-input rule: the linked outputs are inputs, and
the graph must contain no other module from the `exporter` package beyond
`export-bootstrap.ts` and no `behavior-compiler`/`behavior-compiler`'s
`esbuild` dependency.

### E18-5 — §5.3 "Browser-only target — pinned build options": insert note

Anchor: after the "same pinned option set applies to all three bundles" bullet.

```diff
+- **The compiled behavior output is an intermediate, not a §5.3 bundle.** It is
+  produced by `compileBehavior` with a pinned, closed option set
+  (`bundle: true, platform: 'browser', format: 'esm', target: 'es2022',
+  treeShaking: false, sourcemap: false, minify: false`, `../behaviors.md` §5.4) and
+  is then consumed as an input by the §5.3 build of the final bundle — the
+  emitted `js/main.js` (and the play-preview bundle) still uses exactly §5.3's
+  option set, `format: "iife"` included. The intermediate's
+  `outputDigest`/`manifestDigest` are recorded in `meta.json` (E18-3) so the
+  whole chain is reproducible; the §5.4/§5.4.1 scans run over the **final**
+  emitted bytes, which include the intermediates' bytes.
```

### E18-4 — §5.4 "Forbidden-content scan": insert rule

```diff
+**Behavior outputs are scanned as part of the emitted bytes.** The §5.4 patterns
+(a–j) and the §5.4.1 recorded-exception table apply unchanged to the final bundle,
+including the linked behavior output bytes; additionally, each prepared behavior
+output is scanned at preparation time by the compiler's own §5.5 output scan
+(`../behaviors.md` §5.5) so a forbidden pattern is refused *before* it can reach
+an export. Whether a given behavior output hits a pattern is a per-build
+measurement, not contract text: this diff records no measured count for behavior
+bytes and makes no zero-count claim for them.
```

### E18-3 — §6 "`meta.json` (exact, canonical)": insert fields

```diff
+{
+  …,
+  "behaviors": [
+    { "behaviorId": "behavior-0002", "sourceDigest": "<64 hex>",
+      "sourceByteLength": 1234, "manifestDigest": "<64 hex>",
+      "outputDigest": "<64 hex>", "outputByteLength": 4096,
+      "apiVersion": 1,
+      "enginePins": [ { "id": "@thirdlight/runtime", "version": "0.2.0", "apiVersion": 1 } ] }
+  ],
+  "behaviorTrust": { "acknowledgedSourceDigests": [ "<64 hex>" ] }
+}
```

Rules: `behaviors` is ascending by `behaviorId` and contains only behaviors the
snapshot uses with a non-null `source` (declaration-only behaviors are omitted —
they link nothing); `enginePins` is ascending by `id` and identical to the pins
the bundle was built with (`../behaviors.md` §5.3); `behaviorTrust` lists the
digests whose acknowledgment the export relied on, read from
`content.behaviorTrust.entries` at build time (`../behaviors.md` §7). An export of
a snapshot with a `source`-bearing behavior whose digest is not acknowledged fails
with `behavior_trust_unacknowledged` and produces no artifact
(`../behaviors.md` §2.3/§8.7); the exported page must present the §2.3 trust
notice before starting (packet 36).

### E18-6 — §8 "What is deliberately not in M1": insert bullets

```diff
+- No behavior code, compiler, loader or behavior artifact in an M1 export, and no
+  export-time compilation: M2's behavior outputs are prepared before the command
+  and linked as static inputs from packet 33 on (`../behaviors.md` §8.7).
+- No worker/WASM/iframe execution boundary for behaviors and no preemption
+  claim: the exported game runs trusted behavior code in its own main context,
+  with no hard timeout and no hostile-code sandbox (`../behaviors.md` §2.2).
```

### E18-7 — §9 "Change rules": insert bullets

```diff
+- Adding a `meta.json` field, changing the behavior-artifact pin format, letting
+  an export load behavior code at runtime (any `import()`/fetch of code), or
+  dropping the trust-acknowledgment precondition is a reviewed contract diff
+  (`../behaviors.md` §8.3/§12).
+- §5.3's pinned option set, §5.4's pattern table and §5.4.1's recorded-exception
+  counts are unchanged by packet 18 and keep their re-measurement rule: a
+  behavior output that changes the emitted counts is a build finding, not a
+  contract amendment.
```

---

# Packet 19 additions — delivery closure, format-aware validation and versioned fetches

**PROPOSED — pending Gate E.** Appended by packet 19
(`docs/planning/m2-packets.md` §19) to the same diff file. **Packet 18's sections
(`E18-1`…`E18-7`) and its "not changed" list above are unchanged and remain in
force**; every item below applies *on top of* them. Normative text source:
[`../delivery.md`](../delivery.md) §§2–4/9/10/12 and
[`sessions.md`](sessions.md) §"Packet 19" (the locator). Promotion is docs-only,
per diff, at Gate E.

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending.** The physics-restated manifest
identity is `@dimforge/rapier2d-compat@0.20.0` — **selection per decision 0002
§1, owner pre-approval**; the pin enters the lockfile only at packet 31.

## E19. Summary

| # | Destination | Kind | Normative text |
|---|---|---|---|
| E19-1 | §2 "Input: one immutable snapshot" | insert paragraph | `../delivery.md` §2 |
| E19-2 | §3 "Output layout (normative)" | reword + insert rows | `../delivery.md` §§2/9/12 |
| E19-3 | §4 "Validation pipeline" | insert steps + codes | `../delivery.md` §§3/4.4 |
| E19-4 | §4.1 "Stable error codes" | insert rows | `../delivery.md` §§4.4/6.2 |
| E19-5 | §5.2 "Exact import graph" | insert rows | `../delivery.md` §9 |
| E19-6 | §5.3/§5.4 engine fetches + scan | reword + insert | `../delivery.md` §§4.3/4.4 |
| E19-7 | §5.4.1 recorded-exception table | insert clarification (U-4 ACCEPT) | `../delivery.md` §13 |
| E19-8 | §6 "`meta.json`" | insert fields + schemaVersion 2 | `../delivery.md` §9 |
| E19-9 | §7 "Reproducibility scope" | insert clause | `../delivery.md` §§2.2/9 |
| E19-10 | §8/§9 non-goals + change rules | insert bullets | `../delivery.md` §17 |

Not changed by packet 19: §1 scope/ownership, §4's step 1–3 and step 6,
§4.1's existing six codes, §5.1 (packet 18's behavior paragraph stands),
§5.2's forbidden-node list (extended only by the artifacts below), §5.4's
pattern table a–j and §5.4.1's counts/binding conditions, §5.5's bootstrap
steps 2–5, §6's existing fields, §7's out-of-scope list.

## E19-B. Existing sections

### E19-1 — §2 "Input: one immutable snapshot": insert paragraph

```diff
+**M2: the snapshot is captured into a runtime-content manifest.** The exporter
+still reads one authoring state through the injected workspace service and
+freezes it; it then derives the immutable runtime-content manifest
+(`../delivery.md` §2) — scene digest, resolved asset versions, behavior
+outputs, required engine modules, recipe/toolchain versions and build identity —
+from that single capture. The manifest is the export's structural input; a
+revision or resolved-digest change after capture is `export_snapshot_mismatch`
+(§4 step 2). The manifest is **not** an engine-independent binary hash, and
+`snapshotId` is never presented as one (`../delivery.md` §2.2).
```

### E19-2 — §3 "Output layout (normative)": reword the tree + add rows

```diff
 <exportRoot>/<projectId>@r<revision>/
   index.html          minimal page: <canvas id="game"> + <script src="./js/main.js" type="module">
                       + a small HUD line for the snapshotId and renderer backend
   js/main.js          the esbuild browser bundle (§5)
-  snapshot.json       the runtime snapshot document, canonical serialization
-                      (project-model §12.2 style: fixed key order, 2-space
-                      indent, LF, one trailing newline, no BOM)
+  manifest.json       the immutable runtime-content manifest (`../delivery.md`
+                      §2), canonical serialization (project-model §12.2 style:
+                      fixed key order, 2-space indent, LF, one trailing
+                      newline, no BOM)
+  content/sha256/<digest>   every reachable committed asset version (immutable,
+                      byte-identical to the authoritative blob)
+  behaviors/<outputDigest>.js   every reachable compiled behavior output
   meta.json           the export metadata (§4), canonical serialization
```

- `snapshot.json` is **superseded** by `manifest.json` for M2 exports; an M1
  export is unchanged and keeps `snapshot.json` (`meta.json.schemaVersion 1`).
- The relative-paths/no-absolute-locator rule is unchanged and now covers the
  new directories; the closure rule (`../delivery.md` §9) requires every declared
  artifact to be present and every present artifact to be declared.

### E19-3 — §4 "Validation pipeline": insert steps

Anchor: after the existing step 5 row, before step 6.

```diff
+| 5a | The manifest validates (strict §2 shape; `buildId` recomputes; every declared path is relative and present; every reachable asset/behavior/module is declared) | `export_manifest_invalid` |
+| 5b | Format-aware validation of every emitted artifact (`../delivery.md` §4.4): GLB container/URI scan, WASM magic/pin scan, JS/text pattern scan, relative closure | `export_bundle_forbidden_content` / `scan_forbidden_content` |
+| 5c | Engine-fetch closure: the emitted bundle's fetch targets equal exactly the declared artifact set + one manifest read (`../delivery.md` §4.3) | `export_bundle_graph_forbidden` |
```

### E19-4 — §4.1 "Stable error codes": insert rows

```diff
+| `export_manifest_invalid` | `validation` — carries ≤ 10 model errors and the manifest path |
+| `export_build_unavailable` | `unavailable` — the derived build failed; the previous output tree is preserved |
+| `scan_forbidden_content` | `internal` — a format-aware scan hit (≤ 4 hits); the shared code with the play build (`sessions.md` §11.3) |
```

### E19-5 — §5.2 "Exact import graph": insert rows

```diff
+  → the manifest's declared artifact set as static build inputs:
+    content/sha256/<digest> (read by the bootstrap as relative artifacts),
+    behaviors/<outputDigest>.js (packet 18's linked outputs),
+    platformer / input / physics-rapier (packet 17, runtime types +
+    the approved Rapier pin)
```

### E19-6 — §5.3/§5.4 engine fetches + scan: reword + insert

**(a)** Replace the §5.3 single-fetch paragraph's rule for M2:

```diff
-- **No service dependency:** the bundle makes exactly **one `fetch`
-  initiated by engine code** — the bootstrap's relative `./snapshot.json`
-  (§5.5 step 1). Other `fetch(` occurrences may appear in the emitted
-  bytes only from the pinned three.js loader code and only as recorded in
-  the §5.4.1 recorded-exception table. No other network call initiated by
-  engine code, no engine WebSocket, no engine `XMLHttpRequest`, no
-  `import()` of remote code, no authoring-service call (charter §1: runs
-  without the editor backend, MCP, or model service).
+- **No service dependency:** the bundle fetches only **relative artifacts
+  declared by its own `manifest.json`** — one manifest read plus one read per
+  unique declared artifact path (`../delivery.md` §4.3), all same-origin,
+  relative to the output tree. For an M1-style closure (no assets, no
+  source-bearing behaviors) this reduces to the M1 rule with `./manifest.json`
+  replacing `./snapshot.json`. Other `fetch(` occurrences may appear in the
+  emitted bytes only from the pinned three.js loader code and only as recorded
+  in the §5.4.1 recorded-exception table. Still: no absolute/remote URL, no
+  engine WebSocket, no engine `XMLHttpRequest`, no `import()` of remote code,
+  no authoring-service call (charter §1: runs without the editor backend, MCP,
+  or model service).
```

**(b)** Insert into §5.4:

```diff
+**Format-aware validation replaces the text-only scan for non-JS artifacts**
+(`../delivery.md` §4.4): `content/sha256/<digest>` GLB blobs are validated as
+containers (glTF magic/version/chunk table, strict JSON chunk, every `uri`
+rejected unless it is an embedded/declared name with no scheme, leading `/`,
+`..` or backslash); a separately emitted WASM artifact is validated by magic,
+version, declared SHA-256 pin and an empty host-import allowlist. The a–j
+patterns and the §5.4.1 counts apply to the **JS/text bytes** (including the
+linked behavior outputs); applying them to a binary payload is explicitly not
+the rule. Pattern i (token values) gains **locator values**: the exporter is
+given the active `contentId`s and any occurrence is a hit.
```

### E19-7 — §5.4.1 recorded-exception table: insert the U-4 clarification

```diff
+**Reference-build entry (U-4 ACCEPT — owner pre-approval (autonomous M2 build
+instruction, 2026-09-18); final manual review pending).** Binding 3's
+"reference full-core three bundle" is materialized with the entry
+`import * as THREE from 'three'; console.log(THREE.REVISION);`. Under the
+pinned esbuild 0.28.2 option set the bare `import * as THREE from 'three';`
+elides to a 15-byte empty IIFE (unused namespace imports are dropped even with
+`treeShaking: false`), which would make binding 3 unsatisfiable. The table's
+counts and binding conditions are **unchanged** and remain the binding record;
+this clause only fixes how the described reference bundle is produced.
```

### E19-8 — §6 "`meta.json` (exact, canonical)": insert fields

```diff
+{
+  "schemaVersion": 2,
+  …,
+  "manifest": {
+    "manifestVersion": 1, "snapshotId": "demo-0001@r12", "revision": 12,
+    "contentDigest": "<64 hex>", "buildId": "<64 hex>",
+    "buildOptionsDigest": "<64 hex>"
+  },
+  "licenses": [ { "id": "three", "version": "0.186.0", "license": "MIT", "source": "npm" } ],
+  "artifacts": {
+    "assets": { "count": 2, "bytes": 8192 },
+    "behaviors": { "count": 1, "bytes": 4096 },
+    "total": { "count": 3, "bytes": 12288 }
+  },
+  "outputDigest": "<64 hex>"
+}
```

Rules: `schemaVersion` becomes exactly `2` for an M2 export (a new required
field or meaning change; the M1 reader rejects unknown majors with an
actionable message). `licenses` is one entry per bundled dependency/artifact,
ascending by `id`; `artifacts` counts/bytes are measured from the emitted tree;
`outputDigest` is the SHA-256 record of the emitted closure (a distinct identity
from `snapshotId`/`buildId` — `../delivery.md` §2.2). An M2 export of an
M1-style snapshot still emits this shape (empty `content/**`/`behaviors/**`).
```

### E19-9 — §7 "Reproducibility scope": insert clause

```diff
+**M2 addition (normative):** two exports of the same captured manifest, same
+artifact bytes and same pins/options produce byte-identical `manifest.json`,
+`content/**`, `behaviors/**` and `js/main.js`; `meta.json` is identical in
+every field except `exportedAt`; `outputDigest` (which excludes `exportedAt` by
+construction) is therefore identical. GLB/WASM artifact bytes are copied
+verbatim, never re-encoded, so the closure is byte-reproducible.
```

### E19-10 — §8/§9: insert bullets

```diff
+- No CDN, capability-URL or absolute-locator export; no service worker; no
+  range/resumable download; no export of a `contentId` or any authoring
+  credential (`../delivery.md` §9).
```

```diff
+- Changing the output layout, the manifest shape, the fetch-closure rule, the
+  format-aware validators or the `meta.json` fields is a reviewed contract diff;
+  the §5.4.1 counts keep their re-measurement rule.
+- Superseding `snapshot.json` with `manifest.json` is a versioned layout change:
+  an M1 export (schemaVersion 1) stays readable and unchanged; a reader must
+  branch on `meta.json.schemaVersion`, never on file presence.
```
