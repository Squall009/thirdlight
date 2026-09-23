/**
 * `exportProject(ctx)` — the standalone export operation (sessions.md §6.3).
 *
 * Exports the project's current v3 state through the M3 pipeline
 * (`export-m3.ts`): the single acknowledged envelope read, the shared
 * runtime-content closure, the bundle, the validation pipeline and the
 * atomic publish. Projects on an older schema version are refused.
 *
 * Pure Node, no Node-builtin imports: filesystem I/O goes through the
 * injected `ExportFs` facade.
 */
import { exportProjectM3 } from './export-m3';
import type { ExportResult } from './errors';
import type { ExportContext } from './export-types';

export type { ExportContext, ExportFs } from './export-types';

export async function exportProject(ctx: ExportContext): Promise<ExportResult> {
  const v3 = ctx.service.readCapturedV3(ctx.projectId);
  if (!v3.ok) {
    if (v3.error.reason === 'version_combination_unsupported') {
      return {
        ok: false,
        error: {
          code: 'export_scene_invalid',
          cls: 'validation',
          message: 'this project uses an older schema version; only v3 projects can be exported',
          detail: { reason: 'version_unsupported' },
        },
      };
    }
    return {
      ok: false,
      error: {
        code: 'export_scene_invalid',
        cls: 'validation',
        message: `the captured v3 read failed: ${v3.error.message}`.slice(0, 256),
        detail: { errors: [v3.error], errorTotal: 1 },
      },
    };
  }
  return exportProjectM3(ctx, { scene: v3.read.scene, content: v3.read.content, revision: v3.read.revision }, ctx.m3BootstrapEntry, ctx.compiler);
}
