/**
 * Project templates: directories under `<engineRoot>/templates/<id>` laid
 * out as a game folder: `thirdlight/` holds the project's own files
 * (`project.json`, `content.json`, `scenes/`) in the current storage and
 * schema versions, and `assets/` the game files they name (models, their
 * `.tlasset` sidecars, resource files). A new project gets copies of both.
 * An optional `template.json` supplies `{ name, description, picture?,
 * packs?, requiredModules? }`: a picture file the project picker shows, and
 * the engine packs (`packs/<id>`) a new project gets. An optional
 * `setup/pack.json` (a pack whose id is the template's) makes the rest by
 * commands once the project exists (`packs.ts`).
 */
import { ID_RE } from '@thirdlight/project-model/limits';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';

import { resolveRequiredModules } from '@thirdlight/exporter';
import type { ProjectSource } from '@thirdlight/workspace';

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  /** Module ids the template declares it needs (`template.json`). */
  requiredModules: string[];
  /** The engine packs a new project gets (added after it is made, before the setup). */
  packs: string[];
  /** A picture of it as a data URL (absent: none), small enough to list (the picker shows it). */
  picture?: string;
}

/** The largest picture a template lists (bytes): a card's thumbnail, not a screenshot. */
export const TEMPLATE_PICTURE_MAX_BYTES = 64 * 1024;

const PICTURE_TYPES: Readonly<Record<string, string>> = { '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg' };

export interface TemplateSource extends ProjectSource {
  requiredModules: string[];
  packs: string[];
  /** The template's own setup pack's folder (absent: none). */
  setupDir?: string;
}
/** A template's project folder and the game folder its files name (beside it). */
const PROJECT_SUBDIR = 'thirdlight';
const GAME_SUBDIR = 'assets';

/** The engine ships templates only (no sample games). */
const ROOTS = ['templates'];

function templateDir(engineRoot: string, id: string): string | null {
  if (!ID_RE.test(id)) return null;
  for (const root of ROOTS) {
    const dir = join(engineRoot, root, id);
    if (existsSync(join(dir, PROJECT_SUBDIR, 'project.json'))) return dir;
  }
  return null;
}

function readInfo(dir: string, id: string): TemplateInfo {
  let name = id;
  let description = '';
  let requiredModules: string[] = [];
  let packs: string[] = [];
  let picture: string | undefined;
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8')) as { name?: unknown; description?: unknown; requiredModules?: unknown; packs?: unknown; picture?: unknown };
    if (typeof meta.name === 'string') name = meta.name;
    if (typeof meta.description === 'string') description = meta.description;
    if (Array.isArray(meta.requiredModules)) requiredModules = meta.requiredModules.filter((m): m is string => typeof m === 'string');
    if (Array.isArray(meta.packs)) packs = meta.packs.filter((m): m is string => typeof m === 'string' && ID_RE.test(m));
    const type = typeof meta.picture === 'string' && !meta.picture.includes('/') && !meta.picture.includes('\\') ? PICTURE_TYPES[extname(meta.picture).toLowerCase()] : undefined;
    if (type !== undefined) {
      const bytes = readFileSync(join(dir, meta.picture as string));
      if (bytes.length <= TEMPLATE_PICTURE_MAX_BYTES) picture = `data:${type};base64,${bytes.toString('base64')}`;
    }
  } catch {
    // no template.json (or no picture): keep the id
  }
  return { id, name, description, requiredModules, packs, ...(picture !== undefined ? { picture } : {}) };
}

export function listTemplates(engineRoot: string): TemplateInfo[] {
  const out: TemplateInfo[] = [];
  for (const root of ROOTS) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(engineRoot, root));
    } catch {
      continue;
    }
    for (const id of entries.sort()) {
      if (out.some((t) => t.id === id)) continue;
      const dir = templateDir(engineRoot, id);
      if (dir !== null) out.push(readInfo(dir, id));
    }
  }
  return out;
}

/** Every file under `root` by its path relative to `base` ('/'-separated). */
function readTree(root: string, base: string, into: Map<string, Uint8Array>): void {
  for (const name of readdirSync(root).sort()) {
    const p = join(root, name);
    const st = statSync(p);
    if (st.isDirectory()) readTree(p, base, into);
    else if (st.isFile()) into.set(relative(base, p).split(sep).join('/'), new Uint8Array(readFileSync(p)));
  }
}

export function loadTemplate(engineRoot: string, id: string): { ok: true; source: TemplateSource } | { ok: false; message: string } {
  const dir = templateDir(engineRoot, id);
  if (dir === null) return { ok: false, message: `no template "${id}"` };
  const project = new Map<string, Uint8Array>();
  const game = new Map<string, Uint8Array>();
  try {
    readTree(join(dir, PROJECT_SUBDIR), join(dir, PROJECT_SUBDIR), project);
    if (existsSync(join(dir, GAME_SUBDIR))) readTree(join(dir, GAME_SUBDIR), dir, game);
  } catch {
    return { ok: false, message: `template "${id}" has unreadable files` };
  }
  const info = readInfo(dir, id);
  const setupDir = join(dir, 'setup');
  return { ok: true, source: { project, game, requiredModules: info.requiredModules, packs: info.packs, ...(existsSync(join(setupDir, 'pack.json')) ? { setupDir } : {}) } };
}

/**
 * The template's declared dependencies resolved against this engine: the
 * module set, or what nobody provides (creation refuses).
 */
export function resolveTemplateModules(source: TemplateSource): ReturnType<typeof resolveRequiredModules> {
  const json = (bytes: Uint8Array | undefined): Record<string, unknown> => {
    try {
      const v = bytes === undefined ? null : (JSON.parse(new TextDecoder().decode(bytes)) as unknown);
      return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const content = (json(source.project.get('content.json'))['content'] ?? {}) as { behaviors?: Array<Record<string, unknown>> };
  const behaviors = (Array.isArray(content.behaviors) ? content.behaviors : [])
    .filter((b) => b['source'] !== null && b['source'] !== undefined)
    .map((b) => ({
      behaviorId: String(b['behaviorId']),
      requiredModules: ((b['source'] as Record<string, unknown>)['requiredModules'] as string[] | undefined) ?? [],
    }));
  // Every scene's objects: a module any of them needs is the project's.
  const entities = [...source.project]
    .filter(([rel]) => rel.startsWith('scenes/'))
    .flatMap(([, bytes]) => ((json(bytes)['scene'] as { entities?: Record<string, unknown>[] } | undefined)?.entities ?? []));
  return resolveRequiredModules({ scene: { entities }, behaviors, declared: source.requiredModules });
}
