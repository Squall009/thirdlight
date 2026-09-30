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
/** The same kinds as keys of a `*_LIMITS` object (`UI_LIMITS.documents`). */
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
    for (const name of ['MAX_ASSETS', 'MAX_AUDIO_ASSETS', 'MAX_SCENES', 'MAX_MATERIALS', 'MAX_GRAPH_DOCUMENTS', 'MAX_VERSION_RECORDS', 'MAX_TRUST_ENTRIES', 'THUMBNAILS_PER_PROJECT_MAX']) expect(COUNT_NAME.test(name), name).toBe(true);
    for (const name of ['MAX_ASSET_VERSIONS', 'MAX_PREFAB_ENTITIES', 'MAX_MATERIAL_SLOTS', 'MAX_TEXTURE_LAYERS', 'MAX_SCENE_DEPTH', 'MAX_CONTENT_FILE_BYTES', 'MAX_LOCAL_LIGHTS']) expect(COUNT_NAME.test(name), name).toBe(false);
    for (const key of ['documents', 'scenes', 'presets', 'libraries', 'projectKeyNumbers', 'behaviorModules']) expect(COUNT_KEY.test(key), key).toBe(true);
    for (const key of ['documentBytes', 'nodes', 'widgets', 'keys', 'hud']) expect(COUNT_KEY.test(key), key).toBe(false);
  });

  it('no limit the model exports counts a project\'s assets or resources', () => {
    const found: string[] = [];
    for (const [name, value] of Object.entries(limits)) {
      if (COUNT_NAME.test(name)) found.push(name);
      if (/_LIMITS$/.test(name) && typeof value === 'object' && value !== null) {
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
          if (COUNT_NAME.test(m[1]!)) found.push(`${file.slice(REPO.length + 1)}: ${m[1]}`);
        }
        for (const m of text.matchAll(/\bconst\s+([A-Z][A-Z0-9_]*_LIMITS)\s*=\s*(?:Object\.freeze\()?\{([^}]*)\}/g)) {
          for (const k of m[2]!.matchAll(/(?:^|[,{\s])([a-zA-Z]+)\s*:/g)) if (COUNT_KEY.test(k[1]!)) found.push(`${file.slice(REPO.length + 1)}: ${m[1]}.${k[1]}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
