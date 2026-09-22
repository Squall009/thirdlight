/**
 * Packet 30 — browser/hardware-only manual procedure (NOT run by vitest; this
 * file has no `*.test.ts` suffix on purpose and is never imported by a bundle).
 *
 * There is no browser, no WebGL context and no gamepad hardware in this
 * container, so every claim below is **UNVERIFIED**. This is the packet-37 /
 * owner procedure that closes acceptance row A11's real-hardware half
 * (`m2-acceptance.md` §1: "Keyboard and a physical gamepad are both
 * required"; a synthetic trace complements but cannot replace it). The pure
 * half of A11 and the exact sampled frames are already Node-verified:
 * `packages/input/src/{mapping,browser,step-source}.test.ts` and
 * `fixtures/m2/input/raw-sequences.json` (re-derived by its own checker).
 *
 * BR-3 note (gamepad/secure-context topology, `docs/handoffs/m2-plan-review.md`
 * §BR-3): the intended authoring topology is plain-HTTP LAN (decision 0001 §7).
 * `navigator.getGamepads()` availability varies by browser in non-secure
 * contexts, and the `gamepad` Permissions-Policy default is `*` (live MDN:
 * Permissions-Policy `gamepad`, 2026-12-28 revision) while a cross-origin
 * iframe needs `allow="gamepad"`. If the pad is not exposed in the
 * separate-origin preview frame on the plain-HTTP topology, A11 cannot pass
 * and the owner must choose the topology (localhost access on the backend host,
 * or TLS termination) before this procedure can succeed. Do not install TLS
 * services or system packages to force it.
 *
 * Preconditions: the editor + preview bundles built (`npm run build`), the
 * packet-13/37 local deployment with a disposable `m2-course` project, and a
 * scene with one `components.controller` entity plus a floor and walls
 * (`fixtures/m2/contracts/platformer/**` course spec). A physical controller
 * must be connected and recognised by the OS before opening the browser.
 *
 *  1. Record the environment: OS + version, browser name + version, WebGL
 *     backend/renderer, window size, authoring origin (O_A) and preview origin
 *     (O_P), whether O_A is a secure context, the pad's `Gamepad.id` /
 *     `mapping` / connected flag (DevTools console:
 *     `navigator.getGamepads().map(g => g && [g.index, g.id, g.mapping])`),
 *     and the preview iframe's `allow` attribute. Open the editor and press
 *     Play so the separate-origin preview iframe is live and focused.
 *  2. Console instrumentation (packet 35 wires the binding; until then inspect
 *     the preview's exported diagnostics): log `input_unavailable`,
 *     `input_mapping_unsupported`, `input_suspend`, `input_activate` and
 *     `input_disconnect` diagnostics, plus every sampled `ActionFrame`. Confirm
 *     the console shows `input_unavailable` (`reason: 'gamepad'`) exactly once
 *     if the pad is not exposed, and that keyboard play still works in that
 *     case (this is the A11 "insecure/denied API yields actionable unavailable
 *     state" half).
 *  3. Keyboard: hold `D` (and `ArrowRight`) and confirm the character moves
 *     right with `moveX === 1`; hold `A`/`ArrowLeft` for `moveX === -1`; hold
 *     both and confirm `moveX === 0` (no summation, and — with the stick
 *     centred — no drift). Press `Space` and confirm exactly one `pressed`
 *     frame, then `held` frames while held, then one `released` frame. Tap
 *     `Space` as fast as possible; confirm exactly one `pressed` at the next
 *     executed step (no double edge).
 *  4. Physical controller: with a **standard-mapped** pad, push the left stick
 *     past the dead zone and confirm `moveX` tracks the rescaled value
 *     (`0.2` ⇒ `0`, `0.6` ⇒ `0.5`, full ⇒ `1`); centre it and confirm `0`.
 *     Press D-pad left/right and confirm `−1`/`1` (and that the D-pad beats the
 *     stick); press the primary face button and confirm the same
 *     `pressed → held → released` chain as `Space`. Hold `D` and push the stick
 *     the other way: confirm the keyboard wins. Confirm a non-standard-mapped
 *     pad is ignored and reported once as `input_mapping_unsupported`.
 *  5. Focus/text-field suppression: click into an Inspector numeric/text input
 *     and type `a`, `d`, and Space. Confirm no `keydown` reaches the binding
 *     (no held state, no `moveX`, no jump) and that the characters appear in
 *     the input; then click the play preview again and confirm keyboard control
 *     resumes after a fresh press.
 *  6. Blur release: hold `D` and `Space` (movement + `held` frames), then
 *     switch to another window (or click the editor UI). Confirm the console
 *     shows `input_suspend`, the next frames are neutral, and after returning
 *     the character does **not** resume moving or jump until a new keydown /
 *     button-down is observed post-resume (fresh activation: `pressed` only
 *     after a real up→down).
 *  7. Hidden tab: hold `D`, switch to another browser tab, wait ≥ 2 s, return.
 *     Confirm `input_suspend` + `input_activate`, neutral frames while hidden,
 *     no catch-up burst of movement (the runtime drops wall time; A13) and no
 *     phantom jump edge from state held before the tab switch.
 *  8. Hot disconnect: while the character is moving / jump is held, physically
 *     unplug the controller. Confirm `input_disconnect`, the next frame is
 *     neutral, no phantom `pressed`, and that the character stops. Confirm a
 *     second pad connected afterwards may take over but requires a release
 *     before a new `pressed` (awaitingRelease). Reconnect the first pad and
 *     confirm it works without restarting play (index reuse: confirm the
 *     console reports the disconnect rather than silently reusing the index).
 *  9. Cleanup: press Stop in the editor and confirm the preview tears down with
 *     no further `ActionFrame` samples, and that pressing keys after Stop
 *     moves nothing (listeners removed, held state cleared). Confirm no
 *     listener leak by toggling Play/Stop five times and checking the console
 *     for repeated `input_suspend`/`input_activate` storms.
 * 10. Capture: a real PNG per state (keyboard move, pad move, jump apex,
 *     post-blur neutral), the console log excerpts for items 2–9, and the
 *     network panel confirming no input traffic beyond the packet-35 relay (if
 *     used). Screenshots must be real captures, not stubs.
 */
export const PACKET_30_BROWSER_PROCEDURE =
  'docs/acceptance/evidence-m2/30/manifest.md §Acceptance criteria (A11, A13) — UNVERIFIED hardware half';
