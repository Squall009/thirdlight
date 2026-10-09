# Limits and defaults: protocol

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The limits and defaults `@thirdlight/protocol` defines, by source file. Values are the running build's.

<a id="limits-protocol--bake"></a>
## `bake.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-lightmap-max-atlas"></a>`LIGHTMAP_MAX_ATLAS` | `2048` |  |
| <a id="limit-lightmap-max-atlases"></a>`LIGHTMAP_MAX_ATLASES` | `16` |  |

<a id="limits-protocol--bridge"></a>
## `bridge.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-bridge-debug-max-breakpoints"></a>`BRIDGE_DEBUG_MAX_BREAKPOINTS` | `64` | Breakpoints in one `tl.debug.request` (node ids as the debugger names them, `fn:<id>/<node>` inside a function). |
| <a id="limit-bridge-debug-result-max-bytes"></a>`BRIDGE_DEBUG_RESULT_MAX_BYTES` | `32768` | The `tl.debug.result` body bound. |
| <a id="limit-bridge-input-max-bytes"></a>`BRIDGE_INPUT_MAX_BYTES` | `16384` |  |
| <a id="limit-bridge-input-max-frames"></a>`BRIDGE_INPUT_MAX_FRAMES` | `600` | `tl.input.request` frames/bytes cap: an input request carries one relay. |

<a id="limits-protocol--content"></a>
## `content.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-content-asset-bytes-max"></a>`CONTENT_ASSET_BYTES_MAX` | `33554432` | The asset byte-read response cap (32 MiB). |
| <a id="limit-content-assets-limit-default"></a>`CONTENT_ASSETS_LIMIT_DEFAULT` | `50` |  |
| <a id="limit-content-assets-limit-max"></a>`CONTENT_ASSETS_LIMIT_MAX` | `128` | The asset-list/query page ceiling (the `queryAssets` command's). |
| <a id="limit-content-proposal-max-bytes"></a>`CONTENT_PROPOSAL_MAX_BYTES` | `262144` | Proposal response ≤ 256 KiB. |
| <a id="limit-content-stage-create-response-max"></a>`CONTENT_STAGE_CREATE_RESPONSE_MAX` | `4096` | The response `Content-Length` bound for a JSON route. |
| <a id="limit-content-stage-max"></a>`CONTENT_STAGE_MAX` | `33554432` | One staged source (and one authoritative source blob): the model's source bound. |
| <a id="limit-content-upload-frame-max"></a>`CONTENT_UPLOAD_FRAME_MAX` | `1048576` | One upload frame ≤ 1 MiB. |
| <a id="limit-instance-buffer-inline-max"></a>`INSTANCE_BUFFER_INLINE_MAX` | `4096` | The most instance-set copies one request carries inline (the buffer route, reads included); larger sets upload through a stage. |

<a id="limits-protocol--delivery"></a>
## `delivery.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-bridge-load-progress-max-bytes"></a>`BRIDGE_LOAD_PROGRESS_MAX_BYTES` | `1024` | The `tl.load.progress` cap. |
| <a id="limit-bridge-message-max-bytes"></a>`BRIDGE_MESSAGE_MAX_BYTES` | `65536` | The v2 bridge message cap. |
| <a id="limit-input-relay-max-body-bytes"></a>`INPUT_RELAY_MAX_BODY_BYTES` | `16384` | The bounded relay body size. |
| <a id="limit-input-relay-max-frames"></a>`INPUT_RELAY_MAX_FRAMES` | `600` | The bounded relay frame count. |
| <a id="limit-input-relay-max-steps"></a>`INPUT_RELAY_MAX_STEPS` | `7200` | The most steps one relay covers (the last frame's `stepOffset + steps`): 60 s at the default 120 Hz step, 2 minutes at 60 Hz. The backend waits for the relay by this span. |
| <a id="limit-input-relay-result-max-bytes"></a>`INPUT_RELAY_RESULT_MAX_BYTES` | `4096` | The input relay body bound restated for the WS ack. |
| <a id="limit-play-content-artifact-max-bytes"></a>`PLAY_CONTENT_ARTIFACT_MAX_BYTES` | `33554432` | The cap on one artifact a Play build holds in memory (what it generates: the manifest's content files, scene files, compiled scripts): one content file's. There is no cap on the set: the project's own files (assets, instance buffers) are served from disk, never held. |
| <a id="limit-play-content-manifest-max-bytes"></a>`PLAY_CONTENT_MANIFEST_MAX_BYTES` | `33554432` | The manifest document cap: the runtime content manifest's. |
| <a id="limit-relay-max-ui-edges"></a>`RELAY_MAX_UI_EDGES` | `8` | UI edges in one frame. |

<a id="limits-protocol--diagnostics-bound"></a>
## `diagnostics-bound.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-play-diagnostics-max-bytes"></a>`PLAY_DIAGNOSTICS_MAX_BYTES` | `16384` | The largest Play diagnostics payload (its JSON text, UTF-8 bytes). |

<a id="limits-protocol--errors"></a>
## `errors.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-message-limit"></a>`MESSAGE_LIMIT` | `256` |  |

<a id="limits-protocol--http"></a>
## `http.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-play-start-project-save-max-bytes"></a>`PLAY_START_PROJECT_SAVE_MAX_BYTES` | `1048576` | A project save document (`format: "thirdlight.save"`) may be as large as a save slot (1 MiB; the request body bound applies too). |
| <a id="limit-play-start-variable-max-chars"></a>`PLAY_START_VARIABLE_MAX_CHARS` | `4096` |  |
| <a id="limit-play-start-variables-max"></a>`PLAY_START_VARIABLES_MAX` | `64` | The bounds of the start options' variables: the script save's own. |
| <a id="limit-screenshot-data-url-max"></a>`SCREENSHOT_DATA_URL_MAX` | `1048576` | The screenshot answer's bound: data URL characters (a base64 PNG). The one bound every hop applies — the preview shrinks a capture to fit it, the bridge's screenshot rule and the backend's reply check it — so an answer the preview sends is never refused further along. |
| <a id="limit-screenshot-max-width-default"></a>`SCREENSHOT_MAX_WIDTH_DEFAULT` | `1024` |  |
| <a id="limit-screenshot-max-width-max"></a>`SCREENSHOT_MAX_WIDTH_MAX` | `2048` |  |
| <a id="limit-screenshot-max-width-min"></a>`SCREENSHOT_MAX_WIDTH_MIN` | `256` | Screenshot width bounds (default 1024, max 2048, min 256). |

<a id="limits-protocol--job-export"></a>
## `job-export.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-job-export-limits"></a>`JOB_EXPORT_LIMITS` | `{"manifestBytes":65536,"files":64,"pathChars":256,"lods":8}` |  |

<a id="limits-protocol--m3"></a>
## `m3.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-game-control-body-max-bytes"></a>`GAME_CONTROL_BODY_MAX_BYTES` | `4096` | Relay bounds: request bodies ≤ 4 KiB; control result ≤ 4 KiB; observation ≤ 16 KiB. |
| <a id="limit-game-control-result-max-bytes"></a>`GAME_CONTROL_RESULT_MAX_BYTES` | `4096` |  |
| <a id="limit-game-observation-max-bytes"></a>`GAME_OBSERVATION_MAX_BYTES` | `16384` |  |
| <a id="limit-game-observe-body-max-bytes"></a>`GAME_OBSERVE_BODY_MAX_BYTES` | `4096` |  |
| <a id="limit-game-observe-timeout-default-ms"></a>`GAME_OBSERVE_TIMEOUT_DEFAULT_MS` | `5000` |  |
| <a id="limit-game-observe-timeout-max-ms"></a>`GAME_OBSERVE_TIMEOUT_MAX_MS` | `15000` |  |
| <a id="limit-game-observe-timeout-min-ms"></a>`GAME_OBSERVE_TIMEOUT_MIN_MS` | `250` | Observe timeout: 250–15 000 ms, default 5 000. |
| <a id="limit-relay-answer-within-max-ms"></a>`RELAY_ANSWER_WITHIN_MAX_MS` | `60000` | The answer's bound on `answerWithinMs` (a relay never waits longer). |
| <a id="limit-texture-pack-layers-max"></a>`TEXTURE_PACK_LAYERS_MAX` | `256` | The most layers a packed texture may have (the model's texture-array limit). |

<a id="limits-protocol--play-problems"></a>
## `play-problems.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-play-problem-kinds-max"></a>`PLAY_PROBLEM_KINDS_MAX` | `32` | The distinct kinds one Play writes at most: each kind is one line, so this bounds a page that reports a new code over and over, not a game. |
| <a id="limit-play-problem-message-max"></a>`PLAY_PROBLEM_MESSAGE_MAX` | `512` | The longest problem line (characters). |

<a id="limits-protocol--ws-events"></a>
## `ws-events.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-ws-in-frame-max"></a>`WS_IN_FRAME_MAX` | `65536` | Frame bounds: incoming ≤ 64 KiB, EXCEPT `screenshot.ack` ≤ 1.5 MiB. The check runs on the raw frame before validation: over the 64 KiB bound only a `screenshot.ack`-shaped frame may proceed; anything else is `frame_too_big` (close 1009). |
| <a id="limit-ws-out-frame-max"></a>`WS_OUT_FRAME_MAX` | `1048576` | Outgoing (server → client) frames are at most 1 MiB — a documented limit that keeps one message from stalling the socket. Nothing is silently held over it: a large Play snapshot goes by reference (`PlaySnapshotRef`, fetched over HTTP), an oversized change record is replaced by `workspace.resync` (the editor re-reads over HTTP), and any other oversized frame is dropped with a visible problem. |
| <a id="limit-ws-screenshot-ack-max"></a>`WS_SCREENSHOT_ACK_MAX` | `1572864` |  |
