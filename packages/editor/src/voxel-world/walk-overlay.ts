/**
 * The voxel world page's walk graph (walk-graph.ts, kept on this page's
 * thread where its streamer runs) and an overlay to check it by eye: each
 * standing cell of the resident chunks round the camera's target as a small
 * square on its floor in its piece's hue (a cell too low for the default
 * walker in grey), each exit between two pieces as a yellow tick across the
 * chunk face, and a path asked for through the page hook as a red ribbon a
 * cell wide along its cells. A bench and debug view only. `?walk=1` starts
 * with the overlay on. The graph is made in a frame callback of its own from
 * every chunk already derived when it is made, in the derive slice; the
 * queries asked through the hook are served in the same slice after it
 * (this page has no simulation step to budget them in).
 */
import * as THREE from 'three';
import { frameSliceMs } from '@thirdlight/shared';
import { NO_WALK_PIECE, VOXEL_SIZE_M, WalkGraph, WalkQueries, type ChunkGrid, type FloatingOrigin, type VoxelStreamer, type WalkPathAnswer } from '@thirdlight/voxel';

/** Chunks round the target the overlay covers (each way, horizontally; vertically half that). */
const OVERLAY_CHUNKS = 3;
/** The least ms between two overlay builds. */
const OVERLAY_REBUILD_MS = 500;
/** How far over a cell's floor its square and the path's ribbon are drawn (metres), so they sit on the surface. */
const FLOOR_LIFT_M = 0.04;
const PATH_LIFT_M = 0.12;

/** A piece's colour: hues apart by chunk and piece (a golden-ratio step), so neighbouring pieces differ. */
function pieceColour(key: number, piece: number, out: THREE.Color): THREE.Color {
  const h = ((key * 0.381966 + piece * 0.618034) % 1 + 1) % 1;
  return out.setHSL(h, 0.8, 0.55);
}

export interface PageWalk {
  readonly graph: WalkGraph;
  /** The page hooks: the graph's counts, the overlay switch, a path asked and drawn. */
  hooks(): Record<string, unknown>;
}

type Cells = { readonly x: number; readonly y: number; readonly z: number };

export function pageWalk(opts: { readonly streamer: VoxelStreamer; readonly grid: ChunkGrid; readonly origin: FloatingOrigin; readonly scene: THREE.Scene; readonly target: Cells; readonly on: boolean }): PageWalk {
  const { streamer, grid, origin, scene } = opts;
  const graph = new WalkGraph(streamer, VOXEL_SIZE_M);
  const queries = new WalkQueries(graph);
  streamer.on((e) => {
    if (e.type === 'unloaded' || (e.type === 'chunk' && !e.shaderOnly && !e.reliefOnly)) graph.touch(e.cx, e.cy, e.cz);
  });
  const per = grid.edge / streamer.sections.edge;
  for (const d of streamer.derivedChunks()) graph.touch(Math.floor(d.cx / per), Math.floor(d.cy / per), Math.floor(d.cz / per));
  const cellsMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide }));
  const exitsLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffe14d, depthTest: false }));
  const pathMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: 0xff2020, depthTest: false, side: THREE.DoubleSide }));
  for (const [m, order] of [[cellsMesh, 10], [exitsLines, 11], [pathMesh, 12]] as const) {
    m.frustumCulled = false;
    m.renderOrder = order;
    m.visible = false;
    scene.add(m);
  }
  let on = opts.on;
  let builtAt = -Infinity;
  let builtVersion = -1;
  let builtRebases = -1;
  let builtTarget = '';
  let path: Int32Array | null = null;
  let pathRebases = -1;
  const drawn = { cells: 0, pieces: 0, exits: 0, chunks: 0, pathCells: 0, buildMs: 0 };
  const colour = new THREE.Color();

  function build(target: Cells): void {
    const t0 = performance.now();
    const c = [target.x >> grid.shift, target.y >> grid.shift, target.z >> grid.shift] as const;
    const v = OVERLAY_CHUNKS;
    const h = Math.max(1, v >> 1);
    const pos: number[] = [];
    const col: number[] = [];
    const lines: number[] = [];
    const o = origin.origin;
    const s = VOXEL_SIZE_M;
    const e = grid.edge;
    const inset = 0.1;
    let pieces = 0;
    let chunks = 0;
    for (let cx = c[0] - v; cx <= c[0] + v; cx++) for (let cz = c[2] - v; cz <= c[2] + v; cz++) for (let cy = c[1] - h; cy <= c[1] + h; cy++) {
      const part = graph.chunkAt(cx, cy, cz);
      if (part === null || part.ys.length === 0) continue;
      chunks++;
      pieces += part.pieces.length;
      for (let i = 0; i < part.ys.length; i++) {
        const lx = (part.col[i]! / e) | 0;
        const lz = part.col[i]! % e;
        const x0 = (cx * e + lx - o.x) * s;
        const z0 = (cz * e + lz - o.z) * s;
        const y = (cy * e + part.ys[i]! - o.y) * s + FLOOR_LIFT_M;
        const p = part.piece[i]!;
        if (p === NO_WALK_PIECE) colour.setRGB(0.45, 0.45, 0.45);
        else pieceColour(part.key, p, colour);
        const a = [x0 + inset, z0 + inset];
        const b = [x0 + s - inset, z0 + s - inset];
        for (const [qx, qz] of [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], a[1]], [b[0], b[1]], [a[0], b[1]]] as const) {
          pos.push(qx!, y, qz!);
          col.push(colour.r, colour.g, colour.b);
        }
      }
      for (let p = 0; p < part.pieces.length; p++) {
        for (const x of graph.exitsOf(part, p)) {
          for (const [ch, cell] of [[x.from, x.a], [x.to, x.b]] as const) {
            const k = ch.col[cell]!;
            lines.push((ch.cx * e + ((k / e) | 0) + 0.5 - o.x) * s, (ch.cy * e + ch.ys[cell]! - o.y) * s + PATH_LIFT_M, (ch.cz * e + (k % e) + 0.5 - o.z) * s);
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    cellsMesh.geometry.dispose();
    cellsMesh.geometry = g;
    const l = new THREE.BufferGeometry();
    l.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3));
    exitsLines.geometry.dispose();
    exitsLines.geometry = l;
    Object.assign(drawn, { cells: pos.length / 18, pieces, exits: lines.length / 6, chunks, buildMs: Number((performance.now() - t0).toFixed(2)) });
  }

  /** The path's cells as a ribbon a cell wide, along each step. */
  function buildPath(): void {
    const pos: number[] = [];
    const o = origin.origin;
    const s = VOXEL_SIZE_M;
    const w = s * 0.3;
    const cells = path ?? new Int32Array(0);
    for (let k = 3; k < cells.length; k += 3) {
      const a = [(cells[k - 3]! + 0.5 - o.x) * s, (cells[k - 2]! - o.y) * s + PATH_LIFT_M, (cells[k - 1]! + 0.5 - o.z) * s];
      const b = [(cells[k]! + 0.5 - o.x) * s, (cells[k + 1]! - o.y) * s + PATH_LIFT_M, (cells[k + 2]! + 0.5 - o.z) * s];
      const dx = b[0]! - a[0]!;
      const dz = b[2]! - a[2]!;
      const len = Math.hypot(dx, dz) || 1;
      const nx = (-dz / len) * w;
      const nz = (dx / len) * w;
      const q = [[a[0]! + nx, a[1]!, a[2]! + nz], [b[0]! + nx, b[1]!, b[2]! + nz], [b[0]! - nx, b[1]!, b[2]! - nz], [a[0]! - nx, a[1]!, a[2]! - nz]];
      for (const i of [0, 1, 2, 0, 2, 3]) pos.push(...q[i]!);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    pathMesh.geometry.dispose();
    pathMesh.geometry = g;
    pathRebases = origin.rebases;
    drawn.pathCells = cells.length / 3;
  }

  /** Makes what arrived (the derive slice), serves the queries and rebuilds the overlay when due. */
  function update(target: Cells): void {
    const slice = frameSliceMs('voxelDerive');
    const t0 = performance.now();
    if (graph.pending) graph.update(slice);
    if (queries.queued > 0) queries.serve(slice - (performance.now() - t0));
    cellsMesh.visible = on;
    exitsLines.visible = on;
    pathMesh.visible = on && path !== null;
    if (!on) return;
    if (path !== null && pathRebases !== origin.rebases) buildPath();
    const now = performance.now();
    const key = `${target.x >> grid.shift},${target.y >> grid.shift},${target.z >> grid.shift}`;
    const due = graph.version !== builtVersion || origin.rebases !== builtRebases || key !== builtTarget;
    if (!due || now - builtAt < OVERLAY_REBUILD_MS) return;
    builtAt = now;
    builtVersion = graph.version;
    builtRebases = origin.rebases;
    builtTarget = key;
    build(target);
  }
  const frame = (): void => {
    update(opts.target);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return {
    graph,
    hooks: () => ({
      walk: {
        /** Counts over the graph (chunks, cells, pieces, exits, made and kept), its bytes, whether chunks wait. */
        stats: () => ({ ...graph.stats(), bytes: graph.bytes, pending: graph.pending }),
        /** The overlay on or off; what it drew last. */
        overlay(show: boolean): void {
          on = show;
          builtVersion = -1;
          builtAt = -Infinity;
        },
        drawn: () => ({ on, ...drawn }),
        /** A path between two points (world metres) for the default walker, drawn as the ribbon; its answer (cells flat). */
        path(from: readonly number[], to: readonly number[], options: Record<string, unknown> = {}): Promise<Omit<WalkPathAnswer, 'cells'> & { cells: number[] }> {
          const cell = (p: readonly number[]): [number, number, number] => [Math.floor(p[0]! / VOXEL_SIZE_M), Math.floor(p[1]! / VOXEL_SIZE_M), Math.floor(p[2]! / VOXEL_SIZE_M)];
          return new Promise((ok) => {
            queries.path(cell(from), cell(to), options, (a) => {
              path = a.cells;
              buildPath();
              ok({ ...a, cells: [...a.cells] });
            });
          });
        },
        clearPath(): void {
          path = null;
          buildPath();
        },
      },
    }),
  };
}
