# fixtures/m2/runtime — packet-29 runtime scheduling and module-lifecycle fixtures

Machine-readable fixtures for packet 29 (`docs/planning/m2-packets.md` §29):
safe fixed-step composition before integrating physics or scripts
(`docs/contracts/runtime.md` §§5, 12, 13).

These are **packet-29 evidence**, not accepted contract text. The accepted
packet-17 scheduler/ownership fixture
([`../contracts/runtime/catchup.json`](../contracts/runtime/catchup.json)) is
left byte-unchanged; the packet-29 suites replay it as well as these files.

## Layout

```text
fixtures/m2/runtime/
  index.json                 machine-readable file index (path + real sha256)
  scheduler-traces.json      fixed-step/catch-up/sampling expectations
  demo-traces.json           frozen §7.1 moving-box exact points
  failstop.json              fail-stop and unsupported-combination outcomes
  tools/check-runtime-fixtures.mjs   plain-Node consistency checker
```

## Verification

```bash
node fixtures/m2/runtime/tools/check-runtime-fixtures.mjs            # check
node fixtures/m2/runtime/tools/check-runtime-fixtures.mjs --write    # refresh index.json
npx vitest run tests/m2-runtime                                       # replay through the runtime
```

The checker re-derives the fixed-step arithmetic, the §7.1 demo math and the
fail-stop code registry independently of the TypeScript implementation; the
vitest suite replays the same fixtures through `@thirdlight/runtime`.

## Conventions

- Canonical JSON: UTF-8, LF, 2-space indentation, one trailing newline.
- `scheduler-traces.json` frames give `elapsed` seconds relative to the wall
  anchor (the boot frame for the settle pre-roll); dropping resyncs the anchor
  exactly as `runtime.md` §5.4 specifies.
- Fail-stop cases never claim a transform rollback and never allow resuming a
  failed instance (`runtime.md` §13).
- No credentials, tokens or project data: every value is synthetic.
