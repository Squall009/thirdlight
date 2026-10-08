import { describe, expect, it } from 'vitest';

import { installBuildReuse } from './node-builds';

/**
 * The parts of three 0.186's NodeManager and Pipelines the reuse patches,
 * with three's own release rules: a render object deleted takes a use off
 * its build (gone from the cache at none); a pipeline or program no render
 * object uses is released.
 */
function stubRenderer(): {
  renderer: Record<string, unknown>;
  nodes: { nodeBuilderCache: Map<string, { usedTimes: number }>; data: Map<object, { nodeBuilderState?: { usedTimes: number } }> };
  pipelines: { caches: Map<string, { usedTimes: number; cacheKey: string }>; released: string[] };
  draw(key: string): object;
  drop(ro: object): void;
} {
  const nodeBuilderCache = new Map<string, { usedTimes: number }>();
  const data = new Map<object, { nodeBuilderState?: { usedTimes: number } }>();
  const caches = new Map<string, { usedTimes: number; cacheKey: string }>();
  const released: string[] = [];
  const nodes = {
    nodeBuilderCache,
    data,
    getForRender(ro: { initialCacheKey: string }) {
      const d = data.get(ro)!;
      let state = nodeBuilderCache.get(ro.initialCacheKey);
      if (state === undefined) nodeBuilderCache.set(ro.initialCacheKey, (state = { usedTimes: 0 }));
      state.usedTimes += 1;
      d.nodeBuilderState = state;
      return state;
    },
    getForRenderCacheKey: (ro: { initialCacheKey: string }) => ro.initialCacheKey,
    get(o: object) {
      if (!data.has(o)) data.set(o, {});
      return data.get(o)!;
    },
    delete(o: object) {
      const state = data.get(o)?.nodeBuilderState;
      if (state !== undefined) {
        state.usedTimes -= 1;
        if (state.usedTimes === 0) nodeBuilderCache.delete((o as { initialCacheKey: string }).initialCacheKey);
      }
      data.delete(o);
    },
  };
  const pipelines = {
    caches,
    released,
    _getRenderPipeline: () => undefined,
    _releasePipeline(p: { cacheKey: string }) {
      caches.delete(p.cacheKey);
      released.push(p.cacheKey);
    },
    _releaseProgram: () => undefined,
  };
  const renderer = { _nodes: nodes, _pipelines: pipelines };
  const pipelineOf = new Map<object, { usedTimes: number; cacheKey: string }>();
  return {
    renderer,
    nodes,
    pipelines,
    draw(key) {
      const ro = { isRenderObject: true, initialCacheKey: key };
      nodes.get(ro);
      nodes.getForRender(ro);
      let p = caches.get(key);
      if (p === undefined) caches.set(key, (p = { usedTimes: 0, cacheKey: key }));
      p.usedTimes += 1;
      pipelineOf.set(ro, p);
      return ro;
    },
    drop(ro) {
      renderer._nodes.delete(ro);
      const p = pipelineOf.get(ro)!;
      p.usedTimes -= 1;
      if (p.usedTimes === 0) renderer._pipelines._releasePipeline(p);
    },
  };
}

describe('installBuildReuse', () => {
  it('keeps a build and its pipeline after their last user went, for the object made in its place', () => {
    const s = stubRenderer();
    let now = 0;
    const reuse = installBuildReuse(s.renderer, 1000, () => now)!;
    expect(reuse).not.toBeNull();
    const old = s.draw('tree');
    const state = s.nodes.nodeBuilderCache.get('tree');
    s.drop(old);
    // Gone from three's view of the users, still in its caches.
    expect(s.nodes.nodeBuilderCache.get('tree')).toBe(state);
    expect(s.pipelines.caches.has('tree')).toBe(true);
    expect(reuse.held()).toEqual({ builds: 1, pipelines: 1, programs: 0 });
    // The object made again in its place: the same build, no new one.
    now = 500;
    const again = s.draw('tree');
    expect(s.nodes.data.get(again)?.nodeBuilderState).toBe(state);
    reuse.sweep();
    expect(reuse.held().pipelines).toBe(0);
    // The hold ends on time; the new user keeps the build.
    now = 1001;
    reuse.sweep();
    expect(reuse.held().builds).toBe(0);
    expect(s.nodes.nodeBuilderCache.get('tree')).toBe(state);
    expect(state?.usedTimes).toBe(1);
    // Its last user goes again: held again, then released as three would have.
    s.drop(again);
    expect(reuse.held()).toEqual({ builds: 1, pipelines: 1, programs: 0 });
    now = 2100;
    reuse.sweep();
    expect(s.nodes.nodeBuilderCache.has('tree')).toBe(false);
    expect(s.pipelines.caches.has('tree')).toBe(false);
    expect(s.pipelines.released).toEqual(['tree']);
    expect(state?.usedTimes).toBe(0);
  });

  it('holds a build only for its last user, and releases everything at once when the renderer goes', () => {
    const s = stubRenderer();
    const reuse = installBuildReuse(s.renderer, 1000, () => 0)!;
    const a = s.draw('rock');
    const b = s.draw('rock');
    s.drop(a);
    expect(reuse.held().builds).toBe(0);
    s.drop(b);
    expect(reuse.held().builds).toBe(1);
    reuse.releaseAll();
    expect(reuse.held()).toEqual({ builds: 0, pipelines: 0, programs: 0 });
    expect(s.nodes.nodeBuilderCache.size).toBe(0);
    expect(s.pipelines.caches.size).toBe(0);
  });

  it('installs once per renderer and not without three\'s internals', () => {
    const s = stubRenderer();
    expect(installBuildReuse(s.renderer)).not.toBeNull();
    expect(installBuildReuse(s.renderer)).toBeNull();
    expect(installBuildReuse({})).toBeNull();
    expect(installBuildReuse(null)).toBeNull();
  });
});
