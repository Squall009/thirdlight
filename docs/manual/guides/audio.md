# Audio

**Goal:** a looping hum at a machine in the level, and a blip played by a
script each time the player jumps. Every format, load type, bus and
setting: [Audio, music and fonts](../features/audio.md).

**Audio** is one kind of asset, whatever its length: Ogg Vorbis, Ogg Opus,
MP3, WAV and FLAC. Sound effects, music, voice and UI are mixer **buses**,
not kinds. Sound is presentation only: the game simulation never waits for
it or reads it back.

## In the editor

1. Bring the files in: in the project window, choose a folder and drop the
   files on the list (or **upload**), or put them in the game folder and use
   **import folder…** with a label such as `sfx`.
2. Choose an audio asset: its Inspector shows the **load type** (decode on
   load for short sounds, stream for long ones; the default follows the
   length), **preload**, and a play button after "enable preview sound".
3. Select the machine, **+ Add component → Audio source**, pick `hum`, set
   **Range**. The Scene view draws the full-volume and silent distances.
4. A script plays the blip (see [scripts](scripts.md)); give the sound to
   it through an asset property, so the export ships the file:
   ```ts
   import type { BehaviorContext } from '@thirdlight/runtime';

   export const properties = {
     sound: property.assetRef(null, { tooltip: 'Played on every jump' }),
   };

   export default {
     step(_state: unknown, ctx: BehaviorContext): void {
       if (ctx.input.pressed('jump') && ctx.properties.sound !== null) {
         ctx.audio.play(ctx.properties.sound as string, { bus: 'sfx', volume: 0.8 });
       }
     },
   };
   ```
   Put it on an object and pick `blip` for **Sound**.
5. **▶ play** and click or press a key in the game first: browsers start
   sound only after the player's first key press or click.

Event sounds (a sound per named game event) are set in **File → Project
Settings… → Audio**.

## Through the API

1. Put the files in the game folder (here `assets/audio/`) and import the
   folder ([`importAssets`](../reference/ops-detail.md#op-importAssets)):
   `{"folder": "assets/audio", "labels": ["sfx"]}`. Each file becomes an
   asset named after it (`hum`, `blip`). Over MCP, `tl_content_upload
   {dataBase64, writeTo: "assets/audio/hum.wav"}` writes a file there first.
2. Load type and preload ([`setAssetOptions`](../reference/ops-detail.md#op-setAssetOptions)):
   `{"assetId": "hum", "loadType": "decode-on-load", "preload": true}` when
   the defaults do not fit (`loadType` also `decode-while-playing` or
   `stream`; `null` goes back to the default).
3. The loop ([`audioSource`](../reference/components-audio.md#component-audioSource)):
   `setComponent {"entityId": "<machine>", "component": "audioSource", "value": {"assetId": "hum", "volume": 0.6, "range": 16}}`.
4. Publish the script above ([the script guide](scripts.md#through-the-api))
   and attach it: `setBehaviorProperties {"entityId": "<object>", "behaviorId": "jumpsound", "values": {"sound": "blip"}}`.
5. Play, send a `jump` press as test input and read the diagnostics'
   `audio` block: the blip is listed under `playing.list` on the `sfx` bus.
   Without a real key press or click it stays `pending` with the unlock
   state `locked` (`waiting_for_gesture`); that is the browser's rule, not
   an error.

## Which to use

Import and audition sounds in the editor; loudness and timing are judged
by ear. Use the API to import a whole folder (a voice-over delivery) with
labels in one command. Place looping sounds with audio sources; play
one-shots from scripts, event sounds or timeline keys.

## Pitfalls

- **Nothing plays before the first key press or click.** A headless
  play-test sees sounds as pending, never heard; check `audio.playing` and
  `audio.started` instead, and listen in a real browser.
- **Name sounds through asset properties**, not string literals: the
  export ships only the assets objects and properties reference (or that
  carry an address or label). A literal id of a non-loadable asset is a
  Problems line.
- **Audio sources are heard by X distance to the player in 2D projects**
  and panned around the camera in 3D (the project setting **Audio
  sources**, `audio_spatial`).
- **Voices are limited** (`audio_voices`, 8 by default): the first sound
  dropped for it writes one Problems line, later ones are counted.
- **A script's sounds stop with its object** (scene unload, a destroyed
  copy) unless played with `owner: 'scene'` or `'none'`.
- **Files are bounded only by size** (32 MiB each). Some browsers do not
  play Ogg; the Problems list says which files.

While writing this guide, Play in a browser after one click reported the
hum looping and the blips started on the `sfx` bus (the audio graph's
state); how it sounds was not checked by ear (unverified).

Related: [scripts](scripts.md), [Audio, music and fonts](../features/audio.md).
