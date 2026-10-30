#!/usr/bin/env node
/**
 * Redefinition check. A helper that more than one package needs has one home
 * (the shared leaf for generic algorithms, project-model for domain
 * constants); a second definition drifts from the first, and two copies of a
 * digest or a seeded generator that drift change content digests and saved
 * worlds. So the names below are owned: defining one anywhere but its owner
 * fails the build.
 *
 * A definition is a function, class or variable declaration with an owned
 * name, at any depth (a variable that only aliases another binding, such as
 * `const sha256Hex = sha256HexAsync`, is not a copy). Families whose copies
 * go by many names also carry fingerprints: a numeric constant only that
 * algorithm uses (mulberry32's increment, the CRC-32 polynomial, SHA-256's
 * first round constant). A file that holds a fingerprint but no named
 * definition of the family counts as one copy, listed as `<family> fingerprint`.
 *
 * Copies that exist today are named in the ratchet list (RATCHET_FILE). It
 * only shrinks: the check fails on a copy not on the list, and on a listed
 * copy that is gone (drop its entry with --update). Entries for files in the
 * areas the voxel world retires carry `retired: true`; those files keep their
 * copies until they are deleted with their area.
 *
 * Usage: node tools/check-redefinitions.mjs            (check; exit 1 on a violation)
 *        node tools/check-redefinitions.mjs --update   (drop entries that are gone; never adds)
 *        node tools/check-redefinitions.mjs --list     (every copy found, by family)
 */

import ts from 'typescript';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { checkedFiles } from './check-size.mjs';

/** The ratchet list, relative to the workspace root. */
export const RATCHET_FILE = 'tools/redefinition-ratchet.json';

/** This tool names the fingerprints, so it is not scanned itself. */
const SELF = 'tools/check-redefinitions.mjs';

/**
 * The owned names, by family. `owner`: the one file that may define them (it
 * need not exist yet: until a family moves there, every copy is on the
 * ratchet list). `names`: the identifiers copies use. `fingerprints`: numeric
 * constants that mark a copy whatever it is called.
 */
export const OWNED_FAMILIES = Object.freeze([
  {
    family: 'sha256',
    owner: 'packages/shared/src/sha256.ts',
    names: ['sha256Hex', 'sha256HexOfText', 'sha256HexAsync', 'sha256Words'],
    // The first round constant K[0].
    fingerprints: [0x428a2f98],
  },
  {
    family: 'canonical-json',
    owner: 'packages/shared/src/canonical-json.ts',
    names: [
      'canonicalJson',
      'canonicalJsonText',
      'canonicalJsonTextStrict',
      'canonicalJsonKey',
      'canonicalJsonUtf16',
      'canonicalJsonValue',
      'indentedJsonText',
      'canonicalize',
      'compareCodePoints',
    ],
  },
  {
    family: 'utf8',
    owner: 'packages/shared/src/utf8.ts',
    names: ['utf8Encode', 'utf8Decode', 'utf8Length', 'utf8ByteLength', 'utf8LengthPairingAnyHigh', 'utf8LengthPairingHigh'],
  },
  {
    family: 'crc32',
    owner: 'packages/shared/src/crc32.ts',
    names: ['crc32'],
    // The reflected CRC-32 polynomial.
    fingerprints: [0xedb88320],
  },
  {
    family: 'seeded-random',
    owner: 'packages/shared/src/random.ts',
    names: ['mulberry32', 'seededRandom'],
    // mulberry32's state increment.
    fingerprints: [0x6d2b79f5],
  },
  {
    family: 'value-noise',
    owner: 'packages/shared/src/noise.ts',
    names: ['valueNoise', 'valueNoise01', 'fractalNoise01', 'terrainNoise', 'latticeHash', 'latticeHash4', 'seedCellHash', 'tileHash', 'NOISE_HASH_LANES'],
    // The lattice hash's x lane multiplier, which the brushes', ground cover's, wind's and camera shake's hashes share.
    fingerprints: [0x27d4eb2d],
  },
  { family: 'quaternion', owner: 'packages/shared/src/quat.ts', names: ['mulQuat', 'quatMul', 'quatMultiply', 'multiplyQuat', 'quatFromRotation'] },
  {
    family: 'mat4',
    owner: 'packages/shared/src/mat4.ts',
    names: ['mulMat4', 'mat4Multiply', 'multiplyMat4', 'invertMat4', 'composeMat4', 'decomposeMat4'],
  },
  {
    family: 'glb-container',
    owner: 'packages/shared/src/glb.ts',
    names: ['glbChunks', 'readGlb', 'parseGlb', 'splitGlb', 'glbJson', 'writeGlb', 'glbBytes', 'GLB_MAGIC', 'GLB_CHUNK_JSON', 'GLB_CHUNK_BIN', 'CHUNK_JSON', 'CHUNK_BIN'],
    // The JSON chunk type: every reader and writer of the container names it.
    fingerprints: [0x4e4f534a],
  },
  {
    family: 'image-signatures',
    owner: 'packages/shared/src/image-signatures.ts',
    names: ['PNG_SIGNATURE', 'KTX2_IDENTIFIER', 'KTX2_ID', 'isPng', 'isKtx2', 'isKtx2Bytes', 'hasPngSignature', 'hasKtx2Signature'],
  },
  { family: 'png-writer', owner: 'packages/shared/src/png.ts', names: ['pngChunk', 'pngBytes'] },
  {
    family: 'objects',
    owner: 'packages/shared/src/objects.ts',
    names: ['isPlainObject', 'isPlainObjectStrict', 'isPlainRecord', 'isRecord', 'isObject', 'isObj', 'isPlain', 'isRow', 'isMap', 'deepFreeze', 'deepFreezeAll', 'deepFreezeExceptViews', 'deepFreezeForTest'],
  },
  { family: 'lru', owner: 'packages/shared/src/lru.ts', names: ['LruCache', 'LRUCache', 'LruMap', 'BoundedLru'] },
  { family: 'strict-json', owner: 'packages/shared/src/strict-json.ts', names: ['parseStrictJson', 'strictJson'] },
  {
    family: 'digest-format',
    owner: 'packages/project-model/src/content-helpers.ts',
    names: ['DIGEST_RE', 'isDigest', 'PREPARED_DIGEST_RE', 'SOURCE_DIGEST_PATTERN'],
  },
  { family: 'request-id-format', owner: 'packages/project-model/src/request-id.ts', names: ['REQUEST_ID_RE'] },
]);

/**
 * The areas the voxel world retires (block layers, terrain, the architecture
 * generator's meshes and colliders, and their specs): their files keep their
 * copies until they are deleted, so their entries are marked rather than moved.
 */
export const RETIRED_AREAS = Object.freeze([
  /(^|\/)blocks?[-.]/,
  /(^|\/)block-/,
  /(^|\/)terrain[-.]/,
  /(^|\/)architecture[-.]/,
  /(^|\/)arch-/,
  /(^|\/)spline-mesh\./,
]);

/** Whether a path lies in an area the voxel world retires. */
export function isRetired(file) {
  return RETIRED_AREAS.some((re) => re.test(file));
}

function scriptKind(file) {
  if (file.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.(?:js|mjs|cjs)$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const byName = new Map(OWNED_FAMILIES.flatMap((f) => f.names.map((n) => [n, f])));
const byFingerprint = new Map(OWNED_FAMILIES.flatMap((f) => (f.fingerprints ?? []).map((v) => [v, f])));

/** True when a variable only names another binding (an alias or re-binding, not a copy). */
function isAlias(init) {
  return init !== undefined && (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init));
}

/**
 * The owned definitions in one source text: `[{ name, family, line }]`, a
 * fingerprint-only copy as `{ name: '<family> fingerprint' }`. The owner file's
 * own definitions are left out.
 */
export function definitionsIn(text, file) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const named = [];
  const printed = new Map();
  const visit = (node) => {
    let id;
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) id = node.name;
    else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && !isAlias(node.initializer)) id = node.name;
    if (id && byName.has(id.text)) named.push({ name: id.text, family: byName.get(id.text).family, line: lineOf(node) });
    if (ts.isNumericLiteral(node)) {
      const fam = byFingerprint.get(Number(node.text.replaceAll('_', '')));
      if (fam && !printed.has(fam.family)) printed.set(fam.family, lineOf(node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const out = [...named];
  for (const [family, line] of printed) {
    if (!named.some((d) => d.family === family)) out.push({ name: `${family} fingerprint`, family, line });
  }
  const owners = new Set(OWNED_FAMILIES.filter((f) => f.owner === file).map((f) => f.family));
  return out.filter((d) => !owners.has(d.family));
}

/** Every copy under `root`: `[{ file, name, family, line }]`, sorted by file then name. */
export function findCopies(root) {
  const out = [];
  for (const file of checkedFiles(root)) {
    if (file === SELF) continue;
    for (const d of definitionsIn(readFileSync(join(root, file), 'utf8'), file)) out.push({ file, ...d });
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name) || a.line - b.line);
}

const keyOf = (e) => `${e.file}\u0000${e.name}`;

/**
 * The copies found against the ratchet entries (`[{ file, name, retired? }]`):
 * `{ problems: [{ entry, problem: 'new' | 'stale' | 'marker', line? }], updated }`.
 * Two copies of one name in one file are one entry (the file is what moves).
 */
export function compareRatchet(found, entries) {
  const foundKeys = new Map();
  for (const e of found) if (!foundKeys.has(keyOf(e))) foundKeys.set(keyOf(e), e);
  const listed = new Set();
  const problems = [];
  const updated = [];
  for (const entry of entries) {
    const key = keyOf(entry);
    listed.add(key);
    if (!foundKeys.has(key)) {
      problems.push({ entry, problem: 'stale' });
      continue;
    }
    const retired = isRetired(entry.file);
    if (Boolean(entry.retired) !== retired) problems.push({ entry, problem: 'marker' });
    updated.push(retired ? { file: entry.file, name: entry.name, retired: true } : { file: entry.file, name: entry.name });
  }
  for (const [key, e] of foundKeys) {
    if (!listed.has(key)) problems.push({ entry: { file: e.file, name: e.name }, problem: 'new', line: e.line, family: e.family });
  }
  return { problems, updated };
}

/** One violation as a line of the check's output. */
export function problemText({ entry, problem, line, family }) {
  switch (problem) {
    case 'new': {
      const owner = OWNED_FAMILIES.find((f) => f.family === family)?.owner;
      return `${entry.file}:${line}: '${entry.name}' is defined again; import it from its owner ${owner} (if the boundary rules forbid that, change the rule in its own commit; never copy)`;
    }
    case 'marker':
      return `${entry.file}: '${entry.name}' — its retired marker must say whether the file lies in a retired area; run node tools/check-redefinitions.mjs --update`;
    default:
      return `${entry.file}: '${entry.name}' is no longer defined there; drop its entry: node tools/check-redefinitions.mjs --update`;
  }
}

/** Reads the ratchet list under `root` (an absent file is an empty list). */
export function readRatchet(root) {
  let text;
  try {
    text = readFileSync(join(root, RATCHET_FILE), 'utf8');
  } catch {
    return [];
  }
  return JSON.parse(text).entries;
}

/** Writes the ratchet list: one entry per line, sorted, so a change reads as a one-line diff. */
export function writeRatchet(root, entries) {
  const sorted = [...entries].sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  const lines = sorted.map((e) => `    ${JSON.stringify(e)}`);
  mkdirSync(dirname(join(root, RATCHET_FILE)), { recursive: true });
  writeFileSync(join(root, RATCHET_FILE), `{\n  "entries": [\n${lines.join(',\n')}\n  ]\n}\n`);
}

/** The check over a workspace root: `{ found, problems, updated }`. */
export function checkRedefinitions(root) {
  const found = findCopies(root);
  return { found, ...compareRatchet(found, readRatchet(root)) };
}

function main(argv) {
  const root = process.cwd();
  if (argv.includes('--list')) {
    for (const e of findCopies(root)) console.log(`${e.family.padEnd(18)} ${e.file}:${e.line}  ${e.name}${isRetired(e.file) ? '  (retired area)' : ''}`);
    return 0;
  }
  const { found, problems, updated } = checkRedefinitions(root);
  if (argv.includes('--update')) {
    writeRatchet(root, updated);
    const left = problems.filter((p) => p.problem === 'new');
    for (const p of left) console.error(`check-redefinitions: ${problemText(p)}`);
    console.log(`check-redefinitions: ${RATCHET_FILE} updated (${updated.length} entries)`);
    return left.length > 0 ? 1 : 0;
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`check-redefinitions: ${problemText(p)}`);
    console.error(`check-redefinitions: FAIL — ${problems.length} problem(s). Owned helpers are defined once; ${RATCHET_FILE} lists today's copies and only shrinks.`);
    return 1;
  }
  const retired = updated.filter((e) => e.retired).length;
  console.log(`check-redefinitions: OK — ${found.length} definition(s) of owned names outside their owners, each on the ratchet list (${updated.length} entries, ${retired} in retired areas).`);
  return 0;
}

// Realpath-based, so a symlinked or relative tool path still runs the check.
function isMain() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) process.exit(main(process.argv.slice(2)));
