# Context privacy

Context packets use the same live agent grant as the other serving tools. Claims,
conflicts, validity gaps and identity aliases require authorization before they
can enter the text projection. A token budget never relaxes that authorization.

## Working claims

The stored claim label controls its sensitivity ceiling. Missing or invalid
labels, taint or authority stamps, invalid claim lifecycle state, and missing, unlabelled or
tombstoned provenance are withheld from every principal, including the owner.
Each provenance event must still exist; its captured text is not included in a
working-claim line.

Type scope uses the claim's declared frontmatter type. Subject scope applies to
the primary subject named in the line. Time scope uses `valid_from`, consistent
with correction target authorization. A missing scoped field fails closed.
An owner correction may explicitly lower a derived claim's label without
allowing the reader to see the private source record.

Claim-controlled scalar fields are JSON-escaped so embedded newlines cannot manufacture new
packet sections. Each line carries sensitivity, taint and authority stamps.

## Derived statements

Conflicts are computed from readable claims and report only those members.
Superseded claims can support historical gaps but never appear as current facts
or alias evidence. Validity gaps require the complete bounded history to be readable: removing a
hidden interval could invent a hole. If the history exceeds the 400-claim scan
bound, no gap is asserted.

An alias requires access to both subject identities and all its evidence. Its
sensitivity is the strictest valid evidence label. Evidence can name an event or
a claim; typed `event:` and `claim:` references select that namespace. A legacy
bare identifier must resolve to exactly one namespace. Missing, dead, ambiguous
or unreadable evidence withholds the association. Type-scoped readers cannot
receive an identity link without a declared type.

## Audit and bounds

Only units actually packed into the response contribute served audit entries.
Working claims and counterevidence carry their supporting claim metadata;
aliases carry a stable association identifier, effective label and evidence
count. Audit storage hashes identifiers and does not retain claim text. A unit
that cannot fit its complete audit in the bounded row is not packed. An
unchanged delta response does not record content as newly served.

Candidate scans remain bounded. The working-claim scan considers at most 400
rows per requested subject (up to 16 subjects); each alias-root scan considers
at most 400 links before applying the smaller output limits. Packets are
briefs, not exhaustive exports. Each claim or alias may cite at most 64
evidence identifiers of at most 128 characters in this serving path; oversized
persisted evidence is withheld before lookup.

## Verification

```bash
bun test packages/core/test/serving/packet-claim-boundaries.test.ts
bun test packages/core/test/serving/packet.test.ts
bun run verify
```

The fixtures cover ceiling, subject, type and time boundaries; owner
classification corrections; deleted and missing-label evidence; conflicts;
interval gaps; alias evidence; audit redaction; and section-injection attempts.
