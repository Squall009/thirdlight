/**
 * Golden values of the helpers several packages define today, taken before
 * any of them moves to its one home (tools/check-redefinitions.mjs names the
 * owners). Content digests and saved worlds hang on these bytes: a stored
 * digest must still match its file, a seed must still draw the same numbers
 * and a noise must still give the same field. Every copy is compared, and
 * copies that already differ are kept apart as named variants, each with its
 * own golden, so a move can only merge copies that were the same.
 *
 * A sequence's golden is the SHA-256 of its float64 values (little-endian),
 * so a change in the last bit fails.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as assetPipeline from '../packages/asset-pipeline/src/sha256';
import * as behaviorBuild from '../packages/behavior-build/src/canonical';
import * as projectModel from '../packages/project-model/src/sha256';
import * as workspace from '../packages/workspace/src/digest';
import { canonicalJson as exporterCanonicalJson } from '../packages/exporter/src/canonical';
import { canonicalJson as prefabCanonicalJson } from '../packages/project-model/src/prefab-relink';
import { Rng } from '../packages/effects/src/rng';
import { seededRandom } from '../packages/project-model/src/arch-math';
import { prng } from '../packages/editor/src/session/instances';
import { fractalNoise01, terrainNoise, valueNoise01 } from '../packages/project-model/src/value-noise';
import { ruleNoise } from '../packages/project-model/src/surface-rules';
import { brushHash } from '../packages/project-model/src/instance-brush';
import { shakeNoise } from '../packages/runtime/src/camera-rig';
import { coverRandom } from '../packages/three-adapter/src/cover-placement';
import { makeWindNoise } from '../packages/three-adapter/src/wind-field';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const reference = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const digestOf = (values: ArrayLike<number>): string => reference(new Uint8Array(Float64Array.from(values).buffer));

/** Every synchronous SHA-256 copy over bytes, by where it lives. */
const SHA256_COPIES: Record<string, (bytes: Uint8Array) => string> = {
  'asset-pipeline': assetPipeline.sha256Hex,
  'behavior-build': behaviorBuild.sha256Hex,
  'project-model': projectModel.sha256Hex,
  workspace: workspace.sha256Hex,
};
/** Every SHA-256-of-text copy. */
const SHA256_TEXT_COPIES: Record<string, (text: string) => string> = {
  'asset-pipeline': assetPipeline.sha256HexOfText,
  'behavior-build': behaviorBuild.sha256HexOfText,
  'project-model': projectModel.sha256HexOfText,
};

/** Content-addressed files in the committed fixtures: each file is named by its digest. */
function contentAddressed(): { path: string; digest: string }[] {
  const out: { path: string; digest: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\/sha256\/[0-9a-f]{64}$/.test(p)) out.push({ path: p, digest: e.name });
    }
  };
  walk(join(ROOT, 'fixtures'));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Asset sidecars and the source digests they store (the importer's record of each file; a version without a source path keeps its bytes in the content-addressed store). */
const SIDECARS = [
  'fixtures/phase26/legacy-v4-build/project/assets/Beep.wav.tlasset',
  'fixtures/phase26/legacy-v4-build/project/assets/Crate.glb.tlasset',
  'fixtures/phase26/legacy-v4-build/project/assets/Wall-checker.png.tlasset',
  'templates/starter/assets/Character.glb.tlasset',
  'templates/starter/assets/Pillar.glb.tlasset',
  'templates/starter-3d/assets/Character.glb.tlasset',
];
function sidecarDigests(): { path: string; digest: string }[] {
  return SIDECARS.flatMap((rel) => {
    const sidecar = JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as { record: { versions: { sourceDigest: string; sourcePath?: string }[] } };
    return sidecar.record.versions.flatMap((v) => (v.sourcePath === undefined ? [] : [{ path: join(ROOT, dirname(rel), '..', v.sourcePath), digest: v.sourceDigest }]));
  });
}

/** Lengths around SHA-256's padding boundaries, and one large buffer, with their digests. */
const PADDING_LENGTHS = [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 1000, 1 << 20];
const patterned = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 31 + (i >> 8)) & 255);
const PADDING_GOLDENS: Record<number, string> = {
  0: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  1: '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  3: '94e1c77d23e949c5fe5b5309709054b595ae0ddd29b86b0b4f89ba8a7de870fe',
  55: '27d3069ecafb8507f92fa750312a99afe0908525e67b2abe8942b51659945b1b',
  56: '3428ab653c0a1ac104ee80fd3bed55135da5556ca4c26da9c781ae56364a6969',
  57: '28c22b1d4fc34c26ca51d137ec64373fc16b38e32cef9c6759f910fc628efee1',
  63: 'b5ec25bd1c4b7c94c9ea9d235272e43f644f561d7c8c7e58ec5fa9aefe95ef07',
  64: 'a08f82c23e6c13629d8e33d0d2a13005fb104363eb793b5e8842044951d27764',
  65: 'c0a0263ae1ab4e9dda9cd2ed6c44b23ee6ff75c90c640185f462fad7f24fcd6f',
  119: 'b4639d08cdba917a7875088b4e05633a7812e14282482de937915c9799b17250',
  120: 'e4fce14f6aa99657bdffe9f1da59ce85f0398479e9af7e9de6ccf53e174447ab',
  127: 'c3328af00588e4c0de651212baf4babe06a69afd3a41320daf2508bd5290fc9e',
  128: '8bb5dfd6ac2a606ce25701c19ed1fe8fa3a1a7355cd7fe3445ac3e2cc7a45359',
  1000: '04a2a26617da9ddbb0b64cec2b6079d2cd760cf70691de063552c06ea8d153e2',
  1048576: 'f6a34d4c79c3d12c297589206bf216b084347471a53ea5e7fe9a46bd1230f098',
};

/** Texts across the UTF-8 widths (one, two, three and four bytes, and a lone surrogate). */
const TEXTS = ['', 'abc', 'héllo wörld', '世界 – “quotes”', 'clef 𝄞 and 😀', 'lone \ud800 surrogate'];
const TEXT_GOLDENS: Record<string, string> = {
  "": 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  "abc": 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  "h\u00e9llo w\u00f6rld": 'a1003f7d04a4115711d0b48a2eaf1359ce565d2d2a6fd65098dfcffadeeef59f',
  "\u4e16\u754c \u2013 \u201cquotes\u201d": '30b99b9968e6406e01430b4af089f5f1b721860ac633a32af00916b66ef41bb4',
  "clef \ud834\udd1e and \ud83d\ude00": '1c7fb02e7f5407a0b59b043b8abc034593ff496d790ad397bea2016af9672c8f',
  "lone \ud800 surrogate": 'dc12673580894e234a7f878d6c2c065ca6a14fe3833c4545417dacb2e196fe2c',
};

describe('SHA-256: every copy gives the stored digests', () => {
  it('matches every content-addressed fixture file and every asset sidecar\'s source digest', () => {
    const files = [...contentAddressed(), ...sidecarDigests()];
    expect(files.length).toBeGreaterThanOrEqual(11);
    for (const { path, digest } of files) {
      const bytes = new Uint8Array(readFileSync(path));
      for (const [where, sha] of Object.entries(SHA256_COPIES)) expect(sha(bytes), `${where} over ${path}`).toBe(digest);
    }
  });

  it('matches the goldens at the padding boundaries and over a large buffer', async () => {
    for (const n of PADDING_LENGTHS) {
      const bytes = patterned(n);
      expect(reference(bytes), `node:crypto, ${n} bytes`).toBe(PADDING_GOLDENS[n]);
      for (const [where, sha] of Object.entries(SHA256_COPIES)) expect(sha(bytes), `${where}, ${n} bytes`).toBe(PADDING_GOLDENS[n]);
      expect(await projectModel.sha256HexAsync(bytes), `project-model async, ${n} bytes`).toBe(PADDING_GOLDENS[n]);
    }
  });

  it('hashes text as its UTF-8 bytes (a lone surrogate as U+FFFD)', () => {
    for (const text of TEXTS) {
      expect(reference(text), `node:crypto ${JSON.stringify(text)}`).toBe(TEXT_GOLDENS[text]);
      for (const [where, sha] of Object.entries(SHA256_TEXT_COPIES)) expect(sha(text), `${where} ${JSON.stringify(text)}`).toBe(TEXT_GOLDENS[text]);
    }
  });

  it('gives a manifest\'s stored settings and media digests', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'fixtures/phase26/legacy-v4-build/build/manifest.json'), 'utf8')) as Record<string, unknown>;
    for (const block of ['settings', 'media'] as const) {
      const text = `${JSON.stringify(manifest[block], null, 2)}\n`;
      for (const [where, sha] of Object.entries(SHA256_TEXT_COPIES)) expect(sha(text), `${where} ${block}`).toBe(manifest[`${block}Digest`]);
    }
  });
});

/**
 * Canonical JSON. The copies already differ, so each keeps its own goldens,
 * named by its variant: "keys by code point" (compact, keys sorted by code
 * point; the four copies agree on every input), "keys by UTF-16 unit" (the
 * same text while every key is in the BMP, as in the fixture documents, but
 * not for the astral key of the edge value) and "indented, keys as inserted"
 * (the exporter's document text: not sorted at all). A move may merge only
 * copies whose goldens agree.
 */
const CANONICAL_VARIANTS: Record<string, (value: unknown) => string> = {
  'keys by code point: asset-pipeline canonicalJsonText': assetPipeline.canonicalJsonText,
  'keys by code point: behavior-build canonicalJsonText': behaviorBuild.canonicalJsonText,
  'keys by code point: project-model canonicalJsonText': projectModel.canonicalJsonText,
  'keys by code point: project-model prefab-relink canonicalJson': prefabCanonicalJson,
  'keys by UTF-16 unit: workspace canonicalize': workspace.canonicalize,
  'indented, keys as inserted: exporter canonicalJson': (v) => exporterCanonicalJson(v),
  'indented, keys as inserted: exporter canonicalJson at depth 2': (v) => exporterCanonicalJson(v, 2),
};
/** Real documents from the committed fixtures, and one value at the edges (key order across UTF-16 and code points, escapes, numbers). */
const DOCUMENTS = [
  'fixtures/phase26/legacy-v4-build/project/project.json',
  'fixtures/phase26/legacy-v4-build/project/content.json',
  'fixtures/phase26/legacy-v4-build/project/scenes/scene-main.json',
  'fixtures/phase26/legacy-v4-build/project/assets/materials/wall-mat.material.json',
  'fixtures/phase26/legacy-v4-build/project/assets/prefabs/crate-prefab.prefab.json',
  'fixtures/phase26/legacy-v4-build/build/manifest.json',
];
const EDGES = {
  b: 1,
  a: [{ z: null, é: 'x', '\u{1D11E}': 2, '￿': 3, '': 'empty', A: true }],
  n: [-0, 0.1, 1.5e-7, 1e21, -12345.678],
  s: 'quote " backslash \\ newline \n tab \t line sep   control \u0001',
  nested: { y: { b: [], a: {} }, x: [[1, [2]], 'z'] },
};
const CANONICAL_GOLDENS: Record<string, Record<string, string>> = {
  "keys by code point: asset-pipeline canonicalJsonText": {
    "fixtures/phase26/legacy-v4-build/project/project.json": '7ba829855e38489970b422f3a15d0b76757d1b64a12e02281e7abcb46f4458c0',
    "fixtures/phase26/legacy-v4-build/project/content.json": '68fc6e837e502f7ebd606360ed76a7cc7e941e05109b2ce3a1a43de484909414',
    "fixtures/phase26/legacy-v4-build/project/scenes/scene-main.json": '001164d31263319885cc91e0c10ec5c049d5bb8a74c6f6363e106ace1ac3284e',
    "fixtures/phase26/legacy-v4-build/project/assets/materials/wall-mat.material.json": '3c8ee6b239a0fdf6abfe3c05663957a17c4e87edf1d6958e678e1034fc35ed06',
    "fixtures/phase26/legacy-v4-build/project/assets/prefabs/crate-prefab.prefab.json": 'f153c9d0fdd52a7a47dcab3cb096f45ad8b243cae2db1d4a50c47b66c87b6f52',
    "fixtures/phase26/legacy-v4-build/build/manifest.json": 'a2f4fc83dfbdf7d67204d57ebfdc974a441a9fa9ab2fea0674f6561e8c014c98',
    "edges": '2cc433c05e7b264f413f68b095ba3263792898f4992b563e912c5e8fd6c3e818',
  },
  "keys by code point: behavior-build canonicalJsonText": {
    "fixtures/phase26/legacy-v4-build/project/project.json": '7ba829855e38489970b422f3a15d0b76757d1b64a12e02281e7abcb46f4458c0',
    "fixtures/phase26/legacy-v4-build/project/content.json": '68fc6e837e502f7ebd606360ed76a7cc7e941e05109b2ce3a1a43de484909414',
    "fixtures/phase26/legacy-v4-build/project/scenes/scene-main.json": '001164d31263319885cc91e0c10ec5c049d5bb8a74c6f6363e106ace1ac3284e',
    "fixtures/phase26/legacy-v4-build/project/assets/materials/wall-mat.material.json": '3c8ee6b239a0fdf6abfe3c05663957a17c4e87edf1d6958e678e1034fc35ed06',
    "fixtures/phase26/legacy-v4-build/project/assets/prefabs/crate-prefab.prefab.json": 'f153c9d0fdd52a7a47dcab3cb096f45ad8b243cae2db1d4a50c47b66c87b6f52',
    "fixtures/phase26/legacy-v4-build/build/manifest.json": 'a2f4fc83dfbdf7d67204d57ebfdc974a441a9fa9ab2fea0674f6561e8c014c98',
    "edges": '2cc433c05e7b264f413f68b095ba3263792898f4992b563e912c5e8fd6c3e818',
  },
  "keys by code point: project-model canonicalJsonText": {
    "fixtures/phase26/legacy-v4-build/project/project.json": '7ba829855e38489970b422f3a15d0b76757d1b64a12e02281e7abcb46f4458c0',
    "fixtures/phase26/legacy-v4-build/project/content.json": '68fc6e837e502f7ebd606360ed76a7cc7e941e05109b2ce3a1a43de484909414',
    "fixtures/phase26/legacy-v4-build/project/scenes/scene-main.json": '001164d31263319885cc91e0c10ec5c049d5bb8a74c6f6363e106ace1ac3284e',
    "fixtures/phase26/legacy-v4-build/project/assets/materials/wall-mat.material.json": '3c8ee6b239a0fdf6abfe3c05663957a17c4e87edf1d6958e678e1034fc35ed06',
    "fixtures/phase26/legacy-v4-build/project/assets/prefabs/crate-prefab.prefab.json": 'f153c9d0fdd52a7a47dcab3cb096f45ad8b243cae2db1d4a50c47b66c87b6f52',
    "fixtures/phase26/legacy-v4-build/build/manifest.json": 'a2f4fc83dfbdf7d67204d57ebfdc974a441a9fa9ab2fea0674f6561e8c014c98',
    "edges": '2cc433c05e7b264f413f68b095ba3263792898f4992b563e912c5e8fd6c3e818',
  },
  "keys by UTF-16 unit: workspace canonicalize": {
    "fixtures/phase26/legacy-v4-build/project/project.json": '7ba829855e38489970b422f3a15d0b76757d1b64a12e02281e7abcb46f4458c0',
    "fixtures/phase26/legacy-v4-build/project/content.json": '68fc6e837e502f7ebd606360ed76a7cc7e941e05109b2ce3a1a43de484909414',
    "fixtures/phase26/legacy-v4-build/project/scenes/scene-main.json": '001164d31263319885cc91e0c10ec5c049d5bb8a74c6f6363e106ace1ac3284e',
    "fixtures/phase26/legacy-v4-build/project/assets/materials/wall-mat.material.json": '3c8ee6b239a0fdf6abfe3c05663957a17c4e87edf1d6958e678e1034fc35ed06',
    "fixtures/phase26/legacy-v4-build/project/assets/prefabs/crate-prefab.prefab.json": 'f153c9d0fdd52a7a47dcab3cb096f45ad8b243cae2db1d4a50c47b66c87b6f52',
    "fixtures/phase26/legacy-v4-build/build/manifest.json": 'a2f4fc83dfbdf7d67204d57ebfdc974a441a9fa9ab2fea0674f6561e8c014c98',
    "edges": '648dae3ca41696ec37d578e3a7edd6ce8aac4f3c175a938a0582eba03688b130',
  },
  "indented, keys as inserted: exporter canonicalJson": {
    "fixtures/phase26/legacy-v4-build/project/project.json": 'd2fff9c43bc6f5c569d2b1ce31e23f6a55f719c225567c4c1e362271351eac81',
    "fixtures/phase26/legacy-v4-build/project/content.json": '3940a23346ee4aaf7e9e4babf10ddcc2ea99408b89c452daf7fafec884bda261',
    "fixtures/phase26/legacy-v4-build/project/scenes/scene-main.json": '25c5df0a7f23d03cff096a8c765895dd24a8d313740cfd78f40f4f8a982dd1dc',
    "fixtures/phase26/legacy-v4-build/project/assets/materials/wall-mat.material.json": '48655f675aeb2fffecdca01c736a668a1690e7eb432b5b4875d9ebf06177ff04',
    "fixtures/phase26/legacy-v4-build/project/assets/prefabs/crate-prefab.prefab.json": '82f5ea980825c692c6f185a54b946e84a70794343c52a8037a80320f38b40d1c',
    "fixtures/phase26/legacy-v4-build/build/manifest.json": '2e97726879fd7ab93cb595b3c1120720246ff3e70bab09cc1ee9022147d00f4e',
    "edges": 'fe478cdea66bbb72921d0ddaa55fa7863fcda3a08139f2fd558a71be0511961c',
  },
  "indented, keys as inserted: exporter canonicalJson at depth 2": {
    "fixtures/phase26/legacy-v4-build/project/project.json": 'f4c92b502d27931716d149827c6146777be52bf9a4b5f2ee7585087810a9e8e1',
    "fixtures/phase26/legacy-v4-build/project/content.json": '4e03e346868579789a3c1b3d72cf07b4e8497d529fe6841366529a677c3fe747',
    "fixtures/phase26/legacy-v4-build/project/scenes/scene-main.json": 'fc23d011eddeb52506011d1eed87385f14970d33836f30d3fbe4888905dd0757',
    "fixtures/phase26/legacy-v4-build/project/assets/materials/wall-mat.material.json": '6fa9ddcb5f6fa03924369f1d9ccb1673adef7f614d4dec25b9c17c0313e4cc41',
    "fixtures/phase26/legacy-v4-build/project/assets/prefabs/crate-prefab.prefab.json": '490beafbfefd9a76b8bc277f93f38ea157b7546a1215364b93a381a733c5febb',
    "fixtures/phase26/legacy-v4-build/build/manifest.json": 'f24e5a55e0bf9aa1609e80ae7dee459b452ae9e5fa795289a8d25f2d6d972dcd',
    "edges": 'b7441e2c9763069ca94bc9c725cf34f1ec5c83ed84dbe53694047a389a919dce',
  },
  "keys by code point: project-model prefab-relink canonicalJson": {
    "fixtures/phase26/legacy-v4-build/project/project.json": '7ba829855e38489970b422f3a15d0b76757d1b64a12e02281e7abcb46f4458c0',
    "fixtures/phase26/legacy-v4-build/project/content.json": '68fc6e837e502f7ebd606360ed76a7cc7e941e05109b2ce3a1a43de484909414',
    "fixtures/phase26/legacy-v4-build/project/scenes/scene-main.json": '001164d31263319885cc91e0c10ec5c049d5bb8a74c6f6363e106ace1ac3284e',
    "fixtures/phase26/legacy-v4-build/project/assets/materials/wall-mat.material.json": '3c8ee6b239a0fdf6abfe3c05663957a17c4e87edf1d6958e678e1034fc35ed06',
    "fixtures/phase26/legacy-v4-build/project/assets/prefabs/crate-prefab.prefab.json": 'f153c9d0fdd52a7a47dcab3cb096f45ad8b243cae2db1d4a50c47b66c87b6f52',
    "fixtures/phase26/legacy-v4-build/build/manifest.json": 'a2f4fc83dfbdf7d67204d57ebfdc974a441a9fa9ab2fea0674f6561e8c014c98',
    "edges": '2cc433c05e7b264f413f68b095ba3263792898f4992b563e912c5e8fd6c3e818',
  },
};

describe('canonical JSON: each variant keeps its output', () => {
  const inputs: [string, unknown][] = [
    ...DOCUMENTS.map((rel): [string, unknown] => [rel, JSON.parse(readFileSync(join(ROOT, rel), 'utf8'))]),
    ['edges', EDGES],
  ];
  for (const [variant, canonical] of Object.entries(CANONICAL_VARIANTS)) {
    it(variant, () => {
      for (const [name, value] of inputs) expect(reference(canonical(value)), `${variant} over ${name}`).toBe(CANONICAL_GOLDENS[variant]![name]);
    });
  }
});

/** Seeds across the 32-bit range (negative and past 2^32 included: each copy wraps them its own way). */
const SEEDS = [0, 1, 42, 0x7fffffff, 0xdeadbeef, -1, -123456, 2 ** 32 + 5];
const DRAWS = 64;
const draws = (next: () => number): number[] => Array.from({ length: DRAWS }, next);

/**
 * mulberry32 copies. All three draw the same today (one golden). Not here:
 * the GPU copy (three-adapter TslRng, a shader node), the visual-script
 * prelude's copy (behavior-build, source text compiled into scripts), the
 * terrain erosion generator (a retired area) and the copies inside tests and
 * perf tools.
 */
const RANDOM_COPIES: Record<string, (seed: number) => () => number> = {
  'effects Rng': (seed) => {
    const rng = new Rng(seed);
    return () => rng.next();
  },
  'project-model seededRandom': seededRandom,
  'editor prng': prng,
};
const RANDOM_GOLDENS: Record<string, string> = {
  "effects Rng": 'bca8278e289d4c17e90716b2f716c266e1ba9781c4c6bac3ff6dc88bd43467bd',
  "project-model seededRandom": 'bca8278e289d4c17e90716b2f716c266e1ba9781c4c6bac3ff6dc88bd43467bd',
  "editor prng": 'bca8278e289d4c17e90716b2f716c266e1ba9781c4c6bac3ff6dc88bd43467bd',
};

describe('seeded random: every copy draws the same sequences', () => {
  for (const [where, make] of Object.entries(RANDOM_COPIES)) {
    it(where, () => {
      const all = SEEDS.flatMap((seed) => draws(make(seed)));
      expect(digestOf(all)).toBe(RANDOM_GOLDENS[where]);
    });
  }
});

/** A grid of points (fractions, negatives, lattice points and far coordinates) noise is sampled on. */
const POINTS: [number, number, number][] = [];
for (const x of [-1000.25, -3.5, -1, -0.001, 0, 0.3, 1, 2.75, 17.125, 4096.5]) {
  for (const z of [-7.75, -0.5, 0, 0.45, 3, 99.9]) for (const y of [0, 0.6, -2.2]) POINTS.push([x, y, z]);
}
const NOISE_SEEDS = [0, 7, -3, 0x12345678];

/**
 * Noise and lattice hashes. These are variants, not copies of one function:
 * each has its own lanes and output range, and a stored world depends on
 * each (terrain sculpts, rule scatter, brushes, ground cover, camera shake,
 * the wind texture).
 */
const NOISE_VARIANTS: Record<string, () => number[]> = {
  'value-noise terrainNoise': () => NOISE_SEEDS.flatMap((s) => POINTS.map(([x, , z]) => terrainNoise(x, z, s))),
  'value-noise valueNoise01': () => NOISE_SEEDS.flatMap((s) => POINTS.map(([x, y, z]) => valueNoise01(x, z, s, y))),
  'value-noise fractalNoise01': () => NOISE_SEEDS.flatMap((s) => POINTS.map(([x, y, z]) => fractalNoise01(x, z, 4, s, y))),
  'surface-rules ruleNoise': () => NOISE_SEEDS.flatMap((s) => POINTS.map(([x, y, z]) => ruleNoise(x, y, z, s))),
  'instance-brush brushHash': () => NOISE_SEEDS.flatMap((s) => POINTS.map(([x, y, z], i) => brushHash(s, Math.floor(x), Math.floor(z), Math.floor(y) + i))),
  'cover-placement coverRandom': () => NOISE_SEEDS.flatMap((s) => POINTS.map(([x, y, z], i) => coverRandom(s, Math.floor(x), Math.floor(z), Math.floor(y) + i))),
  'camera-rig shakeNoise': () => NOISE_SEEDS.flatMap((s) => POINTS.map(([x, y], i) => shakeNoise(s, i % 3, x + y))),
  'wind-field makeWindNoise': () => Array.from(makeWindNoise(64)),
};
const NOISE_GOLDENS: Record<string, string> = {
  "value-noise terrainNoise": '1df3f80f7648b223344d0bce16b5b0269cd19efbd7b1d7a1903206edecd3122c',
  "value-noise valueNoise01": 'b8c297df81dba894a647daf3becfc4e11a864663559929b96bbef3ab956098e8',
  "value-noise fractalNoise01": '15ad501db2dd7b00706524e55f2b2912426eacb0b919fb6412e777356f522f8a',
  "surface-rules ruleNoise": 'c9b488d8cae0afb48faad541694374190629a11249d9adc336c6999a896cb749',
  "instance-brush brushHash": '22f42614e44c43548494564af7a8dc33a4a44852e61fc5aae9a3a77c08bf342f',
  "cover-placement coverRandom": 'f05cc61b2cb374b9b568c69d24cbbc08fb49f90bada689e758a8dbfe2d5ca4e2',
  "camera-rig shakeNoise": 'e0243c70cb2679160441a360d8f204bf0e802c93b375f255146367fa2e7eecbc',
  "wind-field makeWindNoise": '54d51a19099615923cc8823dd4186d62b0e69caed68593241be3a63d704f6160',
};

describe('noise and lattice hashes: each variant gives the same field', () => {
  for (const [variant, sample] of Object.entries(NOISE_VARIANTS)) {
    it(variant, () => {
      expect(digestOf(sample())).toBe(NOISE_GOLDENS[variant]);
    });
  }
});
