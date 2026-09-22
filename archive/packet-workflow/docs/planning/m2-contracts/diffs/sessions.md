PROMOTED into docs/contracts/ on 2026-09-18 (Gate E accepted rows; owner pre-approval). Historical proposal — the accepted contract is authoritative.

# PROPOSED section-level diffs — `docs/contracts/sessions.md` (packet 19)

**PROPOSED — pending Gate E.** Packet 19 (`docs/planning/m2-packets.md` §19)
output. This file contains *no* accepted text: it names the exact destination
sections of `docs/contracts/sessions.md`, gives `OLD → NEW` text for every
existing section that changes, and gives insertion instructions (anchor +
normative text source) for new material. Promotion is docs-only, per diff, at
Gate E; nothing here is applied by packet 19.

Read with: [`../delivery.md`](../delivery.md) (the packet-19 proposal: locator,
manifest, fetch policy, relay, bounds), [`export.md`](export.md) §"Packet 19
additions", [`dependencies.md`](dependencies.md) §"Packet 19 additions",
[`../contract-diffs.md`](../contract-diffs.md) (the consolidated inventory and
the conflict resolutions).

Owner pre-approval: **owner pre-approval (autonomous M2 build instruction,
2026-09-18); final manual review pending** (a pre-approval, not an independent
review).

**Physics selection (restated for this packet's manifest identity):**
`@dimforge/rapier2d-compat` at exactly 0.20.0, kinematic character controller —
**selection per decision 0002 §1, owner pre-approval (autonomous M2 build
instruction, 2026-09-18); final manual review pending.** PROVISIONAL until the
packet-14 desktop evidence and Gate E accept it; the pin enters the lockfile only
at packet 31.

Convention: `OLD` is the accepted text exactly as it reads today (shortest unique
quote); `NEW` is the replacement. `+` blocks are pure insertions at the stated
anchor. Accepted section numbers are **never renumbered**: new material is
appended as §16/§17/§18.

---

## A. Summary of required changes

| # | Destination | Kind | Normative text |
|---|---|---|---|
| S19-1 | §1 "Scope and ownership" | insert bullets | [`../delivery.md`](../delivery.md) §§3/5/6/7/8 |
| S19-2 | §2 "Topology and origins" | reword the preview-listener bullet | `../delivery.md` §§4.3/6.2 |
| S19-3 | §3 "IDs and tokens" | insert one row | `../delivery.md` §6 |
| S19-4 | §9 "Gesture preview / commit" | insert snapping rules | `../delivery.md` §11, this file |
| S19-5 | §10.1 "Start" result + new §10.5 | extend result, insert subsection | `../delivery.md` §§3/6/7 |
| S19-6 | §11.3 "Session-layer error codes" | insert rows | `../delivery.md` §§6.2/8.2/10.1 |
| S19-7 | §11.5 "M1 constants" | reword heading + insert rows | `../delivery.md` §11 |
| S19-8 | §13.2 "Page config" | reword (v2 config) | `../delivery.md` §7 |
| S19-9 | §13.5 "Message allowlist" | insert rows + bounds paragraph | `../delivery.md` §7 |
| S19-10 | §13.7 "Development / deployment origin configuration" | insert config rows | U-4 disposition, `../delivery.md` §13 |
| S19-11 | **new §16** "Authenticated committed asset-byte reads (authoring scope)" | insert section | `../delivery.md` §§5/15 |
| S19-12 | **new §17** "Immutable play-content locator and format-aware delivery" | insert section | `../delivery.md` §§2/6/7 |
| S19-13 | **new §18** "Bounded input-exercise relay (MCP)" | insert section | `../delivery.md` §8 |
| S19-14 | §15 "Change rules" | insert bullets | this file |

Not changed: §4's token/origin/WS-upgrade shapes, §5's session lifecycle, §6's
command/query transport, §7's WS event catalog (the v2 messages are **bridge**
messages, §13.5 — no new WS event), §8's projection, §11.1/§11.2/§11.4/§11.6,
§12's screenshot/diagnostics relay, §13.1/§13.3/§13.4/§13.6, §14's non-goals
other than the recorded v2 additions below.

---

## B. Existing sections

### S19-1 — §1 "Scope and ownership": insert bullets

Anchor: after the bullet ending `… plus development/deployment origin
configuration (§13.7).`

```diff
+- The **authoring content-byte reads** (new §16) and the **immutable
+  play-content locator** the preview frame loads its artifacts from (new §17).
+- The **versioned bridge (v2)** message set and the bounded **input-exercise
+  relay** for MCP (new §18).
+- The M2 **gesture snapping** increments (this contract's §9 extension).
```

### S19-2 — §2 "Topology and origins": reword the preview-listener bullet

```diff
-- The backend process serves both listeners (one process, process-level
-  deployment — decision 0001 §6). The **preview listener serves only the
-  static preview page** (a small HTML template + the preview bundle). It
-  exposes no API endpoints, no WS, and no authenticated channel: the
-  preview frame's only inputs are the static page, the injected config
-  (§13.2), and bridge messages from the verified authoring origin
-  (§13.3–§13.5).
+- The backend process serves both listeners (one process, process-level
+  deployment — decision 0001 §6). The **preview listener serves the static
+  preview page** (a small HTML template + the preview bundle) **and, in M2,
+  the immutable play-content locator routes of §17** (`/play/…`,
+  `/play-content/<contentId>/…`). It still exposes **no authoring API
+  endpoints, no WS, and no authenticated channel**: the locator routes return
+  only completed immutable artifacts for one play session, carry no authoring
+  credential, and are not an `/api/v1` surface. The preview frame's only
+  inputs are the static page, the injected config (§13.2), the locator
+  artifacts (§17) and bridge messages from the verified authoring origin
+  (§13.3–§13.5).
```

Also extend the credentials bullet:

```diff
+- **The locator identifier is a capability, not a credential, and is redacted
+  in logs** (§17.4). It grants reads of one immutable artifact set only and is
+  excluded from exports (`export.md` §5.4.1).
```

### S19-3 — §3 "IDs and tokens": insert one row

Anchor: after the `relayId` row.

```diff
+| `contentId` | 43-char base64url (32 CSPRNG bytes, no padding: `^[A-Za-z0-9_-]{43}$`) | **server** | one play artifact set; `PLAY_CONTENT_TTL` 900 s (+ 60 s grace, §17.3) |
```

and one bullet after the `playSessionId` bullet:

```diff
+- `contentId` appears in the preview URL query (`?content=<id>`, §13.2) and in
+  the play-start result (§10.1). It is a **bearer capability** for immutable
+  reads only: it is never logged verbatim (§17.4), never accepted as an
+  authoring credential, and never included in an export.
```

### S19-4 — §9 "Gesture preview / commit (normative)": insert snapping rules

Anchor: after the existing `Cancellation` bullet (the last bullet of §9).

```diff
+**Snapping (M2, local preview only; normative).** Snapping is applied to the
+local preview transform only; it changes no server message and adds no command:
+
+| Aspect | Rule |
+|---|---|
+| Translate | increment `SNAP_TRANSLATE_M = 0.25 m`, independently per world axis in the scene's Y-up/right-handed metre space (project-model §2); the **gesture delta** is snapped, not the absolute position, so repeated moves do not accumulate drift |
+| Rotate | increment `SNAP_ROTATE_DEG = 15°` about the gizmo axis; the accumulated gesture angle is snapped, the quaternion is rebuilt from the snapped angle and re-normalized (project-model §12.2 quaternion rule) |
+| Scale | increment `SNAP_SCALE = 0.25` on the uniform scale factor; result clamped to `[SCALE_MIN 0.01, SCALE_MAX 100]` (a snap never produces a zero/negative/non-finite scale) |
+| Rounding | `snapped = clamp(round(value / increment) * increment)` with round-half-away-from-zero, then quantized to `1e-4` before it is displayed or committed (the committed value is the quantized value) |
+| Coordinate space | world-space axis-aligned deltas for translate, the gizmo's rotation axis for rotate, the entity's uniform scale for scale; no parent-space or local-space snapping in M2 |
+| Disable for one gesture | holding `Shift` during the gesture disables snapping for that gesture only (local UI state; **no persistent setting, no project field, no localStorage/backend write**) |
+| Commands | **zero** commands during the drag; snapping never changes the number of commands; on release **exactly one** `setTransform` carrying the snapped, quantized final values with `expectedRevision = baseRevision`; on cancel **none** |
+| Conflict | unchanged §9: at most one automatic re-issue, then the conflict is surfaced; a snapped value is never silently re-snapped or re-rounded on re-issue |
+
+`SNAP_TRANSLATE_M`, `SNAP_ROTATE_DEG`, `SNAP_SCALE`, `SCALE_MIN`, `SCALE_MAX`
+and the `1e-4` quantum are fixed M2 constants (acceptance A08 and the packet-27
+tests reference their exact values); there is no snapping setting in the
+project document, in the backend configuration or in `localStorage`. Snapping
+is a gesture option, never a second authority: nothing about it is observable
+to other clients before the single release commit.
```

### S19-5 — §10.1 "Start" result + new §10.5

**(a)** Extend the success result (after the existing `expiresAt` field):

```diff
 { "ok": true, "playSessionId": "play-…", "playBase": "http://127.0.0.1:8502/",
   "snapshotId": "demo-0001@r12", "revision": 12, "demo": true, "expiresAt": "…" }
```

becomes

```diff
 { "ok": true, "playSessionId": "play-…", "playBase": "http://127.0.0.1:8502/",
   "snapshotId": "demo-0001@r12", "revision": 12, "demo": true, "expiresAt": "…",
   "playContent": { "contentId": "<43-char base64url>", "buildId": "<64 hex>",
     "path": "/play-content/<contentId>/", "manifestPath": "manifest.json",
     "expiresAt": "…" } }
```

and add after the existing §10.1 paragraph that constructs the preview URL:

```diff
+With M2 content the editor builds the iframe `src` from the locator instead:
+`<playBase><path>?play=<playSessionId>&content=<contentId>` (§17.2). Both
+identifiers are quoted from this result; neither is invented client-side.
+`playContent` is present for a snapshot with assets or source-bearing
+behaviors; for an M1-style snapshot it is still present (the locator serves
+the manifest-only artifact set, §12 of `delivery.md`).
```

**(b) new §10.5** — insert after §10.4:

```diff
+### 10.5 Play-content readiness, staleness and failure
+
+- The play record gains one derived field: `buildId` (the immutable runtime-
+  content manifest's `buildId`, `delivery.md` §2). It is fixed at start with
+  `revision`/`snapshotId` and never changes for the play session (§10.2's
+  freeze rule).
+- **Ready is truthful:** `presented` (the existing `play.preview.ready` ack)
+  is sent only after the preview confirms the manifest `buildId`, all declared
+  asset reads and the physics initialization and the runtime instantiation
+  (`delivery.md` §7). A load that is still running or that failed never
+  produces `presented`; the failure carries the load phase.
+- **Stale capture/build:** a play whose captured `snapshotId`/`buildId` no
+  longer matches the requested one (e.g. a reload against a newer play) is
+  reported as stale, never silently served: unknown/stopped ⇒
+  `play_locator_invalid`, expired ⇒ `play_locator_expired`, build missing ⇒
+  `play_build_unavailable` (§17.2).
+- **Cancellation:** a stop requested while the preview is still loading takes
+  the existing §10.3 stop path; the preview must abort in-flight artifact
+  reads and dispose and the backend must not report `presented` afterwards.
+- **No binary in WS:** neither the full-state frame nor `play.started`,
+  `mutation.applied` or `change` carries GLB bytes, compiled behavior bytes or
+  source text; the preview loads them from the locator (§7 of `delivery.md`).
```

### S19-6 — §11.3 "Session-layer error codes": insert rows

Anchor: after the `relay_failed` row.

```diff
+| `play_locator_invalid` | not_found | — | malformed/unpaired `contentId`/`playSessionId` on a locator route (§17.2) |
+| `play_locator_expired` | unavailable | `expiresAt` | the locator TTL elapsed (§17.3) |
+| `play_content_not_ready` | conflict | `phase` | the artifact set is not complete / a load phase failed (§10.5, §17.2) |
+| `play_build_unavailable` | unavailable | `reason`, `snapshotId` | no successful build for the requested `buildId` (build failure preserves the previous artifact, `delivery.md` §2.2) |
+| `content_frame_invalid` | validation | `path`, `found`/`expected` | malformed binary upload frame (bad `X-Thirdlight-Offset`, wrong total, truncated frame) |
+| `job_not_found` | not_found | `jobId` | an unknown content job (§15 of `delivery.md`) |
+| `job_expired` | unavailable | `jobId` | a late/expired job result |
+| `input_relay_conflict` | conflict | `playSessionId` | a relay while physical input is engaged / a second relay (§18.3) |
+| `input_relay_limits_exceeded` | validation | `limit`, `found` | relay frames/body over a bound (§18.1) |
+| `input_relay_timeout` | unavailable | `requestId` | no `tl.input.result` within 10 s (§18.3) |
+| `scan_forbidden_content` | internal | `hits` (≤ 4) | a format-aware scan found forbidden content in a built artifact (`delivery.md` §4.4) |
```

Add one line under the table:

```diff
+`blob_missing`, `blob_corrupt`, `path_rejected`, `stage_not_found`,
+`stage_expired`, `stage_limits_exceeded` and `import_rejected` are the accepted
+workspace/content-storage codes surfaced unchanged by the new routes
+(`import_rejected` with cls `validation`, HTTP 400). Two accepted §11.3 status
+exceptions are restated, not changed: `unauthorized` ⇒ 401 (§4.1) and
+`bad_origin` ⇒ 403 (§4.2); every other code keeps the §11.2 class mapping.
```

### S19-7 — §11.5 "M1 constants (normative)": reword + insert rows

```diff
-### 11.5 M1 constants (normative)
+### 11.5 Constants (normative; M1 rows unchanged, M2 rows added)
```

Insert at the end of the table:

```diff
+| `PLAY_CONTENT_TTL` / `PLAY_CONTENT_GRACE` | 900 s / 60 s |
+| `contentId` length | 43 base64url chars (32 CSPRNG bytes) |
+| play artifact set cap / single artifact cap | 512 MiB / 32 MiB |
+| asset byte-read response cap | 32 MiB |
+| upload frame cap / stage cap | 1 MiB / 32 MiB |
+| input relay max frames / max body / ack timeout | 600 / 16 KiB / 10 s |
+| bridge v2 message cap (non-snapshot) / `tl.load.progress` cap | 64 KiB / 1 KiB |
+| manifest document cap | 256 KiB |
```

### S19-8 — §13.2 "Page config (the only dynamic content)": reword

````diff
-The preview HTML (a backend-served template) injects exactly:
-
-```js
-window.__thirdlightPreview = { v: 1, authoringOrigin: "<O_A exact>" };
-```
+The preview HTML (a backend-served template) injects exactly:
+
+```js
+window.__thirdlightPreview = {
+  v: 2,
+  authoringOrigin: "<O_A exact>",
+  playSessionId: "<from ?play=>",
+  contentId: "<from ?content=>",
+  manifestPath: "./manifest.json"
+};
+```

-plus the static bundle script tag (`./preview.js`, relative). **No tokens,
-no API URLs, no credentials** in the page or the bundle (packet 10
-verifies). `authoringOrigin` is configuration, not a secret. The preview
-reads the expected `playSessionId` from its own `?play=` query at load; a
-missing/unrecognized parameter ⇒ the preview shows a static "no active
-play" notice and processes no bridge messages.
+plus the static bundle script tag (`./preview.js`, relative). **No tokens,
+no API URLs, no credentials** in the page or the bundle (packet 10
+verifies). `authoringOrigin` is configuration, not a secret; `contentId` is a
+read-only artifact capability and is redacted in logs (§17.4). The preview
+reads the expected `playSessionId`/`contentId` from its own URL query at load;
+a missing/unrecognized parameter, or a URL whose `contentId` does not match
+the served shell, ⇒ the preview shows a static "no active play" notice and
+processes no bridge messages (it never falls back to another locator).
````

### S19-9 — §13.5 "Message allowlist": additions

**(a)** Reword the discriminator sentence:

```diff
-All messages are strict JSON with `v: 1` (the M1 discriminator); unknown
+All messages are strict JSON with `v: 2` (the M2 bridge discriminator); a
+`v: 1` message from an M2 preview is rejected exactly like an unknown field.
+Unknown
```

**(b)** Insert rows into the two tables:

```diff
 | `tl.handshake` | `v, playSessionId, nonce, demo (bool)` |
+| `tl.handshake` (v2) | `v, bridgeVersion: 2, playSessionId, nonce, demo, contentId, buildId` |
 | `tl.snapshot` | `v, playSessionId, nonce, snapshot (runtime.md §2 document)` |
+| `tl.playContent.expect` | `v, playSessionId, contentId, buildId` |
+| `tl.input.request` | `v, playSessionId, requestId, frames (1–600 ActionFrame values, ascending stepOffset)` |
 | `tl.play.stop` | `v, playSessionId` |
```

```diff
 | `tl.ready` | `v, playSessionId, snapshotId, revision` |
+| `tl.ready` (v2) | `v, playSessionId, snapshotId, revision, buildId, contentDigest, stepIndex` |
+| `tl.load.progress` | `v, playSessionId, phase ∈ {shell, manifest, assets, behaviors, runtime}, loadedBytes, totalBytes` |
+| `tl.input.result` | `v, playSessionId, requestId, ok, appliedFromStep?, appliedToStep?, error?` |
 | `tl.stopped` | `v, playSessionId` |
@@
-| `tl.error` | `v, playSessionId, code (a runtime.md code), message? (≤ 256)` |
+| `tl.error` | `v, playSessionId, code (a runtime.md code or a §11.3 delivery code), phase?, message? (≤ 256)` |
```

**(c)** Insert the payload-bounds paragraph:

```diff
+**Payload bounds (v2).** Every bridge message is ≤ 64 KiB except
+`tl.snapshot` (≤ 1 MiB, unchanged) and `tl.screenshot.result` (≤ 1.5 MiB,
+unchanged); `tl.load.progress` ≤ 1 KiB; `tl.input.request` ≤ 16 KiB with ≤ 600
+frames. **No message carries GLB bytes, compiled behavior output bytes or
+source text**, and no bridge message is a second mutation or storage path
+(`delivery.md` §7). A `tl.snapshot` for a content-bearing snapshot references
+assets by `assetId`/version only.
```

### S19-10 — §13.7 "Development / deployment origin configuration": insert config rows

This is the **U-4 acceptance diff** (`engineRoot`; Gate C CF-2). Add after the
`exportRoot` line:

```diff
+engineRoot:       /home/dadmin/projects/thirdlight   # optional; engine tree (packages/ + node_modules/)
+# env: THIRDLIGHT_ENGINE_ROOT (executable entry, packet 13)
```

and a bullet:

```diff
+- **`engineRoot` (optional, U-4 ACCEPT — owner pre-approval (autonomous M2
+  build instruction, 2026-09-18); final manual review pending).** The export
+  route uses it for output-target containment and the export.md §5.4.1
+  reference-build identity paths. Absent/empty ⇒ the export route fails closed
+  with a structured `unavailable` result; no other route reads it, and no
+  M1 behavior changes.
```

### S19-14 — §15 "Change rules": insert bullets

```diff
+- Adding a locator route, changing `PLAY_CONTENT_TTL`/the locator's read-only
+  scope, weakening the no-listing/no-traversal/redaction rules, changing a
+  bridge message or its bound, or changing a snapping constant is a reviewed
+  contract diff (facts and fixtures reference their exact values).
+- The v2 bridge discriminator (`v: 2`) and the new messages require the
+  `protocol` package's strict validators in the same review (the
+  exhaustive-catalog rule: a message not in §13.5 is invalid by definition).
+- The input relay is **not** a command path and must never mutate authoring
+  state; giving it write authority is a contract change, not a feature.
```

---

## C. New sections

### S19-11 — new §16 "Authenticated committed asset-byte reads (authoring scope)"

Insert after §15. Normative text, verbatim:

| Destination subsection | Text source |
|---|---|
| §16.1 Route, origin and authentication | `../delivery.md` §5 |
| §16.2 Immutable-version addressing and resolution | `../delivery.md` §5 |
| §16.3 Response, integrity and bounds | `../delivery.md` §5/§11 |
| §16.4 The renderer receives no authoring token | `../delivery.md` §5 |
| §16.5 Failure mapping | `../delivery.md` §§5/10.1 (N1–N6) |

### S19-12 — new §17 "Immutable play-content locator and format-aware delivery"

Insert after §16. Normative text, verbatim:

| Destination subsection | Text source |
|---|---|
| §17.1 The immutable runtime-content manifest and snapshot capture | `../delivery.md` §§2/3 |
| §17.2 Locator routes, shape and error mapping | `../delivery.md` §§6.1/6.2 |
| §17.3 Lifetime, cache behavior and cleanup | `../delivery.md` §§6.3/6.4 |
| §17.4 Capability handling, redaction and exclusions | `../delivery.md` §6.3 |
| §17.5 Format-aware resource validation and the fetch policy | `../delivery.md` §4.3/§4.4 |
| §17.6 Readiness and load failure | `../delivery.md` §7, this file §10.5 |

### S19-13 — new §18 "Bounded input-exercise relay (MCP)"

Insert after §17. Normative text, verbatim:

| Destination subsection | Text source |
|---|---|
| §18.1 Route, request shape and bounds | `../delivery.md` §8.1 |
| §18.2 Result and step-range provenance | `../delivery.md` §8.2 |
| §18.3 Exclusive test-input mode and clearing | `../delivery.md` §8.2 |
| §18.4 Failure mapping and no-browser rule | `../delivery.md` §8.2/§10.1 (N14–N17) |

---

## D. Explicitly not changed

- §4.1/§4.2/§4.3 token scopes, origin allowlist and WS-upgrade auth.
- §5.1–§5.3 session establish/re-attach, WS channel, bookkeeping.
- §6.1–§6.3 commands/queries/operator operations.
- §7's WS event catalog (M2 adds bridge messages, not WS events).
- §8's projection/resync/gap rule.
- §9's conflict/re-issue semantics other than the additive snapping rules.
- §10.2's state machine, §10.3's stop sequence, §10.4's routing and no-browser
  rule (the relay reuses it).
- §11.1's log ring, §11.2's error shape/status mapping, §11.4's listing/log,
  §11.6's boundedness argument.
- §12's screenshot/diagnostics relay chain.
- §13.1/§13.3/§13.4's isolation, origin/source checks and handshake sequence.
- §14's M1 non-goals (the M2 additions are recorded in §17/§18, not by weakening
  an M1 statement).
