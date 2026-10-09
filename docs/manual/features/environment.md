# Environment

How to set a scene's sky and fog step by step: [the environment guide](../guides/environment.md).

## Grading and fog volumes

In the Environment window, post-processing grading has **lift**
(raises the blacks, −0.5–0.5), **gamma** (mid-tones, 0.2–5; above 1
brightens) and **gain** (scales the whites, 0–4); the defaults (0, 1, 1)
leave the image unchanged. A **fog volume** (Inspector) has *thins with
height*: its density fades by e^(−k·height) above the box bottom (k per
metre, 0–10; 0 = even fog).

## Height fog

A scene's look (and an environment preset) can carry an exponential
**height fog** (`heightFog`; Environment window → *Height fog*; MCP
`setEnvironment {sceneId, environment: {heightFog}}`): fog of `density`
per metre at the world height `height`, thinning by e^(−`falloff`) per
metre above it and thickening below, from `start` metres away from the
camera on, in `color`; `inscatterColor` adds a glow towards the sun (the
key light's, else a physical sky's; `inscatterExponent` 1–64 narrows it).
It thickens with distance and lies in valleys, and it fogs the sky towards
the horizon too (a dome just inside the camera's far plane), so the far
edge of a level — terrain at its coarsest level, the end of the streaming
rings — fades into it: no separate vista ring is needed. With the classic
linear/exp2 fog also set, both draw (the classic first). Presets blend it
like the rest of the look (a look without one thins it). Absent: no height fog.

- Defaults of absent fields: `height` 0, `falloff` 0.05 (halves every
  14 m), `start` 0, `inscatterExponent` 8; a new height fog in the window
  starts at density 0.02, `#c8d2dc`. Ranges: density 0–1, height ±10,000 m,
  falloff 0–10, start 0–10,000 m.
- Set the camera's far plane (`camera_far_m`) to where the level should end:
  the sky takes the fog's colour at that distance.
- Cost (this host's Iris Xe, 1080p, the landscape class with a valley haze
  and sun glow over its exp2 fog, WebGPU): the scene pass +0.3–0.45 ms GPU,
  +1 draw; the uncapped frame +0.4–0.6 ms on both renderers (about the added GPU
  time; not split further).

## Sky rotation

An image sky (`sky.mode` `texture`, an equirect or six cube faces) turns
about the vertical axis by `sky.rotation` (degrees, −360–360, absent 0;
counter-clockwise seen from above): the background and the sky's
image-based lighting and reflections turn together, on both renderers, in
the Scene view, Play and the export. A turn changes two rotation uniforms:
no image is reloaded and no lighting re-baked. Other sky modes ignore it
(the physical sky's sun already follows the key light). Set it in the
Environment window (*rotation (°)* under the panorama) or MCP `setEnvironment {sceneId, environment: {sky: {…,
rotation}}}`. Scripts turn a sky through environment presets: two presets
with the same image and different turns blend the turn the short way round
(`ctx.environment.set` / `blend`); there is no per-field sky setter.

**Align the sky's sun to the key light** (Environment window button) finds
the sun in the image — the centre of its brightest area: the pixels within
3/255 of the brightest one, gathered round the 10° cell holding most of
them, read at 512 × 256 (64 × 64 per cube face) — and sets the turn that
puts it at the azimuth the active scene's directional light comes from. It
matches the azimuth only (a turn cannot raise or lower a painted sun) and
says where it found the sun. Images in a compressed (KTX2) format cannot be
read for this; set the rotation by hand.

## Environment presets (runtime environment changes)

An **environment preset** is a named look a game switches or blends to at
run time — the same village by day and by night, a storm rolling in. A
preset is project content (`environment.presets`, at most 64) with any of:

- `sky` and `fog` — a whole sky / fog (the Environment window's shapes);
- `post` — post-processing merged per effect over the base (exposure, tone
  mapping, grading incl. lift/gamma/gain/tint, bloom, vignette, …);
- `lights` (at most 32 entries) — colour, intensity, direction (directional
  and spot) and ground colour (hemisphere) for the scene lights an entry
  names: by `entity` id, by `tag` name or by light `type` (e.g. every
  `ambient` or `hemisphere` light), every light when it names none; later
  entries win per field;
- `lightmap: { intensity?, tint? }` — a multiplier on baked lightmaps;
- `wetness` (0–1) — the scene's wetness under the preset (rain), blended
  linearly (a look without it is dry): materials with a **Scene wetness**
  node (the height-blended layers template) add it to their painted wetness.

A part a preset does not set is the **base look**'s: the active scene's look, and the lights as authored.

**Editor.** The Environment window's *Presets* section: type a name and
**capture current as preset** — the environment's sky, fog and post and
every scene light's colour, intensity and direction are stored (one
`setEnvironment`, undo/redo like any edit). **preview** shows a preset in the
Scene view (with game lighting); *blend from* / *blend to* and the **blend
preview** slider show a mix; **stop preview** goes back. Previewing stores
nothing. **delete** removes a preset. MCP: `setEnvironment` with
`environment.presets`.

**Scripts.** `ctx.environment`:

- `set(presetId, { blend?, easing?, override? })` — switch to a preset (`''`
  = the base look) over `blend` seconds (0–600; absent: at once), easing
  `linear` (default: a time-of-day fade progresses evenly), `easeIn`,
  `easeOut` or `easeInOut`; an interrupted blend continues from the look on
  screen. `override` changes fields of the preset for this change only
  (`{ fog: { color: '#ff0000' } }`: sky, fog, post and lightmap merge over
  the preset's, lights add entries). False (and a warning in the play log)
  for an unknown preset or a bad option.
- `blend(a, b, t)` — hold a mix of two presets (t 0–1), for a timeline or a
  script that drives t itself.
- `state()` → `{ target, progress, blending }`, `weight(presetId)`,
  `presets()`.

Visual scripts have the same as *Set environment*, *Blend environments*,
*Environment state*, *Environment weight* and *Environment presets*
(category Environment). The blend is simulation state: it replays, runs the
same in the simulation worker and in exports, and is in the step digest once
a script used it (games that never do are unchanged). A project save
document includes it when the save schema lists the `environment` section.
`tl_game_observe` (and an export's `window.__thirdlightObserve()`) reports
`environment: { target, progress, weights }` once a script changed it.

**How it draws.** Numbers blend linearly, colours in linear light, light
directions are normalized, the sun's azimuth goes the short way round. The
renderer changes them in place every frame — sky colours and parameters,
fog colour and distances, exposure, grading, vignette and bloom are
uniforms, so a blend compiles no new shaders (a change of tone-mapping mode
or fog kind does). Two presets with **different skies** (another mode, or
another sky image) **cross-fade**: each sky is drawn as a dome over the
background with its share as opacity; the image-based lighting is the
heavier sky's. A sky that only changes its numbers re-bakes its image-based
lighting at most every 30th frame, and only once it has moved past a
threshold from the last bake (a colour channel by more than
0.01, a procedural sky number by more than 1 %, the sun by more than 0.5°);
the bake reuses its target, so the scene's environment texture never
changes during a blend. A blend that only changes fog, exposure, grading or
lights never re-bakes. A script may give `blend(a, b, t)` a new t every step:
measured on the GPU host (Iris Xe), no step is dropped once loaded
(`environment-blend-cost.e2e.ts`). Fog of different kinds converts (linear
↔ exp2 by density = 2 / far); a look without fog thins it. Tone mapping,
anti-aliasing, AO, depth of field and the LUT image cannot blend: the
heavier look's is used.

**Baked lighting.** A lightmap holds the light of the moment it was baked:
changing a baked light's colour in a preset does not change the baked
surfaces (a light a bake holds is not realtime at all). Give such presets a
`lightmap` multiplier — e.g. `{ intensity: 0.2, tint: '#8090ff' }` for night
— and the baked surfaces darken and tint with the blend.
