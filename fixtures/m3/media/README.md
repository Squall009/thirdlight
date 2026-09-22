# Thirdlight — M3 media fixtures (packet 41; extended by packet 47)

**PROPOSED — not accepted** at packet 41; the packet-41 presentation rows were
**promoted** into `docs/contracts/presentation.md` at Gate K (owner review
pending, `docs/handoffs/m3-promotion.md`). Packet 47 implemented the bounded
`inspectAudio` / role-aware `inspectGlb` proposal in `@thirdlight/asset-pipeline`
and extended this fixture set to exercise every §41.4.4 stage, the §41.3.3
A1–A6 boundaries and the recipe/`recipeDigest`/`metadataDigest` values (see
[`verification.md`](verification.md) §0).

These fixtures accompany packet 41's proposed
presentation contract:

- [`docs/planning/m3-contracts/presentation.md`](../../../docs/planning/m3-contracts/presentation.md)
  — the new proposed contract home (lighting/shadows, primitive presets,
  rigid animation roles + atomic reimport, bounded PCM-WAV audio + injected
  browser owner, checkpoint activation appearance, lifetimes, limits/errors);
- [`docs/planning/m3-contracts/diffs/project-model.md`](../../../docs/planning/m3-contracts/diffs/project-model.md)
  — the packet-41 section (the §18.1 rule-3 replacement and the audio recipe/
  metrics unions);
- [`docs/planning/m3-contracts/diffs/runtime.md`](../../../docs/planning/m3-contracts/diffs/runtime.md)
  and [`diffs/commands.md`](../../../docs/planning/m3-contracts/diffs/commands.md)
  — the packet-41 sections (host-owned presentation lifetimes; atomic
  `publishAsset` reimport and the code rows).

Nothing in `docs/contracts/` is changed and nothing here is implemented. Gate K
records accept/reject per diff; a separate docs-only promotion applies accepted
rows before packet 44. Packets 47/52/53/54/57 implement the behaviour.

Machine-readable index: [`index.json`](index.json). Repeatable checks:
[`verification.md`](verification.md),
[`tools/check-fixtures.mjs`](tools/check-fixtures.mjs).

## Layout

```text
fixtures/m3/media/
  index.json                         byte length + SHA-256 of every data file
  verification.md                    repeatable commands, negative control, arithmetic
  tools/generate-fixtures.mjs        deterministic committed generator (no dependency)
  tools/check-fixtures.mjs           self-contained plain-Node checker (no dependency)
  glb/
    courier-roles.glb                positive: rigid nodes, Idle/Run/Airborne
    courier-reordered.glb            positive: same clips stored in another order
    bad-skin.glb                     negative: `skins` present
    bad-root-motion.glb              negative: root-node translation channel
    dup-names.glb                    negative: two clips named "Idle"
    many-clips.glb                   negative: 9 clips (> 8)
    many-tracks.glb                  negative: 66 channels (> 64)
    many-tracks-per-clip.glb         negative: 33 channels in one clip (> 32)
    many-keyframes.glb               negative: 4101 sampler input keyframes (> 4096)
    long-clip.glb                    negative: 10 100 ms clip (> 10 000)
    bad-joints.glb                   negative: JOINTS_0/WEIGHTS_0 present
    bad-skin-root.glb                negative: skins *and* root motion (A2 before A6)
    clips-at-cap.glb                 positive: exactly 8 clips
    tracks-at-cap.glb                positive: exactly 64 channels / 32 per clip
    keyframes-at-cap.glb             positive: exactly 4096 keyframes
    clip-10s.glb                     positive: exactly 10 000 ms clip
    profile-cases.json               every §41.3.2/§41.3.3 case + expectation
  wav/
    cue-{start,jump,checkpoint,death,goal}.wav   five cue positives
    cue-max.wav                      exactly 96 000 frames / 192 000 PCM bytes
    cue-min.wav                      exactly one frame (2 data bytes)
    cue-preimage.wav                 the byte-identical contracts preimage (236 B)
    rejections/*                     one negative per §41.4.4 stage/boundary
    wav-cases.json                   per-file derived arithmetic, verdict + the
                                     audio record (recipe/recipeDigest/metadataDigest)
  roles/
    roles-cases.json                 packet 53 (CC-47-1 / Gate L P3): the real-rows
                                     `modelAnimation` components for the courier GLBs
                                     (real `AnimationRoleBinding` values; the
                                     placeholder stubs in the frozen contract
                                     envelopes stay untouched)
  render/light-surface-cases.json    light validation, presets, shadow degradation
  activation/appearance-cases.json   activation values + the committed bit timeline
  ownership/ownership-cases.json     creator/disposer/counter + dispose invariants
  audio/audio-cases.json             voice cap, dedupe, stale cancel, statuses
  errors/codes.json                  the closed code sets of presentation.md §41.7.2
```

## Provenance and rights

Every byte under `fixtures/m3/media/**` is **original, self-generated** content:
`tools/generate-fixtures.mjs` builds each GLB, WAV and JSON fixture
deterministically from literal data in that script (a minimal glTF 2.0 GLB
writer and a RIFF/WAVE writer, both plain Node with `node:crypto` only). Nothing
is downloaded, copied from another project or derived from a third-party asset,
and no third-party license is asserted. The generated bytes are dedicated to
this repository's fixture use; re-running the generator reproduces them exactly
(`--check`). No credential, path, network access or `eval` appears in the
generator or the checker.

## Conventions

- JSON fixtures are canonical: UTF-8, LF, 2-space indent, one trailing newline,
  no BOM, no trailing whitespace; the checker verifies the bytes, strict-parses
  (duplicate keys rejected) and re-derives every declared expectation.
- The GLBs are **valid under the accepted M2 model profile** (`project-model`
  §18.7) so the packet-41 animated profile is the only reason to reject them;
  the checker re-reads the JSON chunk itself and does not use the
  `asset-pipeline` implementation.
- The checker is a **contract-consistency** tool: it proves the committed
  numbers agree with the committed rules. It runs no renderer, no Web Audio
  device, no GLTFLoader and no runtime. It is not packet-47/52/53/54 evidence.
- No browser, audibility, GPU or performance claim is made here. Packet 38's
  software-WebGL/PCM-decode facts are cited in `presentation.md`; audibility
  remains UNVERIFIED (no audio device in this container).
