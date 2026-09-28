# fixtures/m3/delivery — packet 42 delivery fixtures

Recorded delivery fixtures (content manifest, digests, pinned runs, wire
messages, controls, closure and dependency rows). `manifest/` is re-derived
with `npx tsx fixtures/m3/delivery/tools/derive-manifest.mts` and checked by
`tests/integration/m3-builds/manifest-v2.test.ts`.

Phase 24.8: the packet-42 fixture checker (`tools/check-fixtures.mjs`) and
its `verification.md` were deleted. It re-derived the proposed contract from
the archived `docs/contracts` and `docs/acceptance` evidence, which are no
longer in the repository, so it could only crash; the gate tests read the
fixtures directly. Git history keeps it.
