# Upstream attribution and integration policy

Policy date: 2026-09-01; amended 2026-09-02  
Scope: dependencies, adapters, reference implementations, evaluated projects,
and any future code or assets incorporated into Kizuki

The 2026-09-02 amendment records the adoption decision for the retrieval
engine and adds the local embedding and rerank reference candidate, per
`docs/decision-log.md` D13 and `rfcs/0002-autonomous-canon.md` §9.1 and §9.4.
This file and `README.md` are the only two files in the tree where the
retrieval engine's product name and canonical URL may appear, and only with
the exact spelling `scripts/verify-attribution.ts` enforces. Everywhere else
it is "the retrieval engine (see `docs/upstream-policy.md`)".

## Principle

Kizuki should synthesize proven work in local knowledge systems, agent memory,
retrieval, enrichment, and personal operations without erasing its lineage or
copying beyond the rights an upstream grants. Credit is part of engineering
quality. License compliance, architectural fit, privacy, and acceptance tests
are gates, not paperwork after integration.

A mention in this document does not make a project a Kizuki dependency. The
repository manifest, lockfile, imports, and distributed artifacts decide what
is actually present.

## Integration boundaries

- **Direct dependency:** imported or bundled code recorded in the manifest and
  lockfile. Its exact version, license, notices, and redistribution obligations
  must be verified before merge.
- **Adapter:** Kizuki-owned boundary code speaks an upstream protocol or API.
  The upstream implementation is not bundled unless separately declared.
- **Permitted fork:** a deliberate derivative of upstream code. Preserve its
  history and notices, mark modifications, document the license, and prefer an
  upstream contribution when the change belongs there.
- **Clean reimplementation:** reproduce an evidenced behavior or public
  contract without copying protected implementation text or assets.
- **Reference candidate:** studied for product or engineering lessons only. It
  is neither a dependency nor a claim of compatibility.

## Initial upstream registry

| Upstream | Capability used or evaluated | License and notice duty | Kizuki boundary | Version or evaluation state | Why it matters to Kizuki |
| --- | --- | --- | --- | --- | --- |
| [Bun](https://github.com/oven-sh/bun/blob/main/LICENSE.md) | TypeScript runtime, test runner, package tooling, and the `bun:sqlite` interface | Bun source is MIT; retain the copyright and permission notice when redistributing copied source. A redistributed Bun binary includes separately licensed components and requires its complete bundled notice set. | Direct runtime/tooling dependency; Kizuki does not redistribute Bun today | CI is pinned to 1.3.10; re-evaluate bundled notices before any binary distribution | A compact local runtime and SQLite integration keep installation and operation simple |
| [TypeScript](https://github.com/microsoft/TypeScript/blob/main/LICENSE.txt) | Strict static checking and compilation during development | Apache-2.0; redistribution must include the license, preserve applicable notices, and mark modified upstream files | Direct development dependency, not shipped application code | Manifest range `^5.9.0`; lockfile snapshot 5.9.3 | Strong contracts reduce ambiguity at evidence, policy, and connector boundaries |
| [SQLite and FTS5](https://www.sqlite.org/copyright.html) | Local ledger, derived indexes, graph state, full-text search, and transactions | SQLite, including FTS5, is dedicated to the public domain; attribution is a courtesy rather than a SQLite license condition | Embedded storage primitive reached through Bun; not a separately vendored fork | Current repository implementation; compatibility is verified by the Kizuki test suite | It provides inspectable, transactional, single-owner local storage without a server |
| [Model Context Protocol specification](https://modelcontextprotocol.io/specification/2026-07-28) | Planned harness-neutral serving contract | The official specification project is Apache-2.0. Preserve the license and applicable notices if specification text or schemas are copied or modified. A protocol implementation alone is not a copy of the specification. | Protocol reference and planned adapter; not yet a shipped serving dependency | Architecture target only; pin a protocol revision in the serving ADR before implementation | It can make scoped Kizuki context portable across replaceable agent harnesses |
| [Official MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/LICENSE) | Possible implementation aid for the planned adapter | Current repository licensing is mixed: new contributions are Apache-2.0 while earlier contributions remain MIT until relicensed. Preserve the license and notice that applies to every distributed file. | Evaluation candidate only; no manifest entry or import is present | Reassess the exact release and per-file licensing when the adapter is implemented | Reusing a maintained SDK may reduce protocol drift if its dependency and license cost remain acceptable |
| [GBrain](https://github.com/garrytan/gbrain) | Hybrid retrieval recipe: reciprocal rank fusion at `k = 60`, layered near-duplicate post-filter, tier-weighted finalization, declared-degradation envelope | MIT, copyright 2026 Garry Tan; retain the copyright and permission notice for copied or substantial portions | **Adopted 2026-09-02 per `docs/decision-log.md` D13 and RFC 0002 §9.1** as a clean reimplementation of the retrieval recipe with prominent credit; a permitted fork remains open for the entity graph only, if reimplementation proves wasteful. Not a Kizuki dependency, and it cannot become one: the project is **not published to a package registry under a name Kizuki can depend on**, so `bun add` is unavailable and the only lawful boundaries are permitted fork or clean reimplementation. | Evaluated 2026-09-01 at package 0.9.1, commit `aeb477d39b730ffc61c4435bc686c47618cd8e46`. **That commit must not be the pinned revision**: it is a fork snapshot not reachable from any public upstream branch, hundreds of commits behind the public tip, and it carries personal configuration. Any future pin must name a revision reachable from the public upstream and be re-evaluated, because the public tip has a materially larger dependency surface. The engine has no reranker and no local GGUF path; anything Kizuki promises in those areas is Kizuki's own work (RFC 0002 §9.4), and promising otherwise would be a fake-surface breach. | First non-trivial implementation target for `kizuki.retrieval/v1`, behind the port rather than in core (D13, D16). Credit lives only here and in the README. |
| [QMD](https://github.com/tobi/qmd) | Local GGUF embedding and rerank model stack: a 300M-parameter GGUF embedding model at 768 dimensions with fixed query/document prompt framing, 800-token chunks with 15% overlap and a break-point search, and a cross-encoder rerank pass | MIT, declared in the repository's `package.json` `license` field and in its README. **No `LICENSE` file ships in the tree**, so the MIT text and copyright notice must be reproduced from the README (and confirmed against the upstream repository) before any copied or substantial portion is redistributed. | Reference candidate. Clean reimplementation of the public recipe against the GGUF runtime, per RFC 0002 §9.4; the implementation is Kizuki's own work in the optional package for `kizuki.embedding/v1`. Not a dependency; no vendored code. | Evaluated 2026-09-02. Record the immutable revision and re-confirm the license text at the pull request that lands `kizuki.embedding.gguf`. | It is the reference for the zero-endpoint default embedding path, which is what makes vector retrieval possible with no network egress. Its measured costs (warm in-process embed, per-chunk CPU seconds, vector storage, native runtime footprint) are stated plainly in RFC 0002 §9.4 rather than implied to match a hosted endpoint. |
| Owner-controlled LifeOS reference implementations | Scoped recall, provenance, reversible knowledge, recovery, personal operations, and evidence-bounded proactive patterns | No public redistribution license is asserted by this policy | Clean reimplementation of verified behavior only; no private code, data, configuration, or deployment assumptions enter Kizuki | Read-only capability audit on 2026-09-01; see `docs/lifeos-capability-gap.md` | Proven local behavior can inform Kizuki while its implementation remains portable and public-safe |
| Future auto-wiki, enrichment, and retrieval projects | Research and enrichment candidates have not been selected | Unknown until a named candidate and immutable revision are reviewed | Reference candidate only; no dependency or compatibility claim | Unselected | Kizuki needs an explicit evidence and license review before adopting an enrichment mechanism |

## Required evaluation record

Before adding or materially upgrading an upstream, the pull request must record:

1. the upstream name, canonical URL, immutable revision or exact version, and
   evaluation date;
2. the capability Kizuki needs and the evidence that the candidate supplies it;
3. the license, applicable notices, patent or trademark conditions, and the
   intended distribution model;
4. one declared boundary from this policy, plus proof that the manifest,
   imports, and documentation agree with it;
5. privacy and network behavior, including whether any owner data can leave
   the machine;
6. fixture-based acceptance, failure, deletion, recovery, and upgrade tests;
   and
7. the upstream contribution plan for generally useful fixes.

An unselected project, a copied README claim, or a locally installed service is
not sufficient evidence of integration.

## Notices, copying, and credit

- Keep required license texts and notices with every redistributed dependency,
  source fragment, schema, binary, or asset. Do not paraphrase a mandatory
  notice into disappearance.
- Do not copy code, documentation, fixtures, visual assets, prompts, or data
  merely because they are publicly visible. Confirm the grant and preserve the
  required record first.
- Credit material inspiration prominently in the README and the relevant
  design record even when a clean reimplementation does not legally require a
  notice.
- Separate factual compatibility from aspiration. “Evaluated,” “planned,” and
  “inspired by” must never be rewritten as “integrated” without repository
  evidence.
- Prefer adapters over forks when a stable contract exists. Prefer a focused
  upstream contribution over maintaining a private patch whose value is
  generally useful.
- Recheck licenses and notices at every upgrade. Repository ownership, package
  contents, transitive dependencies, and license terms can change.

## Release gate

A release fails closed when a direct dependency or distributed artifact lacks
an attributable version, license determination, required notice, or tested
privacy boundary. Exceptions require a documented owner decision; silence is
not approval.
