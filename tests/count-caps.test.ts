/**
 * No per-project count cap on assets or resources (a project holds as many
 * as a game needs; only one file's size and the runtime's memory are
 * bounded). This is the static half of the guard: no limit the engine
 * defines names how many assets or resources a project may hold. The other
 * half (tests/e2e/count-caps.e2e.ts) opens, edits, plays and exports a
 * project above every cap the engine once had.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import * as limits from '../packages/project-model/src/limits';

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
