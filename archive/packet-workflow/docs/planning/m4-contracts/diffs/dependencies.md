# Owned diff rows — `dependencies.md` (packets 64, 65, 66, 67)

Proposal: `../delivery.md` §2.9 (packet 64) and `../distribution.md` (packet
66). Gate Q. **PROPOSED — not accepted.**
Single owner: the `dependencies.md` §4 rows are owned by this packet's
rows; no other M4 packet edits `dependencies.md`.

## C64-6 — the M3 bundle entry rows and the `./gltf-loader` subpath record

### Row 1: `dependencies.md` §4.2, the play-preview bundle table row

OLD (the accepted row as written today):

```text
| **play-preview bundle** (`dist/preview/`) | `packages/editor/src/preview/preview-bootstrap.ts` (wrapper; the composition is `game-host`) | `editor/src/preview/**` (that directory only), `game-host`, `platformer-game`, `protocol` (the pure wire-types package — bridge messages; §3), `runtime`, `three-adapter`, `project-model`, `input`, `platformer`, `physics-rapier` (injected by the wrapper), `three` (incl. the GLTFLoader subpath), plus the **linked behavior outputs** of the snapshot |
```

NEW (the M2 entry stays for M2 plays; the M3 entry is a second,
separately checked entry exactly as the accepted C35-3 pattern; the
allowed graph is unchanged — it already admits the GLTFLoader subpath):

```text
| **play-preview bundle** (`dist/preview/`) | `packages/editor/src/preview/preview-bootstrap.ts` (the M2 wrapper; the M2 play graph is unchanged and **loader-free** — root subpath only) and, for M3 plays, `packages/editor/src/preview/preview-m3.ts` (the M3 wrapper, a second separately checked entry — the C35-3 pattern; the composition is `game-host`) | `editor/src/preview/**` (that directory only), `game-host`, `platformer-game`, `protocol` (the pure wire-types package — bridge messages; §3), `runtime`, `three-adapter` (root; the M3 entry additionally reaches the `./gltf-loader` subpath — the model byte loader port, M4 `delivery.md` §2), `project-model`, `input`, `platformer`, `physics-rapier` (injected by the wrapper), `three` (incl. the GLTFLoader subpath — the M2 bundle's graph does not include it), plus the **linked behavior outputs** of the snapshot |
```

### Row 2: `dependencies.md` §4.2, the export bundle table row

OLD:

```text
| **export bundle** (export output) | `packages/exporter/src/export-bootstrap.ts` (wrapper; the composition is `game-host`) | `exporter/src/export-bootstrap.ts` (that file only), `game-host`, `platformer-game`, `runtime`, `three-adapter`, `project-model`, `input`, `platformer`, `physics-rapier` (injected by the wrapper), `three` (incl. the GLTFLoader subpath), plus the **linked behavior outputs** of the snapshot and the **declared asset artifacts read as relative runtime resources** |
```

NEW:

```text
| **export bundle** (export output) | `packages/exporter/src/export-bootstrap.ts` (the M1/M2 wrapper; the M1/M2 export graphs are unchanged and **loader-free** — root subpath only) and, for M3 (`manifestVersion 2`) exports, `packages/exporter/src/export-bootstrap-m3.ts` (the M3 wrapper — the exact one-file M3 exporter list, `export.md` §5.2 as corrected by C64-5; the composition is `game-host`) | `exporter/src/export-bootstrap.ts` or `exporter/src/export-bootstrap-m3.ts` (the profile's own file only), `game-host`, `platformer-game`, `runtime`, `three-adapter` (root; the M3 entry additionally reaches the `./gltf-loader` subpath — the model byte loader port, M4 `delivery.md` §2), `project-model`, `input`, `platformer`, `physics-rapier` (injected by the wrapper), `three` (incl. the GLTFLoader subpath — the M1/M2 bundles' graphs do not include it), plus the **linked behavior outputs** of the snapshot and the **declared asset artifacts read as relative runtime resources** |
```

### Row 3: `dependencies.md` §4.2, the GLTFLoader bullet (additive record)

OLD:

```text
- **GLTFLoader is the pinned `three@0.186.0` package's own subpath** — no new
  dependency, no new pin (§7). Only `three/examples/jsm/loaders/GLTFLoader.js`
  (+ the animation loader used for clip preview) may appear; a different
  `examples/jsm` module is a reviewed addition.
```

NEW (one additive sentence):

```text
- **GLTFLoader is the pinned `three@0.186.0` package's own subpath** — no new
  dependency, no new pin (§7). Only `three/examples/jsm/loaders/GLTFLoader.js`
  (+ the animation loader used for clip preview) may appear; a different
  `examples/jsm` module is a reviewed addition. **M4 record (C64-6):** the
  `three-adapter` `./gltf-loader` subpath (the `createGltfLoaderPort` binding,
  the accepted packet-26 C26-1) appears in the **M3 play-preview** and **M3
  export** bundle graphs (the wrappers build the loader port the adapter's
  `models` block uses, M4 `delivery.md` §2); the `export.md` §5.4.1
  **GLTFLoader subpath row** (pattern h `https://` +12, `GLTFLoader` ×37,
  d/f/j/a/b/c/e/g/i +0) therefore applies to exactly those two bundles,
  re-measured by packet 70 on the real bundles (any difference requests
  bounded re-review — never an exception widening). The M1/M2 bundles
  (editor `main.js`, M2 `preview.js`, M1/M2 export) remain **loader-free**
  (root subpath only) with their recorded §5.4.1 counts untouched. The
  **editor bundle** gains the subpath only with packet 70-B's
  authoring-viewport model wiring (70-B records and re-measures; this row
  does not pre-empt it).
```

**No other `dependencies.md` change (packet 64).** The §4.1 Node-side rows,
the §4.3 forbidden edges, the §5 boundary checks and the §7 pinned stack
are untouched.

---

# Packet 65 rows (proposal: `../templates.md` §12)

## C65-8 — NO contract text change (adjudication record)

The packet-65 template contract was read against the accepted
dependencies text; **no package, dependency or bundle change is needed**:

- **No new package / no new dependency.** The template logic lives in the
  accepted packages: the workspace service (the `createProjectFromTemplate`
  operator — the accepted §4.1 `workspace` row, no new edge: it reads the
  installed template directory through the injected filesystem facade and
  applies the recipe through the accepted command engine), the backend
  (the admin route — the accepted §4.1 `backend` row), the mcp-adapter (two
  routing tools — the accepted §4.1 `mcp-adapter` row: the tool is a
  routing wrapper into the admin route, "no alternate mutation engine"),
  the editor (the creation UI + the panel-visibility local preference —
  the accepted §4.2 editor row; the preference is browser
  `localStorage` state, never a bundle input).
- **`templates/` is engine data, not a package.** The template directory
  (descriptor + base scene + recipe + sources + NOTICE) is excluded from
  the package graph and from every browser bundle; it is distributed with
  the engine (the packet-66 engine-kit layout owns its in-kit location —
  this row does not pre-empt 66). No browser bundle gains a template byte;
  no Node bundle gains a template import.
- **No graph change from creation:** creating a project writes project
  files only; the bundle graphs of §4.2 (M1/M2/M3 preview/export/editor)
  are untouched by the template contract (the M3 `./gltf-loader` subpath
  rows of packet 64 are unaffected).

**No other `dependencies.md` change (packet 65).**

## C66-1 — the engine kit is a distribution of the existing workspace;
one new tooling unit edge; no new package, dependency, pin or lockfile
change

Proposal: `../distribution.md` §1, §4, §5, §10. Gate Q.

- **The kit (distribution.md §1) contains the 17 units of §2** (source,
  unchanged), the 4 accepted tooling scripts + their tests, the root
  manifests, the exact lockfile bytes and the M4 template data. It renames,
  re-versions, re-scopes or re-declares no unit. **The kit is a data +
  tooling distribution, not a new package.**
- **New tooling unit edge (recorded for Q per the packet):**
  `tools/game-build.mjs` (distribution.md §6) — the game's build entry — a
  plain-Node script using `node:*` builtins only (fs/path/child_process/
  url/crypto). Not a package; appears in no `dependencies` map; changes no
  lockfile entry; added to the kit's `tools/` allowlist at assembly. CCR-66-2
  records that the kit assembler script ships with the packet-75 tooling.
- **No new dependencies (C12):** the kit's installed tree = `npm ci` from
  the accepted lockfile (235 entries — the §7 pins exactly). The
  build-only-vs-runtime table (distribution.md §5) re-states accepted
  §4.2/§7 facts: `esbuild@0.28.2` is an `exporter`/`behavior-build`
  *dependency* that never enters a browser bundle and stays EXTERNAL in the
  backend bundle; `typescript@5.9.3` (typecheck) and `vitest@5.0.1` (tests)
  are dev/test-only; the browser runtime rows are `three@0.186.0`,
  `react@19.3.0`/`react-dom@19.3.0` (editor only — the 0001 §10 scope rule
  holds inside the kit), `@dimforge/rapier2d-compat@0.20.0`, `ws@8.21.3`
  (backend bundle), `@modelcontextprotocol/sdk@1.30.0` (mcp bundle).
- **`node_modules` is never part of the kit** (25 `@esbuild/<platform>`
  binary packages are machine-dependent): install is
  `npm ci --prefix <kit>` — lockfile-authoritative, so **a transitive
  floating dependency is impossible by construction**; registry
  unavailability is the structured `kit_install_unavailable` (never a
  silent skip or partial install).
- The React scope rules and the no-web-framework rule apply unchanged inside
  the kit (it is the same workspace).

**No other `dependencies.md` change (packet 66).**

## C67-4 — the reliability/budget tooling edge; no new package or dependency

Proposal: `../reliability.md` §10. Gate Q.

- **No new dependencies (C12):** the backup/verify/restore/create tools and
  the budget-run tooling are plain-Node scripts (`node:*` only — fs/path/
  crypto/child_process) — not packages, in no `dependencies` map, no
  lockfile change (the packet-66 tooling-edge pattern; CCR-67-1: they ship
  with the packet-75/79 tooling).
- **No new tool edge in the engine build pipeline:** the tools are
  operator-side (run outside the engine, on released/stopped state) and the
  budget harness (79) — none of them joins `npm run build`, the kit
  inventory (packet 66 §1) or any bundle graph. The kit's `tools/` allowlist
  is unchanged; the health report (C67-2) is served by the existing backend
  bundle (no new import).
- The build-only-vs-runtime table (packet 66 §5) is unaffected: no new
  runtime or build member.

**No other `dependencies.md` change (packet 67).**