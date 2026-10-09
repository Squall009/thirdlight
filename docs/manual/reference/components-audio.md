# Components: Audio

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Audio components. Fields list the stored keys; paths with `[]` are list items and `{}` map values.

<a id="component-audioSource"></a>
## audioSource — Audio source

A looping sound here, louder as the player comes near (along X), or panned around the camera (the project's Audio sources setting; 3D projects).

- Category: Audio
- Added: from "+ Add component" after picking `assetId` (the rest starts as `{"volume":0.8,"range":12}`)
- On prefab objects: yes
- Icon: audio

| Field | Type | Default | Range | Description |
|---|---|---|---|---|
| `assetId` | asset id (audio) |  |  | **Sound.** An audio asset (any length: short sounds, music, ambience). (required; scripts read) |
| `volume` | number | `0.8` | 0 – 1, step 0.05 | **Volume.** Volume at full strength. (required; scripts read) |
| `range` | number | `12` | 0.5 – 500, step 0.5, m | **Range.** Heard within this distance (full volume within a quarter of it). Panned: its max distance. (required; Scene handle: radius; scripts read) |
| `distanceModel` | enum: `linear`, `inverse`, `exponential` | `"linear"` |  | **Distance model.** Panned: how the volume falls with distance — linear (silent at the range), inverse or exponential (natural falloff, quieter but never silent within the range). (scripts read) |
| `refDistance` | number | `3` | 0.01 – 500, step 0.25, m | **Full volume within.** Panned: full volume within this distance (absent: a quarter of the range). (scripts read) |
| `rolloff` | number | `1` | 0 – 10, step 0.1 | **Rolloff.** Panned: how fast the volume falls (1: the model's natural rate). (scripts read) |

Scene-view handles:

| Handle | Kind | Edits | Space | Shown when |
|---|---|---|---|---|
| Range | radius | radius → `range` | local |  |
