/**
 * Authoring a template through the real editing path: `@thirdlight/commands`
 * `applyMutation` (the commands the browser and MCP send) on a new project's
 * baseline, then the result captured as `captured/project.json` with the
 * command list in `recipe/commands.json`. Shared by the templates' build
 * scripts, so every template is made the same way.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { applyMutation, createCommandState } from '@thirdlight/commands';
import type { CommandState, MutationSuccess } from '@thirdlight/commands';
import type { SceneV3 } from '@thirdlight/project-model';

export interface Author {
  projectId: string;
  state: CommandState;
  counter: number;
  applied: Array<{ op: string; args: Record<string, unknown> }>;
}

/**
 * A new project's scene: its one default camera (the v3 scene validator
 * requires exactly one) at `cameraAt`, and the content's settings.
 */
export function newAuthor(projectId: string, cameraAt: [number, number, number], settings: Record<string, unknown> = {}): Author {
  return {
    projectId,
    state: createCommandState(
      {
        schemaVersion: 3,
        sceneId: 'scene-main',
        revision: 0,
        entities: [{ id: 'cam-main', name: 'Main camera', components: { transform: { position: cameraAt, rotation: [0, 0, 0, 1], scale: [1, 1, 1] }, camera: { type: 'perspective', fovY: 60, near: 0.1, far: 100 } } }],
      } as unknown as SceneV3,
      { assets: [], prefabs: [], behaviors: [], settings, behaviorTrust: { entries: [] }, game: null } as never,
    ),
    counter: 0,
    applied: [],
  };
}

/** One command, as the editor sends it; a refusal ends the script. */
export function run(author: Author, op: string, args: Record<string, unknown>): MutationSuccess {
  author.counter += 1;
  const revision = (author.state.scene as unknown as { revision: number }).revision;
  const outcome = applyMutation(author.state, { op, projectId: author.projectId, expectedRevision: revision, requestId: `req-${author.counter.toString(16).padStart(32, '0')}`, args } as never);
  if (!outcome.ok) {
    console.error(`FAILED at ${op}:`, JSON.stringify(outcome.result, null, 2));
    process.exit(1);
  }
  author.state = outcome.state;
  author.applied.push({ op, args });
  return outcome.result as MutationSuccess;
}

/** Write `captured/project.json` and `recipe/commands.json` under `root`; prints the objects made. */
export function capture(author: Author, root: string, generatedBy: string, importedAt: string): void {
  const scene = author.state.scene as unknown as { revision: number; entities: Array<{ id: string; name: string }> };
  const captured = {
    storageVersion: 3,
    type: 'authoring-state',
    projectId: author.projectId,
    scene: author.state.scene,
    content: (author.state as unknown as { content: unknown }).content,
    recipe: { generatedBy, commandCount: author.applied.length, importedAt },
  };
  mkdirSync(join(root, 'captured'), { recursive: true });
  mkdirSync(join(root, 'recipe'), { recursive: true });
  writeFileSync(join(root, 'captured', 'project.json'), JSON.stringify(captured, null, 2) + '\n');
  writeFileSync(join(root, 'recipe', 'commands.json'), JSON.stringify({ projectId: author.projectId, importedAt, commands: author.applied }, null, 2) + '\n');
  console.log(`captured ${author.projectId}: revision ${scene.revision}; ${scene.entities.map((e) => `${e.id} ${e.name}`).join(', ')}`);
}
