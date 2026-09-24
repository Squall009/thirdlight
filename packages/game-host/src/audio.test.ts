/**
 * Packet 54 — the injected audio owner (presentation.md §41.4.7): the full
 * rule set exercised against a deterministic fake Web Audio graph (no
 * browser, no Node builtins — the owner's own injection seam). The
 * real-AudioContext halves (audibility, a real gesture reaching `running`,
 * the browser checklist) are the `tests/browser/m3-audio` host + the
 * root `tests/m3-audio` real-cue-bytes tests; audibility stays UNVERIFIED
 * (packet 38 baseline §1: no audio device in this container).
 */
import { describe, expect, it } from 'vitest';
import {
  AUDIO_MAX_DIAGNOSTICS,
  AUDIO_MAX_VOICES,
  createGameAudioOwner,
  type AudioBufferLike,
  type AudioContextLike,
  type AudioNodeLike,
  type BufferSourceLike,
  type GameAudioOwner,
  type GameCueEvent,
  type GainNodeLike,
} from './audio';

// ---------------------------------------------------------------------------
// The deterministic fake Web Audio graph (the owner's injection seam).
// ---------------------------------------------------------------------------

class FakeBuffer implements AudioBufferLike {
  constructor(
    readonly duration: number,
    readonly sampleRate = 48_000,
  ) {
    this.length = Math.max(1, Math.floor(duration * sampleRate));
  }
  readonly length: number;
}

class FakeSource implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
  started = 0;
  stopped = 0;
  readonly connections: AudioNodeLike[] = [];
  connect(target: AudioNodeLike): void {
    this.connections.push(target);
  }
  start(): void {
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
  }
  /** The test drives `ended` explicitly (no clock, no timer). */
  fireEnded(): void {
    const cb = this.onended;
    this.onended = null;
    cb?.();
  }
  get live(): boolean {
    return this.started > 0 && this.onended !== null && this.stopped === 0;
  }
}

class FakeGain implements GainNodeLike {
  readonly gain = { value: 1 };
  readonly connections: AudioNodeLike[] = [];
  connect(target: AudioNodeLike): void {
    this.connections.push(target);
  }
}

class FakeDestination implements AudioNodeLike {
  connect(): void {
    throw new Error('destination is a sink');
  }
}

interface GatedDecode {
  readonly promise: Promise<FakeBuffer>;
  release: (buffer: FakeBuffer) => void;
  reject: (reason: unknown) => void;
}

class FakeContext implements AudioContextLike {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly sources: FakeSource[] = [];
  readonly decodedBytes: { len: number; buffer: ArrayBuffer }[] = [];
  readonly gates: GatedDecode[] = [];
  resumeCount = 0;
  suspendCount = 0;
  closeCount = 0;
  /** The next N resume() calls reject (autoplay denial). */
  resumeRejectsNext = 0;
  /** When set, every decodeAudioData is gated until the test releases it. */
  gateDecodes = false;
  /** Decode duration in seconds (default 0.5). */
  decodeDuration = 0.5;
  /** When true the context starts `closed` (no usable device). */
  constructor(initialClosed = false) {
    if (initialClosed) this.state = 'closed';
  }
  get destination(): AudioNodeLike {
    return new FakeDestination();
  }
  resume(): Promise<void> {
    this.resumeCount += 1;
    if (this.resumeRejectsNext > 0) {
      this.resumeRejectsNext -= 1;
      return Promise.reject(new Error('NotAllowedError: autoplay policy'));
    }
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.suspendCount += 1;
    this.state = 'suspended';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closeCount += 1;
    this.state = 'closed';
    return Promise.resolve();
  }
  decodeAudioData(data: ArrayBuffer): Promise<FakeBuffer> {
    this.decodedBytes.push({ len: data.byteLength, buffer: data });
    const buffer = new FakeBuffer(this.decodeDuration);
    if (!this.gateDecodes) return Promise.resolve(buffer);
    let release!: (b: FakeBuffer) => void;
    let reject!: (r: unknown) => void;
    const promise = new Promise<FakeBuffer>((res, rej) => {
      release = res;
      reject = rej;
    });
    this.gates.push({ promise, release, reject });
    return promise;
  }
  createBufferSource(): BufferSourceLike {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  createGain(): GainNodeLike {
    return new FakeGain();
  }
  liveVoices(): number {
    return this.sources.filter((s) => s.live).length;
  }
  releaseAllGates(): void {
    for (const gate of this.gates) gate.release(new FakeBuffer(this.decodeDuration));
    this.gates.length = 0;
  }
}

function makeEnv(factories: FakeContext[] = []) {
  const env = { factoryCount: 0, contexts: [] as FakeContext[] };
  const owner = createGameAudioOwner({
    contextFactory: () => {
      env.factoryCount += 1;
      const next = factories[env.factoryCount - 1] ?? new FakeContext();
      env.contexts.push(next);
      return next;
    },
  });
  return { env, owner };
}

function cue(
  runId: string,
  kind: GameCueEvent['kind'],
  step: number,
  assetId = 'cue-jump',
): GameCueEvent {
  return { id: `${runId}/${kind}/${step}`, kind, assetId, runId, stepIndex: step };
}

/** Let the owner's promise chains settle (microtasks only — no clock). */
async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    // A macrotask tick is fine here: it is the test harness's own yield,
    // not an owner clock read (the owner reads none).
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 0));
  }
}

describe('packet 54 — the audio owner: bytes-in, validation, status', () => {
  it('registerCue is bytes-in only: empty / non-Uint8Array bytes are audio_invalid_bytes', () => {
    const { owner } = makeEnv();
    expect(owner.registerCue('cue-jump', new Uint8Array(0))).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'audio_invalid_bytes' }),
    });
    expect((owner.registerCue('cue-jump', 42 as unknown as Uint8Array) as { error: { code: string } }).error.code).toBe(
      'audio_invalid_bytes',
    );
    expect(owner.registerCue('cue-jump', new Uint8Array([1, 2, 3, 4]))).toEqual({ ok: true });
    expect(owner.status().state).toBe('blocked'); // pre-gesture, factory present
    owner.dispose();
  });

  it('initial status is honest: blocked pre-gesture with a factory, unsupported without one', async () => {
    const { owner } = makeEnv();
    expect(owner.status()).toEqual({ state: 'blocked', reason: 'autoplay_denied' });
    const silent = createGameAudioOwner(); // no factory — no Web Audio
    expect(silent.status()).toEqual({ state: 'unsupported', reason: 'no_audio_context' });
    // Registration still works while unsupported (the game plays silently;
    // bytes are stored, decode is deferred).
    expect(silent.registerCue('cue-jump', new Uint8Array([1, 2, 3]))).toEqual({ ok: true });
    await expect(silent.unlock()).resolves.toEqual({ state: 'unsupported', reason: 'no_audio_context' });
    owner.dispose();
  });

  it('the decode runs on a COPY of the supplied bytes and never mutates them', async () => {
    const ctx = new FakeContext();
    const { owner } = makeEnv([ctx]);
    const input = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);
    const before = input.slice();
    expect(owner.registerCue('cue-jump', input)).toEqual({ ok: true });
    await owner.unlock();
    await settle();
    expect(ctx.decodedBytes).toHaveLength(1);
    expect(ctx.decodedBytes[0]!.buffer).not.toBe(input.buffer); // a copy, rule 2
    expect(new Uint8Array(ctx.decodedBytes[0]!.buffer)).toEqual(before);
    expect(input).toEqual(before); // never mutated
    owner.dispose();
  });

  it('a malformed decode is a bounded per-cue diagnostic — the game continues', async () => {
    const ctx = new FakeContext();
    const { owner } = makeEnv([ctx]);
    ctx.gateDecodes = true;
    expect(owner.registerCue('bad', new Uint8Array([1, 2]))).toEqual({ ok: true });
    expect(owner.registerCue('good', new Uint8Array([3, 4]))).toEqual({ ok: true });
    await owner.unlock();
    const [badGate, goodGate] = ctx.gates;
    badGate!.reject(new Error('EncodingError: malformed'));
    await settle();
    const badStatus = owner.submit([cue('run-1', 'jump', 1, 'bad')]);
    expect(badStatus).toEqual({ ok: true }); // soft: never a throw across the boundary
    expect(owner.diagnostics().some((d) => d.code === 'audio_decode_failed' && d.assetId === 'bad')).toBe(true);
    goodGate!.release(new FakeBuffer(0.25));
    await settle();
    expect(owner.submit([cue('run-1', 'jump', 2, 'good')])).toEqual({ ok: true });
    expect(ctx.liveVoices()).toBe(1); // the good cue still sounds
    owner.dispose();
  });

  it('the 16-asset store cap holds (the §41.4.5 catalog bound)', () => {
    const { owner } = makeEnv();
    for (let i = 0; i < 16; i += 1) {
      expect(owner.registerCue(`a${i}`, new Uint8Array([i]))).toEqual({ ok: true });
    }
    const over = owner.registerCue('a16', new Uint8Array([16])) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(over.ok).toBe(false);
    expect(over.error?.code).toBe('audio_invalid_bytes');
    // Re-registering an EXISTING asset is still allowed (the store is
    // bounded by distinct assets, not calls).
    expect(owner.registerCue('a0', new Uint8Array([0]))).toEqual({ ok: true });
    owner.dispose();
  });
});

describe('packet 54 — unlock (local gesture) and the sound-off ladder', () => {
  it('a rejected resume is a soft blocked status, not an error; a later gesture retries', async () => {
    const ctx = new FakeContext();
    ctx.resumeRejectsNext = 1;
    const { owner, env } = makeEnv([ctx]);
    await expect(owner.unlock()).resolves.toEqual({ state: 'blocked', reason: 'autoplay_denied' });
    expect(env.factoryCount).toBe(1); // one context per owner, created at the gesture
    expect(ctx.resumeCount).toBe(1);
    // No sound while blocked — but the game continues (submit is ok).
    owner.registerCue('cue-jump', new Uint8Array([1]));
    expect(owner.submit([cue('run-1', 'jump', 1)])).toEqual({ ok: true });
    expect(ctx.sources).toHaveLength(0);
    // The in-game local "Enable sound" gesture retries:
    await expect(owner.unlock()).resolves.toEqual({ state: 'ready', muted: false, unlocked: true });
    expect(env.factoryCount).toBe(1);
    expect(ctx.resumeCount).toBe(2);
    owner.dispose();
  });

  it('a factory that yields no context reports unsupported; a recovered environment unlocks', async () => {
    const good = new FakeContext();
    const env: { n: number; owner: GameAudioOwner } = {
      n: 0,
      owner: createGameAudioOwner({
        contextFactory: (): AudioContextLike | null => {
          env.n += 1;
          return env.n === 1 ? null : good;
        },
      }),
    };
    await expect(env.owner.unlock()).resolves.toEqual({ state: 'unsupported', reason: 'no_audio_context' });
    await expect(env.owner.unlock()).resolves.toEqual({ state: 'ready', muted: false, unlocked: true });
    env.owner.dispose();
  });

  it('a context that is closed on creation is no_device (soft blocked, not an error)', async () => {
    const { owner } = makeEnv([new FakeContext(true)]);
    await expect(owner.unlock()).resolves.toEqual({ state: 'blocked', reason: 'no_device' });
    expect(owner.submit([cue('run-1', 'jump', 1)])).toEqual({ ok: true }); // the game continues
    owner.dispose();
  });

  it('unlock is idempotent: the factory is invoked exactly once', async () => {
    const { owner, env } = makeEnv();
    await owner.unlock();
    await owner.unlock();
    expect(env.factoryCount).toBe(1);
    expect(owner.status()).toEqual({ state: 'ready', muted: false, unlocked: true });
    owner.dispose();
  });

  it('hidden before unlock: the gesture unlocks, then the context stays suspended (no sound while hidden)', async () => {
    const ctx = new FakeContext();
    const { owner } = makeEnv([ctx]);
    expect(owner.setHidden(true)).toEqual({ state: 'blocked', reason: 'autoplay_denied' }); // pre-gesture
    await owner.unlock();
    expect(ctx.resumeCount).toBe(1);
    expect(ctx.suspendCount).toBe(1); // the invariant is re-applied after unlock
    expect(ctx.state).toBe('suspended');
    expect(owner.status()).toEqual({ state: 'ready', muted: false, unlocked: true }); // ready = unlocked
    owner.setHidden(false);
    await settle();
    expect(ctx.state).toBe('running');
    owner.dispose();
  });
});

describe('packet 54 — committed cue submission: dedupe, cap, stale runs', () => {
  async function armed(assetId = 'cue-jump'): Promise<{ owner: GameAudioOwner; ctx: FakeContext }> {
    const ctx = new FakeContext();
    const { owner } = makeEnv([ctx]);
    owner.registerCue(assetId, new Uint8Array([1, 2, 3, 4]));
    await owner.unlock();
    await settle();
    return { owner, ctx };
  }

  it('the full cue path: one source per distinct committed id, dedupe is a no-op', async () => {
    const { owner, ctx } = await armed();
    const ev = cue('run-1', 'jump', 1);
    expect(owner.submit([ev])).toEqual({ ok: true });
    expect(owner.submit([ev, ev, ev])).toEqual({ ok: true }); // rule 4: at most once
    expect(ctx.sources).toHaveLength(1);
    const source = ctx.sources[0]!;
    expect(source.buffer).toBeInstanceOf(FakeBuffer);
    expect(source.connections).toHaveLength(1); // source → gain
    expect((source.connections[0] as FakeGain).connections).toHaveLength(1); // gain → destination
    expect((source.connections[0] as FakeGain).gain.value).toBe(1);
    owner.submit([cue('run-1', 'checkpoint', 5, 'cue-checkpoint')]); // a different id needs the asset…
    expect(owner.diagnostics().some((d) => d.code === 'cue_skipped')).toBe(true); // …which was never registered
    expect(ctx.liveVoices()).toBe(1);
    owner.dispose();
  });

  it('the voice cap is 8: the 9th cue is dropped with a bounded voice_cap diagnostic, never queued', async () => {
    const { owner, ctx } = await armed();
    for (let step = 0; step < AUDIO_MAX_VOICES; step += 1) {
      owner.submit([cue('run-1', 'jump', step)]);
    }
    expect(ctx.liveVoices()).toBe(AUDIO_MAX_VOICES);
    owner.submit([cue('run-1', 'jump', 100)]); // the 9th
    expect(ctx.liveVoices()).toBe(AUDIO_MAX_VOICES);
    expect(ctx.sources).toHaveLength(AUDIO_MAX_VOICES); // no 9th source was created
    const caps = owner.diagnostics().filter((d) => d.code === 'voice_cap');
    expect(caps).toHaveLength(1);
    expect(caps[0]!.message).toContain('voice_cap');
    // A voice ends → the next cue plays (the slot is released on ended).
    ctx.sources[0]!.fireEnded();
    owner.submit([cue('run-1', 'jump', 101)]);
    expect(ctx.liveVoices()).toBe(AUDIO_MAX_VOICES);
    expect(ctx.sources).toHaveLength(AUDIO_MAX_VOICES + 1);
    owner.dispose();
  });

  it('phase 15.3: the voice count is the project\'s audio_voices (maxVoices), clamped to 1..32', async () => {
    for (const [asked, cap] of [[3, 3], [20, 20], [100, 32], [0, 1]] as const) {
      const ctx = new FakeContext();
      const owner = createGameAudioOwner({ contextFactory: () => ctx, maxVoices: asked });
      owner.registerCue('cue-jump', new Uint8Array([1, 2, 3, 4]));
      await owner.unlock();
      await settle();
      for (let step = 0; step < cap + 5; step += 1) owner.submit([cue('run-1', 'jump', step)]);
      expect(ctx.liveVoices(), `maxVoices ${asked}`).toBe(cap);
      expect(owner.diagnostics().filter((d) => d.code === 'voice_cap')).toHaveLength(5);
      owner.dispose();
    }
  });

  it('the diagnostic ring is bounded (drop-oldest at AUDIO_MAX_DIAGNOSTICS)', async () => {
    const { owner } = await armed();
    for (let step = 0; step < AUDIO_MAX_VOICES; step += 1) owner.submit([cue('run-1', 'jump', step)]);
    for (let step = 0; step < 100; step += 1) owner.submit([cue('run-1', 'jump', 1000 + step)]);
    expect(owner.diagnostics()).toHaveLength(AUDIO_MAX_DIAGNOSTICS);
    owner.dispose();
  });

  it('a run change stops every voice, marks in-flight decodes stale, and clears the dedupe set', async () => {
    const ctx = new FakeContext();
    ctx.gateDecodes = true;
    const { owner } = makeEnv([ctx]);
    owner.registerCue('cue-jump', new Uint8Array([1, 2, 3, 4]));
    owner.registerCue('late', new Uint8Array([5, 6, 7, 8]));
    await owner.unlock();
    expect(ctx.gates).toHaveLength(2); // both decodes are in flight (gated)
    owner.submit([cue('run-1', 'jump', 1)]); // cue skipped: still decoding
    expect(ctx.liveVoices()).toBe(0);
    // stop()/replay: a new run arrives.
    owner.submit([cue('run-2', 'start', 1, 'cue-jump')]);
    const stale = owner.diagnostics().filter((d) => d.code === 'stale_work_discarded');
    expect(stale.length).toBeGreaterThanOrEqual(1);
    expect(stale[0]!.message).toContain('run changed');
    // The in-flight decodes resolve after the run change: the OLD buffers
    // are discarded, never played (rule 5), and fresh decodes are re-armed
    // for the current run — which the gate catches again (proof they are
    // NEW work, not the stale buffers):
    ctx.releaseAllGates();
    await settle();
    expect(ctx.gates.length).toBe(2); // the re-armed decodes
    ctx.releaseAllGates();
    await settle();
    expect(owner.submit([cue('run-2', 'start', 2, 'cue-jump')])).toEqual({ ok: true });
    expect(ctx.liveVoices()).toBe(1); // the re-armed decode served the new run
    // A cue from the PREVIOUS run is never replayed into the new run: it
    // arrives inside a current-run submit (a committed view is single-run;
    // a late old-run event is the "cue from old run" failure mode):
    owner.submit([cue('run-2', 'jump', 7), cue('run-1', 'jump', 9, 'cue-jump')]);
    const stale2 = owner.diagnostics().filter((d) => d.code === 'stale_work_discarded');
    expect(stale2.some((d) => d.message.includes('different run'))).toBe(true);
    expect(ctx.liveVoices()).toBe(2); // the current-run cue played; the old one never did
    owner.dispose();
  });

  it('a late event with a foreign runId inside one submit is skipped, never played', async () => {
    const { owner, ctx } = await armed();
    owner.submit([cue('run-1', 'jump', 1), cue('run-0', 'jump', 9)]);
    expect(ctx.liveVoices()).toBe(1); // only the current-run cue played
    expect(
      owner.diagnostics().some((d) => d.code === 'stale_work_discarded' && d.message.includes('run-0')),
    ).toBe(true);
    owner.dispose();
  });

  it('submit of zero events is a clean no-op', async () => {
    const { owner, ctx } = await armed();
    expect(owner.submit([])).toEqual({ ok: true });
    expect(ctx.sources).toHaveLength(0);
    expect(owner.diagnostics()).toHaveLength(0);
    owner.dispose();
  });
});

describe('packet 54 — mute, hidden, dispose', () => {
  async function armed(assetId = 'cue-jump'): Promise<{ owner: GameAudioOwner; ctx: FakeContext }> {
    const ctx = new FakeContext();
    const { owner } = makeEnv([ctx]);
    owner.registerCue(assetId, new Uint8Array([1, 2, 3, 4]));
    await owner.unlock();
    await settle();
    return { owner, ctx };
  }

  it('mute stops current voices, defers decodes, and nothing plays while muted', async () => {
    const ctx = new FakeContext();
    const { owner } = makeEnv([ctx]);
    owner.registerCue('cue-jump', new Uint8Array([1, 2, 3, 4]));
    await owner.unlock();
    await settle();
    owner.submit([cue('run-1', 'jump', 1)]);
    expect(ctx.liveVoices()).toBe(1);
    expect(owner.setMuted(true)).toEqual({ state: 'ready', muted: true, unlocked: true });
    expect(ctx.liveVoices()).toBe(0); // current voices stopped
    expect(ctx.sources[0]!.stopped).toBe(1);
    // Nothing is decoded while muted:
    owner.registerCue('deferred', new Uint8Array([9, 9]));
    await settle();
    expect(ctx.decodedBytes).toHaveLength(1); // only the pre-mute asset decoded
    // Nothing is played while muted:
    owner.submit([cue('run-1', 'jump', 2, 'deferred')]);
    expect(ctx.liveVoices()).toBe(0);
    // Unmute: the deferred decode runs and the next cue plays.
    expect(owner.setMuted(false)).toEqual({ state: 'ready', muted: false, unlocked: true });
    await settle();
    expect(ctx.decodedBytes).toHaveLength(2);
    owner.submit([cue('run-1', 'jump', 3, 'deferred')]);
    expect(ctx.liveVoices()).toBe(1);
    owner.dispose();
  });

  it('hidden suspends the context; visible resumes only when unlocked; a rejected resume degrades to blocked', async () => {
    const ctx = new FakeContext();
    const { owner } = makeEnv([ctx]);
    await owner.unlock();
    expect(owner.setHidden(true)).toEqual({ state: 'ready', muted: false, unlocked: true });
    await settle();
    expect(ctx.suspendCount).toBe(1);
    expect(ctx.state).toBe('suspended');
    // Hidden: no resume attempt without a prior unlock; with an unlock, the
    // visible transition attempts resume:
    ctx.resumeRejectsNext = 1;
    owner.setHidden(false);
    await settle();
    expect(ctx.resumeCount).toBe(2);
    expect(owner.status()).toEqual({ state: 'blocked', reason: 'autoplay_denied' }); // degraded, not an error
    // A later local gesture retries and recovers:
    await owner.unlock();
    expect(owner.status()).toEqual({ state: 'ready', muted: false, unlocked: true });
    // setHidden(false) before any unlock attempts nothing:
    const ctx2 = new FakeContext();
    const { owner: owner2 } = makeEnv([ctx2]);
    owner2.setHidden(false);
    await settle();
    expect(ctx2.resumeCount).toBe(0);
    owner.dispose();
    owner2.dispose();
  });

  it('dispose closes the created context exactly once, releases voices, and cancels in-flight work', async () => {
    const ctx = new FakeContext();
    ctx.gateDecodes = true;
    const { owner } = makeEnv([ctx]);
    owner.registerCue('cue-jump', new Uint8Array([1, 2, 3, 4]));
    owner.registerCue('pending', new Uint8Array([5, 6, 7, 8]));
    await owner.unlock();
    // Force one live voice: register+decode a ready asset (ungate just that
    // decode by releasing the first gate), then submit.
    ctx.gates[0]!.release(new FakeBuffer(0.25));
    await settle();
    owner.submit([cue('run-1', 'jump', 1)]);
    expect(ctx.liveVoices()).toBe(1);
    expect(owner.dispose()).toEqual({ ok: true });
    expect(ctx.closeCount).toBe(1);
    expect(ctx.liveVoices()).toBe(0); // every voice released
    expect(ctx.sources[0]!.stopped).toBe(1);
    // Rule 8: closing is synchronous w.r.t. public state.
    expect(owner.status()).toEqual({ state: 'disposed' });
    expect(owner.registerCue('x', new Uint8Array([1]))).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'audio_disposed' }),
    });
    expect(owner.submit([cue('run-1', 'jump', 2)])).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'audio_disposed' }),
    });
    expect(owner.setMuted(true)).toEqual({ state: 'disposed' });
    expect(owner.setHidden(false)).toEqual({ state: 'disposed' });
    await expect(owner.unlock()).resolves.toEqual({ state: 'disposed' });
    expect(owner.dispose()).toEqual({ ok: true, alreadyDisposed: true });
    expect(ctx.closeCount).toBe(1); // closed exactly once
    // The in-flight decode resolves AFTER dispose: discarded, never played.
    ctx.releaseAllGates();
    await settle();
    expect(ctx.sources).toHaveLength(1); // no new voice
    expect(owner.diagnostics().some((d) => d.code === 'stale_work_discarded')).toBe(true);
  });

  it('a re-registered asset (a new version) serves the new bytes to later cues', async () => {
    const { owner, ctx } = await armed();
    const v1 = cue('run-1', 'jump', 1);
    owner.submit([v1]);
    expect(ctx.liveVoices()).toBe(1);
    const v1Dur = ctx.sources[0]!.buffer!.duration;
    // A new version of the same asset (reimport moved the bytes):
    ctx.decodeDuration = 1.25;
    owner.registerCue('cue-jump', new Uint8Array([7, 7, 7, 7, 7]));
    await settle();
    owner.submit([cue('run-1', 'jump', 2)]);
    expect(ctx.liveVoices()).toBe(2);
    expect(ctx.sources[1]!.buffer!.duration).toBe(1.25);
    expect(ctx.sources[1]!.buffer!.duration).not.toBe(v1Dur);
    owner.dispose();
  });
});

describe('packet 54 — determinism (no clock, no global audio state)', () => {
  function scripted(owner: GameAudioOwner): Promise<{ diag: string[]; status: string }> {
    return (async () => {
      owner.registerCue('a', new Uint8Array([1]));
      owner.registerCue('b', new Uint8Array([2]));
      await owner.unlock();
      await settle();
      owner.submit([cue('r1', 'jump', 1, 'a'), cue('r1', 'jump', 1, 'a')]);
      owner.setMuted(true);
      owner.submit([cue('r1', 'jump', 2, 'b')]);
      owner.setMuted(false);
      await settle();
      owner.submit([cue('r2', 'start', 1, 'a')]);
      return {
        diag: owner.diagnostics().map((d) => `${d.code}:${d.assetId}`),
        status: JSON.stringify(owner.status()),
      };
    })();
  }

  it('two owners over identical scripted inputs produce identical observable sequences', async () => {
    const { owner: o1 } = makeEnv();
    const { owner: o2 } = makeEnv();
    const [s1, s2] = await Promise.all([scripted(o1), scripted(o2)]);
    expect(s2).toEqual(s1);
    expect(s1.diag.length).toBeGreaterThan(0);
    o1.dispose();
    o2.dispose();
  });
});