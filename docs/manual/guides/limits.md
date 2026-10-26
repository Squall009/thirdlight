# Limits

**Goal:** know which limits your game can meet, what happens when it does,
and which ones you can change.

## No count limits on a project

A project holds as many assets, resources and scenes as a full game needs:
models, textures, sounds, prefabs, scripts, materials, scenes, dialogues,
block types, presets. There is no per-project count of any of them. Each is
its own file, so what is bounded is **one file's size** and **the running
game's memory**.

## The three kinds of limit

Each number below links to its constant in the generated reference, which
holds this build's value.

- **Per file or per object.** One content file is at most 1 MiB
  ([`MAX_CONTENT_FILE_BYTES`](../reference/limits-project-model-1.md#limit-max-content-file-bytes)),
  one imported asset at most 32 MiB
  ([`CONTENT_STAGE_MAX`](../reference/limits-protocol.md#limit-content-stage-max)),
  one scene's objects at most 32 MiB of scene document, about four times
  16,384 plain objects
  ([`SCENE_OBJECT_BUDGET_BYTES`](../reference/limits-project-model-2.md#limit-scene-object-budget-bytes);
  a memory budget, not a count: `tl_inspect target="project"` shows each
  scene's `objectBytes`),
  one instance set at most 65,536 copies
  ([`MAX_INSTANCES`](../reference/limits-project-model-2.md#limit-max-instances)),
  one block layer at most 1,024 × 256 × 1,024 cells of bounds
  ([`BLOCK_LIMITS`](../reference/limits-project-model-1.md#limit-block-limits)
  `layerWidth`, `layerHeight`). A big world is several scenes loaded
  together.
- **Per request or per step.** One command is at most 64 KiB
  ([`MAX_REQUEST_BYTES`](../reference/limits-project-model-1.md#limit-max-request-bytes)):
  a larger edit is staged (an upload) or split (a long brush drag is
  several strokes). A script may spawn 64 objects a step
  ([`MAX_SPAWNS_PER_STEP`](../reference/limits-runtime.md#limit-max-spawns-per-step));
  at most 16 realtime or mixed point and spot lights shine across the loaded
  scenes (baked ones and area lights are not counted)
  ([`MAX_LOCAL_LIGHTS`](../reference/limits-project-model-1.md#limit-max-local-lights)).
- **Runtime budgets.** Memory the running game may use: textures
  (`texture_budget_mb`, default
  [512 MiB](../reference/limits-project-model-2.md#limit-texture-budget-default-mb)),
  streamed terrain tiles and block chunks (`streaming_budget_mb`, default
  [768 MiB](../reference/limits-project-model-2.md#limit-streaming-budget-default-mb)),
  light probes (128 MiB of GPU memory, fixed; the renderer's, not in the
  reference). A budget is never a refusal: the least needed detail is
  dropped first, and a ring that alone needs more is reported once in
  Problems.
- **Cost budgets of decals.** A spot of a level blends at most 16
  projected decals ([`DECAL_CELL_BUDGET`](../reference/limits-project-model-1.md#limit-decal-cell-budget));
  scripts' spawned marks keep the newest 256
  ([`DECAL_TRANSIENT_BUDGET`](../reference/limits-project-model-1.md#limit-decal-transient-budget)).
  Neither caps decals in a project; vertex paint has none (4 bytes a painted
  vertex). Which decal to use where, and what each costs:
  [Decals](../features/decals.md#limits-and-budgets),
  [Vertex paint](../features/vertex-paint.md#limits-and-budgets).

Every limit and default of this build, generated from the engine's source:
[the limits reference](../reference/limits.md#limits-index). Each with its
reason: [Engine limits](../features/tuning.md#engine-limits-constants).

## When you meet one

A command over a limit is refused and changes nothing. The answer names
the field and the limit, for example:

```json
{"ok": false, "error": {"code": "limits_exceeded", "path": "/args/value/bounds",
 "found": [2048, 8, 32], "message": "a layer spans at most 1024 × 256 × 1024 cells"}}
```

The editor shows the same message under **Problems**.

## Change a budget

**Editor:** **File → Project Settings…**: **Quality → Rendering → Streaming budget**
and **Texture budget**.

**API:** [`setSettings`](../reference/ops-detail.md#op-setSettings)
`{"settings": {"texture_budget_mb": 768, "streaming_budget_mb": 1024}}`
(each [1](../reference/limits-project-model-2.md#limit-streaming-budget-min-mb)–[65,536](../reference/limits-project-model-2.md#limit-streaming-budget-max-mb) MiB; see
[the settings](../reference/content-blocks-settings.md#content-settings)).

Raise a budget only for machines that have the memory: the defaults hold a
large landscape on a laptop with an integrated GPU sharing 8–16 GiB.

## Pitfalls

- **Limits you cannot change are engine constants**, sized for any game,
  each with its reason in the source. If your game needs more, split the
  thing (another scene, another layer, another set) rather than ask for a
  bigger one.
- **Per-object caps are not per-project caps.** A scene's memory budget
  is one scene's; load several scenes together for a larger world.
- **Measure before raising a budget**: see
  [measure and budget performance](performance.md).
