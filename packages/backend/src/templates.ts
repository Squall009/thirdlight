/**
 * Project templates: directories under `<engineRoot>/templates/<id>` holding
 * `captured/project.json` (the v3 scene +
 * content) and the asset files the content references under `assets/`.
 * An optional `template.json` supplies `{ name, description, picture?,
 * packs?, requiredModules? }`: a picture file the project picker shows, and
 * the engine packs (`packs/<id>`) a new project gets. An optional
 * `setup/pack.json` (a pack whose id is the template's) makes the rest by
 * commands once the project exists (`packs.ts`).
 */
import { ID_RE } from '@thirdlight/project-model/limits';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

import { physicsDimensionOf, resolveRequiredModules } from '@thirdlight/exporter';

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

export interface TemplateSource {
  scene: unknown;
  content: unknown;
  blobs: ReadonlyMap<string, Uint8Array>;
  requiredModules: string[];
  packs: string[];
  /** The template's own setup pack's folder (absent: none). */
  setupDir?: string;
}
/** The engine ships templates only (no sample games). */
const ROOTS = ['templates'];

function templateDir(engineRoot: string, id: string): string | null {
  if (!ID_RE.test(id)) return null;
  for (const root of ROOTS) {
    const dir = join(engineRoot, root, id);
    if (existsSync(join(dir, 'captured', 'project.json'))) return dir;
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

export function loadTemplate(engineRoot: string, id: string): { ok: true; source: TemplateSource } | { ok: false; message: string } {
  const dir = templateDir(engineRoot, id);
  if (dir === null) return { ok: false, message: `no template "${id}"` };
  let captured: { scene?: unknown; content?: unknown };
  try {
    captured = JSON.parse(readFileSync(join(dir, 'captured', 'project.json'), 'utf8')) as { scene?: unknown; content?: unknown };
  } catch {
    return { ok: false, message: `template "${id}" has an unreadable captured/project.json` };
  }
  const blobs = new Map<string, Uint8Array>();
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        const bytes = new Uint8Array(readFileSync(p));
        blobs.set(createHash('sha256').update(bytes).digest('hex'), bytes);
      }
    }
  };
  if (existsSync(join(dir, 'assets'))) walk(join(dir, 'assets'));
  const info = readInfo(dir, id);
  const setupDir = join(dir, 'setup');
  return { ok: true, source: { scene: captured.scene, content: captured.content, blobs, requiredModules: info.requiredModules, packs: info.packs, ...(existsSync(join(setupDir, 'pack.json')) ? { setupDir } : {}) } };
}

/**
 * The template's declared dependencies resolved against this engine: the
 * module set, or what nobody provides (creation refuses).
 */
export function resolveTemplateModules(source: TemplateSource): ReturnType<typeof resolveRequiredModules> {
  const content = (source.content ?? {}) as { behaviors?: Array<Record<string, unknown>>; settings?: unknown };
  const behaviors = (Array.isArray(content.behaviors) ? content.behaviors : [])
    .filter((b) => b['source'] !== null && b['source'] !== undefined)
    .map((b) => ({
      behaviorId: String(b['behaviorId']),
      requiredModules: ((b['source'] as Record<string, unknown>)['requiredModules'] as string[] | undefined) ?? [],
    }));
  return resolveRequiredModules({
    scene: source.scene as { entities?: Record<string, unknown>[] },
    behaviors,
    declared: source.requiredModules,
    // A 3D template needs the 3D backend.
    physicsDimension: physicsDimensionOf(content.settings),
  });
}
