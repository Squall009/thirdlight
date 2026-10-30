/**
 * The committed state of a ratchet list (tools/size-ratchet.json,
 * tools/docs-ratchet.json, tools/redefinition-ratchet.json).
 *
 * A ratchet entry may only shrink or go: `--update` lowers and drops entries
 * but never adds or raises one. A list is plain JSON, though, so an entry
 * added or raised by hand would pass a check that reads only the working
 * tree. Each check therefore also reads the list as HEAD has it: an entry it
 * lacks, or lists smaller, was not made by an update and fails. Outside a git
 * checkout of that root (a test workspace, an unpacked copy), or before the
 * list was first committed, there is nothing to compare and the check is
 * skipped.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20 });

/** The entries of `file` (relative to `root`) as HEAD has them, or null when there is no committed list to compare. */
export function committedEntries(root, file) {
  try {
    if (realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== realpathSync(root)) return null;
    const entries = JSON.parse(git(root, ['show', `HEAD:${file}`])).entries;
    return Array.isArray(entries) ? entries : null;
  } catch {
    return null;
  }
}

/**
 * The entries not made by an update: `{ entry, problem: 'added' }` for one the committed list lacks and
 * `{ entry, problem: 'raised', size }` (size: the committed one) for one listed larger than committed.
 * `keyOf` names an entry; entries without a `size` are only checked for being added.
 */
export function handEdits(entries, committed, keyOf) {
  if (committed === null) return [];
  const before = new Map(committed.map((e) => [keyOf(e), e]));
  const out = [];
  for (const entry of entries) {
    const was = before.get(keyOf(entry));
    if (was === undefined) out.push({ entry, problem: 'added' });
    else if (typeof entry.size === 'number' && typeof was.size === 'number' && entry.size > was.size) out.push({ entry, problem: 'raised', size: was.size });
  }
  return out;
}

/** One hand edit as a line of a check's output. */
export function handEditText(where, { problem, size }, file) {
  return problem === 'added'
    ? `${where}: not in the committed ${file}; an entry is never added by hand (split or import instead; --update only lowers and drops)`
    : `${where}: listed above the committed ${file} (${size}); an entry is never raised by hand`;
}
