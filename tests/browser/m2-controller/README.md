# Packet 32 — M2 controller browser course (manual, packet-37 procedure)

**Status in this repository: UNVERIFIED.** There is no browser, no WebGL
context and no physical gamepad in the build container, so the browser half of
A12/A13 and every visual/device claim of packet 32 is unverified until a human
runs this procedure. The Node numerical suite
(`tests/m2-controller/**`) is the verified half.

`m2-controller.browser.ts` is a **temporary test host**, not a production
bootstrap and not a shipped bundle. It is named `.browser.ts` so vitest never
collects it.

## Procedure

Prerequisites: the owner's desktop with a physical keyboard and a physical
gamepad (standard mapping), a modern Chromium/Firefox, and Node 22 (the
repository toolchain).

1. From the repository root, build the host with the pinned esbuild
   (the same option set as `export.md` §5.3):
   `npx esbuild tests/browser/m2-controller/m2-controller.browser.ts --bundle --platform=browser --format=iife --outfile=dist/m2-controller-test/harness.js`
2. Write a page next to it that loads `./harness.js`, then serve the repository
   root over HTTP so `/fixtures/m2/course/course.json` resolves, e.g.
   `npx http-server -p 8140 .` (any static server; do not open `file://`).
3. Open `http://127.0.0.1:8140/dist/m2-controller-test/` in the browser.
4. Record the environment into the evidence file: OS + browser + version,
   WebGL renderer string (printed in the HUD), `isSecureContext`, and whether
   `navigator.getGamepads` exists. `http://127.0.0.1` is a secure context;
   a non-localhost origin needs HTTPS for gamepads.
5. **Keyboard pass**: press `D`/`ArrowRight` to run, `Space` to jump (tap for
   the short jump, hold for the full jump), and run off the ledge to exercise
   the coyote window. Confirm in the HUD: the character moves only in X/Y, the
   Z lock stays `true`, `errors: 0`.
6. **Gamepad pass**: connect the physical standard-mapped gamepad, press a
   button so the browser exposes it, then repeat with the left stick / D-pad
   and the primary face button. The HUD lists the detected pads
   (`index`/`id`/`mapping`); a non-standard pad must be reported as
   `input_mapping_unsupported` on the console and contribute nothing.
7. **Focus/stall pass**: hold Space, switch tabs for ≥ 5 s, come back, and
   release/press again. A jump must not be replayed from the stale hold; the
   runtime executes at most 8 catch-up steps and reports the dropped time.
8. Capture: a real screenshot of the running course, the console output
   (including any `input_unavailable`/`input_mapping_unsupported` lines), and
   `await window.__m2Controller.collectEvidence()` (copies the recorded
   per-step action frames + positions + environment JSON).
9. Store them under `docs/acceptance/evidence-m2/37/` (packet 37 owns the
   final acceptance record) and reference them from the packet-32 manifest as
   the resolved browser evidence.

## What this establishes (once run)

- the course is traversable with a physical keyboard and a physical gamepad;
- one sample per executed fixed step, no phantom jump after tab resume;
- Z/rotation/scale locked in a real browser session;
- the recorded frames + positions make the run replayable in Node
  (`createRecordedActionSource`) for a step-by-step comparison.

## What it does not establish

- GPU/rendering performance, pixel correctness, or any product frame budget;
- anything about the packet-35 production preview bundle (separate packet).
