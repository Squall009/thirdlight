# Gate M — adjudication (packets 49–51, M3 campaign)

## 1. Scope & method

Packets 49–51 (gameplay/session, safe respawn, follow camera) reviewed by a
fresh, independent reviewer in three chunks: A — full toolchain re-run
(`/tmp/gate-m-toolchain.txt`); B — code-level verification of the CC-51-1
artefacts and handoff-51 claims (`/tmp/gate-m-findings-1.md`); C — this
adjudication: CC-51-1/CC-51-2 verdicts plus applying the accepted CC-51-2
diff. All numbers cite a chunk A/B artefact or a command run here (C-ran).
No commits; HEAD `5b746ee…` throughout.

## 2. Toolchain re-run (chunk A)

| Command | Exit | Result |
|---|---|---|
| npm test | 0 | 154 files / 1921 tests (A; count re-verified fresh, B §7) |
| typecheck / check-deps / check-boundaries / build | 0 | 16 packages; all exact versions; 304 files / 1188 specifiers, 0 violations; 4 built / 0 skipped |
| M2 six checkers | 0 | contracts 34/34; input, course (9), runtime, behaviors, physics all green |
| M3 gameplay | 0 | 23 groups / 127 checks (A; re-run C post-CC) |
| M3 contracts / media / delivery / storage | 0 | 39 groups; 13/115 + control 9/9; 16/153 + both rejected; 9/10 + 6/6 (A exits; counts from 51's table) |
| check-audit clean (pre-CC-51-2) | 1 | the single expected `[codes]` failure naming exactly four reasons (C-ran; A) |
| check-audit --corrupt-control (pre-CC-51-2) | 1 | control itself PASSES — all three corruptions rejected; exit 1 per the line-600 rule requiring a green clean tree (A; 51's note) |
| check-promotion (+ control) | 0 | all checks; every removal detected |
| media generate --check | 0 | 65 files reproduce exactly |

## 3. Findings (chunk B)

- **CC-51-1 artefacts (B §1, PASS):** checker re-derives with `doc.cameraId`
  (L893; no `c.cameraId` remains); the five repaired expects name each case's
  own violated condition; digest 4768 B / `1ff2e681…` matches `wc -c`/
  `sha256sum`; corrupt-control claim reproduced by a real /tmp-copy run
  (`TL40_FIXTURE_ROOT`): exit 1, 4 FAIL lines, repo untouched.
- **Runtime cross-check (B §2, PASS):** every case checked against the real
  M3 validation in `runtime.ts` (scene_version L584, game_config L593,
  gameplay_module L603, camera_owner L613/623/951, camera_follow L636); one
  violated condition per case, so ordering is immaterial. Note:
  `camera_follow` is a presence check (gameplay.md §3.4); not pinned by a
  real-runtime test.
- **Module boundary (B §3, PASS):** types-only `@thirdlight/runtime` import;
  four §7.1 constants in-package; no Node/DOM/three/clock access.
- **Physics identity (B §4, PASS):** the separate `resize physics identity`
  test: committed 1500-step player trajectory byte-identical across a resize
  (strict element-wise `Object.is`).
- **Scope (B §5, FAIL packet 51 only):** three disclosed files outside 51's
  may-edit set — the CC-51-1 checker (intrinsic to the CC) plus two
  stub→real camera test files. Packets 49/50 in scope (49's package-lock note
  is mechanical).
- **Ground rules (B §6, PASS):** HEAD `5b746ee…`, no campaign commits, zero
  camera PNGs, browser rows honestly UNVERIFIED, no approval claims in 51.md.
- **Discrepancies:** the may-edit deviation (resolved in §4) and the
  corrected exit-code note for `check-audit --corrupt-control` (51's table
  fixed pre-gate: exit 1 while the clean tree is red).

## 4. CC-51-1 verdict — ACCEPT

The defect is real (case-level `c.cameraId`, always `undefined`, masked the
later §3.4 checks); the repair aligns the fixture with the runtime's
documented behaviour (runtime.md lines 1040–1049, read directly) and changes
no accepted contract's meaning. Artefacts mutually consistent and
cross-checked against real code paths (B §1–2); the negative control was
reproduced by a real run (exit 1).

Adjudicated scope-diff wording: in addition to the CC-51-1 core (checker,
five expects, index digest), the adjudicated CC scope covers the two
disclosed test files: (1) `tests/m3-respawn/respawn.test.ts` — stub→real
camera module with zero assertion changes to player/respawn behaviour
(C-ran: `platformerGameCameraSpec` at L50/L225; header retains the packet-50
R1–R7 description with the packet-51 camera note); (2)
`tests/m3-gameplay/course.test.ts` — camera asserts rewritten to real-module
semantics (C-ran: real spec composed; asserts track the real
clamp/dead-zone behaviour). These replace the stubs packet 50 disclosed as
owned by 51; no further scope expansion is granted.

## 5. CC-51-2 verdict — ACCEPT (applied)

The four strings are the runtime's actual `config_invalid` reasons,
documented verbatim in runtime.md's M3 supersession block (lines 1040–1049).
The `[codes]` group exists so no fixture invents or silently coerces a
reason; the repaired owner.json declares exactly what the runtime emits —
my own pre-apply run (C-ran) names exactly these four reasons and no others.

Applied diff — `fixtures/m3/audit/index.json`, `reasonAllowlist` tail:
before: `"rotation", "frame-ancestors is ignored in a meta policy and the
export is not framed" ],` → after: `"rotation", "frame-ancestors is ignored
in a meta policy and the export is not framed", "gameplay_module",
"scene_version", "game_config", "camera_follow" ],`

Post-apply (all C-ran): check-audit **exit 0**, 8/8 groups "all checks
passed" (was 7/8, exit 1); --corrupt-control **exit 0**, all three
corruptions rejected (each control exit 1 as expected), line-600's
green-tree requirement now met; check-promotion **exit 0**, 5 groups / 110
markers, unchanged; gameplay check-fixtures **exit 0**, 23 groups / 127
checks.

## 6. Gate M verdict — ACCEPTED (with the CC-51-1 and CC-51-2 diffs applied)

The single FAIL (B §5 scope) is resolved by §4's scope wording: the files
are disclosed, minimal, functionally inseparable from the CC. Rejection
would have required reverting the two test files to the stubs and a separate
CC — unnecessary given the packet-50 disclosure and the zero-assertion-change
(respawn) / semantics-preserving (course) replacements.

## 7. Next

Packet 52 — shared light, shadow and primitive-material rendering. Do not
start it; it is a separate, separately-assigned task.

Gate M reviewer (fresh, independent re-run), 2026-09-20