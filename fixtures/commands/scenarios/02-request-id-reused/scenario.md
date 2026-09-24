# Scenario 02 — requestId reuse with different content

Pins: commands.md §6.2 (`request_id_reused`), §5.4 (code/class/fields),
§6.6 (digest = semantic equality of requests).

## Precondition (disk-before)

`demo-0001` at T5 (`disk-before` == `envelope/valid/demo-0001-rev5`;
revision 5, record R5 for `requestId req-1…05` in the scene file).

## Messages (messages.json)

1. `in`: a `deleteEntity` request for `box-0002` at `expectedRevision 5`
   that **reuses** the `requestId` of A5 (`req-1…05`) — different `op` and
   `args`, hence a different content digest (independently recomputable:
   see `verification.md` check 2).
2. `out`: `error` `request_id_reused` (`cls: "conflict"`) carrying
   `currentRevision: 5` and the recovery hint.

## Expected observations

- The dedup step finds the requestId (in the union of the project files'
  records), compares digests, and fails the request: a requestId is a
  content-addressed lease, permanently bound to the content first recorded
  under it.
- No state change: `disk-after` is byte-identical to `disk-before`.
- The conflicting request is never recorded, and the original record R5 is
  untouched (identical retries of the *original* A5 would still replay).
- Recovery (client policy, commands.md §5.5): re-read state, re-issue the
  intended `deleteEntity` with a **fresh** `requestId`.

Storage v4 changes nothing here beyond the file layout.
