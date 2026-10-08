/**
 * Node programs and pipelines kept across a re-bake, and what three builds
 * marked for the perf harness.
 *
 * three r186 shares a node build (and a pipeline, and a shader program)
 * between render objects with the same material and vertex layout, but
 * forgets it the moment its last user goes. An edit that makes objects again
 * (a terrain or spline re-bake: scatter sets, ground-cover squares, the
 * spline's mesh, the terrain's draws) drops the old objects before the new
 * ones are first drawn, so each new object built its program from scratch:
 * 10–28 ms of main thread per build, about 80–100 ms a re-bake, in frames
 * that should take 8. Here a build whose last user went is kept
 * {@link RELEASED_BUILD_KEEP_MS} longer (as are the pipelines and programs
 * three would release), so the object made in its place reuses it; one not
 * wanted again in that time is released as three would have.
 *
 * Marks: every node program built and every render pipeline made, timed
 * (`tl:node-build`, `tl:pipeline`, detail: object, material, ms), which the
 * perf harness reads per window to show what still builds.
 *
 * Private API of the pinned three version (`_nodes`, `_pipelines`), guarded:
 * missing, nothing is installed.
 */

/** The mark of a node program built (detail: object, material, ms). */
export const NODE_BUILD_MARK = 'tl:node-build';
/** The mark of a render pipeline made (detail: object, material, ms). */
export const PIPELINE_MARK = 'tl:pipeline';
/**
 * How long (ms) a node build, pipeline or program no object uses any more is
 * kept for one made in its place: a re-bake's new objects are drawn within a
 * second or two of the old ones going (the command's round trip, the blobs
 * read, the sets prepared on a worker), with room to spare.
 */
export const RELEASED_BUILD_KEEP_MS = 10_000;

interface RenderObjectLike {
  readonly isRenderObject?: boolean;
  readonly object?: { readonly name?: string } | null;
  readonly material?: { readonly name?: string; readonly type?: string } | null;
  readonly initialCacheKey?: unknown;
}

interface BuildStateLike {
  usedTimes: number;
}

interface NodeManagerLike {
  getForRender(ro: RenderObjectLike, useAsync?: boolean): unknown;
  getForRenderCacheKey?(ro: RenderObjectLike): unknown;
  nodeBuilderCache?: Map<unknown, unknown>;
  get(o: object): { nodeBuilderState?: BuildStateLike };
  delete(o: object): unknown;
}

interface UsedLike {
  usedTimes: number;
  readonly cacheKey?: unknown;
  readonly code?: unknown;
  readonly stage?: string;
}

interface PipelinesLike {
  _getRenderPipeline(ro: RenderObjectLike, ...rest: unknown[]): unknown;
  _releasePipeline(pipeline: UsedLike): unknown;
  _releaseProgram(program: UsedLike): unknown;
  caches?: Map<unknown, unknown>;
  programs?: Record<string, Map<unknown, unknown>>;
}

type RendererLike = { _nodes?: NodeManagerLike | null; _pipelines?: PipelinesLike | null; __tlBuildMarks?: true; __tlBuildReuse?: true } | null | undefined;

const detailOf = (ro: RenderObjectLike, ms: number): { object: string; material: string; ms: number } => ({ object: ro.object?.name ?? '', material: ro.material?.name || ro.material?.type || '', ms: Math.round(ms * 100) / 100 });

const internalsOf = (renderer: unknown): { nodes: NodeManagerLike; pipelines: PipelinesLike } | null => {
  const r = renderer as RendererLike;
  const nodes = r?._nodes;
  const pipelines = r?._pipelines;
  if (nodes === null || nodes === undefined || typeof nodes.getForRender !== 'function' || typeof nodes.delete !== 'function' || typeof nodes.getForRenderCacheKey !== 'function' || !(nodes.nodeBuilderCache instanceof Map)) return null;
  if (pipelines === null || pipelines === undefined || typeof pipelines._getRenderPipeline !== 'function' || typeof pipelines._releasePipeline !== 'function' || typeof pipelines._releaseProgram !== 'function' || !(pipelines.caches instanceof Map)) return null;
  return { nodes, pipelines };
};

/** Mark the node builds and pipelines a renderer makes from now on (once per renderer). Returns whether it was installed. */
export function installBuildMarks(renderer: unknown): boolean {
  const r = renderer as RendererLike;
  const perf = globalThis.performance;
  const parts = internalsOf(renderer);
  if (r === null || r === undefined || r.__tlBuildMarks === true || parts === null || typeof perf?.mark !== 'function') return false;
  const { nodes, pipelines } = parts;
  r.__tlBuildMarks = true;
  const getForRender = nodes.getForRender.bind(nodes);
  nodes.getForRender = (ro: RenderObjectLike, useAsync?: boolean): unknown => {
    const miss = nodes.get(ro as object).nodeBuilderState === undefined && !nodes.nodeBuilderCache!.has(ro.initialCacheKey);
    if (!miss) return getForRender(ro, useAsync);
    const t0 = perf.now();
    const out = getForRender(ro, useAsync);
    perf.mark(NODE_BUILD_MARK, { detail: detailOf(ro, perf.now() - t0) });
    return out;
  };
  const getRenderPipeline = pipelines._getRenderPipeline.bind(pipelines);
  pipelines._getRenderPipeline = (ro: RenderObjectLike, ...rest: unknown[]): unknown => {
    const before = pipelines.caches!.size;
    const t0 = perf.now();
    const out = getRenderPipeline(ro, ...rest);
    if (pipelines.caches!.size > before) perf.mark(PIPELINE_MARK, { detail: detailOf(ro, perf.now() - t0) });
    return out;
  };
  return true;
}

/** What {@link installBuildReuse} holds (tests, diagnostics). */
export interface BuildReuse {
  /** Builds, pipelines and programs held now. */
  held(): { builds: number; pipelines: number; programs: number };
  /** Release what was held longer than the keep time (`now`: performance time); called on a timer too. */
  sweep(now?: number): void;
  /** Release everything held and stop the timer (the renderer is disposed). */
  releaseAll(): void;
}

/**
 * Keep a renderer's node builds, pipelines and programs
 * {@link RELEASED_BUILD_KEEP_MS} after their last user went (once per
 * renderer). Returns the holder, or null where the internals are not there.
 */
export function installBuildReuse(renderer: unknown, keepMs: number = RELEASED_BUILD_KEEP_MS, clock: () => number = () => performance.now()): BuildReuse | null {
  const r = renderer as RendererLike;
  const parts = internalsOf(renderer);
  if (r === null || r === undefined || r.__tlBuildReuse === true || parts === null) return null;
  const { nodes, pipelines } = parts;
  r.__tlBuildReuse = true;
  /** Held builds (one use each, the hold) → their cache key and when the hold ends. */
  const builds = new Map<BuildStateLike, { key: unknown; until: number }>();
  /** Pipelines and programs three released (none used them) → when they really go. */
  const heldPipelines = new Map<UsedLike, number>();
  const heldPrograms = new Map<UsedLike, number>();
  const releasePipeline = pipelines._releasePipeline.bind(pipelines);
  const releaseProgram = pipelines._releaseProgram.bind(pipelines);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = (): void => {
    if (timer !== null || (builds.size === 0 && heldPipelines.size === 0 && heldPrograms.size === 0)) return;
    timer = setTimeout(() => {
      timer = null;
      reuse.sweep();
      schedule();
    }, Math.max(250, keepMs / 4));
  };
  const dropBuild = (state: BuildStateLike, key: unknown): void => {
    state.usedTimes -= 1;
    if (state.usedTimes <= 0 && nodes.nodeBuilderCache!.get(key) === state) nodes.nodeBuilderCache!.delete(key);
  };

  const remove = nodes.delete.bind(nodes);
  nodes.delete = (object: object): unknown => {
    const ro = object as RenderObjectLike;
    if (ro.isRenderObject === true) {
      const state = nodes.get(object).nodeBuilderState;
      if (state !== undefined) {
        const key = nodes.getForRenderCacheKey!(ro);
        const held = builds.get(state);
        // Its last user goes (the hold aside): held, or held longer, for one made in its place.
        if (state.usedTimes - (held !== undefined ? 1 : 0) === 1 && nodes.nodeBuilderCache!.get(key) === state) {
          if (held !== undefined) held.until = clock() + keepMs;
          else {
            state.usedTimes += 1;
            builds.set(state, { key, until: clock() + keepMs });
          }
          schedule();
        }
      }
    }
    return remove(object);
  };
  pipelines._releasePipeline = (pipeline: UsedLike): unknown => {
    heldPipelines.set(pipeline, clock() + keepMs);
    schedule();
    return undefined;
  };
  pipelines._releaseProgram = (program: UsedLike): unknown => {
    heldPrograms.set(program, clock() + keepMs);
    schedule();
    return undefined;
  };

  const reuse: BuildReuse = {
    held: () => ({ builds: builds.size, pipelines: heldPipelines.size, programs: heldPrograms.size }),
    sweep(now = clock()): void {
      for (const [state, h] of builds) {
        // Used again meanwhile: the users keep it; the hold ends when it would have.
        if (h.until > now) continue;
        builds.delete(state);
        dropBuild(state, h.key);
      }
      // Pipelines before programs (a pipeline's programs are released after it, as three does).
      for (const [p, until] of heldPipelines) {
        if (p.usedTimes > 0) heldPipelines.delete(p);
        else if (until <= now) {
          heldPipelines.delete(p);
          releasePipeline(p);
        }
      }
      for (const [p, until] of heldPrograms) {
        if (p.usedTimes > 0) heldPrograms.delete(p);
        else if (until <= now) {
          heldPrograms.delete(p);
          releaseProgram(p);
        }
      }
    },
    releaseAll(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      reuse.sweep(Infinity);
    },
  };
  return reuse;
}
