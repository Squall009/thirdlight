/**
 * The voxel worlds the Scene view draws: every world a `voxelWorld` object
 * in the open scenes names, streamed around the point the view orbits and
 * drawn in the adapter's scene by the chunk views Play draws with
 * (`VoxelWorldDraws`). The worlds stream in a worker
 * (scene-voxels-worker.ts), which reads the region files by range from the
 * backend and derives in workers of its own, so this page only replaces
 * chunk draws, a batch at a time, and draws a frame after each.
 *
 * As in a game, a world's first object gives its settings (ring, sections)
 * and its cell 0 lies at the world origin; nothing collides in the editor.
 * An edit applied by the command route (the editor's, MCP's) arrives as the
 * feed's `voxelsChanged` and is handed to the worker, which reads the
 * chunks it names again; the view shows it without a reload.
 *
 * Detail pieces are the project's voxel kits, read once when the first
 * world opens (through the command route; their GLBs from the backend), with
 * the engine's default kit for the materials no kit binds: the worker
 * derives with the piece table of those kits, the draws use the same. A kit
 * edited while the view is open shows once the view reads its kits again
 * (a page reload or a renderer change).
 */
import { resolveVoxelWorld, type VoxelWorldComponent } from '@thirdlight/project-model/voxel-world';
import type { VoxelsChangedPayload } from '@thirdlight/protocol';
import { VoxelKitMeshes, VoxelWorldDraws, type SceneAdapter, type VoxelGridRenderer, type VoxelKitRecordLike } from '@thirdlight/three-adapter';
import { pageKitPieces, readVoxelKits, type KitRoute } from '../voxel-world/kit-pieces';
import type * as THREE from 'three';
import type { ProjectedEntity } from '../session/projection';
import type { SceneVoxelsIn, SceneVoxelsOut } from '../voxel-world/scene-voxels-wire';

/** Where the editor reads a project's voxel worlds: the backend's route of a world and the headers it needs. */
export interface SceneVoxelsSource {
  url(world: string): string;
  readonly headers: Readonly<Record<string, string>>;
  /** Where the project's voxel kits and their models are read (absent: the default kit only). */
  readonly kits?: KitRoute;
}

export interface SceneVoxelsHost {
  readonly adapter: () => SceneAdapter;
  readonly requestRender: () => void;
  readonly source: SceneVoxelsSource | null;
}

type WorldState = Extract<SceneVoxelsOut, { t: 'state' }>;

/** The worker streaming the worlds and the voxel worker it starts, next to the editor page. */
const WORKER_SCRIPT = 'voxel-view-worker.js';
const DERIVE_SCRIPT = 'voxel-worker.js';

export class SceneVoxels {
  private worker: Worker | null = null;
  private draws: VoxelWorldDraws;
  /** The worlds opened, by name: the settings they were opened with. */
  private readonly open = new Map<string, string>();
  private readonly states = new Map<string, WorldState>();
  private readonly problems = new Map<string, string>();
  /** The focus last sent (cells' worth of metres apart before another is sent). */
  private focusSent: [number, number, number] | null = null;
  private stampMark = '';
  /** The project's kits once read (null until the first world opens), and their meshes. */
  private kits: Promise<readonly VoxelKitRecordLike[]> | null = null;
  private kitMeshes: VoxelKitMeshes | null = null;

  constructor(private readonly host: SceneVoxelsHost) {
    this.draws = this.makeDraws();
  }

  /** Reads the project's kits once and gives the draws their pieces; resolves to the kits the worker derives with. */
  private projectKits(): Promise<readonly VoxelKitRecordLike[]> {
    if (this.kits !== null) return this.kits;
    const route = this.host.source?.kits;
    const read = (route === undefined ? Promise.resolve([]) : readVoxelKits(route)).catch((e: unknown) => {
      for (const name of this.open.keys()) this.problems.set(name, `voxel kits: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    });
    this.kits = read;
    void read.then((kits) => {
      // The renderer was replaced or the view disposed while the kits were read: those draws are gone, make nothing.
      if (this.kits !== read) return;
      if (route !== undefined) {
        const p = pageKitPieces(route, kits);
        this.kitMeshes = p.meshes;
        this.draws.setKits(p.set);
        void p.loaded.then((why) => {
          if (why === '') return;
          for (const name of this.open.keys()) this.problems.set(name, why);
          this.host.requestRender();
        });
      } else {
        this.kitMeshes = new VoxelKitMeshes();
        this.draws.setKits(this.kitMeshes.world(kits));
      }
    });
    return this.kits;
  }

  private makeDraws(): VoxelWorldDraws {
    const { adapter, requestRender } = this.host;
    return new VoxelWorldDraws({
      scene: () => adapter().threeScene?.() ?? null,
      // The grids upload through the renderer once it can draw.
      renderer: () => (adapter().rendererStarting() ? null : ((adapter().currentRenderer?.() ?? null) as VoxelGridRenderer | null)),
      report: (world, bytes, coarse, kits) => this.post({ t: 'drawn', world, bytes, coarse, kits }),
      applied: () => requestRender(),
    });
  }

  private post(m: SceneVoxelsIn): void {
    this.worker?.postMessage(m);
  }

  private start(): Worker {
    if (this.worker !== null) return this.worker;
    const w = new Worker(new URL(WORKER_SCRIPT, document.baseURI).href, { type: 'module', name: 'thirdlight-voxel-view' });
    w.onmessage = (e: MessageEvent<SceneVoxelsOut>) => {
      const m = e.data;
      if (m.t === 'batch') this.draws.receive(m.batch);
      else if (m.t === 'state') {
        this.states.set(m.world, m);
        this.problems.delete(m.world);
        this.host.requestRender();
      } else {
        this.problems.set(m.world, m.message);
        this.host.requestRender();
      }
    };
    this.worker = w;
    return w;
  }

  /** The open scenes' objects: the worlds they name are opened, those no object names any more closed. */
  sync(entities: readonly ProjectedEntity[]): void {
    const source = this.host.source;
    if (source === null) return;
    const wanted = new Map<string, string>();
    const settings = new Map<string, ReturnType<typeof resolveVoxelWorld>>();
    for (const e of entities) {
      const c = e.components['voxelWorld'] as VoxelWorldComponent | undefined;
      if (c === undefined || typeof c.world !== 'string' || wanted.has(c.world)) continue;
      const s = resolveVoxelWorld(c);
      wanted.set(c.world, JSON.stringify(s));
      settings.set(c.world, s);
    }
    for (const name of [...this.open.keys()]) {
      if (wanted.get(name) === this.open.get(name)) continue;
      this.open.delete(name);
      this.states.delete(name);
      this.problems.delete(name);
      this.post({ t: 'close', world: name });
    }
    for (const [name, key] of wanted) {
      if (this.open.has(name)) continue;
      const s = settings.get(name)!;
      this.start();
      this.open.set(name, key);
      void this.projectKits().then((kits) => {
        // Closed (or opened again with other settings) while the kits were read.
        if (this.open.get(name) !== key) return;
        this.post({ t: 'open', world: name, url: source.url(name), headers: source.headers, workerUrl: new URL(DERIVE_SCRIPT, document.baseURI).href, ring: s.ring, levels: s.levels, collision: s.collision, sectionEdge: s.sectionEdge, kits });
        if (this.focusSent !== null) this.post({ t: 'focus', x: this.focusSent[0], y: this.focusSent[1], z: this.focusSent[2] });
      });
    }
  }

  /** Where the view looks (the orbit's target, metres): the worlds stream around it. */
  focus(at: THREE.Vector3): void {
    if (this.open.size === 0) return;
    const f = this.focusSent;
    // A move within a cell changes nothing the streamer plans with.
    if (f !== null && Math.abs(f[0] - at.x) < 0.5 && Math.abs(f[1] - at.y) < 0.5 && Math.abs(f[2] - at.z) < 0.5) return;
    this.focusSent = [at.x, at.y, at.z];
    this.post({ t: 'focus', x: at.x, y: at.y, z: at.z });
  }

  /** A voxel world change from the editor feed. */
  changed(c: VoxelsChangedPayload): void {
    if (!this.open.has(c.world)) return;
    this.post({ t: 'changed', world: c.world, change: c });
  }

  /** The adapter (and its renderer) was replaced: the draws start again in its scene, every world streamed again. */
  adapterReplaced(): void {
    this.draws.dispose();
    this.draws = this.makeDraws();
    // The kits are read again for the new draws, their meshes loaded again for the new renderer.
    this.kitMeshes?.dispose();
    this.kitMeshes = null;
    this.kits = null;
    const names = [...this.open.keys()];
    for (const name of names) this.post({ t: 'close', world: name });
    this.open.clear();
    this.states.clear();
    this.focusSent = null;
  }

  /** What is drawn (`data-voxels` on the view: tests read it); absent with no world. */
  stamp(root: HTMLElement): void {
    if (this.open.size === 0 && this.stampMark === '') return;
    const drawn = this.draws.stats();
    const mark = this.open.size === 0 ? '' : JSON.stringify({ worlds: drawn.worlds, replaced: drawn.replaced, batches: drawn.batches, states: Object.fromEntries(this.states), problems: Object.fromEntries(this.problems) });
    if (mark === this.stampMark) return;
    this.stampMark = mark;
    if (mark === '') root.removeAttribute('data-voxels');
    else root.setAttribute('data-voxels', mark);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.draws.dispose();
    this.kitMeshes?.dispose();
    this.kitMeshes = null;
    this.kits = null;
    this.open.clear();
  }
}
