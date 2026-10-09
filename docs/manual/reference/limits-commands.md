# Limits and defaults: commands

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The limits and defaults `@thirdlight/commands` defines, by source file. Values are the running build's.

<a id="limits-commands--errors"></a>
## `errors.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-request-bytes"></a>`MAX_REQUEST_BYTES` | `65536` | The canonical request byte cap (65 536). |

<a id="limits-commands--ops"></a>
## `ops.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-create-entities-max"></a>`CREATE_ENTITIES_MAX` | `1024` | The most entities one `createEntities` may create (folders' children included; the 64 KiB request cap bounds it too). |

<a id="limits-commands--terrain-erosion-ops"></a>
## `terrain-erosion-ops.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-erosion-layer-id-default"></a>`EROSION_LAYER_ID_DEFAULT` | `"erosion"` | The layer an erode writes when it names none. |
