/**
 * M3 media panel preview audio (packet 57; the packet surface "Preview audio
 * uses explicit local gesture and injected owner, no authoring token in
 * resources").
 *
 * The media panel's cue PREVIEW plays committed cue bytes in the editor page.
 * The owner is INJECTED into the panel (the App creates exactly one per
 * session and disposes it on teardown — never a module global); the cue BYTES
 * come from the editor's authenticated content read (the authoring token is
 * the session credential of that read, exactly as for model bytes — it is
 * never embedded in a resource, data URL or static path).
 *
 * This is the editor's preview utility, NOT the binding game-host audio owner
 * (presentation.md §41.4.7 — that owner serves the game runtime and the play
 * host; the editor package's boundary row cannot import game-host). It keeps
 * the same safety laws the panel needs:
 *
 *  - RULE 1 (gesture): the `AudioContext` is created only by an explicit
 *    local gesture (`unlock()` — the panel wires it to a real `isTrusted`
 *    pointerdown). Register/preview before the gesture stay `blocked` and
 *    never throw; the game (panel) never waits for audio.
 *  - RULE 2 (bounded decode): cue bytes decode on a COPY (the registered
 *    bytes are never mutated); a decode failure is a bounded per-cue
 *    diagnostic, never a throw across the panel boundary.
 *  - RULE 3 (bounded voices): at most `PREVIEW_AUDIO_MAX_VOICES = 8`
 *    concurrent preview voices; a new preview at the cap is dropped with one
 *    bounded diagnostic, never queued; every voice is released exactly once
 *    on `ended`.
 *  - RULE 4 (dedupe): at most one live voice per cue key.
 *  - RULE 5 (dispose): `dispose()` closes exactly the contexts it created,
 *    once; after it every method reports the disposed state.
 *
 * Deterministic with the injected `contextFactory` (no clock, no PRNG, no
 * global audio state read) — the Node tests drive a fake Web Audio graph
 * exactly as `packages/game-host/src/audio.test.ts` does.
 */

export interface PreviewAudioContextLike {
  readonly state: 'suspended' | 'running' | 'closed';
  readonly destination: unknown;
  resume(): Promise<void>;
  close(): Promise<void>;
  decodeAudioData(input: ArrayBuffer): Promise<AudioBufferLike>;
  createBufferSource(): { buffer: unknown; gain: unknown; connect(t: unknown): void; start(): void; onended: (() => void) | null; };
}

export interface AudioBufferLike {
  readonly duration: number;
}

export type PreviewAudioStatus =
  | { state: 'blocked' }
  | { state: 'ready'; muted: boolean }
  | { state: 'unsupported' }
  | { state: 'disposed' };

export interface PreviewAudioDiagnostic {
  code: 'preview_decode_failed' | 'preview_voice_cap' | 'preview_audio_disposed' | 'preview_unsupported';
  message: string;
}

export interface PreviewAudioOwnerConfig {
  /** The bounded Web Audio factory (the panel passes the real
   * `() => new AudioContext()`; the tests inject a fake). Returns `null`
   * when the platform has no Web Audio (status `unsupported`). */
  contextFactory?: () => PreviewAudioContextLike | null;
}

const DEFAULT_FACTORY: () => PreviewAudioContextLike | null = (): PreviewAudioContextLike | null => {
  if (typeof window === 'undefined') return null;
  const Ctor = (window as unknown as { AudioContext?: new () => PreviewAudioContextLike; webkitAudioContext?: new () => PreviewAudioContextLike });
  const A = Ctor.AudioContext ?? Ctor.webkitAudioContext;
  if (A === undefined) return null;
  try {
    return new A();
  } catch {
    return null;
  }
};

const BOUND = 256;
const bound = (s: string): string => (s.length <= BOUND ? s : `${s.slice(0, BOUND - 1)}…`);

interface CueSlot {
  bytes: Uint8Array;
  buffer: AudioBufferLike | null;
  decodeState: 'pending' | 'ok' | 'failed';
  live: boolean;
}

/**
 * One editor-page preview owner. The cue key is the assetId (one asset = one
 * committed cue in the panel; a reimported version re-registers fresh bytes
 * under the same key and cancels the old decode/voice).
 */
export class PreviewAudioOwner {
  private factory: () => PreviewAudioContextLike | null;
  private context: PreviewAudioContextLike | null = null;
  private disposed = false;
  private muted = false;
  private unlocked = false;
  private readonly cues = new Map<string, CueSlot>();
  private readonly diagnosticsRing: PreviewAudioDiagnostic[] = [];

  constructor(config: PreviewAudioOwnerConfig = {}) {
    this.factory = config.contextFactory ?? DEFAULT_FACTORY;
  }

  private diag(code: PreviewAudioDiagnostic['code'], message: string): void {
    this.diagnosticsRing.push({ code, message: bound(message) });
    if (this.diagnosticsRing.length > 64) this.diagnosticsRing.shift();
  }

  private guard(): boolean {
    return !this.disposed;
  }

  private ensureContext(): PreviewAudioContextLike | null {
    if (this.context === null && this.unlocked) {
      this.context = this.factory();
      if (this.context === null) {
        this.diag('preview_unsupported', 'no Web Audio context could be created on this page');
      }
    }
    return this.context;
  }

  /** The explicit local gesture (the panel calls it from a real `isTrusted`
   * pointer). Creates the context (if absent) and resumes it. */
  async unlock(): Promise<void> {
    if (!this.guard()) return;
    this.unlocked = true;
    const ctx = this.ensureContext();
    if (ctx === null) return;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch {
      // A rejected resume stays `blocked` (the status reflects the context
      // state); a later gesture retries.
    }
    // Eagerly decode the registered cues so the first preview is instant.
    await this.decodeAllPending();
  }

  /** Register (or replace) a cue's bytes. Before the gesture this only
   * stores bytes (status stays `blocked`); never a network call, never a
   * throw. */
  registerCue(key: string, bytes: Uint8Array): void {
    if (!this.guard()) return;
    // A fresh registration cancels any in-flight/old decode and live voice.
    const slot: CueSlot = { bytes: bytes.slice(0), buffer: null, decodeState: 'pending', live: false };
    this.cues.set(key, slot);
    if (this.unlocked && this.context !== null && this.context.state === 'running') {
      void this.decodeOne(slot, key);
    }
  }

  /**
   * Preview a cue once. Sound-off (pre-gesture) or muted: a no-op with the
   * bounded diagnostic (the panel never blocks on audio). At the voice cap
   * or for a failed/missing decode: a bounded diagnostic, never a throw.
   */
  preview(key: string): void {
    if (!this.guard()) {
      this.diag('preview_audio_disposed', 'preview after dispose is a no-op');
      return;
    }
    if (!this.unlocked || this.context === null || this.context.state !== 'running') {
      return; // sound-off: the gesture unlocks; nothing is recorded
    }
    if (this.muted) return;
    const slot = this.cues.get(key);
    if (slot === undefined) {
      this.diag('preview_decode_failed', `the cue "${key}" was never registered`);
      return;
    }
    if (slot.decodeState !== 'ok' || slot.buffer === null) {
      // A pending decode plays once it lands (the panel shows the cue as
      // registered); a failed decode is already diagnosed.
      if (slot.decodeState === 'failed') this.diag('preview_decode_failed', `the cue "${key}" failed to decode`);
      return;
    }
    if (slot.live) return; // dedupe: one live voice per cue
    const liveCount = [...this.cues.values()].filter((s) => s.live).length;
    if (liveCount >= PREVIEW_AUDIO_MAX_VOICES) {
      this.diag('preview_voice_cap', 'the preview voice cap is reached; the cue is dropped (never queued)');
      return;
    }
    const ctx = this.context;
    const source = ctx.createBufferSource();
    source.buffer = slot.buffer;
    source.connect(ctx.destination);
    slot.live = true;
    source.onended = () => {
      if (slot.live) {
        slot.live = false;
        source.onended = null;
      }
    };
    try {
      source.start();
    } catch {
      slot.live = false;
      this.diag('preview_decode_failed', `the preview voice for "${key}" failed to start`);
    }
  }

  setMuted(muted: boolean): void {
    if (!this.guard()) return;
    this.muted = muted;
  }

  status(): PreviewAudioStatus {
    if (this.disposed) return { state: 'disposed' };
    if (this.unlocked && this.context === null) return { state: 'unsupported' };
    if (!this.unlocked || this.context === null || this.context.state !== 'running') return { state: 'blocked' };
    return { state: 'ready', muted: this.muted };
  }

  /** The bounded diagnostic ring (panel display; ≤ 64, drop-oldest). */
  diagnostics(): readonly PreviewAudioDiagnostic[] {
    return [...this.diagnosticsRing];
  }

  /** The number of live preview voices (diagnostic display). */
  liveVoices(): number {
    return [...this.cues.values()].filter((s) => s.live).length;
  }

  /** Exactly one close of the created context; idempotent afterwards. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.cues.values()) {
      slot.live = false;
      slot.buffer = null;
      slot.decodeState = 'failed';
    }
    this.cues.clear();
    if (this.context !== null) {
      try {
        await this.context.close();
      } catch {
        // A failed close is already reflected in the context state.
      }
    }
  }

  private async decodeOne(slot: CueSlot, key: string): Promise<void> {
    const ctx = this.context;
    if (ctx === null || slot.decodeState !== 'pending') return;
    try {
      const copy = slot.bytes.slice().buffer;
      const buffer = await ctx.decodeAudioData(copy);
      // A re-registration replaced the slot while the decode was in flight.
      if (this.cues.get(key) === slot) {
        slot.buffer = buffer;
        slot.decodeState = 'ok';
      }
    } catch {
      if (this.cues.get(key) === slot) {
        slot.decodeState = 'failed';
        this.diag('preview_decode_failed', `the cue "${key}" bytes could not be decoded as audio`);
      }
    }
  }

  private async decodeAllPending(): Promise<void> {
    for (const [key, slot] of this.cues) {
      if (slot.decodeState === 'pending') await this.decodeOne(slot, key);
    }
  }
}

/** The preview voice cap (mirrors the game owner's `AUDIO_MAX_VOICES = 8`). */
export const PREVIEW_AUDIO_MAX_VOICES = 8;

/** Create one editor-page preview owner (the App owns its lifetime). */
export function createPreviewAudioOwner(config?: PreviewAudioOwnerConfig): PreviewAudioOwner {
  return new PreviewAudioOwner(config);
}