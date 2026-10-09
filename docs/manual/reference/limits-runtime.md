# Limits and defaults: runtime

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The limits and defaults `@thirdlight/runtime` defines, by source file. Values are the running build's.

<a id="limits-runtime--actions"></a>
## `actions.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-command-args"></a>`MAX_COMMAND_ARGS` | `8` |  |
| <a id="limit-max-command-text"></a>`MAX_COMMAND_TEXT` | `256` |  |
| <a id="limit-max-frame-actions"></a>`MAX_FRAME_ACTIONS` | `64` | Most named actions in a frame (project-model MAX_INPUT_ACTIONS). |
| <a id="limit-max-frame-commands"></a>`MAX_FRAME_COMMANDS` | `8` | Engine limits of debug commands (per frame; arguments per call). |

<a id="limits-runtime--animator"></a>
## `animator.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-animator-speed-limits"></a>`ANIMATOR_SPEED_LIMITS` | `{"min":0,"max":10}` | The playback speed range of one animator (a multiplier on every layer's clip time and crossfade). 0 holds the pose (a freeze frame); 10× is far past any fast-forward a game shows. Negative speeds are not offered: crossfades and exit times only run forwards. |
| <a id="limit-max-script-morphs"></a>`MAX_SCRIPT_MORPHS` | `64` | How many morph targets scripts may set on one animator (a face rig's worth). |

<a id="limits-runtime--asset-handles"></a>
## `asset-handles.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-asset-key-max-length"></a>`ASSET_KEY_MAX_LENGTH` | `256` | Longest key a script may load by (an id, an address or a label; addresses are the longest names). |
| <a id="limit-max-frame-asset-answers"></a>`MAX_FRAME_ASSET_ANSWERS` | `64` | Answers one input frame carries; more wait for the next frame (never refused: a refused answer would leave its handle loading for good). |

<a id="limits-runtime--audio-mixer"></a>
## `audio-mixer.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-audio-max-handles"></a>`AUDIO_MAX_HANDLES` | `64` | Limits: live handles, plays per step, the command queue nobody takes (oldest dropped). |
| <a id="limit-audio-max-plays-per-step"></a>`AUDIO_MAX_PLAYS_PER_STEP` | `32` |  |
| <a id="limit-audio-max-queued-commands"></a>`AUDIO_MAX_QUEUED_COMMANDS` | `256` |  |
| <a id="limit-audio-pitch-max"></a>`AUDIO_PITCH_MAX` | `4` |  |
| <a id="limit-audio-pitch-min"></a>`AUDIO_PITCH_MIN` | `0.25` |  |
| <a id="limit-audio-spatial-defaults"></a>`AUDIO_SPATIAL_DEFAULTS` | `{"distanceModel":"linear","refDistance":2,"maxDistance":30,"rolloff":1}` | Defaults of a script's positional sound: linear from full volume within 2 m (about arm's reach around a character) to silence at 30 m (well beyond a room, within a courtyard), rolloff 1. Genre-neutral: a sound heard from across a small space, silent across a large one. |
| <a id="limit-stinger-defaults"></a>`STINGER_DEFAULTS` | `{"duck":0.3,"fade":0.25}` | A stinger's music duck (0.3: the track stays audible under it) and its duck/restore time (0.25 s). |

<a id="limits-runtime--blocks"></a>
## `blocks.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-messages-per-step"></a>`MAX_MESSAGES_PER_STEP` | `256` | Script messages per step (`ctx.messages.send`): far above what game logic sends in one step, small enough to bound the per-step lists. |

<a id="limits-runtime--camera-brain"></a>
## `camera-brain.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-shake-impulses"></a>`MAX_SHAKE_IMPULSES` | `16` | Engine limit: live shake impulses at once (the oldest is dropped past it). |

<a id="limits-runtime--character-placement"></a>
## `character-placement.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-character-impulse-max"></a>`CHARACTER_IMPULSE_MAX` | `100` | The largest impulse component a script may give the character (m/s; a safety limit, far above a jump). |

<a id="limits-runtime--entity-access"></a>
## `entity-access.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-entity-writes-per-step"></a>`MAX_ENTITY_WRITES_PER_STEP` | `65536` | Engine limit: accepted `set` calls per step (every script together), a runtime budget against a runaway loop: four writes to every entity of a full scene (16,384). |

<a id="limits-runtime--environment-blend"></a>
## `environment-blend.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-fog-defaults"></a>`FOG_DEFAULTS` | `{"near":10,"far":120,"density":0.01}` | Fog defaults (environment.ts applyFog). |
| <a id="limit-sky-defaults"></a>`SKY_DEFAULTS` | `{"turbidity":6,"rayleigh":1.5,"mieCoefficient":0.005,"mieDirectionalG":0.8,"sunElevation":35,"sunAzimuth":160,"topColor":"#3d7cd6","horizonColor":"#bfe3ff","bottomColor":"#757575","color":"#7ec8ff","intensity":1,"environmentIntensity":1}` | Defaults the renderer uses for absent sky fields (environment.ts buildSky; blended from these). |

<a id="limits-runtime--environment-director"></a>
## `environment-director.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-environment-blend-seconds"></a>`MAX_ENVIRONMENT_BLEND_SECONDS` | `600` | The longest blend in seconds (an engine limit: ten minutes covers a slow day cycle's segment). |

<a id="limits-runtime--frame-clock"></a>
## `frame-clock.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-catchup-seconds"></a>`MAX_CATCHUP_SECONDS` | `0.1` | Game time one frame may catch up before the rest is dropped: a slow frame must not make the next one slower. A time, not a step count, so a game with a fast fixed step (240 Hz) still keeps real-time speed at 30 fps instead of falling into slow motion. |

<a id="limits-runtime--frame-pacing"></a>
## `frame-pacing.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-frame-rate-cap-url-param"></a>`FRAME_RATE_CAP_URL_PARAM` | `"frameRateCap"` | A page URL flag that pins the frame-rate cap whatever the game sets (`?frameRateCap=none\|30\|60\|120`; Play passes the editor's on): measurements run uncapped (none) on any game, and a cap can be tried without editing the project. |

<a id="limits-runtime--input-status"></a>
## `input-status.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-binding-requests"></a>`MAX_BINDING_REQUESTS` | `8` | Engine limits: binding requests a step (all scripts), events a frame. |
| <a id="limit-max-frame-input-events"></a>`MAX_FRAME_INPUT_EVENTS` | `8` |  |

<a id="limits-runtime--intents"></a>
## `intents.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-intent-limits"></a>`INTENT_LIMITS` | `{"perInstancePerStep":40,"perStep":64,"transformWritesPerEntity":3,"logsPerStepPerInstance":16,"logMessageLength":256,"logsRetainedPerInstance":32}` | The intent/log bounds. (The per-instance log bound is a per-step count; the retained ring is the behavior host's per-instance ring.) |

<a id="limits-runtime--physics-query-args"></a>
## `physics-query-args.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-physics-query-limit"></a>`PHYSICS_QUERY_LIMIT` | `1024` | At most this many physics queries (rays, overlaps, picks; 2D and 3D) a step, for every script together: a runtime budget. A game's agents each test line of sight and probe around them every step; 1,024 rays cost Rapier about 1.6 ms in a scene of 16,384 colliders (measured). Beyond it a query finds nothing (warned once in 3D). |

<a id="limits-runtime--primitives"></a>
## `primitives.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-look-max-emissive-intensity"></a>`LOOK_MAX_EMISSIVE_INTENSITY` | `4` | The brightest emissive a look override may set (the surface's own limit). |
| <a id="limit-max-look-overrides"></a>`MAX_LOOK_OVERRIDES` | `1024` | Engine limit — objects with a look override at once (a replay-safe bound on the state). |

<a id="limits-runtime--project-saves"></a>
## `project-saves.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-frame-save-events"></a>`MAX_FRAME_SAVE_EVENTS` | `16` | Engine limit: save entries one input frame may carry. |

<a id="limits-runtime--random"></a>
## `random.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-default-random-seed"></a>`DEFAULT_RANDOM_SEED` | `0` | The seed a project uses until it sets `random_seed` (any fixed value works; 0 is the neutral one). |
| <a id="limit-max-random-streams"></a>`MAX_RANDOM_STREAMS` | `64` | An engine limit protecting the runtime: named streams per script instance. |

<a id="limits-runtime--runtime"></a>
## `runtime.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-effect-max-queued-requests"></a>`EFFECT_MAX_QUEUED_REQUESTS` | `256` | Effect requests kept for a renderer that does not take them (headless): the newest this many. |

<a id="limits-runtime--scatter-copies"></a>
## `scatter-copies.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-scatter-near-max"></a>`SCATTER_NEAR_MAX` | `1024` | The most copies one `ctx.scatter.near` answers (a per-call bound; ask a smaller circle for more). |

<a id="limits-runtime--sockets"></a>
## `sockets.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-socket-attachments"></a>`MAX_SOCKET_ATTACHMENTS` | `1024` | Engine limit: at most this many live attachments (far above equipment slots on a crowd of characters). |

<a id="limits-runtime--spawn"></a>
## `spawn.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-live-spawned"></a>`MAX_LIVE_SPAWNED` | `16384` | Engine limit: spawned entities alive at once (prefab children count): as many as one scene holds, since spawned copies live and draw like a scene's own entities. |
| <a id="limit-max-spawns-per-step"></a>`MAX_SPAWNS_PER_STEP` | `64` | Engine limit: spawns one step may request (every script together), a runtime budget: a spawn costs about 0.1 ms (measured with 16,384 alive), so 64 keep a burst to a few milliseconds of the step; a game that fires more spreads them over steps. |

<a id="limits-runtime--timeline"></a>
## `timeline.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-timeline-max-playing"></a>`TIMELINE_MAX_PLAYING` | `8` | Engine limit: timelines playing at once (the model's). |

<a id="limits-runtime--timers"></a>
## `timers.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-timer-seconds"></a>`MAX_TIMER_SECONDS` | `3600` | The longest timer (s): an hour covers any in-game delay and keeps step counts small. |
| <a id="limit-max-timers-per-instance"></a>`MAX_TIMERS_PER_INSTANCE` | `64` | An engine limit protecting the runtime: running timers per script instance. Named timers are saved with the script; a script needing more keeps a list in its state and one timer. |

<a id="limits-runtime--ui"></a>
## `ui.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-max-frame-ui-events"></a>`MAX_FRAME_UI_EVENTS` | `16` | Engine limits of UI events and the view model. |
| <a id="limit-ui-default-view"></a>`UI_DEFAULT_VIEW` | `{"width":1280,"height":720,"aspect":1.7777777777777777,"pixelRatio":1}` | What `ctx.ui.view()` reads before the host reported one (the editor's default play size). |
| <a id="limit-ui-max-commands"></a>`UI_MAX_COMMANDS` | `64` | Pending presentation commands (tween plays, focus requests) between two host frames. |
| <a id="limit-ui-max-shown"></a>`UI_MAX_SHOWN` | `32` | Documents shown at once. |
| <a id="limit-ui-model-max-bytes"></a>`UI_MODEL_MAX_BYTES` | `65536` |  |
