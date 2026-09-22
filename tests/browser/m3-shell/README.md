# Packet 55 — browser game-shell verification (manual, packet-32/37 procedure)

**Status in this container: UNVERIFIED.** There is no browser, no GPU and no
audio device here (packet-38 baseline §1). Nothing in this directory was
executed; every browser statement of packet 55 (the real keyboard/gamepad
menu channel, the local click unlock, the rendered HUD + game pixels, the
audible cues through the shell) is **UNVERIFIED** until the owner runs this
procedure. The verified halves are:

- the deterministic input menu seam
  (`packages/input/src/menu.test.ts` — the pure state machine: the hard
  bindings, fresh-press-only latches, the §4.2 consumed/needsRelease
  fresh-release machine, the same-press jump suppression, the pad
  disconnect slice, the focus/visibility clear — and
  `packages/input/src/browser-menu.test.ts` — the real
  `attachBrowserInput` over a fake window: menu keys feed the channel, the
  held consumed press does not jump, a fresh press after release does,
  the editable-target/auto-repeat gates still apply);
- the host over real composition parts in Node
  (`packages/game-host/src/host.test.ts` — mount/HUD text-only (the
  malicious title), the menu-driven start with `movementSteps: 0`, the
  runtime's own state rejection, the real packet-54 owner's blocked→ready
  mapping, the committed cue submission with real cue ids, the disposal
  order; and `tests/m3-shell/host-shell.test.ts` — the FULL loop over the
  REAL Rapier port + the REAL `attachBrowserInput` (fake window) + the
  REAL audio owner decoding the REAL committed cue bytes: the title→start
  →checkpoint→goal→won→replay run, the C1/C2 no-phantom-jump, the C3
  gamepad flow, the C7 disconnect, the C9/§4.6 hidden-tab + bounded
  catch-up, the stale-run identity, the repeated mount).

`m3-shell.browser.ts` is a **temporary test host**, not a production
bootstrap and not a shipped bundle. It is named `.browser.ts` so vitest
never collects it. The host builds the platform specifics (canvas, the
real `createSceneAdapter`, the real Rapier port, the real
`attachBrowserInput` on the canvas, the real audio owner via
`browserContextFactory`, the same-origin cue fetches) and hands them to
`createGameHost` — the single production composition (delivery.md §3.2:
no second bootstrap, no second run-state owner).

## What it exercises (the packet-55 evidence lines — B04/B08/B09/B13/B15)

| # | Check | How to witness it |
|---|---|---|
| A1 | **The title HUD (B04)**: the authored title/objective/instructions render as DOM text nodes in the host-owned container (plain text + two plain buttons — Start/Mute — no project-supplied HTML, no remote assets) | the `HUD text:` line in the page status block + inspecting the DOM (the container is plain `<h1>/<p>/<button>` nodes with `textContent`) |
| A2 | **Start at the title (B04/B08, C4)**: `Enter` or `Space` (or a physical pad confirm) starts the run with no motion step; the run state flips to `playing` within a frame | the `observed: awaitingStart … → playing` lines in `window.__m3shell.steps`; the player stays at the spawn until a movement input |
| A3 | **No phantom jump (§4.2, C1/C2)**: hold the start key through the start — the run's opening steps show no jump; release-then-press jumps | hold Enter/Space at the title and watch: the capsule does not hop when the run begins; after a full release the next press jumps |
| A4 | **Win + replay (B08, C5)**: reaching the goal zone wins; a fresh confirm at the win screen replays — the HUD shows the win prompt, the new run starts at the original spawn with `deathCount 0` and no active checkpoint | the `observed:` lines: `won` → `playing` with `run=shell-browser@r1#1`, `deaths=0`; the capsule is back at the left spawn |
| A5 | **Checkpoint status (B09)**: crossing the checkpoint zone activates it; the HUD status line shows the checkpoint state and the death count | the HUD status line (`Deaths: n — checkpoint @ step n active — sound: …`) and the `observed:` `run=`/`state` transitions |
| A6 | **Sound blocked before a local gesture (B13)**: at load the sound status is `blocked` (`unlocked: false`, `gesture: none`); the game plays | the `title: … sound=…` line in `window.__m3shell.steps` |
| A7 | **Local unlock + audible cues (B13, §41.4.7 rule 7)**: a LOCAL click/keydown (a real gesture) unlocks the real `AudioContext`; the start/jump/checkpoint/goal cues (the real fixture WAVs fetched same-origin) sound; `M` mutes/unmutes | the `audio unlock (local gesture): …` line; audible cues on start/jump/checkpoint/goal (audibility witnessed on a real device — UNVERIFIED by contract in-container); `M` toggles the `sound.status` between `ready`/`muted` |
| A8 | **Physical gamepad (B15)**: with a standard-mapped pad connected, the D-pad/stick moves and the primary button confirms/jumps with the accepted arbitration; a disconnect clears the pad state without stuck controls | with a pad: move + confirm + jump at the title; unplug (or `navigator.getGamepads()` dropping the index) — the walk stops, the keyboard still works |
| A9 | **Keyboard-only completion (B15)**: the whole loop (start → play → win → replay) completes with keyboard alone (no mouse) | A2/A4 with a keyboard only; the HUD buttons are optional affordances on the same `control()` channel |
| A10 | **Hidden-tab resume (§4.6)**: hiding the tab clears the held keys and the menu latch (the walk stops); on a long-hidden resume the run does not fast-forward (the bounded catch-up + fresh anchor) | hide the tab mid-walk, return: the capsule is where it stopped (not ahead); a 5s+ absence advances at most 8 steps (the runtime's `MAX_CATCHUP_STEPS`) |
| A11 | **DOM screenshot distinct from the canvas (B04)**: the HUD is DOM; the game is WebGL — the evidence is both halves | the `HUD text:`/`observed:` lines (DOM half) + the F9 canvas screenshot line (`canvas screenshot captured: n bytes` — WebGL half) in `window.__m3shell.steps` |
| A12 | **Dispose/re-mount (B15 lifecycle)**: the page's host owns the runtime/HUD/adapter; a second `createGameHost` on the same snapshot reuses the wrapper's input/audio resources | covered by the Node suites (the repeated-mount test); in the page: a full reload re-mounts cleanly (the evidence restarts) |

## Procedure

Prerequisites: a desktop or a Chromium/Firefox machine, Node 22 (the
pinned toolchain), and — for A7/A8 — a real audio device and (optionally) a
standard-mapped gamepad.

1. From the repository root, build the host with the pinned esbuild:
   `npx esbuild tests/browser/m3-shell/m3-shell.browser.ts --bundle --platform=browser --format=iife --outfile=dist/m3-shell-test/harness.js`
2. Serve the repository root over HTTP so the cue fixtures resolve, e.g.
   `npx http-server -p 8145 .` (any static server; do not open `file://`).
3. Open a page that loads `dist/m3-shell-test/harness.js` (the host builds
   its own page DOM: status block, HUD container, canvas). The title HUD
   appears immediately; the sound status is `blocked`.
4. **A1–A3**: inspect the HUD DOM (plain text nodes); press Enter or Space
   (or the pad confirm) and watch the `observed:` lines flip to `playing`;
   hold the key through the start and confirm no hop (C1/C2).
5. **A7**: click the page (or press any key) — the local gesture unlocks
   the real AudioContext; the `audio unlock (local gesture): …` line
   records the status; the start cue sounds.
6. **A4–A5**: hold D / D-pad-right to walk to the checkpoint (the HUD
   status line shows it active), then to the goal zone — the win prompt
   appears; press a fresh Enter/Space/confirm to replay.
7. **A8**: with a pad connected, repeat the start/confirm/jump flow on the
   pad; disconnect it mid-hold (unplug or a second index reuse) and
   confirm no stuck control; the keyboard keeps working.
8. **A10**: hide the tab (or minimize) mid-walk, wait 5s+, return: the
   capsule is at the stopped position and the step count advanced at most
   8.
9. **A11**: press F9 to capture the canvas screenshot (the `canvas
   screenshot captured: n bytes` line); compare it against the HUD text
   evidence (the DOM half) — the game pixels and the HUD are distinct
   surfaces.
10. Copy `JSON.stringify(window.__m3shell, null, 2)` from the console as
    the packet-55 browser evidence; record the screenshot SHA-256.

## Evidence rule

No visual/audible claim of packet 55 is recorded as verified in the
packet-55 handoff or the M3 acceptance record from this directory — only
the owner-run evidence above can upgrade the B04/B13/B15 browser rows.
