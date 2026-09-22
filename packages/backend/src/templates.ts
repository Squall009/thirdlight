/**
 * Project templates: directories under `<engineRoot>/templates/<id>` and
 * `<engineRoot>/samples/<id>` holding `captured/project.json` (the v3 scene +
 * content) and the asset files the content references under `assets/`.
 * An optional `template.json` supplies `{ name, description }`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { resolveRequiredModules } from '@thirdlight/exporter';

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  /** Module ids the template declares it needs (`template.json`). */
  requiredModules: string[];
}

export interface TemplateSource {
  scene: unknown;
  content: unknown;
  blobs: ReadonlyMap<string, Uint8Array>;
  requiredModules: string[];
}

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const ROOTS = ['templates', 'samples'];

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
  try {
    const meta = JSON.parse(readFileSync(join(dir, 'template.json'), 'utf8')) as { name?: unknown; description?: unknown; requiredModules?: unknown };
    if (typeof meta.name === 'string') name = meta.name;
    if (typeof meta.description === 'string') description = meta.description;
    if (Array.isArray(meta.requiredModules)) requiredModules = meta.requiredModules.filter((m): m is string => typeof m === 'string');
  } catch {
    // no template.json: fall back to the game title
    try {
      const cap = JSON.parse(readFileSync(join(dir, 'captured', 'project.json'), 'utf8')) as { content?: { game?: { title?: unknown } } };
      if (typeof cap.content?.game?.title === 'string') name = cap.content.game.title;
    } catch {
      // keep the id
    }
  }
  return { id, name, description, requiredModules };
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
  return { ok: true, source: { scene: captured.scene, content: captured.content, blobs, requiredModules: readInfo(dir, id).requiredModules } };
}

/**
 * The template's declared dependencies resolved against this engine: the
 * module set, or what nobody provides (creation refuses).
 */
export function resolveTemplateModules(source: TemplateSource): ReturnType<typeof resolveRequiredModules> {
  const content = (source.content ?? {}) as { game?: unknown; behaviors?: Array<Record<string, unknown>> };
  const behaviors = (Array.isArray(content.behaviors) ? content.behaviors : [])
    .filter((b) => b['source'] !== null && b['source'] !== undefined)
    .map((b) => ({
      behaviorId: String(b['behaviorId']),
      requiredModules: ((b['source'] as Record<string, unknown>)['requiredModules'] as string[] | undefined) ?? [],
    }));
  return resolveRequiredModules({
    scene: source.scene as { entities?: Record<string, unknown>[] },
    game: content.game ?? null,
    behaviors,
    declared: source.requiredModules,
  });
}
