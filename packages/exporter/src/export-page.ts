/**
 * The exported page's fixed engine text (packet 36) — import-free so both the
 * browser bootstrap and the export scan can use it.
 */

/**
 * The exported page's fixed engine text (packet 36): the mandatory
 * `behaviors.md` §2.3 trust notice presented before the run starts
 * (export.md §6). Kept in its own import-free module so the export scan can
 * count its exact §5.4 pattern contributions (the notice deliberately names the
 * network/global APIs a behavior can reach — `XMLHttpRequest`, `WebSocket` —
 * so its measured contribution is part of the expectation, never a blanket
 * allowance; contract-change request C36-6).
 */
export const BEHAVIOR_TRUST_NOTICE: readonly string[] = [
  'Behavior code is trusted personal project code. It runs on this page\u2019s main thread, in the same JavaScript context as the renderer and the runtime step loop.',
  '1. There is NO hard runtime timeout. A same-thread infinite loop cannot be interrupted: no watchdog, no Stop button and no dispose() call preempt it. A hung behavior hangs this tab until you close it.',
  '2. There is NO hostile-code sandbox. A behavior can reach every global available in its game origin (window, document, fetch, XMLHttpRequest, WebSocket, Worker, storage, console). The compiler checks and the page CSP are defense in depth, not a sandbox.',
  '3. Scripts observe their origin\u2019s globals. The exported page therefore exposes nothing sensitive: no authoring credentials, no /api/v1 access and no project filesystem handle.',
];

/** The single joined notice text (the scan input). */
export const BEHAVIOR_TRUST_NOTICE_TEXT = BEHAVIOR_TRUST_NOTICE.join('\n');
