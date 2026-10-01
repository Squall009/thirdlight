import { describe, expect, it } from 'vitest';

import { createResourceManager, embeddedTextureBytes, type LoadedResource } from './resources';

/** A load that counts its calls and frees, resolving with `value`. */
function counted<T>(value: T, bytes = 10): { load: () => Promise<LoadedResource<T>>; loads: number; frees: T[] } {
  const c = {
    loads: 0,
    frees: [] as T[],
    load: async (): Promise<LoadedResource<T>> => {
      c.loads += 1;
      return { value, bytes, free: (v: T) => c.frees.push(v) };
    },
  };
  return c;
}

describe('resource manager', () => {
  it('loads once for every holder and frees when the last holder goes, at the settle', async () => {
    const m = createResourceManager();
    const c = counted('glb');
    const [a, b] = await Promise.all([m.acquire('model', 'm1', 'entity:a', c.load), m.acquire('model', 'm1', 'entity:b', c.load)]);
    expect([a, b]).toEqual(['glb', 'glb']);
    expect(c.loads).toBe(1);
    expect(m.observe().resident).toEqual({ model: { count: 1, bytes: 10 } });
    m.release('model', 'm1', 'entity:a');
    expect(m.settle()).toBe(0);
    expect(m.peek('model', 'm1')).toBe('glb');
    m.release('model', 'm1', 'entity:b');
    // Not freed before the settle.
    expect(m.peek('model', 'm1')).toBe('glb');
    expect(m.observe().waiting).toBe(1);
    expect(m.settle()).toBe(1);
    expect(c.frees).toEqual(['glb']);
    expect(m.peek('model', 'm1')).toBeUndefined();
    expect(m.observe()).toMatchObject({ resident: {}, loads: { model: 1 }, frees: { model: 1 }, waiting: 0 });
  });

  it('keeps a resource released and taken again before the settle (a transition in one step)', async () => {
    const m = createResourceManager();
    const c = counted('glb');
    await m.acquire('model', 'm1', 'scene:a', c.load);
    m.release('model', 'm1', 'scene:a');
    await m.acquire('model', 'm1', 'scene:b', c.load);
    expect(m.settle()).toBe(0);
    expect(c.loads).toBe(1);
    expect(c.frees).toEqual([]);
    expect(m.holders('model', 'm1')).toEqual(['scene:b']);
  });

  it('a holder holding twice is one hold', async () => {
    const m = createResourceManager();
    const c = counted(1);
    await m.acquire('texture', 't', 'mat', c.load);
    await m.acquire('texture', 't', 'mat', c.load);
    m.release('texture', 't', 'mat');
    m.settle();
    expect(c.frees).toEqual([1]);
  });

  it('releases everything a holder holds', async () => {
    const m = createResourceManager();
    await m.acquire('texture', 'a', 'prep:s', counted('a').load);
    await m.acquire('bytes', 'b', 'prep:s', counted('b').load);
    await m.acquire('bytes', 'b', 'other', counted('b').load);
    m.releaseHolder('prep:s');
    expect(m.settle()).toBe(1);
    expect(m.has('texture', 'a')).toBe(false);
    expect(m.has('bytes', 'b')).toBe(true);
  });

  it('a load every holder left while it ran is freed at the first settle after it completes', async () => {
    const m = createResourceManager();
    let resolve!: (r: LoadedResource<string>) => void;
    const frees: string[] = [];
    const p = m.acquire('audio', 'v', 'voice:1', () => new Promise<LoadedResource<string>>((r) => (resolve = r)));
    m.release('audio', 'v', 'voice:1');
    expect(m.settle()).toBe(0);
    expect(m.observe().loading).toBe(1);
    resolve({ value: 'pcm', bytes: 4, free: (v) => frees.push(v) });
    await p;
    expect(m.observe().waiting).toBe(1);
    expect(m.settle()).toBe(1);
    expect(frees).toEqual(['pcm']);
  });

  it('forgets a failed load (a later ask loads again) and counts it', async () => {
    const m = createResourceManager();
    let n = 0;
    const load = async (): Promise<LoadedResource<string>> => {
      n += 1;
      if (n === 1) throw new Error('offline');
      return { value: 'ok', bytes: 1 };
    };
    await expect(m.acquire('bytes', 'x', 'h', load)).rejects.toThrow('offline');
    expect(m.has('bytes', 'x')).toBe(false);
    await expect(m.acquire('bytes', 'x', 'h', load)).resolves.toBe('ok');
    expect(m.observe().failed).toBe(1);
  });

  it('hold adds a holder only to what exists', async () => {
    const m = createResourceManager();
    expect(m.hold('model', 'm', 'h')).toBe(false);
    await m.acquire('model', 'm', 'a', counted('x').load);
    expect(m.hold('model', 'm', 'b')).toBe(true);
    m.release('model', 'm', 'a');
    expect(m.settle()).toBe(0);
  });

  it('runs the settle where the owner schedules it', async () => {
    const queued: (() => void)[] = [];
    const m = createResourceManager({ schedule: (run) => queued.push(run) });
    const c = counted('x');
    await m.acquire('image', 'i', 'ui', c.load);
    m.release('image', 'i', 'ui');
    m.release('image', 'i', 'ui');
    expect(queued).toHaveLength(1);
    queued.shift()!();
    expect(c.frees).toEqual(['x']);
  });

  it('counts script handles and frees everything on dispose', async () => {
    const m = createResourceManager();
    const c = counted('x');
    await m.acquire('texture', 't', 'handle:1', c.load);
    await m.acquire('texture', 't', 'handle:2', c.load);
    expect(m.observe().handles).toBe(2);
    m.dispose();
    expect(c.frees).toEqual(['x']);
    await expect(m.acquire('texture', 't', 'h', c.load)).rejects.toThrow('closed');
  });

  it('frees a load that completes after the manager closed', async () => {
    const m = createResourceManager();
    let resolve!: (r: LoadedResource<string>) => void;
    const frees: string[] = [];
    const p = m.acquire('model', 'm', 'h', () => new Promise<LoadedResource<string>>((r) => (resolve = r)));
    m.dispose();
    resolve({ value: 'late', bytes: 1, free: (v) => frees.push(v) });
    await expect(p).rejects.toThrow('closed');
    expect(frees).toEqual(['late']);
  });

  it('reports the textures resources carry inside them per kind and in total, the largest first, until they are freed', async () => {
    const m = createResourceManager();
    await m.acquire('model', 'oak@1', 'entity:a', async () => ({ value: 'oak', bytes: 1000, textures: { count: 2, bytes: 800 } }));
    await m.acquire('model', 'rock@3', 'entity:b', async () => ({ value: 'rock', bytes: 500, textures: { count: 1, bytes: 300 } }));
    await m.acquire('model', 'box@1', 'entity:c', async () => ({ value: 'box', bytes: 200 }));
    // A count of nothing is no texture; more texture bytes than the whole resource is held to the whole.
    await m.acquire('model', 'odd@1', 'entity:d', async () => ({ value: 'odd', bytes: 50, textures: { count: 1, bytes: 90 } }));
    await m.acquire('model', 'none@1', 'entity:e', async () => ({ value: 'none', bytes: 40, textures: { count: 0, bytes: 0 } }));
    await m.acquire('texture', 't1', 'entity:a', async () => ({ value: 't1', bytes: 64 }));
    const o = m.observe();
    expect(o.resident).toEqual({ model: { count: 5, bytes: 1790, textures: { count: 4, bytes: 1150 } }, texture: { count: 1, bytes: 64 } });
    expect(embeddedTextureBytes(o)).toBe(1150);
    expect(m.embeddedTextures(2)).toEqual({
      count: 4,
      bytes: 1150,
      resources: 3,
      largest: [
        { kind: 'model', key: 'oak@1', count: 2, bytes: 800 },
        { kind: 'model', key: 'rock@3', count: 1, bytes: 300 },
      ],
    });
    m.release('model', 'oak@1', 'entity:a');
    m.settle();
    expect(m.embeddedTextures(8)).toMatchObject({ count: 2, bytes: 350, resources: 2 });
    expect(embeddedTextureBytes(m.observe())).toBe(350);
    m.dispose();
    expect(m.embeddedTextures(8)).toEqual({ count: 0, bytes: 0, resources: 0, largest: [] });
  });
});
