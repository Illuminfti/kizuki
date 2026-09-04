# Upstream attribution and integration policy

Policy date: 2026-09-01; amended 2026-09-02; amended 2026-09-04  
Scope: dependencies, adapters, reference implementations, evaluated projects,
and any future code or assets incorporated into Kizuki

The 2026-09-02 amendment records the adoption decision for the retrieval
engine and adds the local embedding and rerank reference candidate, per
`docs/decision-log.md` D13 and `rfcs/0002-autonomous-canon.md` §9.1 and §9.4.
The 2026-09-04 amendment records the owner override that the retrieval
recipe and entity graph are a permitted fork of the public tip (D17), not
clean-reimplementation-only.
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
| [GBrain](https://github.com/garrytan/gbrain) | Hybrid retrieval recipe: reciprocal rank fusion at `k = 60`, layered near-duplicate post-filter, authority-weighted finalization, declared-degradation envelope, entity-graph adjacency and hop walk | MIT, copyright 2026 Garry Tan; retain the copyright and permission notice for copied or substantial portions. LICENSE text at the public tip has no product identifier. | **Permitted fork (owner override 2026-09-04, `docs/decision-log.md` D17)** of the retrieval recipe and entity graph into `@kizuki/retrieval-pg` (`packages/retrieval-pg/vendor/`). Not a registry dependency: the project is **not published to a package registry under a name Kizuki can depend on**, so `bun add` remains unavailable. The rest of the upstream tree (CLI, admin, model SDKs, query cache, markdown mutation) is not vendored. Path-derived source-boost maps and personal slug prefixes were not copied. Hybrid is the default search path on this port when an embedding space exists; otherwise it degrades to lexical and declares `vector-skipped`. `kizuki.retrieval.fts5` remains the zero-model fallback. | Evaluated 2026-09-04 at public `master` tip, package 0.48.2.0, commit `8c70f6255047a7647adb30b1d6333a48068d9fa5` (reachable from the public default branch). The 2026-09-01 evaluation of package 0.9.1 at `aeb477d39b730ffc61c4435bc686c47618cd8e46` remains on the record as a **rejected pin**: that snapshot is not reachable from any public upstream branch, is hundreds of commits behind, and carries personal configuration. The engine still has no reranker and no local GGUF path; those remain Kizuki's own work (`@kizuki/embed-gguf` / RFC 0002 §9.4). The public tip's dependency surface (model SDKs, HTTP admin, object storage) is why the fork is recipe-and-graph only. | First non-trivial implementation of `kizuki.retrieval/v1`, behind the port rather than in core (D13, D16, D17). Credit lives only here and in the README. |
| [QMD](https://github.com/tobi/qmd) | Local GGUF embedding and rerank model stack: a 300M-parameter GGUF embedding model at 768 dimensions with fixed query/document prompt framing, 800-token chunks with 15% overlap and a break-point search, and a cross-encoder rerank pass | MIT. Re-confirmed 2026-09-02 at commit `dbfd0b4736aeaf761d1a16ca8e424f071df8feb9`: `package.json` declares `"license": "MIT"`, and a `LICENSE` file now ships in the tree (Copyright (c) 2024-2026 Tobi Lutke). Preserve that notice if any copied or substantial portion is redistributed. | Reference candidate. Clean reimplementation of the public recipe against the GGUF runtime, per RFC 0002 §9.4; the implementation is Kizuki's own work in `@kizuki/embed-gguf` for `kizuki.embedding.gguf`. Not a dependency; no vendored code; no model weights are fetched or committed. | Evaluated 2026-09-02 at public revision `dbfd0b4736aeaf761d1a16ca8e424f071df8feb9` (package 2.8.3). Recipe prompts and 800-token / 15% overlap chunk parameters are recorded on the embedding space. Rerank and transformer GGUF inference remain unbound. | It is the reference for the zero-endpoint default embedding path, which is what makes vector retrieval possible with no network egress. Its measured costs (warm in-process embed, per-chunk CPU seconds, vector storage, native runtime footprint) are stated plainly in RFC 0002 §9.4 rather than implied to match a hosted endpoint. |
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
