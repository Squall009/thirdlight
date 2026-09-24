# Runtime (non-JSON) validation cases — project-model

Contract: `docs/contracts/project-model.md` §12.7. JSON has no literal `NaN`
or `±Infinity` tokens. The directly constructed cases below must be exercised
**in memory** by the packet 05 test suite
(e.g. by building the document value directly and passing it to the
validator). `path` values are shown for a scene where the offending entity
is `entities[0]`; the code, not the exact index, is the binding expectation.

## R1 — NaN in `position`

Input (in-memory scene value):

```js
{
  schemaVersion: 1,
  sceneId: "scene-main",
  revision: 0,
  entities: [
    {
      id: "cam-main",
      components: {
        transform: { position: [Number.NaN, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        camera: { type: "perspective", fovY: 60, near: 0.1, far: 100 },
      },
    },
  ],
}
```

Expectation: `number_not_finite` at `/entities/0/components/transform/position/0`
(with `found: NaN`).

## R2 — `Infinity` and zero in `scale`

```js
transform: { position: [0, 0, 0], rotation: [0, 0, 1, 0], scale: [0, Number.POSITIVE_INFINITY, 1] }
```

Expectation: `number_not_finite` at `/entities/…/scale/1` (Infinity).
Finiteness is checked before range, but all independent errors are collected,
so the `0` at `/entities/…/scale/0` additionally raises
`number_out_of_range` (scale must be `> 0`). Both codes must be present.

## R3 — `-Infinity` in `rotation`

```js
transform: { position: [0, 0, 0], rotation: [0, Number.NEGATIVE_INFINITY, 0, 1], scale: [1, 1, 1] }
```

Expectation: `number_not_finite` at
`/entities/…/components/transform/rotation/1`.

## R4 — finite but out-of-range `fovY` (JSON-encodable; the `invalid/invalid-numbers.json` fixture carries this class with `fovY: 200` and `far: 2000000`)

```js
camera: { type: "perspective", fovY: 1e308, near: 0.1, far: 100 }
```

Expectation: `number_out_of_range` at `/entities/…/components/camera/fovY`.

## R5 — serializer refusal

A normalizer/serializer handed any value containing a non-finite number (via
any of R1–R3 shapes) must return the `number_not_finite` error result and
**must never** emit `NaN`/`Infinity` tokens in any output string — not even
as "best effort" or in an error payload serialized as JSON text.
(`JSON.stringify` of such a value yields `null`/omission; that silent
degradation is forbidden. The correct behavior is to reject before
serializing.)

## R6 — file containing non-strict tokens

Covered by the JSON fixture `../invalid/non-strict-json.json`: strict parse
fails → `json_parse_error`, original bytes retained. No field-level
validation is attempted after a parse failure (contract §12.3).

## Strict-JSON numeric overflow is a separate persisted-input case

`JSON.parse('1e400')` returns `Infinity`; `JSON.parse('-1e400')` returns
`-Infinity`. These are valid JSON numeric tokens, unlike literal `Infinity`
or `NaN`. The strict-JSON fixture `../invalid/numeric-overflow.json` therefore
expects `number_not_finite` from **value validation after successful parsing**,
not `json_parse_error`. NaN itself still requires in-memory construction.
The per-value `Number.isFinite`-style check on every numeric field protects
both persisted bytes and in-memory inputs. See also `byte-input-cases.md`.