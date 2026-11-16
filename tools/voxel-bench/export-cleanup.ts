/**
 * The export a bench run made, and only that one, removed when the run ends. An exported 8 km world is about
 * 1.1 GB, and every `coverage --export` used to leave one in the staging data root's exports folder. A folder
 * counts as made by this run only if it was not in the exports folder before the export call and the backend
 * named it as the call's output; anything else (a folder some earlier run made, an export passed with `--dir`)
 * is never touched.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

export class MadeExport {
  private readonly before: Set<string>;
  private made: string | null = null;

  /** Reads what the exports folder holds before the export call. */
  constructor(readonly root: string) {
    this.before = new Set(existsSync(root) ? readdirSync(root) : []);
  }

  /**
   * The backend's output folder for the call (its `outputDir`, relative to the exports folder). Returns the full
   * path; it is claimed for removal only when it is a direct child that did not exist before the call.
   */
  claim(outputDir: string): string {
    const full = resolve(this.root, outputDir);
    const rel = relative(resolve(this.root), full);
    const direct = rel !== '' && !rel.startsWith('..') && !rel.includes(sep);
    if (direct && !this.before.has(rel)) this.made = full;
    return full;
  }

  /**
   * When the call failed and named no folder: a folder of this project's that appeared since the call began (a
   * half-written export) is claimed, if exactly one did.
   */
  claimNew(prefix: string): string | null {
    if (this.made !== null || !existsSync(this.root)) return this.made;
    const fresh = readdirSync(this.root).filter((n) => n.startsWith(prefix) && !this.before.has(n));
    if (fresh.length === 1) this.made = join(this.root, fresh[0]!);
    return this.made;
  }

  /** The folder this run made, if any. */
  get path(): string | null {
    return this.made;
  }

  /** Removes the folder this run made (once); returns what was removed, or null. */
  remove(): string | null {
    const p = this.made;
    this.made = null;
    if (p === null || !existsSync(p)) return null;
    rmSync(p, { recursive: true, force: true });
    return p;
  }
}

/** The staging data root's exports folder. */
export function exportsRoot(dataRoot: string): string {
  return join(dataRoot, 'exports');
}
