/**
 * The project format after the engine/game separation.
 *
 * `project.json` schemaVersion 3 is the format without the genre layer:
 * `content.json` has no `game` key, and scenes and prefabs carry no
 * `pickup`, `enemy`, `gameZone` or `cameraFollow` component and no spawn
 * `facing`. A schemaVersion 2 project is upgraded by the loader
 * (`upgradeProjectDocsV24`, pure, on the raw documents before they are
 * validated):
 *
 * - generic data is carried over: a `pickup` becomes a `collectible` adding
 *   to the counter the pickup added to (coin → `coins`, gem → `gems`, key →
 *   `keys`, life → `lives`, custom → its own counter), its sound becomes an
 *   event → cue row; a spawn's `facing` left/right becomes a `yaw` of
 *   −90°/+90° (the direction the character already turned to); the session
 *   player's health fields (grace time, knockback, hit bounce and effect),
 *   which only the deleted session read, are dropped; `content.game: null`
 *   is dropped;
 * - game data is refused, never silently dropped (charter: content never
 *   loses behaviour without saying so): a non-null `content.game`, `enemy`,
 *   `gameZone`, `cameraFollow`, and the pickup forms that were game rules
 *   (a heart's healing, "respawn on death", an effect, a sound on a
 *   prefab). Each problem names the component and ends with
 *   `REMOVED_FROM_ENGINE`.
 */
import { isCounterName } from './counter-names';
import type { ModelErrorV3 } from './errors';

/**
 * The `project.json` schemaVersion this build writes (7: the engine owns the
 * view and scenes hold shots — no scene `camera` entity — and objects carry a
 * keep-loaded flag; the workspace's open upgrades a 6, see
 * `upgrade-scene-model.ts`, and older formats on the way).
 */
export const PROJECT_SCHEMA_VERSION = 7;
/** The format with a scene `camera` entity (`project.json` schemaVersion 6), upgraded to 7 on open (`upgradeSceneModel`). */
export const PROJECT_SCHEMA_VERSION_SCENE_CAMERA = 6;
/** The format with one project-wide look (`project.json` schemaVersion 5), upgraded to 6 on open (`upgradeSceneEnvironments`), then to 7. */
export const PROJECT_SCHEMA_VERSION_PROJECT_LOOK = 5;
/** The format whose asset versions were stored in `sources/sha256/` (`project.json` schemaVersion 4), upgraded to 5 on open (then to 6). */
export const PROJECT_SCHEMA_VERSION_V25 = 4;
/** The format without the genre layer (`project.json` schemaVersion 3), upgraded to 4 on load (`upgradeProjectDocsV25`), then on. */
export const PROJECT_SCHEMA_VERSION_V24 = 3;
/** The `project.json` schemaVersion `upgradeProjectDocsV24` upgrades (the format with the genre layer), then `upgradeProjectDocsV25`. */
export const PROJECT_SCHEMA_VERSION_UPGRADED = 2;

/** Whether the loader upgrades a project of this `project.json` schemaVersion (2 to 6). */
export function isUpgradedProjectSchemaVersion(v: unknown): v is 2 | 3 | 4 | 5 | 6 {
  return v === PROJECT_SCHEMA_VERSION_UPGRADED || v === PROJECT_SCHEMA_VERSION_V24 || v === PROJECT_SCHEMA_VERSION_V25 || v === PROJECT_SCHEMA_VERSION_PROJECT_LOOK || v === PROJECT_SCHEMA_VERSION_SCENE_CAMERA;
}

/** The tail every refusal of removed game data carries. */
export const REMOVED_FROM_ENGINE = 'removed from the engine: build it as project scripts';

/** The components deleted with the genre layer (what each did, for the problem text). */
export const REMOVED_COMPONENTS: Readonly<Record<string, string>> = Object.freeze({
  enemy: 'an enemy (patrol, contact damage, stomp)',
  gameZone: 'a game zone (hazard, checkpoint, goal or exit)',
  cameraFollow: 'the game session camera follow',
  pickup: 'a pickup',
});

/** The problem text for a removed component (`component_unknown`). */
export function removedComponentMessage(name: string): string {
  const what = REMOVED_COMPONENTS[name];
  return `component "${name}"${what !== undefined ? ` (${what})` : ''} was ${REMOVED_FROM_ENGINE}`;
}

/** Whether a component name is one of the removed game components. */
export function isRemovedComponent(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(REMOVED_COMPONENTS, name);
}

/** The session player's health fields only the deleted session read (dropped by the upgrade). */
const SESSION_HEALTH_FIELDS = ['invulnerableSeconds', 'knockback', 'hitBounce', 'knockbackTime', 'hitEffect'] as const;

/** Old pickup kind → the counter it added to (a heart healed instead: refused). */
const PICKUP_COUNTERS: Readonly<Record<string, string>> = Object.freeze({ coin: 'coins', gem: 'gems', key: 'keys', life: 'lives' });


export interface UpgradeV24Result {
  /** The upgraded documents (deep copies; the inputs are untouched). */
  content: unknown;
  scenes: unknown[];
  /** What the upgrade changed (for the problems log / upgrade notes). */
  notes: string[];
  /** Game data that is refused (the project does not open). */
  errors: ModelErrorV3[];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function seg(k: string): string {
  return k.replace(/~/g, '~0').replace(/\//g, '~1');
}

function refused(document: 'content' | 'scene', sceneId: string | undefined, path: string, message: string, found: unknown, code: ModelErrorV3['code'] = 'component_unknown'): ModelErrorV3 {
  return {
    code,
    path,
    message,
    expected: 'no game-rule data (the engine has no game rules)',
    found,
    document,
    ...(sceneId !== undefined ? { sceneId } : {}),
  } as ModelErrorV3;
}

/**
 * Upgrade a schemaVersion 2 project's raw content block and scene documents
 * to schemaVersion 3, the format without the genre layer (see the module
 * comment). Pure.
 */
export function upgradeProjectDocsV24(contentIn: unknown, scenesIn: readonly unknown[]): UpgradeV24Result {
  const content = JSON.parse(JSON.stringify(contentIn ?? null)) as unknown;
  const scenes = scenesIn.map((s) => JSON.parse(JSON.stringify(s ?? null)) as unknown);
  const notes: string[] = [];
  const errors: ModelErrorV3[] = [];
  const counts = new Map<string, number>();
  const count = (what: string): void => {
    counts.set(what, (counts.get(what) ?? 0) + 1);
  };
  const cues: Record<string, unknown>[] = [];

  if (isObject(content)) {
    if ('game' in content) {
      if (content['game'] === null) delete content['game'];
      else errors.push(refused('content', undefined, '/game', `content.game (the game block: player, camera, spawn, cues and timing) was ${REMOVED_FROM_ENGINE}`, typeof content['game'], 'field_unexpected'));
    }
    if (content['flow'] !== undefined) {
      errors.push(refused('content', undefined, '/flow', `content.flow (the level flow and its menus) was ${REMOVED_FROM_ENGINE} (menus: the game shell, content.shell)`, 'flow', 'field_unexpected'));
    }
  }

  const upgradeEntity = (e: unknown, path: string, document: 'content' | 'scene', sceneId: string | undefined, prefab: boolean): void => {
    if (!isObject(e) || !isObject(e['components'])) return;
    const comps = e['components'];
    const id = typeof e['id'] === 'string' ? e['id'] : undefined;
    for (const name of ['enemy', 'gameZone', 'cameraFollow'] as const) {
      if (comps[name] !== undefined) errors.push(refused(document, sceneId, `${path}/components/${name}`, removedComponentMessage(name), name));
    }
    const pickup = comps['pickup'];
    if (pickup !== undefined) {
      const p = `${path}/components/pickup`;
      const reasons: string[] = [];
      const kind = isObject(pickup) ? pickup['kind'] : undefined;
      let counter: string | undefined;
      if (kind === 'heart') reasons.push('a heart healed the player (use a collectible with an onCollect signal and ctx.health.heal)');
      else if (kind === 'custom') counter = isObject(pickup) && typeof pickup['counter'] === 'string' ? pickup['counter'] : 'custom';
      else if (typeof kind === 'string') counter = PICKUP_COUNTERS[kind];
      if (counter === undefined && kind !== 'heart') reasons.push(`its kind ${JSON.stringify(kind)} is not a known pickup kind`);
      if (counter !== undefined && !isCounterName(counter)) reasons.push(`its counter ${JSON.stringify(counter)} is not a counter name`);
      if (isObject(pickup) && pickup['respawn'] === 'death') reasons.push('it came back when the player died (a collectible comes back after seconds; a script calls ctx.collectible.restore)');
      if (isObject(pickup) && pickup['effect'] !== undefined) reasons.push('it played an effect when collected');
      const cue = isObject(pickup) ? pickup['cue'] : undefined;
      if (cue !== undefined && (prefab || id === undefined)) reasons.push('it played a sound from a prefab (an event → cue row names a scene object)');
      if (comps['collectible'] !== undefined) reasons.push('the object already has a collectible');
      if (!isObject(pickup)) reasons.push('it is not an object');
      if (reasons.length > 0) {
        errors.push(refused(document, sceneId, p, `${removedComponentMessage('pickup')} — ${reasons.join('; ')}`, 'pickup'));
      } else {
        const pk = pickup as Record<string, unknown>;
        const amount = pk['value'];
        const size = pk['size'];
        comps['collectible'] = {
          counter,
          ...(typeof amount === 'number' && amount !== 1 ? { amount } : {}),
          ...(Array.isArray(size) ? { size: [...(size as number[])] } : {}),
        };
        delete comps['pickup'];
        count('pickups became collectibles');
        if (typeof cue === 'string') {
          cues.push({ on: 'event', name: 'collected', entity: id, assetId: cue });
          count('pickup sounds became event → cue rows');
        }
      }
    }
    const health = comps['health'];
    if (isObject(health)) {
      let dropped = false;
      for (const k of SESSION_HEALTH_FIELDS) {
        if (health[k] !== undefined) {
          delete health[k];
          dropped = true;
        }
      }
      if (dropped) count('health components lost the session player fields (grace time, knockback, hit bounce, hit effect; only the deleted session read them)');
    }
    const spawn = comps['playerSpawn'];
    if (isObject(spawn) && 'facing' in spawn) {
      const facing = spawn['facing'];
      delete spawn['facing'];
      if (spawn['yaw'] === undefined && (facing === 'left' || facing === 'right')) {
        spawn['yaw'] = facing === 'right' ? 90 : -90;
        count('spawn facings became yaws');
      } else if (facing !== 'none' && facing !== undefined && facing !== 'left' && facing !== 'right') {
        errors.push(refused(document, sceneId, `${path}/components/playerSpawn/facing`, 'playerSpawn.facing is none, left or right (the upgrade makes it a yaw in degrees)', facing, 'field_value'));
      }
    }
  };

  scenes.forEach((s, si) => {
    if (!isObject(s) || !Array.isArray(s['entities'])) return;
    const sid = typeof s['sceneId'] === 'string' ? s['sceneId'] : `#${si}`;
    (s['entities'] as unknown[]).forEach((e, i) => upgradeEntity(e, `/entities/${i}`, 'scene', sid, false));
  });
  if (isObject(content) && Array.isArray(content['prefabs'])) {
    (content['prefabs'] as unknown[]).forEach((pf, pi) => {
      if (!isObject(pf) || !Array.isArray(pf['entities'])) return;
      (pf['entities'] as unknown[]).forEach((e, i) => upgradeEntity(e, `/prefabs/${pi}/entities/${i}`, 'content', undefined, true));
    });
  }
  if (cues.length > 0 && isObject(content)) {
    const table = Array.isArray(content['eventCues']) ? (content['eventCues'] as unknown[]) : [];
    content['eventCues'] = [...table, ...cues];
  }
  for (const [what, n] of counts) notes.push(`game-rules upgrade: ${n} ${what}`);
  return { content, scenes, notes, errors };
}
