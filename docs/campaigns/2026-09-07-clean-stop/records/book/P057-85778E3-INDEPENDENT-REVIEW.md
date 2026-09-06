# P057 independent MIME correction review

Verdict: **ACCEPT for the scoped source correction** at `85778e3f343f854e227f744aff0c13a47051278f`, reviewed 6 September 2026. No blocking specification/security or implementation/regression finding. This review does not grant account, native-package, connector, integration, merge, or release acceptance.

The private clone `PRIVATE_FLEET/code-repos/P057` is clean. The exact head has sole parent `f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7` and tree `72b73dff3e0f692c39d5db6d8c85951758201092`. Its complete diff is confined to the three paths approved in `GROK-P050-P056-REVIEW/implementation-packets.json`: `packages/connector-imap/src/mime/parse.ts`, `test/mime/parse.test.ts`, and `test/events.test.ts`. All three diffs were read. No source outside the approved parser file changes. Neither test diff removes or changes any existing line.

## Specification and security

The implementation follows the frozen contract: numeric continuation ordering, percent decoding only for encoded pieces, collection of the complete octet sequence, and one final character-set decode. This aligns with RFC 2231's ordered continuations and single charset for a mixed encoded/unencoded value. The standard places charset/language information at the beginning and requires an encoded first segment when those fields are given. [RFC 2231 sections 3 and 4.1](https://www.rfc-editor.org/rfc/rfc2231.html#section-4.1)

The new source retains the existing parser's permissive handling of malformed continuation numbering and selects the first encoded piece's charset as the approved packet requests. It does not claim to add full RFC syntax validation. No malformed-input, timing, predecessor, or vulnerability experiment was run for this review.

The parameter parser is reached from byte-preserving header text: `parseHeaders` maps each input byte to one character under the existing 65,536-byte/200-field bounds. `appendRawBytes` therefore restores ordinary unencoded wire octets when a mixed value must be decoded as a whole. An unencoded percent sign stays literal. Header, MIME-depth/part-count, attachment reference, and event provenance policies are unchanged.

The added inputs are small synthetic MIME messages, literal neutral filenames, and an `.example` sender. There are no account connections, secrets, private fixtures, new filesystem effects, new dependencies, native changes, or unsupported provider claims.

## Implementation and regression

`decodeContinued` sorts the same collected local pieces used by the prior implementation. When none is extended, it joins their original strings directly, preserving plain continuation behavior without lossy byte conversion. Ordinary non-continuation parameters continue through the unchanged assignment path.

The single extended-parameter path calls the same assembler with one encoded piece. Its prefix splitting, percent conversion, and `decodeCharset(...).text` behavior are equivalent to the prior `decodeExtended` path. The percent-decoding loop is moved without changing its existing conversion policy.

For extended continuations, the charset is read once and later bytes share it. This repairs both the Latin-1 later-segment case and a UTF-8 character whose octets span segments. The unchanged `decodeCharset` still defaults an empty label to UTF-8 and falls back to Windows-1252 for an unavailable/unknown label; this review establishes preservation by source comparison, not a new fallback execution claim.

The thirteen added ordinary input cases are expressed in twelve test executions. They cover Latin-1 and split UTF-8 filenames, mixed encoded/plain segments, literal percent signs, numeric ordering independent of parameter order, all-plain continuation, and both disposition `filename` and content-type `name`. The event-level case independently expects `café.txt`, section ID `2`, source record ID `9:4:Archive/2026`, exact text and attachment size, and a valid event. Expected Unicode strings are authored literals, not generated from production output. Existing plain, whole-character continuation, single extended-parameter, MIME, and event assertions remain intact.

The three small helpers keep byte collection separate from charset decoding and share the same logic for single and continued extended values. No second parser, new abstraction layer, mutable global state, or unrelated refactor was introduced.

## Exact execution evidence

Root's sealed production-runner receipt is `PRIVATE_FLEET/test-controller/runs/1f059846c9eb45ee9433a52d0854f6cc/result.json`. It tested:

```text
bun test packages/connector-imap/test/mime/parse.test.ts packages/connector-imap/test/events.test.ts
```

The retained logs show **77 pass, 0 fail, 235 assertions across two files**, using Bun 1.3.14, with Bun reporting 199 ms. The runner reports exit 0, no termination reason, confirmed cleanup, and `stale: false`. Before and after input digests both equal `7d4b2a3cb3f1a17e9afc0492a7d3e32e7e80392acc6a2aaf00b68342ab34968c`. The fixed image is `sha256:aca1b9d024834903f414fcbb90e096ec406152e8b08177bb00f4b991cc811eef`; source/dependencies are read-only and networking is disabled.

I independently compared each Git blob at the reviewed head with both the current file bytes and the receipt's frozen overlay hash:

| Path under `packages/connector-imap/` | SHA-256 |
| --- | --- |
| `src/mime/parse.ts` | `e04742e004ac92a7803075b359700334293294a48aae339849d3f0dabeda7863` |
| `test/mime/parse.test.ts` | `abbd3dd7538f60092944c642a53961711305b1925efa8a2371e6742388ebb65d` |
| `test/events.test.ts` | `8ab1a66da3d21f8f2612e7ad72a5b51a525363916a3c9286c94a87ec2616c702` |

All match. Rehashed stdout is `d6684989b8dd63b37d2f1954270826fbe1bd89a8debd12bcacf03ed1c6140ef6` (28 bytes); stderr is `82702a6eb15f083976c6ec37b10d8012cf5f7721276c37896c1e060e0e9186de` (6,821 bytes). `git diff --check f57acb3046e6bdd7cbee3b260cdfe6114b8f58c7...85778e3f343f854e227f744aff0c13a47051278f` passed. This reviewer made no candidate edit and launched no additional execution.

Typecheck, the full non-live connector/repository gates, final compiled-package journeys, and P058 real mailbox qualification remain separate evidence requirements. This focused review does not establish those outcomes.
