# Removed in phase 47T (the test suite reset)

- `gate-areas.json`, `check-gate-areas.mjs`: the old gate's e2e areas (which browser test files a changed source
  file ran) and their build check. The gate's `fast`, `area`, `rerun` and `full` modes and the "changed since the
  branch's last green gate" widening used them. Replaced by two commands, `tools/gate.sh check` (build, lint, the
  fast unit set, the five-test boot check) and `tools/gate.sh phase` (everything, once a phase): see
  `docs/plan-phase-47t.md` §2. The old `tools/gate.sh` is in git history before this commit.
