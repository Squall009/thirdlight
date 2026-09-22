# Packet 35 evidence — Content-aware play delivery and bounded MCP input

Date: 2026-09-19. Owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending. No commit made.

Selection per decision 0002 §1, owner pre-approval.

Raw command outputs: `commands.txt` (the exact toolchain and test runs).
Browser procedure (packet 37): `tests/browser/m2-play/README.md`.

## What really ran (no mocks)

| # | Claim | Method | Artifact |
|---|---|---|---|
| E1 | A real backend child process builds the immutable runtime-content manifest at play start and serves it through the scoped, read-only, unguessable locator | `tests/integration/m2-play/play-delivery.test.ts` (real fs + real HTTP on both origins + real WS) | `commands.txt` (13/13) |
| E2 | The manifest is self-identifying: `buildId` = SHA-256 of the canonical document without `buildId`, key order exactly §17.1.1; assets/behaviors ordered; the option-set digest is the §4.2 record | `packages/backend/src/play-content.test.ts` (10/10) | `commands.txt` |
| E3 | The locator serves only the declared routes: `manifest.json`, `game.js`, `content/sha256/<digest>`, `content/<assetId>/<version>`, `behaviors/<outputDigest>.js`; artifacts carry `X-Thirdlight-Digest`/`ETag`/`Cache-Control: private, max-age=<remaining>, immutable`/`Referrer-Policy: no-referrer` | integration (E1) + `classifyLocatorPath` units | `commands.txt` |
| E4 | Never a filesystem fallback: listing (`/play-content/`), traversal, undeclared paths and malformed ids ⇒ `path_rejected` 400; an unknown/unpaired capability ⇒ `play_locator_invalid` 404 | integration (E1) + path units | `commands.txt` |
| E5 | The locator capability is redacted in error/log paths (the response never contains the `contentId`) | integration (E1) | `commands.txt` |
| E6 | Pins are frozen: publishing a new behavior source + attaching it to a new entity during a running play does not change the served manifest bytes; a fresh play adopts the new revision/`buildId` | integration (E1) | `commands.txt` |
| E7 | The bounded input-exercise relay works through the REAL stdio MCP SDK: `tl_input_exercise` → backend `POST …/play/:id/input` → real editor WS `input.request` → bounded `input.result`; the result carries `appliedFromStep/To` + `snapshotId`/`buildId` and `inputMode: "test"` | integration (E1) | `commands.txt` |
| E8 | Relay limits: >600 frames and non-ascending offsets rejected; a silent preview ⇒ `input_relay_timeout`; unknown/stopped play ⇒ structured `play_not_found`; never a simulated success | integration (E1) | `commands.txt` |
| E9 | Repeated start/stop allocates a fresh capability each cycle and stops cleanly; an owner disconnect terminates the live play (`session_lost`) with the locator still readable in grace; after a backend restart the old capability is a structured 404 (plus the documented operator takeover) | integration (E1) | `commands.txt` |
| E10 | The TTL (900 s), the 60 s terminal grace, the 512 MiB closure / 32 MiB artifact caps, the extra-TTL retention before pruning and the leak counters (sets/plays/bytes/timers) all behave | store units | `commands.txt` |
| E11 | The production play-preview bundle composes runtime + input + platformer + physics-rapier + three/GLTFLoader and carries **no** authoring credential, **no** `/api/v1/`, no Node leak, no remote locator | `tests/integration/m2-play/bundle-scan.test.ts` (esbuild with the exact §5.3 pinned options) | `commands.txt` |

### Measured bundle scan (pinned esbuild 0.28.2, §5.3 options)

| Bundle | Bytes | a | c | d `fetch(` | e `node:` | f `process.` | g `/mcp` | h URLs | j XHR/WS |
|---|---|---|---|---|---|---|---|---|---|
| reference full-core `three@0.186.0` | 1 777 856 | 0 | 0 | 3 | 0 | 3 | 0 | 26 | 3 |
| play-preview bundle | 4 522 584 | 0 | 0 | 6 | 0 | 3 | 0 | 38 | 3 |

- The reference counts reproduce the §5.4.1 table exactly (d 3, f 3, h 26,
  j 3, rest 0); the reference byte count differs from the recorded 1 777 857 by
  one byte (the entry's `console.log(THREE.REVISION)` line — the counts, not the
  size, are what binding 3 pins).
- GLTFLoader row: `GLTFLoader` ×37 and `https://` +12 (⇒ 38) — the recorded
  packet-26/§5.4.1 row, re-derived on this bundle.
- The preview's extra `fetch(` over the core: 2 own call sites (manifest + one
  per declared asset path) + **1 inert occurrence inside the pinned
  `@dimforge/rapier2d-compat` compat loader** (`A2 = fetch(A2)`; unreachable —
  the WASM is inlined and the port receives bytes). Recorded as C35-7.
- `three` bundled revision literal `186` (the pinned `three@0.186.0`).

## Acceptance criteria

**Passed (real process/FS/HTTP/WS/SDK, no browser needed):** immutable play
build + pins + locator (E1–E6, E10); scoped artifact server with traversal /
listing / cross-project / redaction rejection (E4–E5); bounded MCP relay with
step/snapshot provenance and the no-browser structured failure (E7–E8);
repeated start/stop plus disconnect/restart lifecycle (E9); preview bundle
contains no authoring credentials and makes no authoring API call (E11).

**Unverified (no browser, procedure in `tests/browser/m2-play/README.md`):**
the real production browser Play (loading the pinned GLB and behavior, WebGL
rendering, ready/progress in a live preview), course traversal, physical
keyboard/gamepad input (including denied gamepad permission and the
injected-vs-physical re-arm), tab-resume, and **the rendered PNG** (A20). No
placeholder image is substituted: packet 35 captured no pixels and no PNG, and
the packet-37 owner procedure records exactly how to capture and hash one.

## Contract-change requests (recorded, not silently applied)

- **C35-1** — `workspace.readSourceBlob(projectId, { digest })`: the accepted
  §3 surface names only `readBlob(assetId, version)`; the play build needs a
  verified digest-addressed read for behavior source containers (not catalog
  assets). Additive, verified, `O_NOFOLLOW` + digest-verified. Proposed diff:
  add the row to dependencies.md §3/§4.1 and workspace.md §13.5.
- **C35-2** — the runtime-content manifest `behaviors[]` row must also carry
  `declaration`, `ownedTransforms` and `requiredModules`: the preview cannot
  materialize declared properties or validate transform ownership without them,
  and §17.1.1 lists neither. Proposed diff: extend the §17.1.1 row.
- **C35-3** — the play-preview entry's direct edges are the §4.2 preview graph
  (protocol/runtime/three-adapter/project-model/input/platformer/physics-rapier
  + three incl. GLTFLoader), but dependencies.md §4.1's `editor` row names only
  the editor UI's edges. The boundary checker now validates
  `packages/editor/src/preview/preview-bootstrap.ts` against the §4.2 graph and
  records one bounded exception: a computed `import()` whose target is a
  manifest-declared relative locator artifact path (delivery §4.3). Proposed
  diff: name the preview entry in §4.1/§4.2 and the locator dynamic import in
  §5.1.
- **C35-4** — sessions.md §19.1 lists no behavior-source preparation route, but
  packet 35 needs one to publish a behavior source end-to-end (the packet-34
  editor path could only surface `behavior_publication_unavailable`). Additive
  route `POST /api/v1/projects/:projectId/content/behaviors/source` runs the
  existing packet-33 facade (no second commit path).
- **C35-5** — the runtime snapshot's `scene.schemaVersion` was derived from the
  project manifest (M1), which stays 1 for a `storageVersion 2` project while
  the scene document is 2. Packet 35 derives 2 when the envelope carries the v2
  content block, so the v2 component rules apply; `queryProject` should expose
  the scene document's `schemaVersion` directly. Also: neither the accepted
  `tl.snapshot` nor the runtime snapshot carries resolved `content.settings`, so
  the preview uses the contract defaults (run_speed 4, gravity −19.62, …).
- **C35-6** — export.md §5.4.1 binding 4's literal "pattern d: exactly 3 + 0 in
  the preview bundle" was written for the M1 preview, which fetched nothing;
  delivery §4.3 explicitly permits the M2 preview to read `./manifest.json` and
  one read per declared artifact path. The scan asserts the recorded baseline +
  the loader row + the counted preview call sites instead.
- **C35-7** — the §5.4.1 recorded-exception table needs a
  `@dimforge/rapier2d-compat` row once the physics pin enters the preview bundle
  (`fetch(` +1, inert; measured above).
- **C35-8** — the WS event names `input.request`/`input.result` used by the
  relay are not in sessions.md §7's catalog (which predates §18).

## Limitations

- **No browser:** every browser/WebGL/pixel claim is UNVERIFIED (above).
- The play build buffers the artifact set in memory (bounded by the contract
  caps); a large real project would prefer streaming from the artifact store.
- Behavior outputs are recompiled deterministically at play start (the compiled
  bytes are not persisted by packet 33); the `outputDigest` is verified against
  the published record, and a mismatch fails the build
  (`play_build_unavailable`, `behavior_output_digest_mismatch`).
- The §18.1 "physical input already engaged" conflict is implemented as the
  observable concurrent-relay conflict plus the preview's exclusive-mode
  suppression/re-arm; the bridge carries no physical-engagement signal in the
  accepted catalog (part of C35-8).
