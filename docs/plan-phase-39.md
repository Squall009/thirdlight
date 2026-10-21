# Phase 39 — See-through around subjects

Status: planned 2026-10-21.

Goal: anything between the camera and a subject (a player, a unit) dithers
away in a soft circle around that subject. The rest of the scene stays drawn,
so rooms, doorways and paths stay readable. This is the "occluder fade" or
x-ray of isometric and third-person games. It is a camera-level rendering
feature that works on every kind of object: block layers, architecture,
models, scatter, terrain. It is not a block cut-away mode. Read
`docs/roadmap.md` (principles 1 and 1b) first.

Source: Temporal G7 (`~/projects/temporal/docs/engine-gaps.md`, 2026-10-21).
Temporal wants a fade centred on its player for interiors seen from the follow
camera, because whole-zone cut-aways hide doorways. Temporal asked for a block
cut-away mode. The engine builds the general feature instead, and the request
is answered by it.

## 1. Owner decisions (2026-10-21)

- **Dither, never fully invisible.** The circle thins what is in front to a
  dither with a maximum fade below 1 (default 0.75, set per project). Doors,
  walls and props in front stay visible as a see-through pattern instead of
  vanishing.
- **A list of subjects.** The default subject is the active camera's target,
  but any number of objects can be subjects at once, up to the GPU-side array
  size (§2).
- **Only above the subject.** A pixel fades only if it is closer to the camera
  than the subject AND higher than half the subject's height above its feet.
  Floors, ground and anything low around a subject never fade.
- **Multi-floor levels work.** A character on the stairs fades the floor above
  them, but never the floor they stand on or the floors below. Both are
  acceptance cases.
- **Everything takes part by default.** Every drawn object can fade, so a tree
  or prop nobody marked doesn't block the view. Objects opt out with
  `seeThrough: false`. A subject never fades itself or its children.

## 2. Design

- **One dither-fade node.** The block cut-away already fades meshes with a
  per-pixel dither ANDed into the material's `maskNode`
  (`three-adapter/src/block-cutaway-view.ts`, `keepNode` / `makeFadeVariant`).
  It works for every node material kind (standard, trim, layered surface,
  graph, terrain, skinned, instanced, decals) and adds no program per value.
  That code moves into one shared module. The cut-away and see-through both
  use it, and later fades (LOD crossfade, distance fade) can too.
- **The see-through mask**, evaluated in the fragment stage of every material
  that takes part:
  - for each subject: its screen position, its view depth and its feet height
    (world up), all per-frame uniforms set once per view
    (`uniform().onRenderUpdate`, like `effect-lights.ts`);
  - a pixel's fade is the largest over the subjects of: the soft circle (a
    radius and softness as a fraction of the view height, scaled with distance
    so the circle covers the subject's body at any zoom) × [pixel view depth <
    subject view depth − margin] × [pixel world height > feet + half the subject's height];
  - fade = min(that, max fade); the fade eases in and out over time per
    subject (the cut-away's `CUTAWAY_FADE_SECONDS` style; one constant).
- **Array size.** Subjects are a fixed-size uniform array: a GPU constraint,
  not a content cap. It is defined once (default 4 per view). Asking for more
  keeps the nearest to the camera and logs one Problems line.
- **The height rule is one rule everywhere** (owner, 2026-10-21). Nothing
  below half the subject's height above its feet ever fades. For a character
  that is half its controller's height; for other subjects, half their
  bounds. Things on or near the floor stay solid on every storey, in a side
  view and in 3D. The rule doesn't depend on the scene, a plane or the project
  kind.
- **Opt-out:** a `seeThrough` render flag on models, boxes, block layers (per
  layer), architecture, terrain and scatter rules, default true. It is a
  per-object uniform like `lightLayers`, so no program variants per object.
  Batching and merged statics keep objects with `seeThrough: false` apart from
  the rest, as they do for light layers.
- **Shadows** are unaffected: a faded wall still casts its shadow.
- **Control:**
  - project settings (Rendering → See-through): on/off, radius, softness, max
    fade, depth margin, fade time;
  - script: `ctx.camera.setSeeThrough({enabled?, subjects?, radius?, …})` to
    change it at runtime (indoors, cutscenes); `subjects: null` goes back to
    the camera's target;
  - a timeline key isn't planned (a script call covers cutscenes).
- **Cut-aways stay** for hiding whole zones (roofs, upper storeys). The two
  combine.

## 3. Items

**E2E budget (D253):** no new e2e file and no net added e2e time. Shader and
mask maths get vitest checks (TSL node built and evaluated on the CPU reference
where possible). The editor surface is one step in an existing e2e file.

| Item | What |
|---|---|
| 39.0 | **Release checks** (three.js, Rapier), as every phase. |
| 39.1 | **One dither-fade module.** Move the cut-away's dither, variant cache and precompile into one shared module, and switch the cut-away to it. No visual change: the cut-away's existing e2e and screenshots must match. |
| 39.2 | **The see-through mask** (§2) in every material kind, with per-view subject uniforms, the per-object opt-out, subjects excluded from their own fade, and batching keys. Every material that takes part gets the mask through the shared module at creation (precompiled), not a copy mesh: no extra draws. |
| 39.3 | **Settings and API:** project settings, `ctx.camera.setSeeThrough`, the `seeThrough` flag in the Inspector for each object kind, typings, graph node, MCP docs. Additive on schema 7. |
| 39.4 | **Correctness cases** (vitest on the mask maths + a browser check): a wall between camera and subject fades inside the circle only; a wall behind the subject never fades; the floor around the subject never fades; **multi-floor**: a character on the stairs between storeys fades the storey slab above them, not the one under them, and walking up flips which slab fades; two subjects in one view; a subject that is itself in front of another subject; a side-view foreground prop near the floor stays solid. |
| 39.5 | **Editor:** a See-through preview toggle in the Scene view (with the selected object, or the camera target, as the subject), so level builders see the effect while editing. One step in an existing editor e2e. |
| 39.6 | **Performance:** measure on the village and an interior class (a multi-storey building) on both renderers at 1080p on the Iris Xe. Target: ≤ 0.3 ms GPU frame time added with 4 subjects, no added draws, no added programs after warm-up. |
| 39.7 | **The manual:** a see-through section in the camera and rendering pages, the cut-away page's "combine with see-through" note, and a how-to for interiors (follow camera + see-through + roof cut-away). |
| 39.8 | **Acceptance.** In a real browser on both renderers at 1920×1080: the Temporal-style interior (a follow camera over a two-storey building, a player walking through rooms and up the stairs) and an open scene with trees between camera and player. Screenshots to `~/.cache/thirdlight-phase39/acceptance`; owner look pending. Full gate, then the phase review. |
| 39.9 | **Review fixes.** |

**Done when:**
- Walls, props and trees between the camera and any subject dither (never
  vanish) in a soft circle around it.
- Floors at and below the subject's feet never fade, including on stairs
  between storeys.
- Every object takes part unless it opts out.
- It costs ≤ 0.3 ms GPU and no extra draws.
- `tools/gate.sh full --both-renderers` is green.

## 4. Progress

| Item | Status |
|---|---|
| — | Not started. |

## 5. Decision log

- 2026-10-21: Planned from Temporal G7. The owner chose dither with a maximum
  fade below 1, a subject list, fading only above the subject's feet,
  multi-floor correctness, and everything taking part by default.
- 2026-10-21 (owner, decision session): the height rule is "nothing below half
  the subject's height fades", the same everywhere. It replaces the "2D vs 3D
  project" default (P39-1).
