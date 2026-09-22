**PROPOSED — not accepted.** Packet 42 (`docs/planning/m3-packets.md` §42)
output. Section-level diffs for `docs/contracts/sessions.md`. Normative rule
text lives in [`../delivery.md`](../delivery.md) §§2, 4–6; this file names the
exact destination, the shortest unique OLD quote and the NEW text. Convention
(same as [`../../m2-contracts/diffs/sessions.md`](../../m2-contracts/diffs/sessions.md)):
`OLD` is accepted text exactly as it reads today; `NEW` is the replacement; `+`
blocks are pure insertions. Accepted section numbers are never renumbered: the
new M3 relay material is appended as **§20**. Superseded text is called out
explicitly.

Read basis: accepted `sessions.md` §§7/10–13/16–19; `m3-plan.md` §3.4;
`m3-packets.md` §42/§48/§55/§58/§59; handoffs 40 (C40-9), 41 (C41-5); packet-38
evidence (`acceptance/evidence-m3/38/raw/engine*.json`, `summary.json`). No
product code, no dependency upgrade.

---

## A. Summary of required changes

| # | Destination | Kind | Normative text |
|---|---|---|---|
| S42-1 | §7.1/§7.2 WS catalog | insert two server→client and two client→server rows | delivery.md §5 |
| S42-2 | §10.5 readiness | insert the manifest-v2 sentence | delivery.md §2.3/§2.6 |
| S42-3 | §11.5 constants | insert three rows | delivery.md §8 |
| S42-4 | §13.1 isolation/framing | extend the `allow="gamepad"` requirement | delivery.md §6.2 |
| S42-5 | §13.5 message allowlist | insert four bridge rows + bounds | delivery.md §5 |
| S42-6 | §13.6 reload | insert the fresh-host sentence | delivery.md §3.1 |
| S42-7 | §17.1.1 manifest | change the version + insert six rows and the `kind` rule | delivery.md §2 |
| S42-8 | §17.4 CSP | **the exact one-token diff** | delivery.md §6.1 |
| S42-9 | §17.5 fetch policy | insert the no-new-fetch note | delivery.md §6.5 |
| S42-10 | §17.6 readiness | insert the host/menu readiness rule | delivery.md §4.5 |
| S42-11 | **new §20** | insert section | delivery.md §5 |
| S42-12 | §15 change rules | insert bullets | delivery.md §11 |

Not changed: §§1–6, §8, §9, §11.1–§11.4/§11.6, §12 (the screenshot/diagnostics
chain is untouched), §13.2–§13.4/§13.7, §14, §16, §17.1.2/§17.1.3/§17.2/§17.3,
§18 (the input-exercise relay is unchanged; §20 is its sibling), §19.

---

## B. Existing sections

### S42-1 — §7 WS event catalog: insert the relay rows

Anchor 1: after the `input.request` row of §7.1 (the last row of the table).

```diff
+| `game.control.request` | `{ relayId, command, expectedRunId? }` — `command` ∈ `{start, replay, mute, unmute}`; `expectedRunId` shape `<snapshotId>#<replayEpoch>`; body ≤ 4 KiB | a §20 control request is forwarded to the owner editor, which relays it to the preview |
+| `game.observe.request` | `{ relayId, timeoutMs }` — 250–15 000; body ≤ 4 KiB | a §20 observation request is forwarded to the owner editor (packet-42 addition; the §7 catalog predates §20) |
```

Anchor 2: after the `input.result` row of §7.2 (the last row of the table).

```diff
+| `game.control.ack` | `{ relayId, ok, result?, error? }` — on `ok: true` the §20 control result (≤ 4 KiB); on failure `error.code` is one of the §20 codes | the preview's `tl.game.control.result` relayed back by the owner editor (never fabricated) |
+| `game.observe.ack` | `{ relayId, ok, result?, error? }` — on `ok: true` the §20 observation result (≤ 16 KiB); on failure `error.code` is one of the §20 codes | the preview's `tl.game.observe.result` relayed back by the owner editor |
```

The editor's relay-never-fabricates rule of §7.2 applies to both ack rows
unchanged: a failed relay is `ok: false, error.code: "relay_failed"`, never an
invented observation.

### S42-2 — §10.5: the manifest v2 identity

Anchor: after the bullet ending "…and never changes for the play session (§10.2's
freeze rule)."

```diff
+- **The build is a manifest v2 capture.** `buildId` identifies the immutable
+  runtime-content manifest (delivery.md §2); for an M3 build that manifest also
+  binds the resolved six-key settings, the frozen `content.game` block and the
+  media identity (cue/role resolution) by digest. Ready additionally requires
+  those blocks to match the served bytes (S42-10). A later settings/game/media
+  edit changes the authoring revision and therefore a *fresh* capture's
+  `snapshotId`/`buildId`; it never changes this play's (delivery.md §2.6/§3.3).
```

### S42-3 — §11.5 constants: insert rows

Anchor: after the `manifest document cap` row.

```diff
+| game control relay: request body cap / result cap | 4 KiB / 4 KiB |
+| game observation relay: request body cap / result cap / timeout | 4 KiB / 16 KiB / 250–15 000 ms (default 5 000) |
+| game observation events | ≤ 32 (`MAX_GAME_EVENTS`, `gameplay.md` §6) |
```

### S42-4 — §13.1: extend the `allow="gamepad"` requirement (C38-2)

Anchor: the paragraph beginning "The preview `<iframe>` carries `allow="gamepad"`
(C30-5)."

```diff
-The preview `<iframe>` carries `allow="gamepad"` (C30-5). The `gamepad`
-Permissions-Policy feature defaults to `*`, so the attribute is harmless
-today, but it is required hardening once any `Permissions-Policy` header
-exists: a policy that does not delegate `gamepad` would otherwise deny
-`navigator.getGamepads()` in the cross-origin frame and the packet-37 A11
-hardware half could not pass. Packet 35 adds the attribute to
-`packages/editor/src/ui/App.tsx` when it attaches input in the preview.
+**Every** play `<iframe>` embedding carries `allow="gamepad"` — the editor
+preview wrapper and the M3 locator shell alike (C30-5, confirmed and extended by
+packet 42's C38-2). The `gamepad` Permissions-Policy feature defaults to `*`, so
+the attribute is harmless today, but it is required hardening once any
+`Permissions-Policy` header exists: a policy that does not delegate `gamepad`
+denies `navigator.getGamepads()` in the cross-origin frame. Packet 38 measured
+the failure directly: with `allow="gamepad 'none'"`, `navigator.getGamepads()`
+throws a `SecurityError` (`acceptance/evidence-m3/38/raw/summary.json`), so the
+gamepad half of the acceptance rows is unreachable without the attribute. If a
+`Permissions-Policy` header is added, it must delegate `gamepad`; the attribute
+stays required either way.
```

### S42-5 — §13.5 message allowlist: insert the bridge rows

Anchor 1: after the `tl.input.request` row of the "Editor → preview" table.

```diff
+| `tl.game.control` | `v, playSessionId, relayId, command, expectedRunId?` |
+| `tl.game.observe` | `v, playSessionId, relayId, timeoutMs` |
```

Anchor 2: after the `tl.input.result` row of the "Preview → editor" table.

```diff
+| `tl.game.control.result` | `v, playSessionId, relayId, ok, result?, error?` |
+| `tl.game.observe.result` | `v, playSessionId, relayId, ok, result?, error?` |
```

Anchor 3: the payload-bounds paragraph.

```diff
-**Payload bounds (v2).** Every bridge message is ≤ 64 KiB except
-`tl.snapshot` (≤ 1 MiB, unchanged) and `tl.screenshot.result` (≤ 1.5 MiB,
-unchanged); `tl.load.progress` ≤ 1 KiB; `tl.input.request` ≤ 16 KiB with ≤ 600
-frames. **No message carries GLB bytes, compiled behavior output bytes or
-source text**, and no bridge message is a second mutation or storage path
-(delivery §7). A `tl.snapshot` for a content-bearing snapshot references
-assets by `assetId`/version only.
+**Payload bounds (v2).** Every bridge message is ≤ 64 KiB except
+`tl.snapshot` (≤ 1 MiB, unchanged) and `tl.screenshot.result` (≤ 1.5 MiB,
+unchanged); `tl.load.progress` ≤ 1 KiB; `tl.input.request` ≤ 16 KiB with ≤ 600
+frames; `tl.game.control`/`tl.game.control.result` ≤ 4 KiB;
+`tl.game.observe.result` ≤ 16 KiB. **No message carries GLB bytes, compiled
+behavior output bytes, audio bytes/base64, an authoring token or a `contentId`
+capability**, and no bridge message is a second mutation or storage path
+(delivery §5.4/§7). A `tl.snapshot` for a content-bearing snapshot references
+assets by `assetId`/version only; audio is referenced by `assetId` only
+(C41-5).
```

### S42-6 — §13.6 reload: insert the fresh-host sentence

Anchor: after the bullet beginning "**Preview reload/refresh:**".

```diff
+- A reload constructs a **fresh `game-host`** from the re-sent snapshot and the
+  same manifest/artifact set: the host holds no cross-load state, and a stale
+  run/menu latch cannot survive the reload (delivery.md §4.2/§5.3).
```

### S42-7 — §17.1.1 manifest: the version change and the new fields

Anchor 1: the example's discriminator line.

```diff
-  "manifestVersion": 1,
+  "manifestVersion": 2,
```

Anchor 2: the field-rule row.

```diff
-| `manifestVersion` | exactly `1` (M2). A new required field or a meaning change ⇒ `2`. |
+| `manifestVersion` | exactly `2` for an M3 capture. `1` remains a **readable** version under its old meaning (no `settings`/`game`/`media`, `assets` rows without `kind`, the M2 pin set) and is **never** upgraded in place. A v1 reader receiving a v2 document fails with `manifest_invalid` (`reason: "manifest_version"`) rather than ignoring unknown required keys. The authoring `project.json` `schemaVersion` stays `1` (delivery.md §2.1). |
```

Anchor 3: after the `contentDigest` row, insert six rows.

```diff
+| `gameDigest` | SHA-256 of the canonical serialization of the `game` value; `null` hashes the four bytes `null`. |
+| `settingsDigest` | SHA-256 of the canonical serialization of the resolved `settings` block. |
+| `mediaDigest` | SHA-256 of the canonical serialization of the `media` block. |
+| `settings` | the **resolved** six-key gameplay settings (`defaults ⊕ content.settings`, project-model §21.5), registry key order. A resolution failure at capture ⇒ `game_config_invalid`/`field_value`; never a partial object. These are the values the host passes to both the runtime and the physics configuration (delivery.md §3.3). |
+| `game` | the frozen `content.game` value (39 §23.4) or `null`; embedded (no side-car file), canonical block order, ≤ 16 384 B. |
+| `media` | the resolved media identity: `cues` (five keys `start, jump, checkpoint, death, goal` → `{assetId, version}` or `null`) and `animation` (per `modelAnimation` entity, ascending `entityId` then `assetId`, carrying the immutable `(assetId, version)`, the `profileDigest` of its canonical `roles` bytes and the validated `roles`). It must equal the captured content's resolution or the manifest is `manifest_invalid` (`reason: "media_identity"`). It carries **no** audio bytes and no URL. |
```

Anchor 4: the `assets` row.

```diff
-| `assets` | every asset version reachable from the captured scene/prefabs, ascending by `assetId` then `version`; `version` is the **resolved immutable version** (an `assetId` reference resolves to exactly one version here). |
+| `assets` | every asset version reachable from the captured scene/prefabs, ascending by `assetId` then `version`; `version` is the **resolved immutable version**; each row carries a required `kind ∈ {model, audio}` matching the captured record (`asset_kind_mismatch` otherwise), and `path` is always `content/sha256/<sourceDigest>`. |
```

Anchor 5: after the `buildId` row, add the digest-preimage note.

```diff
+The block digests are `sha256(JSON.stringify(value, null, 2) + "\n")` UTF-8 over
+the declared canonical key order (`delivery.md` §2.4). Because `settings`,
+`game` and `media` sit inside the `buildId` preimage, every runtime-affecting
+authored value is hash-bound; the block digests let a consumer verify one block
+without re-serializing the document. No map order, clock or locale may affect a
+block — the only clock input is `capturedAt`.
```

### S42-8 — §17.4: the CSP diff (C38-1, exact)

Anchor: the first line of the CSP fence.

```diff
-  default-src 'none'; script-src 'self'; connect-src 'self';
+  default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self';
```

Consequences recorded with the diff (normative):

- `'wasm-unsafe-eval'` permits **WebAssembly compilation only**; it does **not**
  permit `eval`, `new Function` or arbitrary script evaluation. No `eval`
  interface is introduced by M3.
- The implementation's nonce clause is unchanged: the header is
  `"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'"` + (nonce ?
  `` ` 'nonce-${nonce}'` `` : `""`) + `"; connect-src 'self'; …"`, applied to the
  shell and artifact responses alike.
- Evidence of record: `acceptance/evidence-m3/38/raw/engine.json`
  (`physicsOk: false`, `WebAssembly` compile blocked by `script-src 'self'`),
  `…/engine-nocsp.json` (`physicsOk: true`), `…/engine-csp-wasm.json`
  (`physicsOk: true` with this exact token). Until Gate K accepts and promotes
  this diff, no M3 packet may change the CSP silently.
- The standalone export states its own policy with the same token
  (export.md §3, E42-1); a separately emitted WASM artifact keeps the accepted
  `scanWasmContainer` validation and `application/wasm` MIME. If a
  `Permissions-Policy` header is added it must delegate `gamepad` (S42-4).
- No other CSP source is added: no `unsafe-inline`, no `unsafe-eval`, no remote
  origin, no `data:` script.

### S42-9 — §17.5: the M3 fetch list

Anchor: after the second row of the permitted-fetch table.

```diff
+**M3 (packet 42): no new fetch.** `game-host` initiates none, and the M3
+manifest keys (`settings`, `game`, `media` and their digests) are **embedded**
+in `manifest.json`: there is **no** `game.json` side-car and no additional
+artifact class. The list stays `./manifest.json`, `./scene.json` (export) and
+one read per unique declared asset path — count `1 + |unique declared
+artifacts|`. `content/sha256/<digest>` remains the path for model **and** audio
+bytes. Packets 58/60 re-measure the real bundles (delivery.md §6.5).
```

### S42-10 — §17.6 readiness: the host/menu readiness rule

Anchor: after the paragraph ending "…never a silent retry against newer bytes."

```diff
+**M3 readiness and the title screen.** Ready means the **title screen loaded**,
+not that gameplay started: the preview reports ready after the manifest v2
+identity matches (including `settingsDigest`/`gameDigest`/`mediaDigest`), every
+declared asset read completed and verified, the physics port initialized from the
+manifest `settings` (same object the runtime receives — delivery.md §3.3), the
+linked behavior outputs are linked and the `game-host` composition instantiated.
+The run is `awaitingStart` and no movement step has executed. The
+game-control/observation channel is available from that moment, and every
+start/replay/mute is serviced between frames — the host never waits for a
+physics tick to accept a menu action (delivery.md §4.5). Injected/relayed input
+is never a trusted user gesture and can never unlock audio (delivery.md §4.4).
```

### S42-11 — new §20 "M3 game control and observation relay"

Anchor: the end of §19 (after §19.4), appended as a new top-level section.

```diff
+## 20. M3 game control and observation relay
+
+Two bounded, typed relays address an explicitly selected play session. `protocol`
+is the sole home of the shapes (packet 48 implements the validators and the
+`tl_game_control`/`tl_game_observe` MCP tools); `backend` frames the routes and
+routes through the owner browser's WS; the preview supplies the values from the
+committed read-only `GameView` (`gameplay.md` §6) and the injected audio owner.
+Neither relay simulates gameplay, mutates authoring state or becomes a second
+command path.
+
+### 20.1 Routes, shapes and bounds
+
+| Route | Body | Result |
+|---|---|---|
+| `POST /api/v1/projects/:projectId/play/:playSessionId/control` | `{ command ∈ {start, replay, mute, unmute}, expectedRunId? }` ≤ 4 KiB | `{ ok, playSessionId, snapshotId, buildId, runId, command, state, acceptedAtStep, inputMode }` ≤ 4 KiB |
+| `POST /api/v1/projects/:projectId/play/:playSessionId/observe` | `{ timeoutMs }` 250–15 000 (default 5 000) ≤ 4 KiB | the observation document (≤ 16 KiB; `delivery.md` §5.2) |
+
+Both are authoring-origin routes with the accepted bearer/admin auth. The
+observation carries the identity tuple `(playSessionId, snapshotId, buildId,
+runId, stepIndex)`, the run state, checkpoint id + active bit, death count,
+`goalReached`, cumulative event counters, ≤ 32 events, `inputMode` and the sound
+status (`muted`/`blocked`/`ready`/`unavailable`, `unlocked`, `voices`, `gesture`).
+
+### 20.2 Failure mapping (closed)
+
+`field_value`/`field_unexpected` (400 `validation`);
+`game_command_invalid` (`reason: "state"`, 400); `game_run_stale` (409
+`conflict`, carrying the current `runId`, **not applied**); `play_not_found`
+(404); `play_locator_expired` (503 `unavailable`); `bad_origin` (403);
+`game_relay_rejected` (503 `unavailable`, dropped and counted — wrong source or
+nonce); `session_unavailable` (503, no registered browser / owner WS detached /
+not yet `presented` with `reason: "not_presented"`); `game_relay_timeout` (503);
+`input_relay_conflict` (409, physical input engaged during exclusive test mode);
+`limits_exceeded` (`result_bytes`, 400).
+
+**Nothing binary or sensitive crosses.** No relay request, result, WS frame,
+bridge message or log entry carries GLB/WAV bytes, base64 media, an authoring
+token, a `contentId` capability (redacted `<redacted:contentId>`), an absolute
+workspace path or a generic eval/script field. Audio is referenced by `assetId`
+only; bytes are read by the preview from the immutable blob/locator path.
+
+### 20.3 Staleness and exclusive mode
+
+A stale identity is always detectable from the result alone
+(`runId`/`stepIndex`/`snapshotId`/`buildId`); a stale **control** is refused
+with `game_run_stale`. While the accepted §18 exclusive test-input mode is
+active, physical frames **and** the physical menu channel are ignored, so an
+injected sequence cannot race a physical press. Injected input is never a
+trusted user gesture and cannot unlock audio (delivery.md §4.4).
```

### S42-12 — §15 change rules: insert bullets

Anchor: after the bullet ending "…giving it write authority is a contract change,
not a feature."

```diff
+- The manifest v1/v2 rules, the block-digest preimage and the `capturedAt`
+  reproducibility rule are contract material: adding a required manifest key,
+  changing a digest rule or normalizing an extra field is a reviewed diff
+  (`delivery.md` §2/§11).
+- The preview CSP token set (including `'wasm-unsafe-eval'`) and the
+  `allow="gamepad"` attribute are security material: relaxing either — or
+  replacing `'wasm-unsafe-eval'` with `'unsafe-eval'` — is a reviewed diff, never
+  a convenience change (S42-4/S42-8).
+- The §20 relay codes, bounds and identity tuple are contract material; every
+  new WS event or bridge message updates §7/§13.5 **and** the `protocol`
+  validators in the same review (the exhaustive-catalog rule).
```

## C. Explicitly not changed by packet 42

- §12's screenshot/diagnostics chain, §16's authenticated asset reads, §17.1.2/
  §17.1.3, §17.2/§17.3, §18's input-exercise relay and §19's content surface.
- §13.2's page config: the host needs no new page field (no token, no capability,
  no settings in the page — settings arrive through the manifest and snapshot).
- §10.1's play-start result shape: `playContent` is unchanged; the M3 identity is
  carried by `buildId`/`snapshotId` and the manifest itself.
