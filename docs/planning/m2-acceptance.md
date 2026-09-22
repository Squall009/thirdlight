# M2 acceptance plan

**DRAFT — proposed evidence requirements, not test results.**
Plan: [m2-plan.md](m2-plan.md). Packets: [m2-packets.md](m2-packets.md).
Every row below is currently **PENDING / NOT RUN**. No M2 feature is implemented
or accepted by creating this document.

## 1. Test project and evidence rules

Use a disposable `m2-course` project, never the owner's game data. The committed,
self-generated or redistribution-cleared fixture set contains:

- a tiny self-contained GLB with distinguishable geometry, at least two materials
  and one previewable animation clip;
- a second version that changes geometry/material/clip ordering, retaining the
  same whole-model asset identity (no persistent subresource identity promise);
- malformed, external-URI, unsupported-extension and resource-limit GLBs;
- a prefab subtree with an internal entity reference and a typed behavior property;
- a static XY course: floor, wall, ceiling, seam, ledge, climbable and too-steep
  convex ramps, one upright character and a fixed camera looking toward -Z;
- a tiny trusted TypeScript behavior with a visible/measurable declared property,
  plus compile-error, forbidden-import and throwing-behavior fixtures;
- a complete valid M1 source project used only for original-preserving migration-copy.

Gate E fixes all tolerances/defaults, fixture sizes, input step sequences, sample
counts and numerical limits. Later tests reference those accepted fixtures; they
do not choose easier thresholds after observing failures. Performance claims name
hardware/browser/resolution/load and distinguish CPU measurements from GPU timing.
This milestone does not establish M4 whole-product frame budgets.

Real-browser evidence can be manual on the owner's desktop or separately approved
automation. **Keyboard and a physical gamepad are both required**. Record browser,
OS, device/mapping, secure-context status and preview iframe permissions. A synthetic
input trace complements but cannot replace physical device evidence. Use an actual
WebGL context and capture real PNGs, not a protocol stub's placeholder image.

**Packet-19 refinement (visible; no outcome weakened).** The Gate-E-fixed
constants the packets 15–19 proposals pinned are recorded in §5 below, together
with the evidence artifact names each row should cite. §5 only *adds* exact
values and artifact names; it does not relax any row, and any row that needed
narrowing would be marked there as an explicit scope-change request instead.

Store sanitized commands, assertions, hashes, screenshots and console/network
captures under `docs/acceptance/evidence-m2/<packet>/`, with a small manifest linking
each claim to its artifact. Include content/toolchain versions and relevant
project/revision/snapshot/build/play IDs. Redact real credentials and play-content
capability URLs. Long raw artifacts may have a documented durable location/hash;
ephemeral `/tmp` paths alone are not sufficient gate evidence.

## 2. Acceptance matrix

| ID | Scenario and expected observation | Primary packets / gate | Required evidence |
|---|---|---|---|
| A01 | M1 opens/edits/exports unchanged; explicit M2 migration-copy succeeds without altering source bytes; unknown/malformed versions fail without rewrite | 20/23/37 — F/J | v1 fixture regression; original-tree hashes; interrupted-copy fault tests; new project IDs/revision documented |
| A02 | Import supported GLB, inspect model/materials and play/pause/scrub clip, place two instances | 24–27 — F/G | Real files + real browser images; import recipe/source hashes; no unintended network requests |
| A03 | Reimport under same assetId; both placements keep entity IDs/transforms and use new visual; undo restores old version; reorder of internal names/indices does not create false persistent references | 23–27 — F/G | Before/after catalog/envelope hashes, browser images, undo/redo results |
| A04 | Bad GLB/remote URI/required extension/decoded-resource limit is rejected; previous catalog, scene and acknowledged revision unchanged | 24/25/27 — F/G | Adversarial fixture outputs; on-disk byte comparisons; actionable UI error |
| A05 | Capture prefab; instantiate twice with one legal initial property override; internal refs remapped, copies independent; delete/undo/redo/retry restores exact IDs | 22/25/28 — F/G | Pure mapping fixtures, real backend/SDK retry test, browser/reopen walkthrough |
| A06 | Reject nested prefab/camera capture/external reference/unknown override/scene overflow atomically | 22/25 — F | Invalid-result fixtures and unchanged durable state |
| A07 | Edit typed component/properties in inspector and MCP; stale mutation rejected; notifications converge without reload | 21/25/28 — F/G | Actual SDK calls + WS/projection capture + real browser paint; property type/default/error assertions |
| A08 | Translation/rotation/scale snapping previews locally; one commit and undo on release, none on cancellation | 27 — G | Browser network recording, gesture tests and one-revision assertions |
| A09 | Kill disposable writer before/after blob/envelope publication; after takeover/reopen, acknowledgements and retry results match durable references; expired stage does not break recorded replay | 23/37 — F/J | Real subprocess SIGKILL/fault tests, envelope/blob hashes, takeover and replay outputs |
| A10 | Concurrent/stale import never overwrites newer work; missing source fails closed; derived cache deletion is recoverable; source tampering is detected; source backup/restore retains playable content | 23/24/33/37 — F/I/J | Concurrent command results, tamper/cache tests and restored disposable project |
| A11 | Keyboard/gamepad actions obey focus, dead zone, simultaneous source, pressed/held/released and hot disconnect rules; insecure/denied API yields actionable unavailable state | 14/30/35 — E/H/I | Real hardware/browser report and pure exact action-frame traces; iframe policy verification |
| A12 | Character walks/stops/jumps; coyote/buffer/release behavior matches fixed-step windows; no extra air jump; wall/head/ledge/seam/steep-slope behavior matches contract; no Z drift | 31/32 — H | Real physics numerical traces and keyboard + controller browser course recordings |
| A13 | Long stall executes ≤8 steps then drops remaining wall time; jump edge consumed once; no phantom physics step, duplicate loop or snapshot write-back | 29–32 — H | Clock-injected traces and real tab-resume check; before/after authored hashes |
| A14 | Throw after physics/private-state mutation fail-stops whole runtime; only last completed state renders; corrupted state cannot resume; fresh instance works | 29/31/34 — H/I | Fault-injection traces, lifecycle diagnostics, cleanup assertions |
| A15 | Stage declared property/source, validate/compile without server execution, atomically publish successful prepared result, run trusted behavior; property changes visibly affect fresh play; staged source edits do not change active play | 33–35 — I | Compiler graph, publish revisions/digests, actual preview behavior and before/after source/snapshot hashes |
| A16 | Forbidden source imports/eval, compile failure and invalid declaration/intents reject safely; runtime exception/log flood is bounded; trust warning explicitly states no hard main-thread timeout | 18/33–35 — E/I | Negative build probes, old-artifact byte comparison, runtime diagnostics and UI evidence; no hostile-code safety claim |
| A17 | Play freezes scene/assets/code; reimport or source publish while playing leaves current play unchanged; reload uses same pins, fresh Play uses new ones | 35 — I | Revision/content/build hashes, two browser captures, reload/new-start logs |
| A18 | Origin/source/nonce/auth/path/expiry attacks fail; preview has no authoring token, no general project reads; cancelled/failed load never reports ready | 25/35 — F/I | Actual HTTP/WS/bridge negative tests, bundle scan and browser network/console capture |
| A19 | Real MCP bounded action sequence targets explicit presented session, identifies applied steps and snapshot, then clears injected state; real screenshot works; no-browser is structured unavailable | 35/37 — I/J | Actual SDK client, real rendered PNG and step/relay logs; no synthetic screenshot substitution |
| A20 | Repeated play/stop/reload cancels pending loads, releases input/physics/script/GPU resources and installs one loop; failure has actionable diagnostics | 26/29–35 — G/H/I | Resource/listener counters with stated limits, browser console and lifecycle traces |
| A21 | Export complete content closure; backend stopped/unreachable; keyboard and physical gamepad traverse course from independent static server at a non-root URL path | 36/37 — I/J | Real browser walkthrough, network log with only relative artifact reads, console/render-backend report and server process evidence |
| A22 | Play/export share module sources/build identities; same action sequence matches state trace within approved tolerance; repeated same-input exports differ only by the contracted capture-second-dependent timestamp (`capturedAt`/`buildId`; C36-7 accepted with diff, Gate I) | 36 — I | Graph/metadata comparison, numerical trace diff and byte-tree/hash diff |
| A23 | Missing asset/source/module, forbidden graph/resource locator or write fault fails export without replacing good output; cold first build repeatedly exercised | 33/36 — I | Actual deployed-process tests, negative scans and prior output hashes; M1 U-2 status, no guessed root cause |
| A24 | Clean install, strict types, package/bundle boundaries and credential scans pass; M1 regressions pass; deployment/source-backup/trust/gamepad topology documented | 37 — J | Actual commands/results and dependency pins; configuration supplied vs performed distinguished |

## 3. Integrated user journey (packet 37)

Run the matrix's failure probes plus this complete non-mocked journey:

1. Create a disposable M2 project (and separately perform A01 migration-copy).
2. In the browser import and inspect GLB v1, place it, capture a prefab and create
   a second copy with an explicit property override. Reopen and verify persistence.
3. Snap/edit/undo/redo. Use actual MCP to make a visible typed property change;
   submit a stale command and verify conflict, not overwrite.
4. Reimport GLB v2; verify stable whole-model references. Reject a malformed
   replacement and undo/redo the successful reimport.
5. Configure the character/test course through supported commands/inspector.
   Stage a small trusted behavior, inspect/fix compile errors, then publish only
   the successfully validated/compiled source and declaration.
6. Start production isolated Play. Traverse the course with keyboard, then physical
   gamepad; test blur/disconnect, slope/jump cases, diagnostics and a real screenshot.
7. Publish a source/property/asset change during play; prove the running content
   remains pinned and fresh Play adopts the new revision. Exercise bounded MCP input
   and repeated stop/reload/dispose.
8. Restart the disposable backend, explicitly resolve stale ownership as required,
   reconnect and verify persisted state and lost-ack retry. Restore from a source
   backup and prove the same captured content remains available.
9. Export twice; compare outputs, serve independently under a subpath with backend
   unavailable, then repeat keyboard/gamepad traversal and bounded trace comparison.
10. Produce `docs/acceptance/m2-report.md`, mapping A01–A24 to exact evidence,
    failures/unverified cases and U-1…U-5 dispositions. Bring to Gate J review.

## 4. Acceptance rule

M2 is complete only after Gate J accepts the integrated evidence. Unit tests alone,
protocol stubs, synthetic controller frames or a working primitive demo do not
establish GLB/gamepad/script/export acceptance. Missing physical-controller or real
browser evidence leaves relevant rows **UNVERIFIED and milestone acceptance pending**.
Do not reduce criteria to match the available container environment. Record an
explicit scope-change request if the owner chooses a different target.

After acceptance: stop. M3 is a separately requested planning task, not an automatic
continuation or an excuse to implement hazards/camera/HUD inside M2.

## 5. Gate-E-fixed constants and evidence artifact names (packet-19 refinement)

**Refinement only — no promised outcome is weakened or narrowed.** Every value
below was fixed by an M2 proposal (`docs/planning/m2-contracts/**`); later tests
reference these exact values and must not choose easier thresholds after
observing failures. Where a row's scenario could not be met, the correct output
is an explicit scope-change request, not a lowered threshold; no such request is
recorded by packet 19.

### 5.1 Content, assets and storage (A02–A06, A09, A10)

| Constant | Value | Source |
|---|---|---|
| upload frame / stage / source cap | 1 MiB / 32 MiB / 32 MiB | `content-storage.md` §9 |
| content block / manifest document cap | 1 MiB / 256 KiB | `content-storage.md` §9, `delivery.md` §3 |
| catalog caps | 128 assets, 32 versions/asset, 1 024 version records | `content-storage.md` §9 |
| open stages / staged bytes per project / stage TTL | 8 / 128 MiB / 3 600 s | `content-storage.md` §9 |
| project quota / free-space headroom | 512 MiB / blob + 64 MiB | `content-storage.md` §9 |
| inspection / publish job timeout | 30 s / 120 s | `content-storage.md` §9 |
| fixture sample sizes | the tiny GLB, its v2 reorder, the malformed/URI/extension/limit set | `m2-acceptance.md` §1 |
| evidence artifacts | `docs/acceptance/evidence-m2/23..25/**`, `.../37/**`; fixture hashes under `fixtures/m2/contracts/{envelope,cases}/**` and `expected.json` | this plan |

### 5.2 Runtime, input and 2.5D physics (A11–A14)

| Constant | Value | Source |
|---|---|---|
| fixed step / catch-up cap | 120 Hz / 8 steps | `runtime.md` §5 (unchanged) |
| settle pre-roll | 12 steps | `platformer.md` §6 |
| action quantization / dead zone | 1e-4 / 0.2 | `input.md` §9 |
| keyboard / gamepad defaults | A/D + arrows + Space / standard mapping axis 0, buttons 0/14/15 | `input.md` §4 |
| input step sequences | `fixtures/m2/contracts/input/action-sequences.json` (5 sequences, 15 mapping cases) | packet 17 |
| coyote / jump buffer / release factor | 6 steps / 8 steps / 0.5 | `platformer.md` §7 |
| gravity / run speed / accel / decel | −19.62 m/s² / 4.0 m/s / 40 / 60 | `platformer.md` §7, `physics.md` §7 |
| capsule / skin / ground snap / slope | r 0.3, hh 0.6 / 0.01 / 0.1 / climb ≤ 45°, slide ≥ 30° | `physics.md` §7 |
| numerical traces | `platformer/traces.json`: 16 traces × 178 rows; replay tolerance ±0.05 m | packet 17 |
| CPU sample counts | packet-14 fixture (64 statics, 120 Hz), warmup/sample counts per `evidence-m2/14/**`; labeled container/Node numbers | `m2-plan.md` §2, decision 0002 §1.1 |
| evidence artifacts | `docs/acceptance/evidence-m2/{29..32}/**`, browser/controller logs, `platformer/traces.json` | this plan |

### 5.3 Behaviors (A15, A16)

| Constant | Value | Source |
|---|---|---|
| compiler bounds | files 16 / fileBytes 65 536 / graphBytes 262 144 / importDepth 8 / importsPerFile 16 / diagnostics 32 / timeoutMs 2 000 / outputBytes 131 072 | `behaviors.md` §6 |
| intent/log caps | 5 intents/instance/step, 64/step, 1/entity/axis/step, 32 logs/instance, 16/step | `behaviors.md` §10 |
| source containers | 16 committed containers, SHA-256/lengths recomputed by the checker | packet 18 |
| evidence artifacts | `docs/acceptance/evidence-m2/{33..35}/**`, `behaviors/publication-cases.json`, `compiled-example.json` | this plan |

### 5.4 Delivery, protocol and export (A17–A23)

| Constant | Value | Source |
|---|---|---|
| locator TTL / grace / id bytes | 900 s / 60 s / 32 (43-char base64url) | `delivery.md` §11 |
| artifact set / single artifact / asset read caps | 512 MiB / 32 MiB / 32 MiB | `delivery.md` §11 |
| input relay frames / body / ack timeout | 600 / 16 KiB / 10 s | `delivery.md` §11 |
| bridge v2 non-snapshot / load-progress caps | 64 KiB / 1 KiB | `delivery.md` §11, `sessions.md` §11.5 |
| snapping | 0.25 m / 15° / 0.25, scale ∈ [0.01, 100], quantum 1e-4 | `sessions.md` §9 (S19-4) |
| export fetch policy | declared relative artifacts + one manifest read; M1 reduction = `./manifest.json` | `delivery.md` §4.3 |
| reproducibility comparison | two exports differ only in `meta.json.exportedAt` (and therefore agree on `outputDigest`) | `export.md` §7, E19-9 |
| play/export trace tolerance | the packet-17 physics tolerance (±0.05 m apex; exact step-indexed traces) | `platformer.md` §7 |
| evidence artifacts | `docs/acceptance/evidence-m2/{25,35,36}/**`, `delivery/{protocol-surface,locator-cases,manifest-example,input-relay}.json`, browser network captures, real PNGs, `meta.json` pairs | this plan |

### 5.5 Evidence-name rule (packet-19 refinement)

Each acceptance row's evidence directory is
`docs/acceptance/evidence-m2/<packet>/` with a `manifest.md` mapping claims to
artifacts (packets 14–18 pattern). Packet-19-level evidence lives in
`docs/acceptance/evidence-m2/19/` (checker output + the inventory-consistency
check). No row may cite a mock, a placeholder image or an ephemeral `/tmp` path
as its primary evidence.
