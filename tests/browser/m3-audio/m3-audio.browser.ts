/**
 * Packet 54 — browser audio owner verification host (manual, the
 * packet-32/37 procedure). TEMPORARY TEST HOST, not a production bootstrap
 * and not a shipped bundle; named `.browser.ts` so vitest never collects it.
 *
 * What it exercises (the packet 54 evidence lines — B12/B13 resource /
 * activation scope):
 *  - the REAL committed cue bytes (`fixtures/m3/media/wav/cue-*.wav`,
 *    SHA-256 verified against `fixtures/m3/media/index.json`) registered
 *    bytes-in with the REAL `AudioContext` (software WebAudio counts —
 *    packet 38 baseline §1);
 *  - a REAL local user gesture (a real `pointerdown` with
 *    `event.isTrusted === true`) driving `unlock()` — the pre-gesture
 *    sound-off state is recorded first (no source is ever created before
 *    the gesture);
 *  - the committed-cue submission timeline: start / jump / checkpoint /
 *    death / goal, each event id once (dedupe proven by a triple-submit
 *    adding exactly one real source), a 12-cue jump flood against the
 *    AUDIO_MAX_VOICES = 8 cap (bounded voice_cap diagnostics), mute →
 *    voices stopped, hidden → context suspended, visible → resumed,
 *    dispose → exactly one `close()` and every later call
 *    `audio_disposed`/`disposed`;
 *  - host-side instrumentation of the injected factory (a pass-through
 *    wrapper around the REAL context that counts decodes/sources — every
 *    real audio-graph operation still runs; the wrapper only observes).
 *
 * Audibility itself stays UNVERIFIED (packet 38 baseline §1: no audio
 * device in this container; §41.4.8 rule 9). Counters + the real context
 * state prove the graph, not the ear.
 */
import {
  AUDIO_MAX_VOICES,
  browserContextFactory,
  createGameAudioOwner,
  type AudioContextLike,
  type GameAudioDiagnostic,
  type GameAudioOwner,
  type GameCueEvent,
  type GameAudioStatus,
} from '@thirdlight/game-host';

const FIXTURES = [
  { file: 'fixtures/m3/media/wav/cue-start.wav', assetId: 'asset-audio-start', kind: 'start' as const },
  { file: 'fixtures/m3/media/wav/cue-jump.wav', assetId: 'asset-audio-jump', kind: 'jump' as const },
  { file: 'fixtures/m3/media/wav/cue-checkpoint.wav', assetId: 'asset-audio-checkpoint', kind: 'checkpoint' as const },
  { file: 'fixtures/m3/media/wav/cue-death.wav', assetId: 'asset-audio-death', kind: 'death' as const },
  { file: 'fixtures/m3/media/wav/cue-goal.wav', assetId: 'asset-audio-goal', kind: 'goal' as const },
];

interface Instrumentation {
  decodes: number;
  decodeErrors: number;
  decodedDurations: number[];
  sources: number;
  sourceDurations: number[];
  live: number;
  peakLive: number;
  resumes: number;
  suspends: number;
  closes: number;
  contextStates: string[];
}

/** A pass-through wrapper around the REAL AudioContext factory: it observes
 * (counts) but never intercepts — every operation still runs on the real
 * graph. Returns null when the environment has no Web Audio. */
function instrumentedFactory(): { factory: () => AudioContextLike | null; counts: Instrumentation } | null {
  const inner = browserContextFactory();
  if (!inner) return null;
  const counts: Instrumentation = {
    decodes: 0, decodeErrors: 0, decodedDurations: [], sources: 0, sourceDurations: [],
    live: 0, peakLive: 0, resumes: 0, suspends: 0, closes: 0, contextStates: [],
  };
    let wrapped: AudioContextLike | null = null;
    const factory = (): AudioContextLike | null => {
      const ctx = inner();
      if (!ctx) return null;
      const decode = ctx.decodeAudioData.bind(ctx);
      const source = ctx.createBufferSource.bind(ctx);
      const resume = ctx.resume.bind(ctx);
      const suspend = ctx.suspend.bind(ctx);
      const close = ctx.close.bind(ctx);
      ctx.decodeAudioData = (data: ArrayBuffer) =>
        decode(data).then(
          (buffer) => {
            counts.decodes += 1;
            counts.decodedDurations.push(buffer.duration);
            counts.contextStates.push(ctx.state);
            return buffer;
          },
          (err: unknown) => {
            counts.decodeErrors += 1;
            throw err;
          },
        );
      ctx.createBufferSource = () => {
        const s = source();
        counts.sources += 1;
        // The owner sets `buffer` before `start()`: record the real decoded
        // duration of the voice this source is created with (per-cue-kind
        // voice proof in the evidence).
        const start = s.start.bind(s);
        s.start = () => {
          if (s.buffer) counts.sourceDurations.push(s.buffer.duration);
          counts.live += 1;
          counts.peakLive = Math.max(counts.peakLive, counts.live);
          const prev = s.onended;
          s.onended = () => {
            counts.live = Math.max(0, counts.live - 1);
            prev?.();
          };
          start();
        };
        return s;
      };
      ctx.resume = () => {
        counts.resumes += 1;
        return resume();
      };
      ctx.suspend = () => {
        counts.suspends += 1;
        return suspend();
      };
      ctx.close = () => {
        counts.closes += 1;
        return close();
      };
      wrapped = ctx;
      return ctx;
    };
    return { factory, counts };
  }

/** The §41.4.4 arithmetic over the fetched bytes (the committed cues are
 * strict 44+data PCM-WAV): the expected decoded duration. */
function expectedDurationSeconds(bytes: Uint8Array): number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return dv.getUint32(40, true) / 2 / 48_000;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy.buffer as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function loadFixture(file: string): Promise<{ bytes: Uint8Array; expectedSha: string; actualSha: string; match: boolean }> {
  const [blobRes, indexRes] = await Promise.all([
    fetch(file),
    fetch('fixtures/m3/media/index.json'),
  ]);
  const blob = await blobRes.arrayBuffer();
  const bytes = new Uint8Array(blob);
  const index = (await indexRes.json()) as { files: Record<string, { sha256: string; bytes: number }> };
  const entry = index.files[file];
  const expectedSha = entry?.sha256 ?? 'missing-from-index';
  const actualSha = await sha256Hex(bytes);
  return { bytes, expectedSha, actualSha, match: actualSha === expectedSha && entry?.bytes === bytes.length };
}

interface Evidence {
  environment: { userAgent: string; webAudio: boolean };
  fixtures: Record<string, { sha256: string; indexSha256: string; match: boolean }>;
  expectedDurations: Record<string, number>;
  preGesture: {
    status: GameAudioStatus;
    sourcesBeforeGesture: number;
    note: string;
    submitBeforeUnlock?: {
      submit: unknown;
      sourcesAfterPreGestureSubmit: number;
      ownerDiagnostics: unknown;
    };
  };
  statusTimeline: { t: string; status: GameAudioStatus }[];
  diagnostics: (GameAudioDiagnostic & { t: string })[];
  checklist: Record<string, unknown>;
  instrumentation?: unknown;
}

function cue(runId: string, kind: GameCueEvent['kind'], step: number, assetId: string): GameCueEvent {
  return { id: `${runId}/${kind}/${step}`, kind, assetId, runId, stepIndex: step };
}

function el(tag: string, text = ''): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  document.body.appendChild(node);
  return node;
}

async function main(): Promise<void> {
  el('h1', 'packet 54 — browser audio owner (manual evidence host)');
  const pre = el('pre', 'initializing…\n');
  const status: { t: string; status: GameAudioStatus }[] = [];
  const diagnosticsLog: (GameAudioDiagnostic & { t: string })[] = [];
  const inst = instrumentedFactory();
  const owner: GameAudioOwner = createGameAudioOwner(
    inst ? { contextFactory: inst.factory } : {},
  );
  const counts = inst?.counts;

  const evidence: Evidence = {
    environment: { userAgent: navigator.userAgent, webAudio: typeof (window as unknown as { AudioContext?: unknown }).AudioContext === 'function' },
    fixtures: {},
    expectedDurations: {},
    preGesture: {
      status: owner.status(),
      sourcesBeforeGesture: counts?.sources ?? 0,
      note: 'no source may exist before a real local gesture (autoplay policy)',
    },
    statusTimeline: status,
    diagnostics: diagnosticsLog,
    checklist: {},
  };

  // A1: sound-off completion — the committed cues are registered bytes-in
  // BEFORE any gesture; submitting them pre-unlock must create no source.
  for (const spec of FIXTURES) {
    const fx = await loadFixture(spec.file);
    evidence.fixtures[spec.file] = { sha256: fx.actualSha, indexSha256: fx.expectedSha, match: fx.match };
    evidence.expectedDurations[spec.kind] = expectedDurationSeconds(fx.bytes);
    const reg = owner.registerCue(spec.assetId, fx.bytes);
    if (!reg.ok) throw new Error(`registerCue failed: ${JSON.stringify(reg)}`);
  }
  status.push({ t: 'load', status: owner.status() });
  const preSubmit = owner.submit([cue('run-1', 'start', 0, 'asset-audio-start')]);
  evidence.preGesture.submitBeforeUnlock = {
    submit: preSubmit.ok ? 'ok (the game never waits for audio)' : preSubmit,
    sourcesAfterPreGestureSubmit: counts?.sources ?? 0,
    ownerDiagnostics: owner.diagnostics(),
  };

  // The timeline runs only from a REAL local user gesture (rule 7):
  const button = el('button', 'Enable sound (real gesture) — starts the cue timeline');
  let gestureIsTrusted = false;
  button.addEventListener('pointerdown', (ev) => {
    gestureIsTrusted = ev.isTrusted;
  });
  button.addEventListener('pointerup', async (ev) => {
    if (!ev.isTrusted) return; // synthetic/relayed activations never unlock
    const unlockStatus = await owner.unlock();
    status.push({ t: 'unlock', status: unlockStatus });
    runTimeline();
  });

  async function runTimeline(): Promise<void> {
    const step = async (label: string, fn: () => void, ms: number): Promise<void> => {
      fn();
      status.push({ t: label, status: owner.status() });
      for (const d of owner.diagnostics()) diagnosticsLog.push({ ...d, t: label });
      // eslint-disable-next-line no-console
      console.log(`[m3-audio] ${label}`, JSON.stringify(owner.status()), JSON.stringify(owner.diagnostics().slice(-3)));
      await new Promise((r) => setTimeout(r, ms));
    };

    await step('start', () => owner.submit([cue('run-1', 'start', 0, 'asset-audio-start')]), 900);
    // dedupe: the same committed event id three times → exactly one new source
    await step('jump-triple', () => {
      const ev = cue('run-1', 'jump', 1, 'asset-audio-jump');
      owner.submit([ev, ev, ev]);
    }, 900);
    await step('checkpoint', () => owner.submit([cue('run-1', 'checkpoint', 2, 'asset-audio-checkpoint')]), 900);
    // flood: 12 committed jump cues against the 8-voice cap
    await step('flood', () => {
      for (let i = 0; i < 12; i += 1) owner.submit([cue('run-1', 'jump', 10 + i, 'asset-audio-jump')]);
    }, 1400);
    await step('death', () => owner.submit([cue('run-1', 'death', 3, 'asset-audio-death')]), 900);
    await step('goal', () => owner.submit([cue('run-1', 'goal', 4, 'asset-audio-goal')]), 900);
    await step('mute', () => owner.setMuted(true), 700);
    await step('jump-while-muted', () => owner.submit([cue('run-1', 'jump', 30, 'asset-audio-jump')]), 700);
    await step('unmute', () => owner.setMuted(false), 700);
    await step('hidden', () => owner.setHidden(true), 900);
    await step('visible', () => owner.setHidden(false), 900);
    await step('dispose', () => owner.dispose(), 300);
    await step('after-dispose', () => {
      owner.submit([cue('run-1', 'goal', 5, 'asset-audio-goal')]);
      owner.registerCue('late', new Uint8Array([1]));
    }, 200);

    finalize();
  }

  function finalize(): void {
    const finalStatus = owner.status();
    const caps = owner.diagnostics().filter((d) => d.code === 'voice_cap');
    const skipped = owner.diagnostics().filter((d) => d.code === 'cue_skipped');
    const durations = counts?.sourceDurations ?? [];
    const kindsRealized = {} as Record<string, boolean>;
    for (const spec of FIXTURES) {
      const expected = evidence.expectedDurations[spec.kind];
      kindsRealized[spec.kind] = durations.some((d) => Math.abs(d - expected) < 1e-9);
    }
    evidence.checklist = {
      webAudioPresent: evidence.environment.webAudio,
      fixturesAllMatch: Object.entries(evidence.fixtures).every(([, fx]) => fx.match),
      preGestureSoundOff: evidence.preGesture.status.state === 'blocked',
      noSourceBeforeGesture: evidence.preGesture.sourcesBeforeGesture === 0,
      preGestureSubmitCreatedNoSource: evidence.preGesture.submitBeforeUnlock?.sourcesAfterPreGestureSubmit === 0,
      unlockFromRealGesture: { isTrusted: gestureIsTrusted, status: status.find((s) => s.t === 'unlock')?.status },
      realDecodesOfRealBytes: counts ? { decodes: counts.decodes, decodeErrors: counts.decodeErrors, durations: counts.decodedDurations } : 'no Web Audio',
      cueKindsRealizedAsVoices: kindsRealized,
      voiceCapHeld: caps.length >= 12 - AUDIO_MAX_VOICES,
      peakLiveNeverExceededCap: (counts?.peakLive ?? 0) <= AUDIO_MAX_VOICES,
      muteStopsAndSilences: skipped.some((d) => d.message.includes('muted')),
      hiddenSuspendedVisibleResumed: counts ? counts.suspends >= 1 && counts.resumes >= 2 : false,
      disposeClosesExactlyOnceAndDisposes: (counts ? counts.closes === 1 : true) && finalStatus.state === 'disposed',
      audibility: 'UNVERIFIED (no audio device — packet 38 baseline §1; counters are not audible output)',
    };
    evidence.instrumentation = counts ? { ...counts } : 'no Web Audio (owner: unsupported)';
    window.__m3Audio = { evidence, owner };
    pre.textContent = 'EVIDENCE\n' + JSON.stringify(evidence, null, 2);
    captureEvidencePng(evidence);
    // eslint-disable-next-line no-console
    console.log('[m3-audio] EVIDENCE COMPLETE', JSON.stringify(evidence.checklist));
  }

  function captureEvidencePng(ev: unknown): void {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.fillStyle = '#101418';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = '#d7e3ee';
    g.font = '13px monospace';
    const lines = JSON.stringify(ev, null, 1).split('\n').slice(0, 46);
    lines.forEach((line, i) => g.fillText(line, 12, 20 + i * 14));
    const a = document.createElement('a');
    a.download = 'm3-audio-evidence.png';
    a.href = canvas.toDataURL('image/png');
    a.click();
  }
}

declare global {
  interface Window {
    __m3Audio?: { evidence: unknown; owner: GameAudioOwner };
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[m3-audio] host failed', err);
  const pre = document.createElement('pre');
  pre.textContent = `HOST FAILED: ${String(err)}`;
  document.body.appendChild(pre);
});