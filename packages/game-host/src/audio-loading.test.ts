/**
 * Each load type's path through the audio owner, with every byte and
 * buffer observed in the resource manager: a file decoded on load (held
 * by its scene, or from its first play by the scenes loaded then), one
 * decoded while playing (compressed bytes kept, decoded per play) and a
 * streamed one (a media element per play); and the lateness bound (a sound
 * not ready when played starts when ready, or is dropped past its bound,
 * and the observation says which).
 */
import { createResourceManager, type ResourceManager } from '@thirdlight/runtime';
import { describe, expect, it } from 'vitest';

import { createGameAudioOwner, type AudioAssetSource, type AudioCommandLike, type MediaElementLike } from './audio';

type Any = any;

function fakeContext() {
  const decodes: number[] = [];
  const sources: Any[] = [];
  const elementNodes: Any[] = [];
  const ctx: Any = {
    state: 'running',
    currentTime: 0,
    resume: async () => undefined,
    suspend: async () => undefined,
    close: async () => undefined,
    decodeAudioData: async (b: ArrayBuffer) => {
      decodes.push(b.byteLength);
      return { duration: 1, sampleRate: 48000, length: 48000, numberOfChannels: 2 };
    },
    createBufferSource: () => {
      const s: Any = { buffer: null, onended: null, loop: false, started: false, playbackRate: { value: 1 }, connect() {}, start() { s.started = true; }, stop() {} };
      sources.push(s);
      return s;
    },
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createMediaElementSource: (el: Any) => {
      const n: Any = { el, connected: false, connect() { n.connected = true; }, disconnect() { n.connected = false; } };
      elementNodes.push(n);
      return n;
    },
    destination: { connect() {} },
  };
  return { ctx, decodes, sources, elementNodes };
}

/** A media element that is ready to play once the test says so. */
function fakeElement(): MediaElementLike & Any {
  const listeners = new Map<string, Set<() => void>>();
  const el: Any = {
    src: '',
    preload: '',
    loop: false,
    playbackRate: 1,
    readyState: 0,
    playing: false,
    freed: false,
    play: async () => {
      el.playing = true;
    },
    pause: () => {
      el.playing = false;
    },
    load: () => undefined,
    removeAttribute: (n: string) => {
      if (n === 'src') {
        el.src = '';
        el.freed = true;
      }
    },
    addEventListener: (t: string, f: () => void) => {
      if (!listeners.has(t)) listeners.set(t, new Set());
      listeners.get(t)!.add(f);
    },
    removeEventListener: (t: string, f: () => void) => listeners.get(t)?.delete(f),
    fire: (t: string) => {
      for (const f of [...(listeners.get(t) ?? [])]) f();
    },
  };
  return el;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await new Promise((r) => setTimeout(r, 0));
};

const play = (handle: number, assetId: string, extra: Partial<Extract<AudioCommandLike, { op: 'play' }>> = {}): AudioCommandLike => ({ op: 'play', stepIndex: 0, handle, assetId, bus: 'voice', volume: 1, loop: false, pitch: 1, fadeIn: 0, ...extra });

interface Setup {
  f: ReturnType<typeof fakeContext>;
  resources: ResourceManager;
  owner: ReturnType<typeof createGameAudioOwner>;
  reads: string[];
  elements: (MediaElementLike & Any)[];
  gates: Map<string, () => void>;
  setNow: (t: number) => void;
}

function setup(files: Record<string, { loadType: AudioAssetSource['loadType']; preload?: boolean; gated?: boolean }>): Setup {
  const f = fakeContext();
  const resources = createResourceManager();
  const reads: string[] = [];
  const elements: (MediaElementLike & Any)[] = [];
  const gates = new Map<string, () => void>();
  let t = 0;
  const owner = createGameAudioOwner({
    contextFactory: () => f.ctx,
    resources,
    now: () => t,
    createMediaElement: () => {
      const el = fakeElement();
      elements.push(el);
      return el;
    },
    source: async (assetId) => {
      const file = files[assetId];
      if (file === undefined) return undefined;
      return {
        loadType: file.loadType,
        preload: file.preload !== false,
        url: `/files/${assetId}.ogg`,
        read: () => {
          reads.push(assetId);
          const bytes = new Uint8Array(100);
          if (file.gated !== true) return Promise.resolve(bytes);
          return new Promise((resolve) => gates.set(assetId, () => resolve(bytes)));
        },
      };
    },
  });
  return { f, resources, owner, reads, elements, gates, setNow: (x) => (t = x) };
}

const resident = (r: ResourceManager, kind: 'audio' | 'audio-bytes' | 'audio-stream'): number => r.observe().resident[kind]?.count ?? 0;

describe('audio load types', () => {
  it('decode on load, preloaded by its scene: before the gesture its bytes are held, at the unlock decoded; the scene unloading frees it', async () => {
    const s = setup({ hit: { loadType: 'decode-on-load' } });
    s.owner.holdAudio!('hit', 'scene:a');
    await flush();
    expect(s.reads).toEqual(['hit']);
    expect(resident(s.resources, 'audio-bytes')).toBe(1);
    expect(s.f.decodes).toEqual([]);
    await s.owner.unlock();
    await flush();
    s.resources.settle();
    expect(s.f.decodes).toEqual([100]);
    expect(resident(s.resources, 'audio')).toBe(1);
    expect(resident(s.resources, 'audio-bytes')).toBe(0);
    // A play uses the decoded buffer at once, and is not late.
    s.owner.command!(play(1, 'hit', { bus: 'sfx' }));
    expect(s.owner.observeAudio!()!.voices).toMatchObject([{ handle: 1, state: 'playing' }]);
    expect(s.owner.observeAudio!()!.voices[0]!.lateMs).toBeUndefined();
    s.f.sources.at(-1).onended();
    s.owner.releaseAudio!('scene:a');
    s.resources.settle();
    expect(s.resources.observe().resident).toEqual({});
  });

  it('decode on load, not preloaded: its first play reads and decodes it and the scenes loaded then keep it', async () => {
    const s = setup({ hit: { loadType: 'decode-on-load', preload: false } });
    await s.owner.unlock();
    s.owner.setAudioScope!(['scene:a', 'scene:b']);
    s.owner.command!(play(1, 'hit'));
    await flush();
    expect(s.owner.observeAudio!()!.voices).toMatchObject([{ handle: 1, state: 'playing' }]);
    s.f.sources.at(-1).onended();
    s.resources.settle();
    expect(resident(s.resources, 'audio')).toBe(1);
    s.owner.releaseAudio!('scene:a');
    s.resources.settle();
    expect(resident(s.resources, 'audio')).toBe(1);
    s.owner.releaseAudio!('scene:b');
    s.resources.settle();
    expect(s.resources.observe().resident).toEqual({});
  });

  it('decode while playing: the compressed bytes are kept; each play decodes them and its buffer goes when it ends', async () => {
    const s = setup({ line: { loadType: 'decode-while-playing' } });
    await s.owner.unlock();
    s.owner.holdAudio!('line', 'dialogue:1');
    await flush();
    expect(resident(s.resources, 'audio-bytes')).toBe(1);
    expect(s.f.decodes).toEqual([]);
    for (const handle of [1, 2]) {
      s.owner.command!(play(handle, 'line'));
      await flush();
      expect(s.owner.observeAudio!()!.voices).toMatchObject([{ handle, state: 'playing' }]);
      expect(resident(s.resources, 'audio')).toBe(1);
      s.f.sources.at(-1).onended();
      s.resources.settle();
      expect(resident(s.resources, 'audio')).toBe(0);
    }
    expect(s.f.decodes).toEqual([100, 100]);
    expect(s.reads).toEqual(['line']);
    s.owner.releaseAudio!('dialogue:1');
    s.owner.releaseAudio!('play');
    s.resources.settle();
    expect(s.resources.observe().resident).toEqual({});
  });

  it('stream: each play gets a media element reading the file, heard through the context, freed when it ends; nothing is read ahead', async () => {
    const s = setup({ theme: { loadType: 'stream' } });
    await s.owner.unlock();
    s.owner.holdAudio!('theme', 'scene:a');
    await flush();
    expect(s.reads).toEqual([]);
    expect(s.elements).toEqual([]);
    s.owner.command!(play(1, 'theme', { bus: 'music' }));
    await flush();
    expect(s.elements).toHaveLength(1);
    const el = s.elements[0]!;
    expect(el.src).toBe('/files/theme.ogg');
    expect(s.owner.observeAudio!()!.voices).toMatchObject([{ handle: 1, state: 'pending' }]);
    el.fire('canplay');
    await flush();
    expect(s.f.elementNodes).toHaveLength(1);
    expect(s.f.elementNodes[0].connected).toBe(true);
    expect(el.playing).toBe(true);
    expect(s.owner.observeAudio!()!.voices).toMatchObject([{ handle: 1, state: 'playing' }]);
    expect(resident(s.resources, 'audio-stream')).toBe(1);
    // Hidden, the element pauses (the suspended context does not stop its clock); visible, it plays on.
    s.owner.setHidden(true);
    expect(el.playing).toBe(false);
    s.owner.setHidden(false);
    expect(el.playing).toBe(true);
    el.fire('ended');
    s.resources.settle();
    expect(resident(s.resources, 'audio-stream')).toBe(0);
    expect(el.freed).toBe(true);
    expect(s.f.decodes).toEqual([]);
    expect(s.reads).toEqual([]);
  });

  it('a streamed music track plays through its element and loops; switching tracks frees it', async () => {
    const s = setup({ theme: { loadType: 'stream' }, battle: { loadType: 'decode-while-playing' } });
    await s.owner.unlock();
    s.owner.playMusic!('theme', 0);
    await flush();
    s.elements[0]!.fire('canplay');
    await flush();
    expect(s.owner.musicStatus!().playing).toBe(true);
    expect(s.elements[0]!.loop).toBe(true);
    s.owner.playMusic!('battle', 0);
    await flush();
    s.resources.settle();
    expect(s.owner.musicStatus!()).toMatchObject({ assetId: 'battle', playing: true });
    expect(resident(s.resources, 'audio-stream')).toBe(0);
    expect(s.elements[0]!.freed).toBe(true);
  });
});

describe('a sound played before it is ready', () => {
  it('starts when ready within its bound (the observation says how late), and is dropped past it (the observation says so)', async () => {
    const s = setup({ a: { loadType: 'decode-while-playing', gated: true }, b: { loadType: 'decode-while-playing', gated: true } });
    await s.owner.unlock();
    s.owner.command!(play(1, 'a', { maxLateMs: 100 }));
    s.owner.command!(play(2, 'b', { maxLateMs: 100 }));
    await flush();
    s.setNow(60);
    s.gates.get('a')!();
    await flush();
    let obs = s.owner.observeAudio!()!;
    expect(obs.voices.map((v) => [v.handle, v.state, v.lateMs])).toEqual([
      [1, 'playing', 60],
      [2, 'pending', undefined],
    ]);
    s.setNow(150);
    s.owner.spatialFrame!(null, () => null);
    obs = s.owner.observeAudio!()!;
    expect(obs.voices.map((v) => v.handle)).toEqual([1]);
    expect(obs.late).toEqual({
      started: 1,
      dropped: 1,
      recent: [
        { handle: 1, assetId: 'a', outcome: 'started', lateMs: 60, maxLateMs: 100 },
        { handle: 2, assetId: 'b', outcome: 'dropped', lateMs: 150, maxLateMs: 100, waitedFor: 'file' },
      ],
    });
    expect(obs.diagnostics.at(-1)).toContain('late_dropped');
    // The file read for the dropped sound stays for its next play (its scope), which then starts at once.
    s.gates.get('b')!();
    await flush();
    s.owner.command!(play(3, 'b', { maxLateMs: 0 }));
    await flush();
    s.owner.command!(play(4, 'b', { maxLateMs: 0 }));
    expect(s.owner.observeAudio!()!.voices.map((v) => [v.handle, v.state])).toContainEqual([4, 'playing']);
  });

  it('a bound of 0 plays now or never; the default bound applies when the caller gives none; a loop is never dropped', async () => {
    const s = setup({ a: { loadType: 'decode-while-playing', gated: true } });
    await s.owner.unlock();
    s.owner.command!(play(1, 'a', { maxLateMs: 0 }));
    expect(s.owner.observeAudio!()!.late.dropped).toBe(1);
    s.owner.command!(play(2, 'a'));
    s.owner.command!(play(3, 'a', { loop: true, maxLateMs: 10 }));
    await flush();
    s.setNow(499);
    s.owner.spatialFrame!(null, () => null);
    expect(s.owner.observeAudio!()!.voices.map((v) => v.handle)).toEqual([2, 3]);
    s.setNow(501);
    s.owner.spatialFrame!(null, () => null);
    expect(s.owner.observeAudio!()!.voices.map((v) => v.handle)).toEqual([3]);
    s.setNow(5000);
    s.gates.get('a')!();
    await flush();
    expect(s.owner.observeAudio!()!.voices).toMatchObject([{ handle: 3, state: 'playing', lateMs: 5000 }]);
  });

  it('a sound played before the first gesture is dropped past its bound as waiting for the unlock', async () => {
    const s = setup({ a: { loadType: 'decode-on-load' } });
    s.owner.command!(play(1, 'a', { maxLateMs: 200 }));
    s.setNow(300);
    s.owner.spatialFrame!(null, () => null);
    expect(s.owner.observeAudio!()!.late.recent).toEqual([{ handle: 1, assetId: 'a', outcome: 'dropped', lateMs: 300, maxLateMs: 200, waitedFor: 'unlock' }]);
  });
});
