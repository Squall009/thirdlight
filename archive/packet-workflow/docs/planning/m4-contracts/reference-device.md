# M4 reference-device record and measurement route (packet 63)

Packet 63 establishes the **measurement route** and records the proposed
reference device. It does **not** measure on representative hardware (none is
available in this container) and does not invent thresholds: unmeasured
thresholds stay explicitly blocked (67-B rule: “Q accepts only the protocol
and explicitly defers 67-B's numerical table” when hardware is unavailable).

## 1. What this environment can and cannot measure (recorded 2026-09-22)

| capability | state in this container | consequence |
|---|---|---|
| WebGL2 | **SwiftShader** (software rasterizer) via headless Chrome for Testing 151 (`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE))`) | no GPU/frame-time/heap/VRAM measurement; canvas-identity motion rows are UNVERIFIED (motion is instead evidenced via runtime interpolated-state deltas — Phase B B04). **SwiftShader evidence is never a hardware-GPU claim.** |
| Display | headless, no physical display | no perceptual/presentation measurement |
| Keyboard | no physical device | as-shipped keyboard path probed via CDP synthetic keys only; D-63-2 (canvas not focusable) captured regardless |
| Gamepad | absent | input.md §5 gamepad degradation UNVERIFIED |
| Audio | no output device; autoplay blocked pre-gesture by contract (B05) | audibility UNVERIFIED (owner annex) |
| Network | loopback only (backend + preview on 127.0.0.1) | no representative cold-network load |
| CPU | shared container (no throttling control, no clock-resolution guarantee) | timing samples here are baseline **samples**, not budget data (recorded in `baseline.md`) |

## 2. Proposed reference device (owner decision item)

The owner must choose/confirm the reference desktop (or target) before 67-B's
numerical table and before any scored 79 run (ratification checkpoint:
`docs/handoffs/67-budget-ratification.md` — “no scored run until target
review/promotion and owner confirmation”). Proposed minimum, for the plan
§2.6 budget route:

- **Class:** consumer desktop (or laptop with dedicated GPU), x86-64,
  Linux or Windows; physical display ≥ 1080p at 60 Hz.
- **GPU:** discrete or integrated GPU with a real (non-SwiftShader) WebGL2
  path; `GL_RENDERER` string recorded in the run evidence (unsupported/
  software GPUs invalidate a scored run — 79 failure mode “unsupported GPU
  query”).
- **CPU/RAM:** ≥ 4 cores / ≥ 8 GB, with CPU throttling disabled or recorded.
- **Input:** physical keyboard (and, for gamepad rows, one USB/Bluetooth
  gamepad).
- **Audio:** at least one output device (audibility rows).
- **Access:** the operator session runs the real browser (not headless
  software GL), the backend on loopback, with the recorded content/engine
  pins of packet 76's independent game.
- **Observability:** observers, clock resolution, and cache/network
  conditions recorded per 79 (warm-cache-only claims are a failure mode).

**Status:** proposed — awaiting owner decision. Until confirmed, 67-B freezes
at the **protocol only** at Gate Q (named device/scene/protocol + thresholds
as placeholders marked *blocked, unmeasured*), and 79 may run only its
candidate-assembly preflight (no scored run).

## 3. Exactly which branches are blocked (and which proceed)

- **Blocked until the owner device exists:** 67-B's numerical threshold
  table; 79's scored desktop budget/lifecycle/soak measurements (C11/C13
  hardware legs); any performance PASS/FAIL verdict.
- **Proceed (not hardware-dependent):** all correctness/contract rows (A/B/C
  phases of packet 63; 64–78 functional work). Gate Q records that
  independent non-performance work proceeds while 67-B awaits hardware
  (67 boundary).
- **C11 (audio/presentation on hardware): UNVERIFIED** with this record as
  the exact missing prerequisites (owner device + display + audio output).
  Packet 80 then takes only the no-change/evidence-pending path (79 rule).

## 4. Timing-sample caveat (baseline, not budget)

The packet-63 baseline records wall-clock samples (export build, preview
boot, play present timeout at +15 s, SwiftShader canvas capture costs) in
`baseline.md` as **reproducibility samples** of this container. They are not
representative calibration and must not be cited as budget data
(67-B: “Early box-only data is not representative calibration”).