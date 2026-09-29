/**
 * The scene preloader — a load answers only once the render
 * side prepared the scene; scenes named by the host are read ahead (at most
 * `max`) and let go when no longer named; a read-ahead scene answers a load
 * without a second read; a cancelled load's preparation is released.
 */
import { describe, expect, it } from 'vitest';

import { createScenePreloader, type ScenePreparation } from './scene-preload';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

function setup(max?: number) {
  const reads: string[] = [];
  const prepared: string[] = [];
  const released: string[] = [];
  const gates = new Map<string, () => void>();
  const pre = createScenePreloader({
    read: async (id) => {
      reads.push(id);
      return [{ id: `${id}-e`, components: {} }] as never;
    },
    ...(max !== undefined ? { max } : {}),
  });
  pre.setPrepare((id): ScenePreparation => {
    prepared.push(id);
    return { ready: new Promise<void>((resolve) => gates.set(id, resolve)), release: () => released.push(id) };
  });
  return { pre, reads, prepared, released, gates };
}

describe('scene preloader (phase 25.24e)', () => {
  it('answers a load once the scene is read and prepared', async () => {
    const s = setup();
    let answered = false;
    const p = s.pre.load('scene-b').then((e) => {
      answered = true;
      return e;
    });
    await flush();
    expect(s.reads).toEqual(['scene-b']);
    expect(s.prepared).toEqual(['scene-b']);
    expect(answered).toBe(false);
    s.gates.get('scene-b')!();
    expect((await p).map((e) => e.id)).toEqual(['scene-b-e']);
    // Loaded: the render side keeps what it prepared (nothing released).
    s.pre.want([], { 'scene-b': 'loaded' });
    expect(s.released).toEqual([]);
  });

  it('reads ahead the named scenes that are not loaded (at most max), lets go of the ones no longer named, and a load reuses the read', async () => {
    const s = setup(2);
    s.pre.want(['scene-b', 'scene-c', 'scene-d', 'scene-a'], { 'scene-a': 'loaded', 'scene-b': 'unloaded', 'scene-c': 'unloaded', 'scene-d': 'unloaded' });
    await flush();
    expect(s.reads).toEqual(['scene-b', 'scene-c']);
    s.gates.get('scene-b')!();
    await flush();
    expect(s.pre.view()).toEqual({ preloading: ['scene-c'], preloaded: ['scene-b'] });
    s.pre.want(['scene-b'], { 'scene-b': 'unloaded', 'scene-c': 'unloaded' });
    expect(s.released).toEqual(['scene-c']);
    const e = await s.pre.load('scene-b');
    expect(e.map((x) => x.id)).toEqual(['scene-b-e']);
    expect(s.reads).toEqual(['scene-b', 'scene-c']); // no second read
  });

  it('lets go of a load the game cancelled (the scene is unloaded again)', async () => {
    const s = setup();
    const p = s.pre.load('scene-b');
    await flush();
    s.gates.get('scene-b')!();
    await p;
    s.pre.want([], { 'scene-b': 'loading' });
    expect(s.released).toEqual([]);
    s.pre.want([], { 'scene-b': 'unloaded' });
    expect(s.released).toEqual(['scene-b']);
  });

  it('a failed read rejects the load; a page without a preparation answers after the read', async () => {
    const pre = createScenePreloader({ read: async () => Promise.reject(new Error('not in this build')) });
    await expect(pre.load('scene-x')).rejects.toThrow('not in this build');
    const plain = createScenePreloader({ read: async (id) => [{ id, components: {} }] as never });
    expect((await plain.load('scene-y')).length).toBe(1);
    plain.dispose();
    await expect(plain.load('scene-y')).rejects.toThrow();
  });
});

describe('scenes to read ahead (phase 25.24e)', () => {
  it('names the unloaded targets of loaded scene transitions and the next listed scene, once each', async () => {
    const { scenesToReadAhead } = await import('./host');
    const set = {
      revision: 3,
      status: { 'scene-main': 'loaded', 'scene-a': 'loaded', 'scene-b': 'unloaded', 'scene-c': 'loading', 'scene-d': 'unloaded', 'scene-e': 'unloaded' },
      batches: [
        { sceneId: 'scene-main', start: true, entities: [{ id: 'door-1', components: { trigger: { sceneTransition: { scene: 'scene-b' } } } }, { id: 'door-2', components: { trigger: { sceneTransition: { scene: 'scene-c' } } } }] },
        { sceneId: 'scene-a', start: false, entities: [{ id: 'door-3', components: { trigger: { sceneTransition: { scene: 'scene-b' } } } }, { id: 'door-4', components: { trigger: { sceneTransition: { scene: 'scene-a' } } } }] },
      ],
      spawned: [{ id: 'door-5', components: { trigger: { sceneTransition: { scene: 'scene-e' } } } }],
    } as never;
    const list = [{ scene: 'scene-main' }, { scene: 'scene-d' }, { scene: 'scene-b' }];
    expect(scenesToReadAhead(set, list, 0)).toEqual(['scene-d', 'scene-b', 'scene-e']);
    expect(scenesToReadAhead(set, undefined, -1)).toEqual(['scene-b', 'scene-e']);
    // Before a run is at a listed entry, the first one is next.
    expect(scenesToReadAhead(set, list, -1)).toEqual(['scene-b', 'scene-e']);
  });
});
