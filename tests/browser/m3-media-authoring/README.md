# M3 media / lighting / animation authoring — browser verification (packet 57)

Manual verification of the editor's media panel (cues / checkpoint activation /
lights / material / animation), the media import (`.glb` + `.wav`), the §8.5.1
atomic animated reimport and the preview-audio gesture flow.

**Status: UNVERIFIED** — no browser/GPU/audio device is available in the
container (the packet 38 baseline §1 rule). The Node tests
(`packages/editor/src/session/media.test.ts`,
`packages/editor/src/session/preview-audio.test.ts`) establish the planning
and owner behavior; the rows below are the manual procedure for a machine
with a real browser.

## Setup

1. Build: `node tools/build.mjs` (emits `dist/editor/index.html`).
2. Start the backend with a project containing at least one imported model
   asset (M2) and run `npm run dev:backend` per `docs/handoffs/50.md` §13.7
   (or the recorded deployment procedure); the editor page is served by the
   backend with the injected `window.__thirdlightEditor {v, projectId,
   previewOrigin, authoringToken}`.
3. Open the editor page (the authoring token is the page-embedded session
   credential of every content read — it is never part of a resource URL).

## Procedure

- **A1 — WAV import (row 18).** Assets → `import…` → a PCM WAV (mono 48 kHz
  16-bit; e.g. `fixtures/m3/media/wav/cue-jump.wav`). The flow stages →
  uploads → inspects (the PCM-WAV profile: `container: 'wav'`,
  `channels: 1`, `sampleRate: 48000`, `bitsPerSample: 16`, the
  `durationMs`/`frames` metrics) → `proposed`. Publish → a `kind: 'audio'`
  catalog record at v1. A non-WAV audio file (e.g. a reencoded MP3 renamed
  `.wav`) must be refused at the inspect with the structured
  `import_rejected` reason — the publish button never becomes available.
- **A2 — Cue pickers (row 5).** Media → Cues: assign `cue-jump.wav` to the
  `jump` slot and `cue-checkpoint.wav` to `checkpoint` (or leave `null` =
  nothing plays). Save → one `setGameConfig` with the full merged `cues`
  block; the other four top-level fields are untouched (compare the change
  record). Undo restores the previous block.
- **A3 — Preview audio gesture (the packet surface).** With a cue slot
  filled: the panel shows `status: blocked` + the `enable preview sound`
  button. Click it (a real `pointerdown` — `isTrusted`) → status `ready`.
  The `▶` per slot plays the committed bytes through the injected preview
  owner; a second `▶` on the same live cue adds no voice (dedupe); 9
  concurrent cues drop the 9th with the `preview_voice_cap` diagnostic
  (never queued). Before the gesture, `▶` is a silent no-op.
- **A4 — Lights (rows 13/14).** Media → Lights: `+ key light` (directional,
  `light-NNNN` derived id) → `+ fill light` (ambient). The buttons disable
  at 1+1 (the §23.10 scene limit). Edit the key light: color `#f0e0d0`,
  intensity 3.5, direction [0.35, -1, 0.55], castShadow on → save sends the
  changed fields only; the viewport renders the directional arrow / ambient
  sphere marker. A second directional must be refused (scene validation).
- **A5 — Material + presets (rows 15/16).** Select a box → Media → Material:
  set roughness 0.2 / metalness 0.4 / emissive `#102030` → save; the box's
  viewport material color updates to the authored surface color. Click
  `hazard` → one `applySurfacePreset` (the `change` carries `previous`/`next`
  + `changedFields`); undo restores the previous values exactly.
- **A6 — Animated reimport (rows 17/21 + §8.5.1).** Import an animated GLB
  with ≥3 clips (idle/run/airborne); place it as a model entity; set its
  animation profile (Media → Animation: version 1 + the three role bindings
  over the inspected clip names) → save (`modelAnimation` with the fixed
  `assetId`). Now Assets → select the asset → `reimport…` a second version
  whose clip order differs (e.g. reordered clips — the
  `fixtures/m3/media/roles/roles-cases.json` shape): the Assets panel shows
  the **Animation mapping** section (required): choose the entity + the
  three clips. Publish sends `publishAsset` with `animation: {entityId,
  roles}` — the ONE command moves the entity's full `modelAnimation` to v2 +
  the new bindings (stage-3 range + stage-5 name checks pass by
  construction). Undo (one step) restores BOTH the old version reference and
  the old component. A reimport with the mapping section skipped must keep
  the publish button disabled (the command would be `field_missing` /
  stage-3 refused).
- **A7 — Checkpoint activation appearance (row 11).** Zones → create the
  checkpoint → Media → Checkpoint: set emissive `#1bc8ff`, intensity 1.2,
  cue reference = the assigned checkpoint cue (or empty = the game's
  `cues.checkpoint`). Save → `setComponent(gameZone, {activation})` partial
  edit (the zone's role/size/safeSpawnId are untouched). A non-audio cue
  reference is refused by the panel preflight (`asset_kind_mismatch` shape).
- **A8 — MCP convergence.** Repeat A2/A4/A5 through the mcp-adapter's
  `tl_command` (the same ops) — the editor must converge on the backend
  states (no divergence, no local writes).
- **A9 — Persistence.** Reload the editor page: the assets (with versions),
  cue block, lights, surfaces, the animation profile and the activation
  appearance all come back from the backend queries (never from localStorage
  or any cache).

## Checklist

| # | Row | Result |
|---|-----|--------|
| A1 | 18/21 — WAV import + PCM-WAV profile | UNVERIFIED |
| A2 | 5 — cue pickers (`setGameConfig` partial, `cues` whole) | UNVERIFIED |
| A3 | packet surface — preview gesture / dedupe / cap | UNVERIFIED |
| A4 | 13/14 — directional + ambient, 1+1 limit | UNVERIFIED |
| A5 | 15/16 — surface values + three presets | UNVERIFIED |
| A6 | 17/21 — §8.5.1 atomic animated reimport + undo | UNVERIFIED |
| A7 | 11 — checkpoint activation appearance | UNVERIFIED |
| A8 | MCP convergence on the same ops | UNVERIFIED |
| A9 | reopen persistence | UNVERIFIED |