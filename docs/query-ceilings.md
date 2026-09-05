# Query sensitivity ceilings

Evidence date: 2026-09-05. Core `search`, `searchResult`, and `timeline` require
an explicit ceiling. The only accepted values are the primitive strings
`public`, `personal`, and `private`.

```ts
import { searchResult, timeline } from "@kizuki/core";

const result = searchResult(db, "project notes", {
  ceiling: authenticatedGrant.ceiling,
  scope: "all",
  limit: 20,
});
const events = timeline(db, {
  ceiling: authenticatedGrant.ceiling,
  day: "2026-09-05",
  limit: 50,
});
```

## Compatibility

This deliberately tightens the legacy convenience APIs. Calls such as
`search(db, text)`, `searchResult(db, text, {})`, and `timeline(db)` no longer
compile in TypeScript and throw a fixed `RangeError` in JavaScript. There is
no implicit owner or public ceiling. Null, unknown labels, inherited property
names, arrays, boxed strings, and coercible objects are rejected before any
database read, including empty-query and zero-limit shortcuts.

The `kizuki.retrieval/v1` port already required a ceiling. Its query validator
also rejects inherited property names as labels. The port shape is unchanged.

## Enforcement and authority

Every public query applies the validated ceiling in SQL. Stored null, unknown
or unlabeled sensitivities are outside the lattice and are never returned,
including at the private ceiling. Filters and limits do not widen the ceiling.

A ceiling is a storage filter. It does not authenticate a caller or create a
grant. Hosts serving agents must continue using core's authenticated serving
functions, which resolve the current principal, apply the grant and source
policy, and write the audit. Passing a string to a raw query does not replace
those checks. Trusted code with a database handle already holds a storage
capability.

The serving functions retain a second bounded query for denial bookkeeping.
That internal query returns identities only, sharing the same filters, order
and limit as before. It selects no title, body, snippet or event preview. Core
loads current policy metadata to decide which identities were withheld. The
public envelope still reports denial counts without exposing withheld IDs or
content. These helpers are excluded from the public package and query exports;
there is no public unrestricted-query option.

## Verification

Direct package-export tests cover missing and malformed ceilings before SQL,
valid-label matrices on the real in-memory ledger and FTS index, and empty/zero
shortcuts. Internal-query tests verify identity-only projections, stable
selection bounds and absence from the public exports. Existing serving tests
cover denial counts, redaction, grant scopes, source policy and live evidence.

```bash
cd /home/ubuntu/LifeOS/workspace/kizuki-retrieval-ceilings-20260905
npx -y bun@1.3.10 test packages/core/test/query packages/core/test/search packages/core/test/serving
npx -y bun@1.3.10 run typecheck
```

The requirements come from RFC 0002 sections 8.1 and 9.2. This query repair
does not alter event storage, source origin, agent grants or canon writing.
