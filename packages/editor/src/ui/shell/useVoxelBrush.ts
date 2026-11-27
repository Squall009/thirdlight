/**
 * The voxel brush's wiring, for the world edit mode and the structure
 * mode's hand edits: the Scene view's voxel brush tool armed by a mode, each
 * stroke sent as one `editVoxels` command (the command MCP sends; undo steps
 * it back on the project's one line), the tool's live readout and the last
 * refusal, and the project's voxel materials as the palettes show them (a
 * base material with its instances as its variants): ground and
 * construction for Add, those and the gases for Paint, the gases and the
 * liquids for the Fill rail. A fill's commands (a `flood` stroke, a water
 * body or a spline made by `createEntity`) go the same way, their answers
 * read for the leaks a refused flood names. The Rules rail's probe writes
 * nothing: what it reads under the pointer is kept here for its column.
 *
 * The editor never writes voxels itself: the view draws a stroke when the
 * change feed brings its chunks.
 *
 * Browser-only (React).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import type { DressingDef, MaterialDef } from '@thirdlight/project-model';
import type { FloodLeakPlace } from '../../session/envelope';
import { resolvedVoxelParts } from '@thirdlight/project-model/voxel-materials';

import { GAS_PALETTE_USES, LIQUID_PALETTE_USES, PAINT_PALETTE_USES, voxelPalette, type VoxelPaletteEntry } from '../../session/voxel-brush';
import type { WorldPalettes } from '../../session/world-mode';
import type { VoxelBrushArm, VoxelBrushCallbacks } from '../../viewport/voxel-brush-tool';
import type { RulesProbeRead } from '../../viewport/voxel-rules-probe';
import type { ClientRef, ViewportRef } from './commands';

/** What a mode hears of its fills: the depth a gesture ended at, an object made. */
export type VoxelFillHandlers = Pick<VoxelBrushCallbacks, 'depth' | 'made'>;

export interface VoxelBrushTools {
  /** Arm the brush for a mode (null: off); `on`: what the mode hears of its fills. */
  arm(a: VoxelBrushArm | null, on?: VoxelFillHandlers): void;
  /** The voxel materials a brush on ground or construction offers, variants after their base. */
  readonly palette: readonly VoxelPaletteEntry[];
  /** Every palette of the world mode (`solid` is `palette`). */
  readonly palettes: WorldPalettes;
  /** Show fog in the Scene view by its density (the overlay) or as a game draws it. */
  gasOverlay(on: boolean): void;
  /** What the Rules rail's probe reads under the pointer, or where it was pinned (null: nothing). */
  readonly probe: RulesProbeRead | null;
  /** The project's dressings (what the Rules rail answers from). */
  readonly dressings: readonly DressingDef[];
  /** The boxes of the props ground cover keeps clear of, as the view last read them (null: none). */
  coverClear(): Float32Array | null;
  /** What the stroke in flight holds, live (null: none). */
  readonly readout: string | null;
  /** Why the last stroke was not applied (null: none since the last one applied). */
  readonly refusal: string | null;
}

export function useVoxelBrush(deps: { clientRef: ClientRef; viewportRef: ViewportRef; materials: readonly MaterialDef[]; dressings: readonly DressingDef[] }): VoxelBrushTools {
  const { clientRef, viewportRef } = deps;
  const [readout, setReadout] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [probe, setProbe] = useState<RulesProbeRead | null>(null);
  const palettes = useMemo<WorldPalettes>(() => {
    const parts = resolvedVoxelParts(deps.materials);
    return { solid: voxelPalette(deps.materials, parts), paint: voxelPalette(deps.materials, parts, PAINT_PALETTE_USES), gas: voxelPalette(deps.materials, parts, GAS_PALETTE_USES), liquid: voxelPalette(deps.materials, parts, LIQUID_PALETTE_USES) };
  }, [deps.materials]);
  const palette = palettes.solid;
  const handlers = useRef<VoxelFillHandlers>({});

  const callbacks = useMemo<VoxelBrushCallbacks>(() => ({
    stroke: async (world, command) => {
      const c = clientRef.current;
      if (c === null) return;
      const r = await c.command('editVoxels', { world, command }, c.projection.revision);
      if (r.ok) {
        setRefusal(null);
        return;
      }
      const res = r.response as { code?: string; message?: string };
      // A stroke over cells it does not change (a dig in the air) is no refusal worth saying.
      if (res.code === 'no_change') {
        setRefusal(null);
        return;
      }
      setRefusal(`Stroke: ${res.message ?? res.code ?? 'refused'}`);
      throw new Error(res.message ?? res.code ?? 'refused');
    },
    refused: (m) => setRefusal(m),
    readout: (t) => setReadout(t),
    send: async (op, args) => {
      const c = clientRef.current;
      if (c === null) return { ok: false, code: 'network', message: 'not connected' };
      const r = await c.command(op, args, c.projection.revision);
      if (r.ok) {
        setRefusal(null);
        return { ok: true, ...(r.createdId !== undefined ? { createdId: r.createdId } : {}) };
      }
      const res = r.response as { code?: string; message?: string; leaks?: FloodLeakPlace[] };
      return { ok: false, code: res.code ?? 'refused', message: res.message ?? res.code ?? 'refused', ...(res.leaks !== undefined ? { leaks: res.leaks } : {}) };
    },
    depth: (m) => handlers.current.depth?.(m),
    made: (what, id) => handlers.current.made?.(what, id),
    probe: (read) => setProbe(read),
  }), [clientRef]);

  const arm = useCallback((a: VoxelBrushArm | null, on: VoxelFillHandlers = {}): void => {
    handlers.current = on;
    const v = viewportRef.current;
    if (v === null) return;
    if (a === null) {
      setReadout(null);
      setRefusal(null);
      setProbe(null);
    }
    v.voxelWorlds.brushTool(a, a === null ? null : callbacks);
  }, [viewportRef, callbacks]);

  const gasOverlay = useCallback((on: boolean): void => viewportRef.current?.voxelWorlds.gasOverlay(on), [viewportRef]);

  const coverClear = useCallback((): Float32Array | null => viewportRef.current?.voxelWorlds.coverClear() ?? null, [viewportRef]);
  const { dressings } = deps;

  return useMemo(() => ({ arm, gasOverlay, palette, palettes, readout, refusal, probe, dressings, coverClear }), [arm, gasOverlay, palette, palettes, readout, refusal, probe, dressings, coverClear]);
}
