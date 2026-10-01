/**
 * `project.json` schemaVersion 6: each scene carries its own look.
 *
 * Up to schemaVersion 5 the sky, fog, post-processing and wind were one
 * project-wide block (`content.environment`). From 6 each scene document has
 * its own (`SceneV4.environment`); the project keeps only what is the
 * player's or shared by every scene: the default quality and the presets.
 * The loader upgrades a 5 (pure, on the raw documents before they are
 * validated): the project's look is copied into every scene, so every scene
 * looks as it did, and leaves the content block. A game that played before
 * plays the same.
 */
import { SCENE_ENVIRONMENT_FIELDS } from './materials';

export interface UpgradeSceneEnvironmentResult {
  /** The upgraded documents (deep copies; the inputs are untouched). */
  content: unknown;
  scenes: unknown[];
  /** What the upgrade changed (for the upgrade notes). */
  notes: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Move a schemaVersion 5 project's sky, fog, post and wind from the content block into every scene document. Pure. */
export function upgradeSceneEnvironments(contentIn: unknown, scenesIn: readonly unknown[]): UpgradeSceneEnvironmentResult {
  const content = JSON.parse(JSON.stringify(contentIn ?? null)) as unknown;
  const scenes = scenesIn.map((s) => JSON.parse(JSON.stringify(s ?? null)) as unknown);
  const env = isObject(content) ? content['environment'] : undefined;
  if (!isObject(content) || !isObject(env)) return { content, scenes, notes: [] };
  const look: Record<string, unknown> = {};
  for (const k of SCENE_ENVIRONMENT_FIELDS) {
    if (env[k] === undefined) continue;
    look[k] = env[k];
    delete env[k];
  }
  if (Object.keys(env).length === 0) delete content['environment'];
  const parts = Object.keys(look);
  if (parts.length === 0) return { content, scenes, notes: [] };
  let copied = 0;
  for (const s of scenes) {
    if (!isObject(s)) continue;
    // A scene that already has a look (written by hand) keeps it.
    if (s['environment'] !== undefined) continue;
    s['environment'] = JSON.parse(JSON.stringify(look)) as unknown;
    copied += 1;
  }
  return {
    content,
    scenes,
    notes: [`each scene has its own look now: the project's ${parts.join(', ')} ${parts.length === 1 ? 'was' : 'were'} copied into ${copied} scene${copied === 1 ? '' : 's'}; the quality and the presets stay the project's`],
  };
}
