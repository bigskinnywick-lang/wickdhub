# tests

Plain Node ESM. No framework, no `package.json`, no install step:

```
cd <repo root>
node tests/member-prefs.test.mjs
```

Exits non-zero on any failure, so it drops straight into a hook or CI later.

## Why these live in the repo

An earlier round of tests existed only inside an ephemeral Cowork container and did not
survive it — FLIGHT_OPS later went looking for "the 67 tests" and found no clone and no
tests. A test that is not committed did not happen. Put them here.

## What `member-prefs.test.mjs` covers (Form OB-1, phase 1)

The Pages Functions are imported directly and driven with a fake KV and real `Request`
objects, so the exported handlers actually execute — this is not a syntax check.

- **Fail-closed rendering.** `visible()` honours a preference only on exact `true`;
  `undefined`, `null`, `"true"` and `1` all read as no. A member with an empty prefs
  object renders as nothing but a number.
- **Defaults are policy, not rendering.** Defaults are written explicitly to KV at
  provisioning and never consulted at render time. (Mutation-tested: wiring defaults into
  the render path makes an empty-prefs member render named, active and credited — the suite
  catches it.)
- **`list_rig` is inert while Section III is PREVIEW** — rejected on write, absent from the
  stored record and from every payload.
- **Identity isolation** — records are keyed per Access email; no identity returns 403.
- **Export redaction** — `member:`, `rig:` and `cmdrlink:` are counted but never dumped by
  default, because that blob is committed to a PUBLIC repo. `?include=personal` returns the
  full dump and labels itself DO NOT COMMIT.

## Keep the controls honest

Every property above was mutation-tested: the source was deliberately broken and the suite
had to fail. A suite that has never been seen to fail is not evidence. If you add a test,
break the thing it covers once and watch it go red before you trust it.
