# Limits and defaults: game-host

_Generated from the engine source by `node tools/gen-reference.mjs`; do not edit by hand._

The limits and defaults `@thirdlight/game-host` defines, by source file. Values are the running build's.

<a id="limits-game-host--audio"></a>
## `audio.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-audio-max-diagnostics"></a>`AUDIO_MAX_DIAGNOSTICS` | `64` | The bounded diagnostic ring size (drop-oldest). |
| <a id="limit-audio-max-voices"></a>`AUDIO_MAX_VOICES` | `8` | Rule 3 — the concurrent voice cap: the default of the project's `audio_voices` setting (`maxVoices`), which may go up to `AUDIO_VOICE_LIMIT`. |

<a id="limits-game-host--rebind"></a>
## `rebind.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-rebind-default-cancel"></a>`REBIND_DEFAULT_CANCEL` | `"Escape"` |  |
| <a id="limit-rebind-default-policy"></a>`REBIND_DEFAULT_POLICY` | `"swap"` |  |
| <a id="limit-rebind-default-timeout-s"></a>`REBIND_DEFAULT_TIMEOUT_S` | `10` | Defaults: listen 10 s (long enough to find a key, short enough that a forgotten listen ends); Escape cancels; swap keeps every action bound. |

<a id="limits-game-host--storage"></a>
## `storage.ts`

| Constant | Value | What it is |
|---|---|---|
| <a id="limit-save-max-bytes"></a>`SAVE_MAX_BYTES` | `65536` | The largest stored entry read back (a longer one is ignored). |
