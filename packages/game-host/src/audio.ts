/**
 * @thirdlight/game-host — packet 54: the injected browser audio owner
 * (presentation.md §41.4.7, delivery request C41-5/6).
 *
 * This is the unit's first and only implemented part at packet 54 (the
 * §41.9 row: the `.` audio entry, created only in packet 54 after Gate K
 * accepted the dependencies.md rows). The delivery.md §§3–5 composition
 * (HUD, controls, `createGameHost`) lands in packet 55 on the same entry —
 * no stubs for those parts exist here.
 *
 * Binding surface (presentation.md §41.4.7): `GameCueEvent`, `GameAudioStatus`,
 * `GameAudioOwner` (registerCue / submit / unlock / setMuted / setHidden /
 * status / dispose), `GameAudioError` (closed codes: audio_decode_failed,
 * audio_unsupported, audio_disposed, audio_invalid_bytes; message ≤ 256
 * chars, log-safe).
 *
 * Normative rules realized here:
 *  1. Bytes in only — registerCue takes a Uint8Array the host obtained via
 *     the accepted immutable blob read. No URL, locator, data: string, fetch,
 *     XHR, <audio> element or base64 anywhere in this module. Cue events
 *     carry assetId only.
 *  2. Decode is bounded and asynchronous — decodeAudioData on a COPY of the
 *     supplied bytes; a failure is a bounded per-cue diagnostic, never a
 *     throw across the host boundary; bytes are never mutated.
 *  3. Voice cap — at most AUDIO_MAX_VOICES = 8 concurrent voices; a new cue
 *     when all 8 are busy is dropped with a bounded `voice_cap` diagnostic,
 *     never queued; every voice is released on ended/stop.
 *  4. Dedupe by run/event identity — each id plays at most once per owner;
 *     the current runId's ids are kept; a runId change clears them
 *     (checkpointActivated never refires on re-entry — 40 §4.5).
 *  5. Stale async work is cancelled — a runId change (stop/replay) and
 *     dispose() mark every in-flight decode and pending voice stale; a
 *     decode that resolves afterwards is discarded, never played; a cue
 *     from a previous run is never replayed into a new run.
 *  6. Suspend on hidden/stop — setHidden(true) suspends the owned context;
 *     setHidden(false) attempts resume() only when already unlocked; a
 *     rejected resume degrades to blocked status, not an error.
 *  7. Local gesture unlock only — unlock() is the host's real-gesture call
 *     (the browser wiring checks `event.isTrusted` at packet 55/62); the
 *     owner never trusts anything by itself and never unlocks on
 *     registerCue/submit. Gameplay never waits for audio.
 *  8. Close on dispose — dispose() closes exactly the contexts it created,
 *     once; the second call returns alreadyDisposed; closing is synchronous
 *     with respect to public state (after dispose, every other method
 *     returns audio_disposed / disposed).
 *  9. Never a server sound device — this module is the browser entry; the
 *     pure runtime never constructs an AudioContext, never imports this
 *     owner and never sees bytes.
 *
 * Determinism: the owner reads no clock, no timer and no global audio
 * state — the environment is the injected `contextFactory` (rule 7 seam),
 * and every observation in the tests is a public state transition or the
 * bounded diagnostic log. The additive `diagnostics()` method is the
 * owner's bounded log surface (the contract's failure table names "one
 * bounded diagnostic is recorded" as behavior; the 8 binding interface
 * members are exactly the contracted set and are unchanged by this
 * additive read-only method).
 */

/** Rule 3 — the concurrent voice cap (contract constant). */
export const AUDIO_MAX_VOICES = 8;
/** The bounded diagnostic ring size (drop-oldest). */
export const AUDIO_MAX_DIAGNOSTICS = 64;
/** The bounded per-asset registration store cap (distinct cue assets ≤ 6, §41.4.5). */
const AUDIO_MAX_REGISTERED_ASSETS = 16;

export type CueKind = 'start' | 'jump' | 'checkpoint' | 'death' | 'goal';

/** Typed, committed cue events (derived by the host from GameView.events +
 * content.game.cues). The id `${runId}/${kind}/${stepIndex}` is the dedupe key. */
export interface GameCueEvent {
  readonly id: string;
  readonly kind: CueKind;
  readonly assetId: string;
  readonly runId: string;
  readonly stepIndex: number;
}

export type GameAudioStatus =
  | { readonly state: 'unsupported'; readonly reason: 'no_audio_context' }
  | { readonly state: 'blocked'; readonly reason: 'autoplay_denied' | 'no_device' }
  | { readonly state: 'ready'; readonly muted: boolean; readonly unlocked: boolean }
  | { readonly state: 'disposed' };

export interface GameAudioError {
  readonly code:
    | 'audio_decode_failed'
    | 'audio_unsupported'
    | 'audio_disposed'
    | 'audio_invalid_bytes';
  /** ≤ 256 chars, log-safe. */
  readonly message: string;
}

/** The owner's bounded diagnostic log codes (additive surface — the closed
 * GameAudioError codes plus the behavioral diagnostics the contract's
 * failure table and rules 3/5 name). */
export type GameAudioDiagnosticCode =
  | 'audio_decode_failed'
  | 'audio_invalid_bytes'
  | 'audio_unsupported'
  | 'voice_cap'
  | 'stale_work_discarded'
  | 'cue_skipped'
  | 'suspend_failed';

export interface GameAudioDiagnostic {
  readonly code: GameAudioDiagnosticCode;
  readonly assetId: string | null;
  /** ≤ 256 chars, log-safe. */
  readonly message: string;
}

/** The injected Web Audio surface — structural (the owner never imports DOM
 * types or `window`; the browser entry's guarded factory satisfies it). */
export interface AudioBufferLike {
  readonly duration: number;
  readonly sampleRate: number;
  readonly length: number;
}

export interface AudioNodeLike {
  connect(target: AudioNodeLike): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: { value: number; setValueAtTime?(v: number, t: number): void; linearRampToValueAtTime?(v: number, t: number): void; cancelScheduledValues?(t: number): void };
  disconnect?(): void;
}

export interface BufferSourceLike {
  buffer: AudioBufferLike | null;
  onended: (() => void) | null;
  connect(target: AudioNodeLike): void;
  start(): void;
  stop(): void;
  /** Phase 9.10: music loops. */
  loop?: boolean;
}

export interface AudioContextLike {
  readonly state: 'suspended' | 'running' | 'closed';
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  createBufferSource(): BufferSourceLike;
  createGain(): GainNodeLike;
  readonly destination: AudioNodeLike;
  /** Phase 9.10: the clock the music crossfades on (absent: gains jump). */
  readonly currentTime?: number;
}

/** Phase 9.10: the mixer buses (phase 14.5: `ui`, the menu sounds). */
export type AudioBus = 'master' | 'music' | 'sfx' | 'ui';
export const MUSIC_MAX_REGISTERED = 64;

export interface GameAudioOwnerConfig {
  /**
   * The environment's AudioContext producer, injected by the browser entry.
   * Invoked on each `unlock()` until it yields a context; the owner then
   * creates exactly ONE context (never at load, never on registerCue — the
   * autoplay-policy-safe creation point, §41.4.7 intro). Returning `null`
   * reports status `unsupported`/`no_audio_context` (the game plays
   * silently; a later gesture may retry with a recovered environment).
   */
  readonly contextFactory?: () => AudioContextLike | null;
}

type AssetState =
  | { state: 'pending'; bytes: Uint8Array; token: number }
  | { state: 'decoding'; bytes: Uint8Array; token: number }
  | { state: 'ready'; buffer: AudioBufferLike; token: number }
  | { state: 'failed'; token: number };

interface Voice {
  readonly source: BufferSourceLike;
  readonly assetId: string;
  /** True once the source fired onended (stop() must not be called again —
   * real Web Audio throws InvalidStateNode on stop-after-ender). */
  ended: boolean;
  released: boolean;
}

function clipMessage(message: string): string {
  return message.length > 256 ? `${message.slice(0, 253)}...` : message;
}

/** The owner (the §41.4.7 interface + the additive `diagnostics()` read). */
export interface GameAudioOwner {
  registerCue(
    assetId: string,
    bytes: Uint8Array,
  ): { ok: true } | { ok: false; error: GameAudioError };
  submit(events: readonly GameCueEvent[]): { ok: true } | { ok: false; error: GameAudioError };
  unlock(): Promise<GameAudioStatus>;
  setMuted(muted: boolean): GameAudioStatus;
  setHidden(hidden: boolean): GameAudioStatus;
  status(): GameAudioStatus;
  dispose(): { readonly ok: true; readonly alreadyDisposed?: true };
  /** Additive observation surface (not a binding §41.4.7 member): the bounded
   * diagnostic ring, newest last. */
  diagnostics(): readonly GameAudioDiagnostic[];
  /** Additive observation surface (packet 55, delivery.md §3.1
   * `sound.voices`): the live concurrent voice count (0..8). */
  liveVoices(): number;
  /** Phase 9.10: register a music track (decoded when it first plays). */
  registerMusic?(assetId: string, bytes: Uint8Array): { ok: true } | { ok: false; error: GameAudioError };
  /** Phase 9.10: loop a track (null: silence), crossfading from the current one. */
  playMusic?(assetId: string | null, fadeSeconds?: number): void;
  /** Phase 9.10: a bus volume, 0–1. */
  setVolume?(bus: AudioBus, value: number): void;
  volumes?(): Readonly<Record<AudioBus, number>>;
  /** Phase 9.10: the wanted track, whether it sounds, and the music bus gain node's value. */
  musicStatus?(): { readonly assetId: string | null; readonly playing: boolean; readonly gain: number };
  /**
   * Phase 9.10: a one-shot sound (a registered cue) at a volume (a script's
   * ctx.audio.play). Phase 14.5: `bus` 'ui' plays it on the menu-sound bus
   * (default 'sfx').
   */
  playSound?(assetId: string, volume: number, bus?: 'sfx' | 'ui'): boolean;
  /** Phase 14.5: one-shot sounds started per bus since creation (observation). */
  soundsPlayed?(): Readonly<Record<'sfx' | 'ui', number>>;
  /** Phase 9.10: a looping emitter (an audio source) at a gain; null stops it. */
  setLoop?(key: string, assetId: string | null, gain: number): void;
  /** Phase 9.10: the live loops (key → gain), for observation. */
  loops?(): Readonly<Record<string, number>>;
}

export function createGameAudioOwner(config: GameAudioOwnerConfig = {}): GameAudioOwner {
  const factory = config.contextFactory;

  let disposed = false;
  let context: AudioContextLike | null = null;
  let contextCreated = false; // the factory has produced the (only) context
  let unlocked = false;
  let muted = false;
  let hidden = false;
  let blockedReason: 'autoplay_denied' | 'no_device' | null = null;

  /** Bumped by a runId change and by dispose(): every in-flight decode
   * captures the epoch it started in; a resolve under a newer epoch is
   * stale (rule 5). */
  let epoch = 0;
  let activeRunId: string | null = null;
  const playedIds = new Set<string>();
  const assets = new Map<string, AssetState>();
  const voices = new Set<Voice>();
  const diagnostics: GameAudioDiagnostic[] = [];
  // Phase 9.10: buses (created with the context) and music.
  const volumes: Record<AudioBus, number> = { master: 1, music: 0.8, sfx: 1, ui: 1 };
  const played: Record<'sfx' | 'ui', number> = { sfx: 0, ui: 0 };
  let buses: Record<AudioBus, GainNodeLike> | null = null;
  const music = new Map<string, { bytes: Uint8Array; buffer: AudioBufferLike | null; decoding: boolean; failed: boolean }>();
  let wantedMusic: string | null = null;
  let wantedFade = 1;
  let track: { assetId: string; source: BufferSourceLike; gain: GainNodeLike } | null = null;

  function ensureBuses(ctx: AudioContextLike): Record<AudioBus, GainNodeLike> {
    if (buses !== null) return buses;
    const master = ctx.createGain();
    const musicBus = ctx.createGain();
    const sfx = ctx.createGain();
    const ui = ctx.createGain();
    master.gain.value = muted ? 0 : volumes.master;
    musicBus.gain.value = volumes.music;
    sfx.gain.value = volumes.sfx;
    ui.gain.value = volumes.ui;
    musicBus.connect(master);
    sfx.connect(master);
    ui.connect(master);
    master.connect(ctx.destination);
    buses = { master, music: musicBus, sfx, ui };
    return buses;
  }

  function ramp(g: GainNodeLike, to: number, seconds: number, ctx: AudioContextLike): void {
    const now = ctx.currentTime;
    if (now === undefined || g.gain.linearRampToValueAtTime === undefined || seconds <= 0) {
      g.gain.value = to;
      return;
    }
    g.gain.cancelScheduledValues?.(now);
    g.gain.setValueAtTime?.(g.gain.value, now);
    g.gain.linearRampToValueAtTime(to, now + seconds);
  }

  // Phase 9.10: looping emitters (audio sources) by key.
  const loopVoices = new Map<string, { assetId: string; source: BufferSourceLike; gain: GainNodeLike }>();
  const loopGains = new Map<string, number>();

  /** The decoded buffer of a registered cue or music asset (music decodes on demand). */
  function bufferOf(assetId: string): AudioBufferLike | null {
    const cue = assets.get(assetId);
    if (cue?.state === 'ready') return cue.buffer;
    if (cue?.state === 'pending' && context !== null && !muted) startDecode(assetId);
    const m = music.get(assetId);
    if (m !== undefined) {
      if (m.buffer !== null) return m.buffer;
      if (!m.decoding && !m.failed && context !== null) {
        m.decoding = true;
        let p: Promise<AudioBufferLike>;
        try {
          p = context.decodeAudioData(m.bytes.slice().buffer);
        } catch (err) {
          p = Promise.reject(err);
        }
        p.then(
          (b) => {
            m.buffer = b;
            m.decoding = false;
          },
          () => {
            m.decoding = false;
            m.failed = true;
          },
        );
      }
    }
    return null;
  }

  function stopLoop(key: string): void {
    const v = loopVoices.get(key);
    if (v === undefined) return;
    loopVoices.delete(key);
    try {
      v.source.stop();
    } catch {
      // already stopped
    }
    v.gain.disconnect?.();
  }

  function stopTrack(fadeSeconds: number): void {
    const t = track;
    track = null;
    if (t === null || context === null) return;
    ramp(t.gain, 0, fadeSeconds, context);
    const stop = (): void => {
      try {
        t.source.stop();
      } catch {
        // already stopped
      }
      t.gain.disconnect?.();
    };
    if (fadeSeconds > 0 && context.currentTime !== undefined) setTimeout(stop, fadeSeconds * 1000 + 50);
    else stop();
  }

  /** Start the wanted track once the context is unlocked and its bytes decoded. */
  function syncMusic(): void {
    if (disposed || context === null || !unlocked) return;
    const ctx = context;
    if (track !== null && track.assetId === wantedMusic) return;
    if (wantedMusic === null) {
      stopTrack(wantedFade);
      return;
    }
    const entry = music.get(wantedMusic);
    if (entry === undefined || entry.failed) {
      stopTrack(wantedFade);
      return;
    }
    if (entry.buffer === null) {
      if (entry.decoding) return;
      entry.decoding = true;
      const id = wantedMusic;
      let p: Promise<AudioBufferLike>;
      try {
        p = ctx.decodeAudioData(entry.bytes.slice().buffer);
      } catch (err) {
        p = Promise.reject(err);
      }
      p.then(
        (buffer) => {
          entry.buffer = buffer;
          entry.decoding = false;
          if (!disposed && wantedMusic === id) syncMusic();
        },
        () => {
          entry.decoding = false;
          entry.failed = true;
          diag('audio_decode_failed', id, 'music decode failed; the level plays without it');
        },
      );
      return;
    }
    stopTrack(wantedFade);
    const bus = ensureBuses(ctx);
    const source = ctx.createBufferSource();
    source.buffer = entry.buffer;
    source.loop = true;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    source.connect(gain);
    gain.connect(bus.music);
    ramp(gain, 1, wantedFade, ctx);
    source.start();
    track = { assetId: wantedMusic, source, gain };
  }

  function diag(
    code: GameAudioDiagnosticCode,
    assetId: string | null,
    message: string,
  ): void {
    diagnostics.push({ code, assetId, message: clipMessage(message) });
    if (diagnostics.length > AUDIO_MAX_DIAGNOSTICS) diagnostics.shift();
  }

  function error(
    code: GameAudioError['code'],
    message: string,
  ): { ok: false; error: GameAudioError } {
    return { ok: false, error: { code, message: clipMessage(message) } };
  }

  function releaseVoice(voice: Voice): void {
    if (voice.released) return;
    voice.released = true;
    voices.delete(voice);
    voice.source.onended = null;
    if (!voice.ended) {
      try {
        voice.source.stop();
      } catch {
        // A source that already stopped/failed: the slot is released either
        // way (rule 3 — every voice is released exactly once).
      }
    }
  }

  function stopAllVoices(): void {
    for (const voice of [...voices]) releaseVoice(voice);
  }

  function startDecode(assetId: string): void {
    const entry = assets.get(assetId);
    if (!entry || entry.state === 'ready' || entry.state === 'failed') return;
    if (!context) return; // decode is deferred until unlock (no context yet)
    const bytes = entry.bytes;
    const token = entry.token + 1;
    const startedEpoch = epoch;
    assets.set(assetId, { state: 'decoding', bytes, token });
    // Rule 2: decode a COPY — the supplied bytes are never read beyond the
    // copy and never mutated. The real decodeAudioData fails asynchronously,
    // but a misbehaving platform could throw synchronously: either way the
    // failure is a bounded per-cue diagnostic, never a throw across the
    // host boundary.
    const copy = bytes.slice();
    let decodePromise: Promise<AudioBufferLike>;
    try {
      decodePromise = context.decodeAudioData(copy.buffer);
    } catch (err) {
      decodePromise = Promise.reject(err);
    }
    decodePromise
      .then((buffer) => {
        if (disposed) {
          diag('stale_work_discarded', assetId, 'decode resolved after dispose; buffer discarded, never played');
          return;
        }
        const cur = assets.get(assetId);
        if (!cur || cur.state !== 'decoding' || cur.token !== token) {
          // Superseded by a re-register (the owner's single store slot per
          // asset): this buffer is discarded, never played.
          diag('stale_work_discarded', assetId, 'decode resolved for a superseded registration; discarded');
          return;
        }
        if (startedEpoch !== epoch) {
          // Rule 5: a runId change bumped the epoch while this decode was in
          // flight — the old buffer is discarded and never played; a fresh
          // decode for the SAME asset is re-armed so a legitimate cue of the
          // new run can still sound (the cue is an asset reference; run
          // identity lives on the event, which submit re-checks).
          diag('stale_work_discarded', assetId, 'decode resolved after a run change; discarded, decode re-armed for the current run');
          assets.set(assetId, { state: 'pending', bytes: cur.bytes, token: cur.token });
          startDecode(assetId);
          return;
        }
        assets.set(assetId, { state: 'ready', buffer, token: cur.token });
      })
      .catch(() => {
        if (disposed) return;
        const cur = assets.get(assetId);
        if (!cur || cur.state !== 'decoding' || cur.token !== token) return;
        assets.set(assetId, { state: 'failed', token: cur.token });
        diag('audio_decode_failed', assetId, 'decodeAudioData rejected; the cue is skipped, one bounded diagnostic recorded, the game continues');
      });
  }

  /** Eagerly decode everything registered-but-pending (unlock / unmute). */
  function decodeAllPending(): void {
    for (const assetId of [...assets.keys()]) {
      const entry = assets.get(assetId);
      if (entry && entry.state === 'pending') startDecode(assetId);
    }
  }

  function currentStatus(): GameAudioStatus {
    if (disposed) return { state: 'disposed' };
    if (context) {
      if (context.state === 'closed') {
        // The environment took the device away after creation.
        return { state: 'blocked', reason: 'no_device' };
      }
      if (unlocked && (context.state === 'running' || hidden)) {
        // Ready. A hidden (suspended) context is a normal paused state, not
        // a policy denial — the owner is unlocked and resumes in place when
        // visible again (rule 6: no fast-forward, no replay).
        return { state: 'ready', muted, unlocked: true };
      }
      // A context exists but is not running-and-unlocked: an autoplay
      // denial (blockedReason set by a rejected resume) or the honest
      // pre-gesture state. Rule 6: a rejected resume degrades to blocked,
      // not an error.
      return { state: 'blocked', reason: blockedReason ?? 'autoplay_denied' };
    }
    if (!factory) return { state: 'unsupported', reason: 'no_audio_context' };
    // Honest pre-gesture state: an autoplay policy would deny resume()
    // before a real local gesture (§41.4.6 row: autoplay denial → blocked).
    return { state: 'blocked', reason: 'autoplay_denied' };
  }

  return {
    registerCue(assetId, bytes) {
      if (disposed) return error('audio_disposed', 'registerCue after dispose');
      if (!assetId || typeof assetId !== 'string') {
        return error('audio_invalid_bytes', 'assetId must be a non-empty string');
      }
      if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
        return error('audio_invalid_bytes', 'cue bytes must be a non-empty Uint8Array (bytes in only — rule 1)');
      }
      if (!assets.has(assetId) && assets.size >= AUDIO_MAX_REGISTERED_ASSETS) {
        // §41.4.5: the catalog holds ≤ 16 audio records; the owner's store
        // caps at the same bound (never grows unboundedly).
        return error('audio_invalid_bytes', `registered asset store full (cap ${AUDIO_MAX_REGISTERED_ASSETS}); re-register an existing asset instead`);
      }
      assets.set(assetId, { state: 'pending', bytes, token: 0 });
      // Rule 2/§41.4.6: nothing is decoded while muted; with a live context
      // and sound on, decode eagerly (a cue must not wait for the first
      // submit after unlock — the "late decode" failure mode).
      if (!muted && context) startDecode(assetId);
      return { ok: true };
    },
    submit(events) {
      if (disposed) return error('audio_disposed', 'submit after dispose');
      if (events.length === 0) return { ok: true };
      // A committed view is a single run: the submit adopts the runId of its
      // first event. Any later event with a different runId is a late cue
      // from an old run — never replayed into the new run (rule 5).
      const runId = events[0]!.runId;
      if (activeRunId !== null && activeRunId !== runId) {
        // stop()/replay() — a run change: every in-flight decode and
        // pending voice is stale (rule 5); the dedupe set clears (rule 4).
        epoch += 1;
        stopAllVoices();
        playedIds.clear();
        diag('stale_work_discarded', null, `run changed (${activeRunId} -> ${runId}); in-flight work marked stale, dedupe cleared`);
      }
      activeRunId = runId;

      for (const event of events) {
        if (event.runId !== runId) {
          diag('stale_work_discarded', event.assetId, `event ${event.id} is from a different run; skipped, never played into the new run`);
          continue;
        }
        if (playedIds.has(event.id)) continue; // rule 4: at most once — no-op
        playedIds.add(event.id); // a dropped cue is not replayed (no queue)
        if (muted) {
          diag('cue_skipped', event.assetId, `cue ${event.id} skipped: muted (nothing is decoded or played)`);
          continue;
        }
        if (!context || !unlocked) {
          diag('cue_skipped', event.assetId, `cue ${event.id} skipped: sound off (${currentStatus().state}), the game continues`);
          continue;
        }
        const ctx = context;
        if (ctx.state === 'closed') {
          diag('cue_skipped', event.assetId, `cue ${event.id} skipped: context closed`);
          continue;
        }
        const entry = assets.get(event.assetId);
        if (!entry) {
          diag('cue_skipped', event.assetId, `cue ${event.id} skipped: asset not registered (the host registers every referenced cue's bytes at load)`);
          continue;
        }
        if (entry.state !== 'ready') {
          diag(
            'cue_skipped',
            event.assetId,
            `cue ${event.id} skipped: asset ${entry.state === 'failed' ? 'decode failed' : `still ${entry.state}`}`,
          );
          continue;
        }
        if (voices.size >= AUDIO_MAX_VOICES) {
          diag('voice_cap', event.assetId, `cue ${event.id} dropped: ${AUDIO_MAX_VOICES} voices busy (voice_cap — never queued)`);
          continue;
        }
        const source = ctx.createBufferSource();
        source.buffer = entry.buffer;
        const gain = ctx.createGain();
        gain.gain.value = 1;
        source.connect(gain);
        gain.connect(ensureBuses(ctx).sfx);
        const voice: Voice = { source, assetId: event.assetId, ended: false, released: false };
        source.onended = () => {
          voice.ended = true;
          releaseVoice(voice);
        };
        // A suspended (hidden) context keeps the graph paused: no sound
        // while hidden, and resume continues in place — no fast-forward,
        // no replay (rule 6).
        source.start();
        voices.add(voice);
      }
      return { ok: true };
    },

    async unlock() {
      if (disposed) return currentStatus();
      const alreadyRunning = unlocked && context !== null && context.state === 'running';
      if (alreadyRunning) return currentStatus();
      if (!factory) return currentStatus(); // unsupported, forever (no Web Audio)
      if (!contextCreated) {
        // Rule 7: the only creation point — a real local gesture call.
        const created = factory();
        if (!created) {
          // §41.4.6: absent AudioContext / no device → soft sound-off. The
          // factory is NOT marked consumed: a later gesture retries (the
          // environment may recover).
          return { state: 'unsupported', reason: 'no_audio_context' };
        }
        contextCreated = true;
        context = created;
        if (context.state === 'closed') {
          // Created but immediately closed: the environment has no usable
          // output device → soft blocked (no_device), never an error.
          blockedReason = 'no_device';
          return { state: 'blocked', reason: 'no_device' };
        }
      }
      const ctx = context;
      if (!ctx) return currentStatus(); // unreachable: created above unless already created
      try {
        await ctx.resume();
      } catch {
        // Autoplay policy denial / no device: soft blocked, not an error
        // (rule 7; §41.4.6). A later local gesture may retry.
        blockedReason = 'autoplay_denied';
        return currentStatus();
      }
      unlocked = true;
      blockedReason = null;
      ensureBuses(ctx);
      // Eagerly decode everything registered before the gesture (the host
      // registers at load; the first cue must not wait).
      decodeAllPending();
      syncMusic();
      if (hidden && ctx.state === 'running') {
        try {
          await ctx.suspend();
        } catch {
          diag('suspend_failed', null, 'suspend after unlock (hidden) rejected');
        }
      }
      return currentStatus();
    },

    setMuted(next) {
      if (disposed) return currentStatus();
      if (muted === next) return currentStatus();
      muted = next;
      if (buses !== null) buses.master.gain.value = muted ? 0 : volumes.master;
      if (muted) {
        // §41.4.6: nothing is decoded or played while muted — current
        // voices stop now; pending decodes are deferred (startDecode is a
        // no-op while muted, via the register/unlock/mute paths' guard).
        stopAllVoices();
        diag('cue_skipped', null, 'muted: current voices stopped, nothing decoded or played');
      } else if (context) {
        // Unmute: decode what was deferred while muted.
        decodeAllPending();
      }
      return currentStatus();
    },

    setHidden(next) {
      if (disposed) return currentStatus();
      hidden = next;
      const ctx = context;
      if (ctx && unlocked) {
        if (next) {
          ctx
            .suspend()
            .catch(() => diag('suspend_failed', null, 'suspend (hidden) rejected; no sound while hidden is best-effort'));
        } else {
          // Rule 6: resume ONLY when already unlocked — and a rejected
          // resume degrades to blocked, not an error.
          ctx
            .resume()
            .then(() => {
              if (!disposed && unlocked) blockedReason = null;
            })
            .catch(() => {
              if (!disposed && unlocked) {
                blockedReason = 'autoplay_denied';
                diag('suspend_failed', null, 'resume (visible) rejected; status degraded to blocked, not an error');
              }
            });
        }
      }
      return currentStatus();
    },

    status() {
      return currentStatus();
    },

    dispose() {
      if (disposed) return { ok: true, alreadyDisposed: true };
      disposed = true;
      epoch += 1; // every in-flight decode is stale (rule 5)
      stopAllVoices();
      stopTrack(0);
      for (const key of [...loopVoices.keys()]) stopLoop(key);
      music.clear();
      if (context) {
        // Rule 8: close exactly the contexts THIS owner created, once.
        context.close().catch(() => {
          // Already-closed / device-gone contexts: public state is
          // disposed either way (closing is synchronous w.r.t. it).
        });
        context = null;
      }
      return { ok: true };
    },

    diagnostics() {
      return diagnostics.slice();
    },

    liveVoices() {
      return voices.size;
    },

    registerMusic(assetId, bytes) {
      if (disposed) return error('audio_disposed', 'registerMusic after dispose');
      if (!assetId || !(bytes instanceof Uint8Array) || bytes.length === 0) return error('audio_invalid_bytes', 'music needs an assetId and non-empty bytes');
      if (!music.has(assetId) && music.size >= MUSIC_MAX_REGISTERED) return error('audio_invalid_bytes', `music store full (cap ${MUSIC_MAX_REGISTERED})`);
      music.set(assetId, { bytes, buffer: null, decoding: false, failed: false });
      if (wantedMusic === assetId) syncMusic();
      return { ok: true };
    },

    playMusic(assetId, fadeSeconds = 1) {
      if (disposed) return;
      wantedMusic = assetId;
      wantedFade = Math.max(0, Math.min(10, fadeSeconds));
      syncMusic();
    },

    setVolume(bus, value) {
      if (disposed) return;
      const v = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1));
      volumes[bus] = v;
      if (buses === null) return;
      if (bus === 'master') buses.master.gain.value = muted ? 0 : v;
      else buses[bus].gain.value = v;
    },

    volumes() {
      return { ...volumes };
    },

    playSound(assetId, volume, bus = 'sfx') {
      if (disposed || muted || context === null || !unlocked || context.state === 'closed') return false;
      if (voices.size >= AUDIO_MAX_VOICES) {
        diag('voice_cap', assetId, `sound ${assetId} dropped: ${AUDIO_MAX_VOICES} voices busy`);
        return false;
      }
      const buffer = bufferOf(assetId);
      if (buffer === null) return false;
      const ctx = context;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, Math.min(1, volume));
      source.connect(gain);
      gain.connect(ensureBuses(ctx)[bus === 'ui' ? 'ui' : 'sfx']);
      played[bus === 'ui' ? 'ui' : 'sfx'] += 1;
      const voice: Voice = { source, assetId, ended: false, released: false };
      source.onended = () => {
        voice.ended = true;
        releaseVoice(voice);
      };
      source.start();
      voices.add(voice);
      return true;
    },

    setLoop(key, assetId, gain) {
      if (disposed) return;
      const g = Math.max(0, Math.min(1, Number.isFinite(gain) ? gain : 0));
      if (assetId === null) {
        stopLoop(key);
        loopGains.delete(key);
        return;
      }
      loopGains.set(key, g);
      const live = loopVoices.get(key);
      if (live !== undefined && live.assetId === assetId) {
        live.gain.gain.value = g;
        return;
      }
      stopLoop(key);
      if (context === null || !unlocked || loopVoices.size >= 16) return;
      const buffer = bufferOf(assetId);
      if (buffer === null) return; // decoding: the next frame's call starts it
      const ctx = context;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gainNode = ctx.createGain();
      gainNode.gain.value = g;
      source.connect(gainNode);
      gainNode.connect(ensureBuses(ctx).sfx);
      source.start();
      loopVoices.set(key, { assetId, source, gain: gainNode });
    },

    soundsPlayed() {
      return { ...played };
    },

    loops() {
      return Object.fromEntries([...loopVoices.entries()].map(([k, v]) => [k, v.gain.gain.value]));
    },

    musicStatus() {
      return { assetId: wantedMusic, playing: track !== null && track.assetId === wantedMusic, gain: buses !== null ? buses.music.gain.value : volumes.music };
    },
  };
}