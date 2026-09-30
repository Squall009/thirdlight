/**
 * The ids scripts name as string literals (`ctx.audio.play("door-open")`).
 *
 * Code is the one place the model cannot see a reference, so it is read as
 * text: every quoted string in a published behavior's source container (a
 * visual script's generated source too) and in each script library file.
 * A mention inside quotes in a comment counts too (the safe side).
 *
 * Two rules read it: an asset or prefab a script names is not deleted, and a
 * script that names an asset which is not loadable (no address, no label)
 * is a Problem, since a build ships only what scenes reference and what is
 * loadable.
 */
import { isLoadable, type ContentCatalogV4 } from '@thirdlight/project-model';
import type { ContentDocument } from '@thirdlight/commands';

/** One script's text and where it is (for the messages). */
interface ScriptText {
  readonly path: string;
  readonly document: string;
  /** Names the script for a person: `script door` or `library ui (hud.ts)`. */
  readonly label: string;
  readonly digest: string | null;
  readonly text: () => string | null;
}

type Read = (digest: string) => Uint8Array | null;
type ContentLike = ContentDocument | ContentCatalogV4;

function scriptTexts(read: Read, content: ContentLike): ScriptText[] {
  const out: ScriptText[] = [];
  const decoder = new TextDecoder();
  (content.behaviors as readonly { behaviorId: string; source?: { sourceDigest?: string } | null }[]).forEach((b, i) => {
    const digest = b.source?.sourceDigest;
    if (digest === undefined) return;
    out.push({
      path: `/behaviors/${i} (script ${b.behaviorId})`,
      document: 'content',
      label: `script ${b.behaviorId}`,
      digest,
      text: () => {
        const bytes = read(digest);
        return bytes === null ? null : decoder.decode(bytes);
      },
    });
  });
  const libraries = (content as { scriptLibraries?: { libraryId: string; files: { path: string; text: string }[] }[] }).scriptLibraries ?? [];
  libraries.forEach((lib, i) => {
    lib.files.forEach((f, j) => {
      out.push({ path: `/scriptLibraries/${i}/files/${j} (library ${lib.libraryId}, ${f.path})`, document: 'content', label: `library ${lib.libraryId} (${f.path})`, digest: null, text: () => f.text });
    });
  });
  return out;
}

/**
 * The quoted strings of a text that could be ids: a quote, then no quote,
 * backslash or white space, then a quote (which may be escaped, as inside a
 * source container's JSON: `\"crate\"`).
 */
const LITERAL_RE = /['"`]([^'"`\\\s]{1,128})(?=\\?['"`])/g;

export function literalsIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(LITERAL_RE)) out.add(m[1]!);
  return out;
}

/** The scripts whose source names `id` as a string literal (an unreadable source is skipped). */
export function scriptsNaming(read: Read, content: ContentLike, id: string): { path: string; document: string }[] {
  const out: { path: string; document: string }[] = [];
  for (const s of scriptTexts(read, content)) {
    const text = s.text();
    if (text !== null && literalsIn(text).has(id)) out.push({ path: s.path, document: s.document });
  }
  return out;
}

/**
 * Every asset some script names, with the scripts that name it (ascending by
 * asset id). `cache` keeps a source container's literals by digest, so a
 * check after each edit reads only the scripts that changed.
 */
export function scriptNamedAssets(read: Read, content: ContentLike, cache?: Map<string, Set<string>>): { assetId: string; loadable: boolean; scripts: string[] }[] {
  const assets = new Map((content.assets as readonly { assetId: string; address?: string; labels?: readonly string[] }[]).map((a) => [a.assetId, a]));
  const named = new Map<string, string[]>();
  for (const s of scriptTexts(read, content)) {
    let literals = s.digest !== null ? cache?.get(s.digest) : undefined;
    if (literals === undefined) {
      const text = s.text();
      if (text === null) continue;
      literals = literalsIn(text);
      if (s.digest !== null) cache?.set(s.digest, literals);
    }
    for (const id of literals) {
      if (!assets.has(id)) continue;
      const list = named.get(id) ?? [];
      list.push(s.label);
      named.set(id, list);
    }
  }
  return [...named.keys()].sort().map((assetId) => ({ assetId, loadable: isLoadable(assets.get(assetId)!), scripts: named.get(assetId)! }));
}
