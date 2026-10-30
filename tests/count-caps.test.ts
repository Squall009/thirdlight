/**
 * No per-project count cap on assets or resources (a project holds as many
 * as a game needs; only one file's size, one request's bytes and the
 * runtime's memory are bounded). This is the static half of the guard: no
 * limit the engine defines names how many assets or resources a project may
 * hold, found by name and by shape (a project-wide list or map of the
 * content descriptor with a most-items bound, and the validators taking far
 * more than any old cap). The other half (tests/e2e/count-caps.e2e.ts)
 * opens, edits, plays and exports a project above every cap the engine once
 * had.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as limits from '../packages/project-model/src/limits';
import { CONTENT } from '../packages/project-model/src/descriptor-content';
import type { FieldDescriptor } from '../packages/project-model/src/descriptor-types';
import { INPUT_ACTIONS_BOUND, INPUT_SETTINGS_MAX_BYTES, validateInput } from '../packages/project-model/src/input';
import { validateBehaviorGroups, validateModes } from '../packages/project-model/src/modes';
import { validateSaveSchema } from '../packages/project-model/src/save-schema';
import { validateShell } from '../packages/project-model/src/shell';
import { MAX_FRAME_ACTIONS, validateActionFrame } from '../packages/runtime/src/actions';
import { validateOpArgs } from '../packages/commands/src/validate-request';
import { validateInputStatus } from '../packages/runtime/src/input-status';

const REPO = resolve(import.meta.dirname, '..');

/** The kinds of assets and resources a project holds (as they appear in limit names). */
const KINDS = [
  'ASSETS', 'MODELS', 'TEXTURES', 'SOUNDS', 'MUSIC', 'FONTS', 'VERSION_RECORDS',
  'PREFABS', 'BEHAVIORS', 'SCRIPTS', 'SCENES', 'MATERIALS', 'ANIMATORS', 'TIMELINES',
  'UI_DOCUMENTS', 'DOCUMENTS', 'UI_THEMES', 'THEMES', 'DIALOGUES', 'SPEAKERS', 'EFFECTS',
  'GRAPHS', 'GRAPH_DOCUMENTS', 'LIBRARIES', 'SCRIPT_LIBRARIES', 'PRESETS', 'ENVIRONMENT_PRESETS',
  'CUES', 'EVENT_CUES', 'TRUST_ENTRIES', 'BLOCK_TYPES', 'STAMPS', 'BLOCK_STAMPS', 'THUMBNAILS',
];
/** `MAX_<kind>`, `MAX_<anything>_<kind>` (`MAX_AUDIO_ASSETS`), `<kind>_PER_PROJECT_MAX`, `MAX_<kind>_PER_PROJECT`. */
const COUNT_NAME = new RegExp(`^(MAX_([A-Z0-9]+_)*(${KINDS.join('|')})|(${KINDS.join('|')})_PER_PROJECT(_MAX)?|MAX_(${KINDS.join('|')})_PER_PROJECT)$`);
/** How many entities a whole project (or an editor session of it) may hold: `MAX_ENTITIES`, `SESSION_ENTITY_BOUND`, `ENTITIES_PER_PROJECT`. Per-scene and per-prefab bounds are not project-wide. */
const PROJECT_ENTITY_NAME = /^(MAX_(PROJECT_|SESSION_|TOTAL_)?ENTITIES|(PROJECT|SESSION|TOTAL)_ENTIT(Y|IES)_(BOUND|CAP|MAX|LIMIT)|ENTITIES_PER_PROJECT(_MAX)?|MAX_ENTITIES_PER_PROJECT)$/;
/**
 * Objects whose keys count what is inside one model file (a glTF's materials
 * and textures), not a project's: the same key names, a different scope.
 * Their values are a per-file question, never a project count cap.
 */
const PER_MODEL_FILE = new Set(['ASSET_METRIC_CAPS', 'M2_GLTF_PROFILE_LIMITS']);
const isCountName = (name: string): boolean => COUNT_NAME.test(name) || PROJECT_ENTITY_NAME.test(name);
/** The same kinds as keys of a `*_LIMITS` or `*_CAPS` object (`UI_LIMITS.documents`). */
const COUNT_KEY = /^(assets|models|textures|sounds|audio|music|fonts|versionRecords|prefabs|behaviors|scripts|scenes|materials|animators|timelines|uiDocuments|documents|uiThemes|themes|dialogues|speakers|effects|graphs|libraries|presets|cues|eventCues|trustEntries|blockTypes|stamps|projectKeyNumbers|totalBytes|behaviorModules|modules)$/;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

describe('no per-project count cap on assets or resources', () => {
  it('the limit names say so (a guard: it flags the caps the engine once had, and nothing else)', () => {
    for (const name of ['MAX_ASSETS', 'MAX_AUDIO_ASSETS', 'MAX_SCENES', 'MAX_MATERIALS', 'MAX_GRAPH_DOCUMENTS', 'MAX_VERSION_RECORDS', 'MAX_TRUST_ENTRIES', 'THUMBNAILS_PER_PROJECT_MAX', 'SESSION_ENTITY_BOUND', 'MAX_ENTITIES']) expect(isCountName(name), name).toBe(true);
    for (const name of ['MAX_ASSET_VERSIONS', 'MAX_PREFAB_ENTITIES', 'MAX_SCENE_ENTITIES', 'MAX_MATERIAL_SLOTS', 'MAX_TEXTURE_LAYERS', 'MAX_SCENE_DEPTH', 'MAX_CONTENT_FILE_BYTES', 'MAX_LOCAL_LIGHTS', 'SESSION_PAGE']) expect(isCountName(name), name).toBe(false);
    for (const key of ['documents', 'scenes', 'presets', 'libraries', 'projectKeyNumbers', 'behaviorModules']) expect(COUNT_KEY.test(key), key).toBe(true);
    for (const key of ['documentBytes', 'nodes', 'widgets', 'keys', 'hud']) expect(COUNT_KEY.test(key), key).toBe(false);
  });

  it('no limit the model exports counts a project\'s assets or resources', () => {
    const found: string[] = [];
    for (const [name, value] of Object.entries(limits)) {
      if (isCountName(name)) found.push(name);
      if (/_(LIMITS|CAPS)$/.test(name) && !PER_MODEL_FILE.has(name) && typeof value === 'object' && value !== null) {
        for (const key of Object.keys(value)) if (COUNT_KEY.test(key)) found.push(`${name}.${key}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('no package defines one either', () => {
    const found: string[] = [];
    const packages = join(REPO, 'packages');
    for (const pkg of readdirSync(packages)) {
      let files: string[];
      try {
        files = sourceFiles(join(packages, pkg, 'src'));
      } catch {
        continue;
      }
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/g)) {
          if (isCountName(m[1]!)) found.push(`${file.slice(REPO.length + 1)}: ${m[1]}`);
        }
        // Typed ones too (`const X_LIMITS: Readonly<…> = {`); a nested object is read up to its first `}`.
        for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*_(?:LIMITS|CAPS))\s*(?::[^=]+)?=\s*(?:Object\.freeze\()?\{([^}]*)\}/g)) {
          if (PER_MODEL_FILE.has(m[1]!)) continue;
          for (const k of m[2]!.matchAll(/(?:^|[,{\s])([a-zA-Z]+)\s*:/g)) if (COUNT_KEY.test(k[1]!)) found.push(`${file.slice(REPO.length + 1)}: ${m[1]}.${k[1]}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});

/**
 * The project-wide lists and maps of the content descriptor that may carry a
 * most-items bound, each with the reason it is not a count cap. Anything
 * else with one fails, whatever its limit is named.
 */
const BOUNDED_BY_A_REASON: Record<string, string> = {
  tags: 'a tag is one bit of the 32-bit mask objects carry and queries filter by',
  collisionLayers: 'a layer is one of the 16 bits of the physics engine\'s collision groups ("default" is the 16th)',
  lightLayers: 'a light layer is one bit of the masks objects and lights carry',
  'saveSchema.sections': 'distinct names from the engine\'s fixed list of save sections',
  cellFields: 'block-layer internals, left for the voxel phases that retire them',
};

/** `path: bound` of every list and map reached from `f` (at `path`) through objects only (a list's items are one record's, not the project's). */
function projectWideBounds(f: FieldDescriptor, path: string, out: string[]): void {
  if (f.type === 'object') for (const c of f.fields) projectWideBounds(c, `${path}.${c.key}`, out);
  else if (f.type === 'list' && f.maxItems !== undefined) out.push(`${path}: ${f.maxItems}`);
  else if (f.type === 'map' && f.maxEntries !== undefined) out.push(`${path}: ${f.maxEntries}`);
}

describe('no per-project count cap by shape', () => {
  it('no project-wide list or map of the content has a most-items bound without a reason', () => {
    const found: string[] = [];
    for (const block of CONTENT) projectWideBounds(block.value, block.key, found);
    const capped = found.filter((f) => BOUNDED_BY_A_REASON[f.slice(0, f.indexOf(':'))] === undefined);
    expect(capped).toEqual([]);
  });

  it('modes, behavior groups, input actions, maps and glyphs take far more than any old cap', () => {
    const errs = (fn: (e: unknown[]) => void): unknown[] => {
      const e: unknown[] = [];
      fn(e);
      return e;
    };
    const n = 300;
    const groups = Array.from({ length: n }, (_, i) => `g${i}`);
    const maps = Array.from({ length: n }, (_, i) => `m${i}`);
    const docs = Array.from({ length: n }, (_, i) => `hud-${i}`);
    const modes = Array.from({ length: n }, (_, i) => ({ modeId: `mode-${i}`, name: `Mode ${i}`, inputMaps: maps, groups, ui: docs }));
    expect(errs((e) => validateModes(modes, '/modes', e as never))).toEqual([]);
    expect(errs((e) => validateBehaviorGroups(groups, '/behaviorGroups', e as never))).toEqual([]);
    const actions = Array.from({ length: n }, (_, i) => ({ name: `a${i}`, type: 'button', map: maps[i % n], bindings: [{ kind: 'key', code: 'KeyA' }] }));
    const glyphs = Object.fromEntries(Array.from({ length: n }, (_, i) => [`key:K${i}`, 'texture-glyph']));
    const input = { actions, maps, glyphs, cursor: Object.fromEntries(maps.map((m) => [m, 'locked'])) };
    expect(errs((e) => validateInput(input, '/input', e as never))).toEqual([]);
    // What bounds them instead: the bytes of the one command that writes the settings.
    const huge = { actions: Array.from({ length: 2000 }, (_, i) => ({ name: `action_${i}`, type: 'button', map: 'gameplay', bindings: [{ kind: 'key', code: 'KeyA' }] })) };
    expect(JSON.stringify(huge).length).toBeGreaterThan(INPUT_SETTINGS_MAX_BYTES);
    expect(errs((e) => validateInput(huge, '/input', e as never)).map((x) => (x as { code: string }).code)).toEqual(['limits_exceeded']);
  });

  it('HUD documents, settings fields and save migrations take far more than any old cap', () => {
    const n = 300;
    const errs: unknown[] = [];
    validateShell({ hud: Array.from({ length: n }, (_, i) => `hud-${i}`) }, '/shell', errs as never);
    validateSaveSchema({
      version: n + 1,
      slots: 3,
      migrations: Array.from({ length: n }, (_, i) => ({ from: i + 1, name: `v${i + 1}` })),
      settings: Array.from({ length: n }, (_, i) => ({ key: `field_${i}`, type: 'number', default: i })),
    }, '/saveSchema', errs as never);
    expect(errs).toEqual([]);
  });

  it('a frame and an input status carry every action the input settings can name', () => {
    expect(MAX_FRAME_ACTIONS).toBe(INPUT_ACTIONS_BOUND);
    expect(INPUT_ACTIONS_BOUND).toBeGreaterThan(1000);
    const actions = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`a${i}`, { v: 1, p: 'held' }]));
    const frame = validateActionFrame({ stepIndex: 1, actions });
    expect(frame.ok, JSON.stringify(frame).slice(0, 200)).toBe(true);
    const status = validateInputStatus({ actions: Array.from({ length: 300 }, (_, i) => ({ name: `a${i}`, type: 'button', map: 'gameplay', bindings: [] })) });
    expect(status.ok, JSON.stringify(status).slice(0, 200)).toBe(true);
  });
});

/**
 * A count of the objects one command names (`DELETE_ENTITIES_MAX`,
 * `MAX_MOVE_ENTITIES`): a selection's size. A selection goes as one command,
 * one undo step, so only the request's bytes bound it; a count would make the
 * editor split it into several undo steps or refuse it. Containers bound
 * their own objects (one prefab's), and are listed with their reason.
 */
const SELECTION_NAME = /^(?:MAX_[A-Z0-9_]+_(?:ENTITIES|ENTITY_IDS|IDS|OBJECTS)|[A-Z0-9_]+_(?:ENTITIES|ENTITY_IDS|IDS|OBJECTS)_MAX)$/;
const NOT_A_SELECTION: Record<string, string> = {
  MAX_PREFAB_ENTITIES: 'the objects of one prefab (a container, as a scene\'s depth is)',
  REPEATED_ROW_ENTITY_IDS_MAX: 'the example objects one Problems row names',
};
const isSelectionCap = (name: string): boolean => SELECTION_NAME.test(name) && NOT_A_SELECTION[name] === undefined;

describe('no count on a selection one command names', () => {
  it('the names say so (a guard: it flags the per-command counts the engine once had)', () => {
    for (const name of ['DELETE_ENTITIES_MAX', 'SET_COMPONENT_ENTITIES_MAX', 'CREATE_ENTITIES_MAX', 'MOVE_ENTITIES_MAX', 'PASTE_ENTITIES_MAX', 'MAX_SELECTED_IDS']) expect(isSelectionCap(name), name).toBe(true);
    for (const name of ['MAX_PREFAB_ENTITIES', 'REPEATED_ROW_ENTITY_IDS_MAX', 'MAX_SCENE_DEPTH', 'MAX_REQUEST_BYTES']) expect(isSelectionCap(name), name).toBe(false);
  });

  it('no limit the model exports and no package constant counts one', () => {
    const found = Object.keys(limits).filter(isSelectionCap);
    const packages = join(REPO, 'packages');
    for (const pkg of readdirSync(packages)) {
      let files: string[];
      try {
        files = sourceFiles(join(packages, pkg, 'src'));
      } catch {
        continue;
      }
      for (const file of files) {
        for (const m of readFileSync(file, 'utf8').matchAll(/\bconst\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=/g)) if (isSelectionCap(m[1]!)) found.push(`${file.slice(REPO.length + 1)}: ${m[1]}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('delete, edit, create, move and paste each take 1,200 objects in one command, within one request\'s bytes', () => {
    const n = 1200;
    const ids = Array.from({ length: n }, (_, i) => `group-${String(i).padStart(6, '0')}`);
    const requests: [string, Record<string, unknown>][] = [
      ['deleteEntity', { entityId: ids[0], entityIds: ids.slice(1) }],
      ['setComponent', { entityId: ids[0], component: 'playerSpawn', value: {}, entityIds: ids.slice(1) }],
      ['createEntities', { entities: ids.map((_, i) => ({ kind: 'group', name: `g${i}` })) }],
      ['moveEntities', { entityIds: ids, parentId: null }],
      ['pasteEntities', { entities: ids.map((id) => ({ id, name: 'g', components: {} })) }],
    ];
    for (const [op, args] of requests) {
      expect(JSON.stringify(args).length, op).toBeLessThan(limits.MAX_REQUEST_BYTES);
      const r = validateOpArgs(op as Parameters<typeof validateOpArgs>[0], args);
      expect(r.ok, `${op}: ${JSON.stringify(r).slice(0, 300)}`).toBe(true);
    }
  });
});
