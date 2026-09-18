/**
 * @thirdlight/workspace — public surface (dependencies.md §3.5).
 *
 * The only entry point. Everything the editor backend, the MCP tool and
 * (via their shared commands layer) future harness flows use goes through
 * this module: the durable write, ownership, the §6.1 pipeline execution,
 * recovery and the external-change protocol live inside the package.
 */

export * from './types';
export { openWorkspaceService } from './service';
export { ERROR_CODES } from './errors';
// Re-exported command/model surface so a consumer never reaches into
// another package's internals (strict-boundary rule, dependencies.md §2):
// commands' MutationResult/CommandError and the model's document types.
// (commands' own `QueryResult` is intentionally NOT re-exported — the
// workspace's own `QueryResult` owns that name on this surface.)
export type { CommandError, MutationResult } from '@thirdlight/commands';
export type { WriteOps } from './write';
export { defaultOps as defaultWriteOps } from './write';
export type { Entity, Scene, Manifest, ModelError } from '@thirdlight/project-model';