/**
 * M3 preview audio owner tests (packet 57) — the editor-page preview
 * utility: gesture gating (RULE 1), bounded decode (RULE 2), bounded voices
 * (RULE 3), per-cue dedupe (RULE 4), idempotent dispose (RULE 5).
 *
 * Deterministic: the fake Web Audio graph is injected (no real AudioContext,
 * no clock, no PRNG, no global audio state) — the same approach as
 * `packages/game-host/src/audio.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { createPreviewAudioOwner, PREVIEW_AUDIO_MAX_VOICES, type PreviewAudioContextLike } from './preview-audio';

interface FakeSource {
  buffer: unknown;
  gain: unknown;
  connect(t: unknown): void;
  start(): void;
  onended: (() => void) | null;
  started: boolean;
}

interface FakeGraph {
  ctx: PreviewAudioContextLike;
  factory: () => PreviewAudioContextLike | null;
  factoryCalls: number;
  resumeCalls: number;
  closeCalls: number;
  decodeCalls: number;
  decodeHook: (input: ArrayBuffer) => { ok: boolean; duration?: number };
  sources: FakeSource[];
  closeHook?: () => void;
}

function makeGraph(opts: { failFactory?: boolean; decodeHook?: (input: ArrayBuffer) => { ok: boolean; duration?: number } } = {}): FakeGraph {
  const g: FakeGraph = {
    ctx: null as unknown as PreviewAudioContextLike,
    factory: () => {
      g.factoryCalls += 1;
      return opts.failFactory ? null : g.ctx;
    },
    factoryCalls: 0,
    resumeCalls: 0,
    closeCalls: 0,
    decodeCalls: 0,
    decodeHook: opts.decodeHook ?? (() => ({ ok: true, duration: 0.5 })),
    sources: [],
  };
  const state = { s: 'suspended' as 'suspended' | 'running' | 'closed' };
  g.ctx = {
    get state() {
      return state.s;
    },
    destination: {},
    resume: async () => {
      g.resumeCalls += 1;
      state.s = 'running';
    },
    close: async () => {
      g.closeCalls += 1;
      state.s = 'closed';
      g.closeHook?.();
    },
    decodeAudioData: async (input: ArrayBuffer) => {
      g.decodeCalls += 1;
      const r = g.decodeHook(input);
      if (!r.ok) throw new Error('decode failed');
      return { duration: r.duration ?? 0.5 };
    },
    createBufferSource: () => {
      const src: FakeSource = {
        buffer: null,
        gain: null,
        connect() {},
        start() {
          src.started = true;
        },
        onended: null,
        started: false,
      };
      g.sources.push(src);
      return src;
    },
  };
  return g;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

describe('RULE 1 — the context is created only by the explicit gesture', () => {
  it('stays blocked before unlock (register/preview never throw, nothing plays)', async () => {
    const g = makeGraph();
    const owner = createPreviewAudioOwner({ contextFactory: g.factory });
    expect(owner.status()).toEqual({ state: 'blocked' });
    owner.registerCue('cue-a', new Uint8Array([1, 2, 3]));
    owner.preview('cue-a');
    expect(owner.status()).toEqual({ state: 'blocked' });
    expect(owner.liveVoices()).toBe(0);
    expect(owner.diagnostics()).toEqual([]);
    expect(g.factoryCalls).toBe(0);
  });

  it('unlock() creates the context exactly once, resumes it and decodes the registered cues', async () => {
    const g = makeGraph();
    const owner = createPreviewAudioOwner({ contextFactory: g.factory });
    owner.registerCue('cue-a', new Uint8Array([9, 9]));
    await owner.unlock();
    expect(g.factoryCalls).toBe(1);
    expect(g.resumeCalls).toBe(1);
    expect(g.decodeCalls).toBe(1);
    expect(owner.status()).toEqual({ state: 'ready', muted: false });
    // A second gesture does not create a second context.
    await owner.unlock();
    expect(g.factoryCalls).toBe(1);
  });
});

describe('RULE 3/4 — bounded voices + per-cue dedupe', () => {
  it('plays a cue once and releases the voice on ended', async () => {
    const g = makeGraph();
    const owner = createPreviewAudioOwner({ contextFactory: g.factory });
    owner.registerCue('cue-a', new Uint8Array([1]));
    await owner.unlock();
    owner.preview('cue-a');
    expect(owner.liveVoices()).toBe(1);
    const first = g.sources[0]!;
    expect(first).toBeDefined();
    expect(first.started).toBe(true);
    const ended = first.onended;
    expect(ended).not.toBeNull();
    ended?.();
    expect(owner.liveVoices()).toBe(0);
    // A second play starts a second voice (released).
    owner.preview('cue-a');
    expect(owner.liveVoices()).toBe(1);
  });

  it('dedupes: a second preview of a live cue adds no voice', async () => {
    const g = makeGraph();
    const owner = createPreviewAudioOwner({ contextFactory: g.factory });
    owner.registerCue('cue-a', new Uint8Array([1]));
    await owner.unlock();
    owner.preview('cue-a');
    owner.preview('cue-a');
    expect(owner.liveVoices()).toBe(1);
    expect(g.sources.length).toBe(1);
  });

  it('drops (never queues) a new cue at the voice cap, with one bounded diagnostic', async () => {
    const g = makeGraph();
    const owner = createPreviewAudioOwner({ contextFactory: g.factory });
    for (let i = 0; i < PREVIEW_AUDIO_MAX_VOICES; i += 1) owner.registerCue(`cue-${i}`, new Uint8Array([i]));
    owner.registerCue('cue-over', new Uint8Array([99]));
    await owner.unlock();
    for (let i = 0; i < PREVIEW_AUDIO_MAX_VOICES; i += 1) owner.preview(`cue-${i}`);
    expect(owner.liveVoices()).toBe(PREVIEW_AUDIO_MAX_VOICES);
    owner.preview('cue-over');
    expect(owner.liveVoices()).toBe(PREVIEW_AUDIO_MAX_VOICES);
    expect(g.sources.length).toBe(PREVIEW_AUDIO_MAX_VOICES);
    const diag = owner.diagnostics();
    expect(diag.length).toBe(1);
    expect(diag[0]?.code).toBe('preview_voice_cap');
  });
});

describe('mute + decode failure (RULE 2)', () => {
  it('muted: preview is a no-op and the status reports muted', async () => {
    const g = makeGraph();
    const owner = createPreviewAudioOwner({ contextFactory: g.factory });
    owner.registerCue('cue-a', new Uint8Array([1]));
    await owner.unlock();
    owner.setMuted(true);
    owner.preview('cue-a');
    expect(owner.liveVoices()).toBe(0);
    expect(owner.status()).toEqual({ state: 'ready', muted: true });
    owner.setMuted(false);
    owner.preview('cue-a');
    expect(owner.liveVoices()).toBe(1);
  });

  it('a decode failure is a bounded diagnostic; previewing the failed cue adds no voice', async () => {
    const g = makeGraph({ decodeHook: (input) => ({ ok: input.byteLength !== 7, duration: 0.2 }) });
    const owner = createPreviewAudioOwner({ contextFactory: g.factory });
    owner.registerCue('good', new Uint8Array([1, 1]));
    owner.registerCue('bad', new Uint8Array(new Array(7).fill(0)));
    await owner.unlock();
    expect(owner.diagnostics().some((d) => d.code === 'preview_decode_failed')).toBe(true);
    owner.preview('bad');
    expect(owner.liveVoices()).toBe(0);
    owner.preview('good');
    expect(owner.liveVoices()).toBe(1);
  });
});

describe('re-registration + decode isolation (RULE 2)', () => {
  it('a re-registration after the gesture re-decodes fresh bytes (the old slot is cancelled)', async () => {
    const g = makeGraph({ decodeHook: (input) => ({ ok: input.byteLength < 100, duration: 0.3 }) });
    const owner = createPreviewAudioOwner({ contextFactory: g.factory });
    owner.registerCue('cue-a', new Uint8Array(new Array(200).fill(5))); // would fail
    await owner.unlock();
    expect(owner.diagnostics().some((d) => d.code === 'preview_decode_failed')).toBe(true);
    const before = g.decodeCalls;
    owner.registerCue('cue-a', new Uint8Array([1, 2])); // fresh, decodable
    await flush();
    expect(g.decodeCalls).toBe(before + 1);
    owner.preview('cue-a');
    expect(owner.liveVoices()).toBe(1);
  });

  it('the decode never mutates the registered bytes (it works on a copy)', async () => {
    const g = makeGraph();
    const owner = createPreviewAudioOwner({ contextFactory: g.factory });
    const bytes = new Uint8Array([7, 8, 9]);
    owner.registerCue('cue-a', bytes);
    await owner.unlock();
    expect(bytes).toEqual(new Uint8Array([7, 8, 9]));
  });
});

describe('RULE 5 — dispose (idempotent) + unsupported platform', () => {
  it('dispose closes the context exactly once; afterwards every method reports disposed', async () => {
    const g = makeGraph();
    const owner = createPreviewAudioOwner({ contextFactory: g.factory });
    owner.registerCue('cue-a', new Uint8Array([1]));
    await owner.unlock();
    owner.preview('cue-a');
    await owner.dispose();
    expect(g.closeCalls).toBe(1);
    expect(owner.status()).toEqual({ state: 'disposed' });
    await owner.dispose(); // idempotent
    expect(g.closeCalls).toBe(1);
    owner.registerCue('cue-b', new Uint8Array([2]));
    owner.preview('cue-b');
    expect(owner.liveVoices()).toBe(0);
    const diag = owner.diagnostics();
    expect(diag.some((d) => d.code === 'preview_audio_disposed')).toBe(true);
  });

  it('a missing platform (null factory) is the `unsupported` state, never a throw', async () => {
    const g = makeGraph({ failFactory: true });
    const owner = createPreviewAudioOwner({ contextFactory: g.factory });
    await owner.unlock();
    expect(owner.status()).toEqual({ state: 'unsupported' });
    owner.registerCue('cue-a', new Uint8Array([1]));
    owner.preview('cue-a');
    expect(owner.liveVoices()).toBe(0);
    await owner.dispose();
  });
});

describe('the diagnostic ring is bounded (≤ 64, drop-oldest)', () => {
  it('70 bounded events keep the newest 64', async () => {
    const g = makeGraph();
    const owner = createPreviewAudioOwner({ contextFactory: g.factory });
    await owner.unlock();
    for (let i = 0; i < 70; i += 1) owner.preview(`never-registered-${i}`);
    const diag = owner.diagnostics();
    expect(diag.length).toBe(64);
    const last = diag[diag.length - 1];
    const oldest = diag[0];
    expect(last?.message).toContain('never-registered-69');
    expect(oldest?.message).not.toContain('never-registered-0');
  });
});