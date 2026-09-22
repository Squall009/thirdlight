/**
 * Packet 54 — the audio owner over the REAL committed cue bytes
 * (`tests/m3-audio/**`): the five `fixtures/m3/media/wav/cue-*.wav` cues
 * (digest-verified against the media `index.json`) drive the owner end to
 * end — registration, the real PCM decode (a pure re-derivation of the
 * §41.4.4 arithmetic; the container has no Web Audio decoder in Node), the
 * committed-cue submission, the voice cap under a flood, mute/hidden, and
 * dispose — plus a real rejected byte string
 * (`wav/rejections/bad-magic.wav`) taking the malformed-decode path.
 *
 * The environment is the owner's injected context factory (a
 * deterministic fake whose `decodeAudioData` really parses the committed
 * WAV bytes — audibility itself stays UNVERIFIED per packet 38 baseline §1:
 * no audio device in this container). Runs in Node (the repo-root test
 * tree may use Node built-ins; the `packages/**` code it drives does not).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AUDIO_MAX_VOICES,
  createGameAudioOwner,
  type AudioBufferLike,
  type AudioContextLike,
  type AudioNodeLike,
  type BufferSourceLike,
  type GameAudioOwner,
  type GameCueEvent,
  type GainNodeLike,
} from '@thirdlight/game-host';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MEDIA = join(REPO_ROOT, 'fixtures', 'm3', 'media');

interface IndexFile {
  kind: string;
  bytes: number;
  sha256: string;
}

function indexFile(path: string): IndexFile {
  const index = JSON.parse(readFileSync(join(MEDIA, 'index.json'), 'utf8')) as {
    files: Record<string, IndexFile>;
  };
  const entry = index.files[path];
  expect(entry, `media index must pin ${path}`).toBeDefined();
  return entry!;
}

function cueBytes(path: string): Uint8Array {
  const bytes = readFileSync(join(MEDIA, path));
  const entry = indexFile(path);
  expect(bytes.length).toBe(entry.bytes);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** The §41.4.4 arithmetic re-derived (stages 2/8/9/10): strict 44+data
 * PCM-WAV only — exactly the committed-cue shape. Throws on anything else
 * (a real decoder would reject these too). */
function pcmWavDurationSeconds(data: Uint8Array): number {
  if (data.length < 44) throw new Error('source too short');
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const riff = String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!);
  const wave = String.fromCharCode(data[8]!, data[9]!, data[10]!, data[11]!);
  if (riff !== 'RIFF' || wave !== 'WAVE') throw new Error('container: not RIFF/WAVE');
  const fmt = String.fromCharCode(data[12]!, data[13]!, data[14]!, data[15]!);
  const dataId = String.fromCharCode(data[36]!, data[37]!, data[38]!, data[39]!);
  if (fmt !== 'fmt ' || dataId !== 'data') throw new Error('chunk framing');
  const fmtSize = dv.getUint32(16, true);
  const audioFormat = dv.getUint16(20, true);
  const channels = dv.getUint16(22, true);
  const sampleRate = dv.getUint32(24, true);
  const bitsPerSample = dv.getUint16(34, true);
  if (fmtSize !== 16 || audioFormat !== 1 || channels !== 1 || bitsPerSample !== 16) {
    throw new Error('format: not 16-bit mono PCM');
  }
  if (sampleRate !== 48_000) throw new Error('rate: not 48 kHz');
  const dataBytes = dv.getUint32(40, true);
  if (data.length !== 44 + dataBytes) throw new Error('chunk framing: bytes do not fill the file');
  if (dataBytes < 2 || dataBytes % 2 !== 0) throw new Error('data: empty or odd');
  return dataBytes / 2 / 48_000; // frames / sampleRate
}

// ---------------------------------------------------------------------------
// The deterministic fake Web Audio graph (Node side: no real Web Audio).
// ---------------------------------------------------------------------------

class FakeBuffer implements AudioBufferLike {
  constructor(readonly duration: number) {
    this.length = Math.max(1, Math.floor(duration * 48_000));
  }
  readonly sampleRate = 48_000;
  readonly length: number;
}

class FakeSource implements BufferSourceLike {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
  started = 0;
  stopped = 0;
  connect(): void {}
  start(): void {
    this.started += 1;
  }
  stop(): void {
    this.stopped += 1;
  }
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
  connect(): void {}
}

class FakeContext implements AudioContextLike {
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  readonly sources: FakeSource[] = [];
  readonly decodedDurations: number[] = [];
  closeCount = 0;
  readonly destination = { connect(): void {} } as AudioNodeLike;
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closeCount += 1;
    this.state = 'closed';
    return Promise.resolve();
  }
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
    try {
      const duration = pcmWavDurationSeconds(new Uint8Array(data));
      this.decodedDurations.push(duration);
      return Promise.resolve(new FakeBuffer(duration));
    } catch (err) {
      // The real decodeAudioData fails asynchronously (a rejected promise),
      // never with a synchronous throw — rule 2's bounded path is the
      // owner's .catch, so the fake mirrors the real API.
      return Promise.reject(err);
    }
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
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

function cue(runId: string, kind: GameCueEvent['kind'], step: number, assetId: string): GameCueEvent {
  return { id: `${runId}/${kind}/${step}`, kind, assetId, runId, stepIndex: step };
}

const CUES: { kind: GameCueEvent['kind']; assetId: string; file: string }[] = [
  { kind: 'start', assetId: 'asset-audio-start', file: 'wav/cue-start.wav' },
  { kind: 'jump', assetId: 'asset-audio-jump', file: 'wav/cue-jump.wav' },
  { kind: 'checkpoint', assetId: 'asset-audio-checkpoint', file: 'wav/cue-checkpoint.wav' },
  { kind: 'death', assetId: 'asset-audio-death', file: 'wav/cue-death.wav' },
  { kind: 'goal', assetId: 'asset-audio-goal', file: 'wav/cue-goal.wav' },
];

function armed(): { owner: GameAudioOwner; ctx: FakeContext } {
  const ctx = new FakeContext();
  const owner = createGameAudioOwner({ contextFactory: () => ctx });
  for (const cueSpec of CUES) {
    owner.registerCue(cueSpec.assetId, cueBytes(cueSpec.file));
  }
  return { owner, ctx };
}

describe('packet 54 — the owner over the REAL committed cue bytes', () => {
  it('the five real cues register, decode to the committed PCM durations, and each committed event sounds once', async () => {
    const { owner, ctx } = armed();
    await owner.unlock();
    await settle();
    expect(ctx.decodedDurations).toHaveLength(5);
    // The re-derived durations match the real byte arithmetic (44+data):
    for (const cueSpec of CUES) {
      const bytes = cueBytes(cueSpec.file);
      const expected = pcmWavDurationSeconds(bytes);
      expect(ctx.decodedDurations).toContain(expected);
      expect(expected).toBeGreaterThan(0);
    }
    // Every cue kind sounds exactly once (the committed event id dedupes):
    for (const [i, cueSpec] of CUES.entries()) {
      const ev = cue('run-1', cueSpec.kind, i, cueSpec.assetId);
      expect(owner.submit([ev, ev, ev])).toEqual({ ok: true });
    }
    expect(ctx.liveVoices()).toBe(5);
    expect(ctx.sources).toHaveLength(5);
    // No voice is shorter than the shortest committed cue (the bytes are
    // real, not stubs):
    expect(Math.min(...ctx.sources.map((s) => s.buffer!.duration!))).toBe(
      Math.min(...CUES.map((c) => pcmWavDurationSeconds(cueBytes(c.file)))),
    );
    owner.dispose();
  });

  it('a flood of 20 committed jump cues holds the 8-voice cap and drops 12 with bounded voice_cap diagnostics', async () => {
    const { owner, ctx } = armed();
    await owner.unlock();
    await settle();
    for (let step = 1; step <= 20; step += 1) {
      owner.submit([cue('run-1', 'jump', step, 'asset-audio-jump')]);
    }
    expect(ctx.sources).toHaveLength(AUDIO_MAX_VOICES); // no 9th+ source was ever created
    expect(ctx.liveVoices()).toBe(AUDIO_MAX_VOICES);
    const caps = owner.diagnostics().filter((d) => d.code === 'voice_cap');
    expect(caps).toHaveLength(20 - AUDIO_MAX_VOICES);
    // A voice ends → the next committed cue plays (release on ended):
    ctx.sources[0]!.fireEnded();
    owner.submit([cue('run-1', 'jump', 21, 'asset-audio-jump')]);
    expect(ctx.sources).toHaveLength(AUDIO_MAX_VOICES + 1);
    expect(ctx.liveVoices()).toBe(AUDIO_MAX_VOICES);
    owner.dispose();
  });

  it('mute/unmute and dispose over the real cues: no sound while muted, one context close', async () => {
    const { owner, ctx } = armed();
    await owner.unlock();
    await settle();
    owner.submit([cue('run-1', 'start', 0, 'asset-audio-start')]);
    expect(ctx.liveVoices()).toBe(1);
    expect(owner.setMuted(true)).toEqual({ state: 'ready', muted: true, unlocked: true });
    expect(ctx.liveVoices()).toBe(0);
    owner.submit([cue('run-1', 'jump', 1, 'asset-audio-jump')]);
    expect(ctx.liveVoices()).toBe(0);
    expect(owner.setMuted(false)).toEqual({ state: 'ready', muted: false, unlocked: true });
    owner.submit([cue('run-1', 'jump', 2, 'asset-audio-jump')]);
    expect(ctx.liveVoices()).toBe(1);
    // Hidden: the context suspends (no sound while the tab is hidden):
    owner.setHidden(true);
    await settle();
    expect(ctx.state).toBe('suspended');
    owner.setHidden(false);
    await settle();
    expect(ctx.state).toBe('running');
    // Dispose: exactly one close, everything disposed afterwards:
    expect(owner.dispose()).toEqual({ ok: true });
    expect(ctx.closeCount).toBe(1);
    expect(owner.status()).toEqual({ state: 'disposed' });
    expect(owner.submit([cue('run-1', 'goal', 3, 'asset-audio-goal')])).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'audio_disposed' }),
    });
    owner.dispose();
    expect(ctx.closeCount).toBe(1);
  });

  it('a real rejected byte string takes the malformed-decode path (bounded diagnostic, game continues)', async () => {
    const { owner, ctx } = armed();
    await owner.unlock();
    await settle();
    const bad = cueBytes('wav/rejections/bad-magic.wav'); // committed: not RIFF/WAVE
    expect(owner.registerCue('asset-audio-bad', bad)).toEqual({ ok: true });
    await settle();
    expect(
      owner.diagnostics().some((d) => d.code === 'audio_decode_failed' && d.assetId === 'asset-audio-bad'),
    ).toBe(true);
    // The bad cue is skipped; a real cue still sounds:
    expect(owner.submit([cue('run-1', 'death', 1, 'asset-audio-bad')])).toEqual({ ok: true });
    expect(owner.diagnostics().some((d) => d.code === 'cue_skipped' && d.assetId === 'asset-audio-bad')).toBe(
      true,
    );
    owner.submit([cue('run-1', 'death', 2, 'asset-audio-death')]);
    expect(ctx.liveVoices()).toBe(1);
    owner.dispose();
  });
});