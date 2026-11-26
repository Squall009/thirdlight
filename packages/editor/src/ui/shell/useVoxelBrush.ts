/**
 * The voxel brush's wiring, for the world edit mode and the structure
 * mode's hand edits: the Scene view's voxel brush tool armed by a mode, each
 * stroke sent as one `editVoxels` command (the command MCP sends; undo steps
 * it back on the project's one line), the tool's live readout and the last
 * refusal, and the project's ground and construction voxel materials as the
 * palette shows them (a base material with its instances as its variants).
 *
 * The editor never writes voxels itself: the view draws a stroke when the
 * change feed brings its chunks.
 *
 * Browser-only (React).
 */
import { useCallback, useMemo, useState } from 'react';
import type { MaterialDef } from '@thirdlight/project-model';
import { resolvedVoxelParts } from '@thirdlight/project-model/voxel-materials';

import { voxelPalette, type VoxelPaletteEntry } from '../../session/voxel-brush';
import type { VoxelBrushArm, VoxelBrushCallbacks } from '../../viewport/voxel-brush-tool';
import type { ClientRef, ViewportRef } from './commands';

export interface VoxelBrushTools {
  /** Arm the brush for a mode (null: off). */
  arm(a: VoxelBrushArm | null): void;
  /** The voxel materials a brush on ground or construction offers, variants after their base. */
  readonly palette: readonly VoxelPaletteEntry[];
  /** What the stroke in flight holds, live (null: none). */
  readonly readout: string | null;
  /** Why the last stroke was not applied (null: none since the last one applied). */
  readonly refusal: string | null;
}

export function useVoxelBrush(deps: { clientRef: ClientRef; viewportRef: ViewportRef; materials: readonly MaterialDef[] }): VoxelBrushTools {
  const { clientRef, viewportRef } = deps;
  const [readout, setReadout] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const palette = useMemo(() => voxelPalette(deps.materials, resolvedVoxelParts(deps.materials)), [deps.materials]);

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
  }), [clientRef]);

  const arm = useCallback((a: VoxelBrushArm | null): void => {
    const v = viewportRef.current;
    if (v === null) return;
    if (a === null) {
      setReadout(null);
      setRefusal(null);
    }
    v.voxelWorlds.brushTool(a, a === null ? null : callbacks);
  }, [viewportRef, callbacks]);

  return useMemo(() => ({ arm, palette, readout, refusal }), [arm, palette, readout, refusal]);
}
