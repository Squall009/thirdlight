# Packet 34 — browser UNVERIFIED list and procedure

There is **no browser and no GPU** in this container. No live-browser,
WebGL-rendered, pixel or physical-device claim is made by packet 34.

## UNVERIFIED in a live browser

| # | Claim | Why unverified | How to verify |
|---|---|---|---|
| U-34-1 | The committed compiled artifact executes in a real browser through the real ES module loader (blob-URL `import`) | no browser | `m2-behaviors.browser.ts` steps 1–4 in `README.md` |
| U-34-2 | `speed` 3.5 vs 6.5 changes the rendered box position (`xHigh > xLow`), screenshot evidence | no browser/GPU | README step 4 + screenshot |
| U-34-3 | The `BehaviorPanel` renders the normative trust notice and the staging/diagnostic controls; a real staging round trip through `session/client.ts` | no browser, no prepared-artifact wire route (C34-4) | README (panel manual check) |
| U-34-4 | Browser `crypto.subtle` digest equals the server's/preparer's SHA-256 | no browser (Node 22 WebCrypto verified) | README step 4 console |
| U-34-5 | Editor end-to-end source publish (`stage → acknowledge → publishBehavior{mode:"source"}`) | no preparation wire route yet (C34-8); the panel surfaces `behavior_publication_unavailable` | packet 35 route + rerun |
| U-34-6 | The production isolated Play composition with real input/physics | packet 35 scope | packet 35 / packet 37 |

## Deliberately not verified (normative limitation)

- **No unbounded-loop (`while (true) {}`) test exists anywhere.** runtime.md
  §14.1.1: a same-thread loop cannot be interrupted by a watchdog, an iframe
  removal, a Stop button or `dispose()`. Do not add one to a live browser run.
- **No hostile-code containment claim.** The static checks are defense in
  depth, not a sandbox.

## Procedure

See `tests/browser/m2-behaviors/README.md` for the exact build, serve and
observation steps and the expected `P34_BROWSER_MEASUREMENT` output. Record the
browser, OS, version, WebGL backend, URL topology, dimensions and a real
screenshot in this directory's manifest when it is run.
