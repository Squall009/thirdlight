# Audio, music and fonts

Audio assets and how they load, audio sources, script audio with buses,
music and 3D panning, and font assets. Step by step:
[the audio guide](../guides/audio.md).

The engine has no built-in level flow (levels, lives, title/pause/end menus,
per-level music): a game's menus and HUD are the **game shell**'s UI
documents ([The game shell](../concepts/game-shell.md)), its scene order
the shell's scene list, and anything like lives or a level timer is the
game's own scripts over named counters. A project from an older engine that
still has a `content.flow` is refused on open, naming it
([Migration notes](migration.md#migration-notes)).

## Audio assets

**Audio** is one kind of asset, whatever its length or use (Unity's
`AudioClip`, Godot's `AudioStream`): Ogg Vorbis, Ogg Opus, MP3, WAV (integer
PCM of 8–32 bits or 32/64-bit float, plain or extensible) and FLAC, at any
channel count and sample rate, of any length; only the file size is bounded
(32 MiB, as every imported file). Sound effects, music, voice and UI are
mixer buses, not kinds: a footstep, a voice line and an hour of ambience are
all `audio`, and any of them can be a dialogue voice or blip, an audio
source, an event sound, a timeline key, `ctx.audio.play` or
`ctx.audio.music`. The import reads the headers only (no transcoding). A WAV
of ADPCM, µ-law or A-law is refused (MDN lists no browser that plays them);
Ogg Vorbis and Ogg Opus are imported, and the Problems list notes that
Safari before 18.4 (macOS 15.4, iOS 18.4) does not play them, as it does for
more than 32 channels or a rate outside 8–96 kHz.

Each audio asset has two import settings, in its `.tlasset` sidecar and in
the audio asset's Inspector (`setAssetOptions {assetId, loadType, preload}`,
one undo): the **load type** — *decode on load* (decoded into memory when it
loads, no wait when played), *decode while playing* (kept compressed,
decoded when played) or *stream* — defaulting by length: under 5 s decode on
load, over 60 s stream, anything between decode while playing; and
**preload** — read with the scene that uses it (the default) or only when
played (a long dialogue's voice lines). The runtime catalog's entry for the
file carries both.
Nothing audio is read when a game starts. A preloaded file is read with the
scene that names it (an audio source, say) and kept until that scene
unloads; files the project-wide parts name (event sounds, timelines, the
shell) are read after the start and kept for the play. A file that is not
preloaded is read when first played and then kept while the scenes loaded at
that moment stay loaded. *Decode on load* keeps the decoded sound, *decode
while playing* keeps the compressed file and decodes it for each play,
*stream* plays through a media element that reads the file as it plays
(nothing is kept). A running conversation reads the voices of the lines
ahead on every branch, three lines deep, and decodes those of the next
lines, so a voice starts with its line. A sound played before its file is
ready starts when it is, unless it would start later than its bound, then it
is dropped: `maxLateMs` on `ctx.audio.play` / `stinger` (default 500 ms, 0:
now or never, at most 60 s), on an event sound row, on a timeline stinger or
sfx key, and the dialogue setting `voiceMaxLateMs` (default 1000 ms) for
voices; loops and music wait as long as it takes. `tl_game_observe` `audio.
late` counts the sounds that started late and those dropped, with the newest
of each (asset, how late, the bound, and whether it waited for its file or
for the first click), and `resources.resident` reports `audio` (decoded),
`audio-bytes` (kept compressed) and `audio-stream` (streams playing). A
project with `music`
records (or short-sound records of the old fixed 2 s mono WAV profile) is
upgraded on open: each becomes `audio` with its id and file kept, and the
upgrade is listed in Problems. Sound starts with the first key press or
click (the browser's sound rule). `tl_game_observe` reports `loops` (each
audio source's current gain).

## Fonts

**Font** assets are TrueType (.ttf), OpenType (.otf), WOFF2 or WOFF files up
to 4 MiB, as many as the project needs. Choose or drop the file in
the project window like other assets, or upload it with `tl_content_upload`
kind `font` and publish it with kind `font`. The import checks the file's
container only (the family name of a TTF/OTF is shown when it has one); the
game's UI loads the font in the browser. A font ships with Play and the export
when the project's UI uses it.

## Audio sources and script audio

Inspector → "+ Add component" → **Audio source** loops an audio asset where
the object is: full volume within a quarter of its range, fading to silent
at the range (measured along X from the player); the Scene view draws both
distances. Scripts play a sound with `ctx.audio.play(assetId, { volume })`
(an audio asset; it is presentation only and never changes the game).
`tl_game_control` *replay* restarts the run.

**Script audio and 3D audio.** `ctx.audio.play(assetId,
{volume, loop, pitch, bus, fadeIn, entityId, position, distanceModel,
refDistance, maxDistance, rolloff})` returns a handle: `stop(h, fade)`,
`fade(h, to, seconds)`, `setVolume`, `setPitch` (the playback rate, 0.25–4),
`setLoop`, `playing(h)`, `volumeOf(h)`, and `finished(h)` / `events()` in the
step after a sound ended or its stop fade finished (computed in the
simulation from the asset's recorded length, so replays and the worker agree).
Buses: sfx, music, voice, ui (`setBusVolume(bus, v, seconds)` mixes on top of
the player's volume). Music: `music(id | null, fade)` crossfades and holds
the music over any other track until `releaseMusic(fade)`;
`stinger(id, {duck, fade})` plays once over the music, ducked to 0.3 under it;
`duck(level, seconds)` / `unduck` — the deepest duck alive wins. A sound with
`entityId` or `position` is panned (equal-power) around the listener, the
active camera, and fades by its distance model (defaults linear, 2–30 m).
The project setting **Audio sources** (`audio_spatial`: 0 automatic, 1 by X
distance to the player, 2 panned) decides how audio sources are heard;
automatic hears 2D projects by X distance to the player and pans in 3D, where an
audio source's range is its max distance and **Distance model**, **Full
volume within** and **Rolloff** are Inspector fields. Scenes without a game
block (3D projects) play script sounds and audio sources too. A script
names its sounds through asset properties (the export carries only the
assets objects and script properties reference). `tl_game_observe` and the
export's `window.__thirdlightObserve()` report `audio`: live voices with
gain, playback rate, pan and distance gain (the Web Audio graph's state, not
heard sound), music owner and duck, bus gains and the listener. How it
sounds has not been checked by ear (unverified).

## Script sounds have an owner

A sound, stinger or music track a script
starts belongs to the script's object: it stops when the object leaves the
game — its scene unloads or reloads, a spawned copy is destroyed — fading
out over the play's `fadeOut` seconds (default 0, at once, as Unity and Godot
stop an object's sounds with it); a music track is released over its own
fade. `owner: 'scene'` ties it to the object's scene instead (a spawned
copy's: to the copy), `owner: 'none'` to nothing (it plays until stopped).
`ctx.audio.stopAll(bus?, fadeSeconds?)` stops every sound on one bus or all
of them, whoever started it, and on the music bus releases the scripts'
music. A scene reload stops the sounds its objects and the scene own; a run
restart (the deprecated `restartLevel`/`newGame` actions and
`ctx.lifecycle.restart()`) stops every script sound. The first sound a Play
drops because every voice is busy (`audio_voices`, 8 by default) writes one
Problems line for that Play; later drops are counted in Play diagnostics
(`audio.skipped.voice_cap`). An exported game only counts them.
