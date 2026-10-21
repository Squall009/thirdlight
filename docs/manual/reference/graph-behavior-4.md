# Graph: Visual script (part 4, from Character impulse (`api.character.impulse`))

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The Visual script node catalogue: port types, then each category's nodes with their inputs, outputs and fields.

<a id="node-behavior--api-character-impulse"></a>
### Character impulse (`api.character.impulse`)

Add `velocity` [x, y, z] (m/s, each at most 100 either way) to a player character's velocity at its next move (`entityId`, absent: the first player controller) — a push, a launch, a knock back or a bounce; its own acceleration then brings it back to what the input asks. A positive y lifts it off the ground. The 2D plane ignores z. Impulses in one step add up. False without that character or for a  An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `velocity` (vector)
- `entityId` "player" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `velocity` | velocity | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `entityId` | player | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-character-place"></a>
### Place character at (`api.character.place`)

Put a player character at `position` [x, y, z] (m; the 2D plane ignores z) from rest, facing `facing` degrees about +Y (0 faces +Z, 90 faces +X; absent: it keeps its way) — a `character_place` after this step's intent phase (called in a later phase: the next step's). It ends a walk under way. False without that character or for a bad point. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `position` (vector)
- `facing` (number)
- `entityId` "player" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `position` | position | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `entityId` | player | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-character-walk-to"></a>
### Walk character to (`api.character.walkTo`)

Have a player character's own controller walk it to `position` (its acceleration, collisions, slopes and animator speed as with the player's input; the player's input does not move it meanwhile): on the ground plane in 3D (the mark's height is where the ground is), along x on the 2D plane. It slows down near the mark and arrives within `arrive` m (absent: 0.1), then turns to `facing` degrees if gi An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `position` (vector)
- `run` (boolean)
- `arrive` (number)
- `facing` (number)
- `entityId` "player" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `position` | position | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `run` | run | boolean | `false` |  |
| `entityId` | player | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-character-walk-state"></a>
### Character walk state (`api.character.walkState`)

A walk's state: walking, arrived, blocked (it got no closer), stopped (a new walk, a placement, `stop` or the end of its scene), or null for an unknown handle.

Inputs:

- `handle` (number)

Outputs:

- `value` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-character-stop"></a>
### Stop character walk (`api.character.stop`)

Stop a player character's walk where it is. False when it was not walking. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "player" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | player | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-character-turn"></a>
### Turn character (`api.character.turn`)

Turn a player character to `facing` degrees about +Y (0 faces +Z, 90 faces +X) at its controller's turn speed in 3D; on the 2D plane its face-movement models turn at once (90 right, −90 left). False without that character. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `facing` (number)
- `entityId` "player" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `facing` | facing | number | `0` | -1000000000 – 1000000000 |
| `entityId` | player | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-character-set-enabled"></a>
### Enable character control (`api.character.setEnabled`)

Switch a player character's controller off (it stays where it is: no input, no gravity — a cutscene, a dialogue) or back on, in 3D and on the 2D plane; a `character_enable`. Lasts until changed or the run restarts. False without that character. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `enabled` (boolean)
- `entityId` "player" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `enabled` | enabled | boolean | `false` |  |
| `entityId` | player | string | `""` | ≤ 256 chars |

<a id="graph-behavior--look"></a>
## Look

- Set look (`api.look.set`): Give an object (and every mesh under it) a look override — a glow (emissive colour and intensity) and/or a tint — replacing any it had, until cleared or a new run. False for an object not loaded or a bad value. An empty entity means this object.
- Clear look (`api.look.clear`): Give an object its own look back. False when it had no override. An empty entity means this object.
- Look of (`api.look.get`): The object's look override now, or null when it has none. An empty entity means this object.

<a id="node-behavior--api-look-set"></a>
### Set look (`api.look.set`)

Give an object (and every mesh under it) a look override — a glow (emissive colour and intensity) and/or a tint — replacing any it had, until cleared or a new run. False for an object not loaded or a bad value. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)
- `emissive` (string)
- `emissiveIntensity` "emissive intensity" (number)
- `tint` (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |
| `emissive` | emissive | string | `""` | ≤ 256 chars |
| `tint` | tint | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-look-clear"></a>
### Clear look (`api.look.clear`)

Give an object its own look back. False when it had no override. An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `entityId` "object" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-look-get"></a>
### Look of (`api.look.get`)

The object's look override now, or null when it has none. An empty entity means this object.

Inputs:

- `entityId` "object" (string)

Outputs:

- `emissive` (string)
- `emissiveIntensity` "emissive intensity" (number)
- `tint` (string)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `entityId` | object | string | `""` | ≤ 256 chars |

<a id="graph-behavior--audio"></a>
## Audio

- Play sound (`api.audio.play`): Play an audio asset of any length (volume 0–1). Returns its handle (0 when refused: a bad id, more than 32 plays in one step or 64 sounds alive). The sound belongs to the script's object: it stops (fading out over `fadeOut` seconds, 0) when the object leaves the game — its scene unloads or reloads; `owner: 'scene'` ties it to the object's scene instead, `owner: 'none'` to nothing. Options: `loop`, An empty entity means this object.
- Stop sound (`api.audio.stop`): Stop a sound, fading out over `fadeSeconds` (0: now). Its finished event (reason "stopped") arrives in the step after the fade ends.
- Fade sound (`api.audio.fade`): Fade a sound's volume to `to` (0–1) over `seconds` (linear, whole steps).
- Set sound volume (`api.audio.setVolume`): Set a sound's volume (0–1) now.
- Set sound pitch (`api.audio.setPitch`): Set a sound's pitch — its playback rate, 0.25–4 (1: as recorded; it plays faster or slower too).
- Set sound loop (`api.audio.setLoop`): Loop a sound or let it end at the end of its clip.
- Sound playing (`api.audio.playing`): Whether a sound is still playing (its finished event has not happened).
- Sound volume (`api.audio.volumeOf`): A sound's volume now (its fade included; 0 when it is not playing).
- Sound finished (`api.audio.finished`): True in the step after a sound finished (it ended or was stopped).
- Set music (`api.audio.music`): Play an audio asset as the music track (looped), crossfading over `fadeSeconds` (1); null fades to silence. The scripts then own the music until `releaseMusic`. The track belongs to the script's object (`options.owner`: `scene`, `none`): when that goes, the music is released over the same fade.
- Release music (`api.audio.releaseMusic`): Give the music back to the host (silence: the engine has no level-flow music), crossfading over `fadeSeconds` (1).
- Play stinger (`api.audio.stinger`): Play a stinger (a short musical phrase) once over the music: the track ducks to `duck` (0.3) while it plays and comes back after it, both over `fade` seconds (0.25). Returns its handle.
- Duck music (`api.audio.duck`): Duck the music to `level` (0–1; 0.3) over `seconds` (0.25) until `unduck`. The deepest duck alive wins (a stinger's, dialogue voice's).
- Unduck music (`api.audio.unduck`): End the script's music duck over `seconds` (0.25).
- Music state (`api.audio.musicState`): Who picks the music (the scripts or the host), the scripts' track and the duck now.
- Set bus volume (`api.audio.setBusVolume`): Mix a bus (sfx, music, voice, ui) to `volume` (0–1) over `seconds` (0), on top of the player's volume setting.
- Bus volume (`api.audio.busVolume`): The scripts' mix of a bus now (1 unless set).
- Stop all sounds (`api.audio.stopAll`): Stop every sound on `bus` (sfx, music, voice, ui; every bus when absent) over `fadeSeconds` (0), whoever started it; on the music bus (or every bus) the scripts' music track is released too. Returns how many sounds it stopped.

<a id="node-behavior--api-audio-play"></a>
### Play sound (`api.audio.play`)

Play an audio asset of any length (volume 0–1). Returns its handle (0 when refused: a bad id, more than 32 plays in one step or 64 sounds alive). The sound belongs to the script's object: it stops (fading out over `fadeOut` seconds, 0) when the object leaves the game — its scene unloads or reloads; `owner: 'scene'` ties it to the object's scene instead, `owner: 'none'` to nothing. Options: `loop`, An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `assetId` "sound" (string)
- `volume` (number)
- `loop` (boolean)
- `pitch` (number)
- `fadeIn` "fade in" (number)
- `entityId` "entity" (string)
- `position` (vector)
- `refDistance` "ref distance" (number)
- `maxDistance` "max distance" (number)
- `rolloff` (number)
- `maxLateMs` "max late ms" (number)
- `fadeOut` "fade out" (number)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `assetId` | sound | string | `""` | ≤ 256 chars; a audio asset |
| `volume` | volume | number | `1` | -1000000000 – 1000000000 |
| `loop` | loop | boolean | `false` |  |
| `bus` | bus | enum | `"sfx"` | `sfx`, `music`, `voice`, `ui` |
| `entityId` | entity | string | `""` | ≤ 256 chars |
| `distanceModel` | distance model | enum | `"linear"` | `linear`, `inverse`, `exponential` |
| `owner` | owner | enum | `"object"` | `object`, `scene`, `none` |

<a id="node-behavior--api-audio-stop"></a>
### Stop sound (`api.audio.stop`)

Stop a sound, fading out over `fadeSeconds` (0: now). Its finished event (reason "stopped") arrives in the step after the fade ends.

Inputs:

- `in` "" (exec): takes several wires
- `handle` (number)
- `fadeSeconds` "fade seconds" (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |
| `fadeSeconds` | fade seconds | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-audio-fade"></a>
### Fade sound (`api.audio.fade`)

Fade a sound's volume to `to` (0–1) over `seconds` (linear, whole steps).

Inputs:

- `in` "" (exec): takes several wires
- `handle` (number)
- `to` (number)
- `seconds` (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |
| `to` | to | number | `0` | -1000000000 – 1000000000 |
| `seconds` | seconds | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-audio-set-volume"></a>
### Set sound volume (`api.audio.setVolume`)

Set a sound's volume (0–1) now.

Inputs:

- `in` "" (exec): takes several wires
- `handle` (number)
- `volume` (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |
| `volume` | volume | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-audio-set-pitch"></a>
### Set sound pitch (`api.audio.setPitch`)

Set a sound's pitch — its playback rate, 0.25–4 (1: as recorded; it plays faster or slower too).

Inputs:

- `in` "" (exec): takes several wires
- `handle` (number)
- `pitch` (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |
| `pitch` | pitch | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-audio-set-loop"></a>
### Set sound loop (`api.audio.setLoop`)

Loop a sound or let it end at the end of its clip.

Inputs:

- `in` "" (exec): takes several wires
- `handle` (number)
- `loop` (boolean)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |
| `loop` | loop | boolean | `false` |  |

<a id="node-behavior--api-audio-playing"></a>
### Sound playing (`api.audio.playing`)

Whether a sound is still playing (its finished event has not happened).

Inputs:

- `handle` (number)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-audio-volume-of"></a>
### Sound volume (`api.audio.volumeOf`)

A sound's volume now (its fade included; 0 when it is not playing).

Inputs:

- `handle` (number)

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-audio-finished"></a>
### Sound finished (`api.audio.finished`)

True in the step after a sound finished (it ended or was stopped).

Inputs:

- `handle` (number)

Outputs:

- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `handle` | handle | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-audio-music"></a>
### Set music (`api.audio.music`)

Play an audio asset as the music track (looped), crossfading over `fadeSeconds` (1); null fades to silence. The scripts then own the music until `releaseMusic`. The track belongs to the script's object (`options.owner`: `scene`, `none`): when that goes, the music is released over the same fade.

Inputs:

- `in` "" (exec): takes several wires
- `assetId` "track" (string)
- `fadeSeconds` "fade seconds" (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `assetId` | track | string | `""` | ≤ 256 chars; a audio asset |
| `fadeSeconds` | fade seconds | number | `1` | -1000000000 – 1000000000 |
| `owner` | owner | enum | `"object"` | `object`, `scene`, `none` |

<a id="node-behavior--api-audio-release-music"></a>
### Release music (`api.audio.releaseMusic`)

Give the music back to the host (silence: the engine has no level-flow music), crossfading over `fadeSeconds` (1).

Inputs:

- `in` "" (exec): takes several wires
- `fadeSeconds` "fade seconds" (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `fadeSeconds` | fade seconds | number | `1` | -1000000000 – 1000000000 |

<a id="node-behavior--api-audio-stinger"></a>
### Play stinger (`api.audio.stinger`)

Play a stinger (a short musical phrase) once over the music: the track ducks to `duck` (0.3) while it plays and comes back after it, both over `fade` seconds (0.25). Returns its handle.

Inputs:

- `in` "" (exec): takes several wires
- `assetId` "sound" (string)
- `volume` (number)
- `duck` (number)
- `fade` (number)
- `maxLateMs` "max late ms" (number)
- `fadeOut` "fade out" (number)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `assetId` | sound | string | `""` | ≤ 256 chars; a audio asset |
| `owner` | owner | enum | `"object"` | `object`, `scene`, `none` |

<a id="node-behavior--api-audio-duck"></a>
### Duck music (`api.audio.duck`)

Duck the music to `level` (0–1; 0.3) over `seconds` (0.25) until `unduck`. The deepest duck alive wins (a stinger's, dialogue voice's).

Inputs:

- `in` "" (exec): takes several wires
- `level` (number)
- `seconds` (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `level` | level | number | `0.3` | -1000000000 – 1000000000 |
| `seconds` | seconds | number | `0.25` | -1000000000 – 1000000000 |

<a id="node-behavior--api-audio-unduck"></a>
### Unduck music (`api.audio.unduck`)

End the script's music duck over `seconds` (0.25).

Inputs:

- `in` "" (exec): takes several wires
- `seconds` (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `seconds` | seconds | number | `0.25` | -1000000000 – 1000000000 |

<a id="node-behavior--api-audio-music-state"></a>
### Music state (`api.audio.musicState`)

Who picks the music (the scripts or the host), the scripts' track and the duck now.

Outputs:

- `owner` (string)
- `track` (string)
- `duck` (number)

<a id="node-behavior--api-audio-set-bus-volume"></a>
### Set bus volume (`api.audio.setBusVolume`)

Mix a bus (sfx, music, voice, ui) to `volume` (0–1) over `seconds` (0), on top of the player's volume setting.

Inputs:

- `in` "" (exec): takes several wires
- `volume` (number)
- `seconds` (number)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `bus` | bus | enum | `"sfx"` | `sfx`, `music`, `voice`, `ui` |
| `volume` | volume | number | `1` | -1000000000 – 1000000000 |
| `seconds` | seconds | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-audio-bus-volume"></a>
### Bus volume (`api.audio.busVolume`)

The scripts' mix of a bus now (1 unless set).

Outputs:

- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `bus` | bus | enum | `"sfx"` | `sfx`, `music`, `voice`, `ui` |

<a id="node-behavior--api-audio-stop-all"></a>
### Stop all sounds (`api.audio.stopAll`)

Stop every sound on `bus` (sfx, music, voice, ui; every bus when absent) over `fadeSeconds` (0), whoever started it; on the music bus (or every bus) the scripts' music track is released too. Returns how many sounds it stopped.

Inputs:

- `in` "" (exec): takes several wires
- `fadeSeconds` "fade seconds" (number)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `bus` | bus | enum | `"sfx"` | `sfx`, `music`, `voice`, `ui` |
| `fadeSeconds` | fade seconds | number | `0` | -1000000000 – 1000000000 |

<a id="graph-behavior--effects"></a>
## Effects

- Play effect (`api.effects.play`): Play a project effect (particles) once: on `entityId` (it follows the object; `position` is then an offset from it) or, without one, at `position` in world metres. `params` override its public parameters. Returns a handle for `stop`, or 0 when refused (a bad id, more than 32 plays in one step). An empty entity means this object.
- Stop effect (`api.effects.stop`): Stop spawning: a play's handle, or an object's id (every effect playing on it, its effect component included). Living particles finish their lifetimes.

<a id="node-behavior--api-effects-play"></a>
### Play effect (`api.effects.play`)

Play a project effect (particles) once: on `entityId` (it follows the object; `position` is then an offset from it) or, without one, at `position` in world metres. `params` override its public parameters. Returns a handle for `stop`, or 0 when refused (a bad id, more than 32 plays in one step). An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `effectId` "effect" (string)
- `position` (vector)
- `entityId` "entity" (string)
- `params` (map)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `effectId` | effect | string | `""` | ≤ 256 chars |
| `entityId` | entity | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-effects-stop"></a>
### Stop effect (`api.effects.stop`)

Stop spawning: a play's handle, or an object's id (every effect playing on it, its effect component included). Living particles finish their lifetimes.

Inputs:

- `in` "" (exec): takes several wires
- `target` (number): type from field `target_type`

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `target_type` | target type | enum | `"number"` | `number`, `string` |
| `target` | target | string | `""` | ≤ 256 chars |

<a id="graph-behavior--decals"></a>
## Decals

- Spawn decal (`api.decals.spawn`): Leave a projected decal (a bullet hole, a footprint, a scorch mark): the `decal` of prefab `prefabId` (its first object carrying one), centred on `position` (world metres) and facing out of the surface along `normal` (it projects back along it; absent: up), turned `angle` degrees about the normal, its box scaled by `scale`. With `entityId` it sticks to that object (`position` and `normal` in the o An empty entity means this object.
- Remove decal (`api.decals.remove`): Fade spawned decals out now: a spawn's handle, or an object's id (every decal spawned on it).

<a id="node-behavior--api-decals-spawn"></a>
### Spawn decal (`api.decals.spawn`)

Leave a projected decal (a bullet hole, a footprint, a scorch mark): the `decal` of prefab `prefabId` (its first object carrying one), centred on `position` (world metres) and facing out of the surface along `normal` (it projects back along it; absent: up), turned `angle` degrees about the normal, its box scaled by `scale`. With `entityId` it sticks to that object (`position` and `normal` in the o An empty entity means this object.

Inputs:

- `in` "" (exec): takes several wires
- `prefabId` "prefab" (string)
- `position` (vector)
- `normal` (vector)
- `angle` (number)
- `scale` (number)
- `lifetime` (number)
- `entityId` "entity" (string)

Outputs:

- `then` "" (exec): one wire
- `value` (number)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `prefabId` | prefab | string | `""` | ≤ 256 chars |
| `entityId` | entity | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-decals-remove"></a>
### Remove decal (`api.decals.remove`)

Fade spawned decals out now: a spawn's handle, or an object's id (every decal spawned on it).

Inputs:

- `in` "" (exec): takes several wires
- `target` (number): type from field `target_type`

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `target_type` | target type | enum | `"number"` | `number`, `string` |
| `target` | target | string | `""` | ≤ 256 chars |

<a id="graph-behavior--save"></a>
## Save

- Saved value (`api.save.get`): The value kept under `key` (undefined when there is none).
- Save value (`api.save.set`): Keep a value under `key`; `false` when it does not fit (a bad key, 64 keys, 4 KB).
- Remove saved value (`api.save.remove`): Forget the value under `key`.
- Saved keys (`api.save.keys`): The keys of the kept values.

<a id="node-behavior--api-save-get"></a>
### Saved value (`api.save.get`)

The value kept under `key` (undefined when there is none).

Inputs:

- `key` (string)

Outputs:

- `value` (number): type from field `value_type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | key | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |

<a id="node-behavior--api-save-set"></a>
### Save value (`api.save.set`)

Keep a value under `key`; `false` when it does not fit (a bad key, 64 keys, 4 KB).

Inputs:

- `in` "" (exec): takes several wires
- `key` (string)
- `value` (number): type from field `value_type`

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | key | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string`, `vector`, `list`, `map` |
| `value` | value | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-save-remove"></a>
### Remove saved value (`api.save.remove`)

Forget the value under `key`.

Inputs:

- `in` "" (exec): takes several wires
- `key` (string)

Outputs:

- `then` "" (exec): one wire

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `key` | key | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-save-keys"></a>
### Saved keys (`api.save.keys`)

The keys of the kept values.

Outputs:

- `value` (list)

<a id="graph-behavior--grid"></a>
## Grid

- Block layers (`api.grid.layers`): The block layers of the loaded scenes (their entity ids, in load order).
- Get cell (`api.grid.get`): The cell at [x, y, z] of a layer, or null when it is empty (or no such layer).
- Set cell (`api.grid.set`): Write a cell: a block and/or metadata overrides. False when refused.
- Clear cell (`api.grid.clear`): Empty a cell (its block and metadata). False when refused or already empty.
- Column top (`api.grid.columnTop`): The highest cell of a column holding a block (its y), or null.
- Surface below (`api.grid.surface`): The ground straight down from a world position: the top of the layer's blocks at or below it (sloped tops, ramps and half blocks included; inside the blocks: the top of the blocks there), with its height, normal, slope and whether it is walkable; null when the column holds no block.
- Column surface (`api.grid.columnSurface`): The top surface of a column at its centre (cell x, z): the highest block's top, its height, normal, slope and whether it is walkable; null when the column holds no block.
- World to cell (`api.grid.worldToCell`): The cell holding a world position (it may lie outside the layer's bounds), or null for no such layer.
- Cell to world (`api.grid.cellToWorld`): The world position of a cell's centre, or null for no such layer.
- Cell metadata (`api.grid.meta`): One effective metadata value of a cell (defaults included), or null for an unknown field or layer.
- Set cell metadata (`api.grid.setMeta`): Set one metadata value of a cell (null removes the override; an empty cell becomes a metadata-only cell). False when refused.
- Pick cell (`api.grid.pick`): The first block cell a ray enters (every layer, or one), with the face it entered through; null when none within maxDistance (default 100 m).
- Neighbour cells (`api.grid.neighbours`): The cells next to [x, y, z] inside the layer's bounds: the 6 face neighbours, or all 26 with diagonal.
- Walk neighbours (`api.grid.walkNeighbours`): The places one step away from the place a cell names (the top it is, or the top a walker in that cell stands on): to the four neighbouring columns (eight with diagonal), within the step, drop and headroom limits, not across a wall or closed door; each with its cost (metres, times any cost field).
- Walk path (`api.grid.path`): The cheapest walk between the places two cells name ([x, y, z] each), start and end included, each with the cost so far; null when there is none (or the search passes 65,536 places: `pathOutcome` tells which).
- Walk path outcome (`api.grid.pathOutcome`): Why the last `path` call answered as it did: "found"; "none" (no walk joins the two places); "limit" (the search passed 65,536 places first: a path may still exist, e.g. ask for a nearer cell); "invalid" (a layer, cell or option that does not fit, or no place at a cell). Null before the first call.
- Walk reach (`api.grid.reachable`): The places reachable from the place a cell names within a cost (metres, times any cost field), cheapest first, the start included (at most 65,536).
- Regions (`api.grid.regions`): The region ids of a layer (each room drawn on it is one too: its outline's id, and "-s1", "-s2"… for its upper storeys).
- Region cells (`api.grid.region`): The cells of a named region (at most 65,536), or null when the layer has no such region.
- In region (`api.grid.inRegion`): Whether a cell lies in a named region.
- Set cut-away (`api.grid.setCutaway`): Force a cut-away zone of a layer hidden (true) or shown (false) whatever the subject does, or give it back to the subject (null). A zone is a region the layer's cutaway lists, or "#<row>" for one of its height planes. Drawing only (it fades like any cut-away). False when refused (an unknown layer or zone).
- Set cut-away subject (`api.grid.setCutawaySubject`): The object whose position decides the layers' cut-aways (what is cut while it stands under or inside it), or null for the camera's target (the default). False when the id is not a string.
- Set cut-away point (`api.grid.setCutawayPoint`): A world point [x, y, z] that decides the layers' cut-aways in place of an object. False when it is not three finite numbers.
- Set kit (`api.grid.setKit`): Show a kit over a layer (no region) or one of its regions: its block types are drawn, collide and spawn as each type's swap under the kit, without changing the cells (a dungeon burnt in place). Null shows no kit there (the authored one included); the layer re-meshes in the background, the old look drawn until the new is ready. False when refused (an unknown layer, kit or region). Saved with the gr
- Kit (`api.grid.kit`): The kit a layer (no region) or one of its regions shows now (null: none).
- Set architecture preset (`api.grid.setArchitecturePreset`): Restyle generated architecture: every outline styled by preset `from` is made by preset `to` instead (its style, values and trim sheet), in every loaded and later loaded scene, without touching the outlines; null puts `from` back. The page makes the changed chunks in the background, the old ones drawn until the new are in, and the colliders follow. False when refused (not preset ids, `to` not a pr
- Architecture preset (`api.grid.architecturePreset`): The preset shown in place of `from` now (null: `from` itself).
- Door link near (`api.grid.doorLink`): The linked door nearest a world point within `reach` metres (absent: 2) on the ground, or null.
- Get edge (`api.grid.edge`): The edge piece on a side of a cell (a wall, door or fence between it and its neighbour), or null when none stands there.
- Edge blocked (`api.grid.blocked`): Whether an edge piece blocks moving from a cell across one of its sides (a wall or a closed door does; an open door, a non-blocking piece or no piece does not). Where no piece stands, a room's wall drawn on the layer blocks (its doorways and windows do not).
- Set edge (`api.grid.setEdge`): Put an edge piece on a side of a cell. False when refused (not an edge block type, outside the bounds, a rotation other than 0 or 180).
- Clear edge (`api.grid.clearEdge`): Remove the edge piece on a side of a cell. False when refused or none stands there.
- Open edge (`api.grid.setEdgeOpen`): Open or close the edge piece on a side of a cell (a door): open, it blocks no passage and has no collider. False when none stands there or it already is.
- Edge object (`api.grid.edgeEntity`): The id of the object a live edge piece spawns (its prefab's root), or null when the edge shows no live piece.
- Cell object (`api.grid.entity`): The id of the object a live block's cell spawns (its prefab's root; a cell a larger block covers names the block's), or null when the cell shows no live block. The id is the cell's from the write on; the object is in the game from the end of the step that wrote the cell.
- Object cell (`api.grid.cellOf`): The cell a live block's object belongs to (its root or any of its children; the block's anchor cell; for a live edge piece the cell whose side it stands on, with that side), or null for any other object. An empty entity means this object.

<a id="node-behavior--api-grid-layers"></a>
### Block layers (`api.grid.layers`)

The block layers of the loaded scenes (their entity ids, in load order).

Outputs:

- `value` (list)

<a id="node-behavior--api-grid-get"></a>
### Get cell (`api.grid.get`)

The cell at [x, y, z] of a layer, or null when it is empty (or no such layer).

Inputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)

Outputs:

- `block` (string)
- `rot` (number)
- `variant` (number)
- `piece` (string)
- `kitBlock` "kit block" (string)
- `meta` (map)
- `anchor_x` "anchor x" (number)
- `anchor_y` "anchor y" (number)
- `anchor_z` "anchor z" (number)
- `corners` (list)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-grid-set"></a>
### Set cell (`api.grid.set`)

Write a cell: a block and/or metadata overrides. False when refused.

Inputs:

- `in` "" (exec): takes several wires
- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)
- `block` (string)
- `rot` (number)
- `variant` (number)
- `corners` (list)
- `meta` (map)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `block` | block | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-clear"></a>
### Clear cell (`api.grid.clear`)

Empty a cell (its block and metadata). False when refused or already empty.

Inputs:

- `in` "" (exec): takes several wires
- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-grid-column-top"></a>
### Column top (`api.grid.columnTop`)

The highest cell of a column holding a block (its y), or null.

Inputs:

- `layer` (string)
- `x` (number)
- `z` (number)

Outputs:

- `value` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-grid-surface"></a>
### Surface below (`api.grid.surface`)

The ground straight down from a world position: the top of the layer's blocks at or below it (sloped tops, ramps and half blocks included; inside the blocks: the top of the blocks there), with its height, normal, slope and whether it is walkable; null when the column holds no block.

Inputs:

- `layer` (string)
- `position` (vector)

Outputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)
- `height` (number)
- `point_x` "point x" (number)
- `point_y` "point y" (number)
- `point_z` "point z" (number)
- `normal_x` "normal x" (number)
- `normal_y` "normal y" (number)
- `normal_z` "normal z" (number)
- `slope` (number)
- `walkable` (boolean)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `position` | position | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--api-grid-column-surface"></a>
### Column surface (`api.grid.columnSurface`)

The top surface of a column at its centre (cell x, z): the highest block's top, its height, normal, slope and whether it is walkable; null when the column holds no block.

Inputs:

- `layer` (string)
- `x` (number)
- `z` (number)

Outputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)
- `height` (number)
- `point_x` "point x" (number)
- `point_y` "point y" (number)
- `point_z` "point z" (number)
- `normal_x` "normal x" (number)
- `normal_y` "normal y" (number)
- `normal_z` "normal z" (number)
- `slope` (number)
- `walkable` (boolean)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-grid-world-to-cell"></a>
### World to cell (`api.grid.worldToCell`)

The cell holding a world position (it may lie outside the layer's bounds), or null for no such layer.

Inputs:

- `layer` (string)
- `position` (vector)

Outputs:

- `x` (number)
- `y` (number)
- `z` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `position` | position | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |

<a id="node-behavior--api-grid-cell-to-world"></a>
### Cell to world (`api.grid.cellToWorld`)

The world position of a cell's centre, or null for no such layer.

Inputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)

Outputs:

- `x` (number)
- `y` (number)
- `z` (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |

<a id="node-behavior--api-grid-meta"></a>
### Cell metadata (`api.grid.meta`)

One effective metadata value of a cell (defaults included), or null for an unknown field or layer.

Inputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)
- `key` (string)

Outputs:

- `value` (number): type from field `value_type`

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `key` | key | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string` |

<a id="node-behavior--api-grid-set-meta"></a>
### Set cell metadata (`api.grid.setMeta`)

Set one metadata value of a cell (null removes the override; an empty cell becomes a metadata-only cell). False when refused.

Inputs:

- `in` "" (exec): takes several wires
- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)
- `key` (string)
- `value` (number): type from field `value_type`

Outputs:

- `then` "" (exec): one wire
- `value` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `key` | key | string | `""` | ≤ 256 chars |
| `value_type` | value type | enum | `"number"` | `number`, `boolean`, `string` |
| `value` | value | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-pick"></a>
### Pick cell (`api.grid.pick`)

The first block cell a ray enters (every layer, or one), with the face it entered through; null when none within maxDistance (default 100 m).

Inputs:

- `origin` (vector)
- `direction` (vector)
- `maxDistance` "max distance" (number)
- `layer` (string)

Outputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)
- `normal_x` "normal x" (number)
- `normal_y` "normal y" (number)
- `normal_z` "normal z" (number)
- `distance` (number)
- `point_x` "point x" (number)
- `point_y` "point y" (number)
- `point_z` "point z" (number)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `origin` | origin | vector | `[0,0,0]` | -1000000000 – 1000000000; 3 components |
| `direction` | direction | vector | `[0,-1,0]` | -1000000000 – 1000000000; 3 components |
| `layer` | layer | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-neighbours"></a>
### Neighbour cells (`api.grid.neighbours`)

The cells next to [x, y, z] inside the layer's bounds: the 6 face neighbours, or all 26 with diagonal.

Inputs:

- `layer` (string)
- `x` (number)
- `y` (number)
- `z` (number)
- `diagonal` (boolean)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `x` | x | number | `0` | -1000000000 – 1000000000 |
| `y` | y | number | `0` | -1000000000 – 1000000000 |
| `z` | z | number | `0` | -1000000000 – 1000000000 |
| `diagonal` | diagonal | boolean | `false` |  |

<a id="node-behavior--api-grid-walk-neighbours"></a>
### Walk neighbours (`api.grid.walkNeighbours`)

The places one step away from the place a cell names (the top it is, or the top a walker in that cell stands on): to the four neighbouring columns (eight with diagonal), within the step, drop and headroom limits, not across a wall or closed door; each with its cost (metres, times any cost field).

Inputs:

- `layer` (string)
- `cell` (list)
- `maxStep` "max step" (number)
- `maxDrop` "max drop" (number)
- `headroom` (number)
- `maxSlope` "max slope" (number)
- `diagonal` (boolean)
- `field` (string)
- `costField` "cost field" (string)
- `avoid` (list)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `diagonal` | diagonal | boolean | `false` |  |
| `field` | field | string | `""` | ≤ 256 chars |
| `costField` | cost field | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-path"></a>
### Walk path (`api.grid.path`)

The cheapest walk between the places two cells name ([x, y, z] each), start and end included, each with the cost so far; null when there is none (or the search passes 65,536 places: `pathOutcome` tells which).

Inputs:

- `layer` (string)
- `from` (list)
- `to` (list)
- `maxStep` "max step" (number)
- `maxDrop` "max drop" (number)
- `headroom` (number)
- `maxSlope` "max slope" (number)
- `diagonal` (boolean)
- `field` (string)
- `costField` "cost field" (string)
- `avoid` (list)

Outputs:

- `value` (list)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `diagonal` | diagonal | boolean | `false` |  |
| `field` | field | string | `""` | ≤ 256 chars |
| `costField` | cost field | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-path-outcome"></a>
### Walk path outcome (`api.grid.pathOutcome`)

Why the last `path` call answered as it did: "found"; "none" (no walk joins the two places); "limit" (the search passed 65,536 places first: a path may still exist, e.g. ask for a nearer cell); "invalid" (a layer, cell or option that does not fit, or no place at a cell). Null before the first call.

Outputs:

- `value` (string)
- `found` (boolean)

<a id="node-behavior--api-grid-reachable"></a>
### Walk reach (`api.grid.reachable`)

The places reachable from the place a cell names within a cost (metres, times any cost field), cheapest first, the start included (at most 65,536).

Inputs:

- `layer` (string)
- `from` (list)
- `maxCost` "max cost" (number)
- `maxStep` "max step" (number)
- `maxDrop` "max drop" (number)
- `headroom` (number)
- `maxSlope` "max slope" (number)
- `diagonal` (boolean)
- `field` (string)
- `costField` "cost field" (string)
- `avoid` (list)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `maxCost` | max cost | number | `0` | -1000000000 – 1000000000 |
| `diagonal` | diagonal | boolean | `false` |  |
| `field` | field | string | `""` | ≤ 256 chars |
| `costField` | cost field | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-regions"></a>
### Regions (`api.grid.regions`)

The region ids of a layer (each room drawn on it is one too: its outline's id, and "-s1", "-s2"… for its upper storeys).

Inputs:

- `layer` (string)

Outputs:

- `value` (list)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |

<a id="node-behavior--api-grid-region"></a>
### Region cells (`api.grid.region`)

The cells of a named region (at most 65,536), or null when the layer has no such region.

Inputs:

- `layer` (string)
- `regionId` "region" (string)

Outputs:

- `value` (list)
- `found` (boolean)

Fields:

| Field | Label | Type | Default | Range |
|---|---|---|---|---|
| `layer` | layer | string | `""` | ≤ 256 chars |
| `regionId` | region | string | `""` | ≤ 256 chars |
