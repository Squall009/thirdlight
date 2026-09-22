# Verification — packet 41 media fixtures

**PROPOSED — not accepted** at packet 41; the presentation rows were promoted at
Gate K and packet 47 implemented the inspector over these bytes. Repeatable
checks for `fixtures/m3/media/`. All commands run from the repository root with
the pinned Node (`package.json` engines: `node 22`; host recorded 22.22.1).

## 0. Packet 47 update (recorded 2026-09-19)

The fixture set grew from 40 to **65** files: the §41.3.3 A1–A6 boundary
positives/negatives (16 GLBs), the §41.4.4 stage/boundary WAV negatives
(`fact`/`bext`/`cue `/`smpl`/duplicate chunks, RF64/BW64, µ-law/A-law, the exact
196 608-byte source bound, non-WAV bytes, `data:`/URL and gzip inputs), the
`cue-min` (1 frame) and `cue-preimage` (236 bytes) positives, and the
`audioRecord` anchor in `wav-cases.json`.

```sh
node fixtures/m3/media/tools/check-fixtures.mjs            # groups: 13, checks passed: 115, failed: 0, EXIT=0
node fixtures/m3/media/tools/check-fixtures.mjs --corrupt-control  # corruption control: 9/9 detected, EXIT=0
generate-fixtures.mjs --check                              # 65 files reproduce exactly, EXIT=0
node fixtures/m3/contracts/tools/check-fixtures.mjs        # groups passed: 39, EXIT=0
```

The checker now also re-derives, from the committed preimage bytes, the
`pcm-wav` recipe, `recipeDigest = SHA-256(canonical JSON of importRecipe)` and
`metadataDigest`, and (when the sibling `fixtures/m3/contracts` tree is present)
asserts that the three committed audio records and their index digests carry
exactly those re-derived facts. The `--corrupt-control` mode runs the checker as
real child processes against corrupt copies of `fixtures/m3` (media +
contracts); each of the nine corruptions must be detected (a WAV stage value, a
new RF64 rejection case, the recipe digest, the record metrics, a new
`JOINTS_0` case, a role expectation, the contracts audio record, an index
digest and the §41.7.2 code set).

`@thirdlight/asset-pipeline`'s `inspectAudio` / role-aware `inspectGlb` are
exercised over these same bytes by `tests/integration/m3-media-inspect/**`
(21 tests); this checker stays an *independent* re-derivation and still calls no
implementation.

## 1. Positive check (must exit 0)

```sh
node fixtures/m3/media/tools/check-fixtures.mjs
echo "EXIT=$?"
```

Recorded result (packet 41): `groups: 13, checks passed: 85, failed: 0`,
`all checks passed`, `EXIT=0`. (Packet 47 re-recorded: `checks passed: 115` —
see §0.)

Groups: `index`, `constants[wav]`, `constants[profile]`, `constants[roles]`,
`constants[shadow]`, `wav[<file>]`, `glb[<file>]`, `glb[reorder-equivalence]`,
`presets[table]`, `light[<id>]`, `shadow[<id>]`, `preset-independence`,
`activation[...]`, `ownership[...]`, `audio[...]`, `codes[...]`,
`selector[role]`, `selector[crossfade]`. Optional machine-readable report:
`--report /tmp/m3-41-report.json`.

The generator's own reproducibility check (must also exit 0):

```sh
node fixtures/m3/media/tools/generate-fixtures.mjs --check
echo "EXIT=$?"
```

Recorded result: `generate-fixtures --check: 40 files reproduce exactly`,
`EXIT=0`.

## 2. Negative control — deliberate corruption (must exit non-zero)

```sh
rm -rf /tmp/m3-41-corrupt && cp -r fixtures/m3/media /tmp/m3-41-corrupt
node - <<'EOF'
import('node:fs').then(({ readFileSync, writeFileSync }) => {
  const w = '/tmp/m3-41-corrupt/wav/cue-start.wav';
  let b = readFileSync(w); b[22] = 2; writeFileSync(w, b);            // channels 1 -> 2
  const j = '/tmp/m3-41-corrupt/glb/profile-cases.json';
  const d = JSON.parse(readFileSync(j, 'utf8'));
  for (const c of d.cases) if (c.id === 'roles-ok-reordered')
    c.expect = { verdict: 'rejected', code: 'animation_role_mismatch' };  // wrong expectation
  writeFileSync(j, JSON.stringify(d, null, 2) + '\n');
  const g = '/tmp/m3-41-corrupt/glb/courier-roles.glb';
  const gb = readFileSync(g);
  gb[gb.indexOf(Buffer.from('"Airborne"')) + 8] = 'X'.charCodeAt(0);  // "AirbornX", same length
  writeFileSync(g, gb);
});
EOF
TL41_FIXTURE_ROOT=/tmp/m3-41-corrupt node fixtures/m3/media/tools/check-fixtures.mjs
echo "EXIT=$?"
```

Recorded result (packet 41): `EXIT=1`, `groups: 13, checks passed: 80,
failed: 8`, with the semantic failures

```text
FAIL [wav[wav/cue-start.wav]] rejected audio_channel_unsupported
FAIL [glb[roles-ok-stored-order]] rejected animation_role_mismatch
FAIL [glb[roles-ok-reordered]] accepted, expected rejection
FAIL [glb[reorder-equivalence]] ["AirbornX","Idle","Run"] != ["Airborne","Idle","Run"]
```

plus the `index[...]`/`json[...]` digest and byte-form failures for the three
edited files. `TL41_FIXTURE_ROOT` points the checker at a fixture copy; the
committed tree is never modified. The control mutates both a **value** and its
**expectation**, so the semantic group checks — not only the digests — fail.

The neighbouring packets' fixtures were re-run in the same step and still pass:

```sh
node fixtures/m3/contracts/tools/check-fixtures.mjs   # 39 groups, EXIT=0
node fixtures/m3/gameplay/tools/check-fixtures.mjs    # 23 groups / 124 checks, EXIT=0
```

## 3. Independent arithmetic (the checker recomputes, this derives)

**(a) WAV header and byte accounting** (`presentation.md` §41.4.1/§41.4.2).
The canonical file is `RIFF`(12) + `fmt ` chunk (8 + 16) + `data` chunk header
(8) = **44 bytes**, then `dataBytes` PCM bytes. With mono signed 16-bit at
48 000 Hz:

- `blockAlign = 1 × 16 / 8 = 2`
- `byteRate = 48000 × 1 × 16 / 8 = 96000`
- `frames = dataBytes / 2`
- `durationMs = floor(frames × 1000 / 48000) = floor(frames / 48)`
- `sourceBytes = 44 + dataBytes`
- `riffSize = sourceBytes − 8 = 36 + dataBytes`

The cap `dataBytes ≤ 192 000` is exactly 96 000 frames × 2 = 2.000 s. Fixture
`cue-max.wav` is the boundary: 96 000 frames, `pcmBytes = 192000`,
`durationMs = floor(96000/48) = 2000`, `sourceBytes = 192044`. The stage-1 file
bound `196608` (192 KiB) fires only for a file that is not even a plausible cue
(`huge-source.wav`: 199 956 PCM bytes + 44 = 200 000 > 196 608); the profile
PCM cap fires first for `oversized-pcm.wav` (192 002 PCM bytes + 44 = 192 046).

**(b) The animated-model profile** (`presentation.md` §41.3.3). The negatives
are single-rule files derived from the generator's parameters:
`many-clips.glb` has 9 clips > 8; `many-tracks.glb` has 3 clips × 22 channels =
66 > 64 (each clip ≤ 32); `long-clip.glb`'s longest clip is 10.1 s = 10 100 ms
> 10 000; `bad-root-motion.glb` adds one translation channel on scene root node
0; `bad-skin.glb` adds a `skins` array; `dup-names.glb` has clips
`["Idle","Run","Idle"]` so a binding naming `"Idle"` has `matches = 2`.
`courier-reordered.glb` stores the same three clip names in the reverse order,
so the equivalent mapping `{idle:2, run:1, airborne:0}` is accepted while the
stored-order mapping would be a `animation_role_mismatch`.

**(c) Shadow derivation** (`presentation.md` §41.1.3). For the sample level
`X ∈ [0,48], Y ∈ [−4,8]`: `halfExtent = max(24, 6) + 2 = 26 ≤ 64`, so the
shadow is on. The degraded-bounds case uses `X ∈ [0,200]`:
`halfExtent = 100 + 2 = 102 > 64` ⇒ `shadow_bounds_exceeded`, shadows off.

**(d) Role selection** (`presentation.md` §41.3.6 rule 3). `RUN_SPEED_EPS =
0.05`: `(grounded, 0) → idle`; `(grounded, 0.05) → idle` (strict `>`);
`(grounded, 0.051) → run`; `(airborne, 4) → airborne` (`!grounded` wins). Crossfade is fixed at 0.2 s.

**(e) Audio owner** (`presentation.md` §41.4.7). 10 distinct committed cue
events with 8 free voices → 8 sounding, 2 dropped (`voice_cap`); repeating an
event `id` is a no-op (3 events / 2 distinct ids → 2 played); a `runId` change
clears dedupe memory (2 + 2 ids with one internal duplicate → 3 played); a
decode resolving after `stop()` is discarded (0 played, 1 discarded).

## 4. What these fixtures do not prove

They are a contract-consistency check: they prove the committed bytes and
numbers agree with the committed rules, not that any implementation exists. No
WebGL, no `three`, no `GLTFLoader`, no `AudioContext`, no browser and no audio
device is exercised. Packets 47/52/53/54/57 own the implementation evidence,
and audibility remains **UNVERIFIED** in this container (packet 38 recorded PCM
decode and a real gesture reaching `running`, but no audio output device).
