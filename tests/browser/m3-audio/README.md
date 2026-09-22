# Packet 54 — browser audio owner verification (manual, packet-32/37 procedure)

**Status in this container: UNVERIFIED.** There is no browser here and no
audio device (packet 38 baseline §1). Nothing in this directory was
executed; every browser statement of packet 54 (the real `AudioContext`,
the real gesture reaching `running`, the real decodes of the committed cue
bytes, the real voice cap, `m3-audio-evidence.png`) is **UNVERIFIED** until
the owner runs this procedure. Audibility itself is **UNVERIFIED by
contract** (§41.4.7 rule 9, §41.4.8): counters and context state prove the
graph, not the ear. The verified halves are: the deterministic owner rule
set (`packages/game-host/src/audio.test.ts`, 21 tests over the injected
context factory — validation, the sound-off ladder, dedupe, the 8-voice
cap, stale run/decode cancellation, mute/hidden, exactly-one close,
determinism) and the owner over the REAL committed cue bytes
(`tests/m3-audio/owner-real-cues.test.ts`, 4 tests: the five
`fixtures/m3/media/wav/cue-*.wav` cues digest-verified against the media
`index.json`, real PCM durations re-derived from the bytes, the cap under
a 20-cue flood, the `wav/rejections/bad-magic.wav` malformed-decode path).

`m3-audio.browser.ts` is a **temporary test host**, not a production
bootstrap and not a shipped bundle. It is named `.browser.ts` so vitest
never collects it. The host injects the owner with a **pass-through
instrumentation wrapper** around the REAL `AudioContext` factory (it
counts decodes/sources/states — every real audio-graph operation still
runs; the wrapper only observes), and it runs the cue timeline only from a
REAL local gesture (`event.isTrusted === true` on a real `pointerdown`/
`pointerup` — rule 7: synthetic/relayed activations never unlock).

## What it exercises (the packet 54 evidence lines — B12/B13)

| # | Check | Recorded (in `window.__m3Audio.evidence`) |
|---|---|---|
| A1 | **Sound-off completion**: the five committed cues registered bytes-in and one committed event submitted BEFORE any gesture — status `blocked`/`autoplay_denied`, `sourcesBeforeGesture === 0`, `preGestureSubmitCreatedNoSource === true`, submit still `ok` (the game never waits for audio) | `preGesture` |
| A2 | **Fixture integrity**: each fetched cue's SHA-256 + length against the media `index.json` | `fixtures`, `fixturesAllMatch` |
| A3 | **Real decodes of real bytes**: the real `AudioContext.decodeAudioData` on the fetched committed bytes — `decodes`, `decodeErrors`, and the realized `AudioBuffer.duration`s | `realDecodesOfRealBytes` |
| A4 | **Each cue kind sounds as a real voice**: the wrapper records each source's buffer duration at `start()`; `cueKindsRealizedAsVoices` = per-kind (start/jump/checkpoint/death/goal) duration match against the §41.4.4 re-derivation of the fetched bytes | `cueKindsRealizedAsVoices` |
| A5 | **Local gesture unlock (rule 7)**: the timeline starts only from a real `isTrusted` pointer; the pre-gesture state was recorded first | `unlockFromRealGesture` |
| A6 | **Dedupe (rule 4)**: the jump cue's committed event id submitted three times adds exactly one real source | `realDecodesOfRealBytes`/source counts |
| A7 | **Voice cap (rule 3)**: a 12-cue jump flood against `AUDIO_MAX_VOICES = 8` — bounded `voice_cap` diagnostics, `peakLiveNeverExceededCap === true` | `voiceCapHeld`, `instrumentation.peakLive` |
| A8 | **Mute**: `setMuted(true)` stops current voices and the muted submit is skipped (`cue_skipped: muted`); unmute restores | `muteStopsAndSilences` |
| A9 | **Hidden/visible (rule 6)**: `setHidden(true)` suspends the real context; `setHidden(false)` resumes (a rejected resume would degrade to `blocked` — the owner unit tests pin that half) | `hiddenSuspendedVisibleResumed` |
| A10 | **Dispose (rule 8)**: exactly one `close()`, status `disposed`, later `submit`/`registerCue` return `audio_disposed` | `disposeClosesExactlyOnceAndDisposes` |
| A11 | **Screenshot**: the evidence JSON rendered to a canvas and downloaded | `m3-audio-evidence.png` (SHA-256 recorded by the owner) |

## Procedure

Prerequisites: the owner's desktop or a Chromium/Firefox machine WITH
WebAudio (software WebAudio counts — packet 38 established the in-container
browser has it), Node 22, and a real audio device to witness audibility
(§41.4.7 rule 9: audibility is witnessed on a real device at 54/62).

1. From the repository root, build the host with the pinned esbuild:
   `npx esbuild tests/browser/m3-audio/m3-audio.browser.ts --bundle --platform=browser --format=iife --outfile=dist/m3-audio-test/harness.js`
2. Write a page next to it that loads `./harness.js`, then serve the
   repository root over HTTP so `/fixtures/m3/media/wav/cue-*.wav` and
   `/fixtures/m3/media/index.json` resolve, e.g. `npx http-server -p 8143 .`
   (any static server; do not open `file://`).
3. Open `http://127.0.0.1:8143/dist/m3-audio-test/` in the browser. The
   host records the pre-gesture state immediately (sound-off, zero
   sources) and waits on the **"Enable sound"** button.
4. **Physically** click the button (a real local gesture — keyboard focus +
   Enter or a pointer click; a scripted `dispatchEvent` must NOT unlock:
   verify `unlockFromRealGesture.isTrusted === true`).
5. The cue timeline runs (~9 s): start → jump×3 (dedupe) → checkpoint →
   12-jump flood → death → goal → mute → jump-while-muted → unmute →
   hidden → visible → dispose → after-dispose. Listen with the real device:
   each cue should be audible once (audibility is the real-device witness).
6. Record the environment (OS + browser + version), the evidence JSON
   (`window.__m3Audio.evidence`, also logged as
   `[m3-audio] EVIDENCE COMPLETE`), and confirm: `fixturesAllMatch=true`,
   `noSourceBeforeGesture=true`, `preGestureSubmitCreatedNoSource=true`,
   `unlockFromRealGesture.isTrusted=true` with status
   `ready/unlocked:true`, `realDecodesOfRealBytes.decodes === 5` (one per
   distinct cue asset), `decodeErrors === 0`,
   `cueKindsRealizedAsVoices` all `true`, `voiceCapHeld=true` (≥ 4 bounded
   `voice_cap` diagnostics from the flood), `peakLiveNeverExceededCap=true`
   (peak ≤ 8), `muteStopsAndSilences=true`,
   `hiddenSuspendedVisibleResumed=true`,
   `disposeClosesExactlyOnceAndDisposes=true`.
7. The host downloads `m3-audio-evidence.png`. Record its SHA-256 and
   dimensions.
8. **Negative check (optional, second run):** with sound OFF in the OS
   mixer (or a no-device profile), repeat the gesture — the status ladder
   must degrade to `blocked`/`no_device` (or the decodes/sources still run
   silently) and NO error may reach the console as a thrown host error
   (a hard failure is never converted into a silent sound-off, and a
   policy denial is never reported as a content failure, §41.4.6).
9. Record the result (verified / the exact diverging fields) in
   `docs/acceptance/evidence-m3/54/` with this README's procedure.

## What is NOT claimed here

- Audibility (no device in this container; §41.4.7 rule 9 — witnessed on a
  real device by the owner).
- Gapless timing, decibel or bit-exact playback (§41.4.8).
- Anything about the delivery composition (HUD, controls, `createGameHost`)
  — packet 55; this host drives the owner directly with committed events.
- The host's own `setTimeout` timeline is a TEST clock (the host is not the
  production composition); the owner itself reads no clock — its timeline
  is the host's `submit` calls + the real AudioContext graph.