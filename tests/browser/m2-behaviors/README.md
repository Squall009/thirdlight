# Packet 34 — manual browser procedure (trusted behavior execution)

**Status in this container: UNVERIFIED (no browser).** The in-container
execution evidence is `behavior-host.test.ts` (Node `node:vm`, bounded context)
plus `packages/runtime/src/behavior.test.ts`. This directory's `.browser.ts`
file is the manual host the packet-37 desktop procedure builds and serves; it
is named `.browser.ts` so vitest never runs it and it can never fail the suite.

Owner decision on record: trusted behaviors run on the **play page's main
thread**. There is **no hard runtime timeout** and **no hostile-code sandbox**
(runtime.md §14.1.1). Do **not** add an unbounded-loop test to this procedure:
a same-thread `while (true) {}` cannot be preempted by a watchdog, an iframe
removal, a Stop button or `dispose()`, so running one would hang the tab.

## Procedure (owner desktop)

1. Build the host (packet-37 esbuild arrangement, no production bootstrap):

   ```
   npx esbuild tests/browser/m2-behaviors/m2-behaviors.browser.ts \
     --bundle --format=esm --platform=browser --target=es2022 \
     --outfile=/tmp/p34-behaviors/host.js
   ```

2. Serve `/tmp/p34-behaviors/host.js` together with `index.html`,
   `fixtures/m2/behaviors/valid/sample.output.js` and
   `fixtures/m2/behaviors/expected.json` from one static root on localhost.

3. Open the page in a browser with WebGL (Chromium/Firefox, HTTPS or
   `http://localhost`). Record browser + OS + version.

4. Expected observations:
   - console/DOM contains
     `P34_BROWSER_MEASUREMENT {"speedLow":3.5,"speedHigh":6.5,"steps":40,"xLow":…,"xHigh":…,"changed":true}`;
     `xHigh > xLow` (the declared `speed` property changes the measured play
     state after a fresh instantiation);
   - the element `#tl-behavior-trust-notice` shows the normative notice with
     the words "NO hard runtime timeout", "NO hostile-code sandbox" and "no
     authoring credentials";
   - no console errors, no network requests beyond the three static files;
   - no `eval`/`new Function` warning (the artifact loads as a module).

5. Record a screenshot of the measurement plus the rendered notice, the
   browser/OS/version, and the console output into
   `docs/acceptance/evidence-m2/34/` and update the manifest's UNVERIFIED list.

## What this procedure does NOT establish

- That a hostile behavior is contained (it is not: documented limitation).
- That the editor panel (trust acknowledgment, staging, publication) works
  end-to-end in a browser: its transport (`session/client.ts`) has no
  preparation wire route yet (packet 35 / contract request C34-3), so the
  panel currently surfaces `behavior_publication_unavailable` honestly.
- The production Play composition (packet 35).
