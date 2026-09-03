# Kizuki product context

Document kind: product direction for humans and agents  
Implementation claim: none; verify shipped behavior against the code and [README.md](../README.md)  
Product stage: single-person private brain first; 1.0 is not tagged

## Product identity

Kizuki is a local-first personal intelligence substrate. It is not an agent
harness and does not own an agent loop. Harnesses, assistants, automations,
and future interfaces connect to Kizuki as clients.

The product turns a person's fragmented digital history into a durable,
source-linked, queryable personal world model. It should let the owner and
their chosen agents recover relevant context, understand why a belief exists,
and improve the model as new evidence or correction arrives.

That world model is broader than a contact book or work tracker. It can cover
people, projects, and commitments, but also ideas, concepts, philosophies,
skills, tools, and the owner's demonstrated aesthetic and decision taste.

## Inputs are evidence

Kizuki is intended to connect to:

- apps and online services;
- databases and files;
- ambient capture systems;
- agent and coding-session histories; and
- other histories the owner explicitly chooses to ingest.

Every meaningful interaction with an agent is evidence. Prompts, responses,
decisions, corrections, accepted work, rejected work, and outcomes can all
change what the personal model should know. A harness is therefore a source
and a consumer, not the place where personal memory is owned.

Raw histories remain attributable to their sources. Kizuki distils them into
a source-linked working model instead of presenting an undifferentiated log.
The owner or an authorized agent must be able to trace material knowledge
back to the evidence that supports it.

## Knowledge layers

Kizuki has three conceptually distinct knowledge layers:

1. **Evidence.** Captured source records and agent interactions, with stable
   source identity, time, provenance, revisions, and deletions.
2. **Working model.** A reversible, source-linked interpretation of the
   evidence. It reconciles entities, tracks current beliefs, and can update
   automatically as evidence changes.
3. **Canon.** Durable, human-owned Markdown for important truths the owner has
   chosen to preserve. Canon remains readable without Kizuki.

Searchable derived layers sit alongside these layers. The product direction
includes full-text, semantic/vector, graph, and timeline retrieval. Derived
state is embedded for useful local access but remains rebuildable from owned
evidence and canon.

## Reconciliation and conversational correction

The working model should reconcile fragmented identities across sources. One
person, organization, project, place, or concept may arrive under several
handles and names. Kizuki should accumulate evidence for identity resolution
without silently turning uncertainty into permanent truth.

Natural conversational correction is a primary update path. When the owner
says that a name, relationship, status, preference, or prior interpretation
is wrong, the working model should incorporate that correction and retain its
provenance. Routine, reversible corrections should not become a ceremony.

Kizuki should surface only material ambiguity or high-impact conflict. The
exact materiality threshold is not decided here. The intended behavior is to
avoid interrupting the owner for low-value uncertainty while refusing to
silently settle consequential contradictions.

## The resolved boundary

The tension between owner-gated canon and a self-updating working model is
resolved in favor of autonomy plus reversibility. There is one durable
knowledge record — the claim — and one durable artifact — the canon page.
Automation writes both. What protects the owner is not an approval step; it
is that every write is attributable, budgeted, reversible by one command,
and outranked by the owner's own word.

High-impact and low-impact writes differ in confidence, authority and
budget, not in who presses a button.

## Agent and harness experience

Kizuki should serve harness-neutral, purpose-bounded context packets rather
than require every agent to understand the entire vault. An authorized agent
should be able to retrieve relevant evidence and knowledge through full-text,
semantic/vector, graph, and timeline views, then cite or propose updates
without acquiring unrestricted write authority.

The intended result is context-aware agent work across different harnesses:
the user's history and current working knowledge follow the authorized task,
while the harness remains replaceable.

Kizuki is intended to be a portable shared brain between the owner and any
authorized agent, harness, or model. Switching tools should not require the
owner to re-explain personal context, working conventions, or capabilities
that prior agents have already learned and evidenced.

Kizuki should compile and serve relevant reusable agent skills and tooling
context, subject to permission, task scope, freshness, and provenance. The
goal is for an authorized agent to work effectively from day one without
receiving an indiscriminate dump of the owner's history. This is product
direction, not a claim that skill compilation is implemented.

## Taste as source-linked working knowledge

Taste is first-class working knowledge. Kizuki should learn from demonstrated
preferences, recurring creative standards, accepted and rejected outputs,
corrections, and the contexts and evidence behind those choices. This should
help an agent produce work aligned with the owner rather than generic output.

Taste must remain revisable, scoped, and source-linked. A preference shown in
one medium, project, or period is not automatically a universal or permanent
personality label. Agents should receive the taste context relevant to the
task, including confidence, source, and freshness where available.

## Progressive ingestion

Ingestion should become useful before a complete historical import finishes.
Recent and high-value material can be processed first, older history can
backfill progressively, and checkpoints can resume safely. New events,
corrections, revisions, and source deletions should continue to update the
working model without requiring a full rebuild of the user's experience.

## Proactive intelligence

The product direction includes:

- proactive briefings and material insights;
- a future auto-wiki enrichment and research layer;
- prioritization informed by the owner's evidence and current commitments;
- evidence-backed scenarios and prediction outputs; and
- context-aware agent work that can use these outputs without confusing them
  with canonical fact.

Proactive output should expose supporting evidence and uncertainty. A
scenario or prediction is an analysis, not a fact merely because Kizuki
generated it.

## Autonomy modes

The intended autonomy model has three modes:

1. **Autonomous by default.** The loop writes canon within its configured
   budgets. Every write is receipted and reversible.
2. **Delegated scope.** An agent or automation reads and proposes within an
   explicit grant: sensitivity ceiling, scope filters, tool allowlist, rate
   limit, audit.
3. **Correction.** The owner's statement outranks every other source,
   supersedes immediately, and rewrites affected canon in the same pass.

These modes do not make Kizuki an action harness. They describe how clients
may be authorized to read, interpret, propose, or update permitted Kizuki
state. Access alone never creates authority.

## Deployment direction

The first product is one person's private brain. Local custody, provenance,
reversibility, and a readable exit remain the foundation.

Consented federated shared worlds may come later. Federation must not turn
private personal context into an implicitly shared global model. The consent,
identity, conflict, revocation, and data-boundary protocol for shared worlds
is not decided here.

## Explicit non-decisions

This context does not decide:

- the federation protocol or shared-world permission model;
- the default proactive delivery channels;
- the representation and compilation format for reusable agent skills; or
- the confidence, review, and expiry rules for inferred taste.

RFC 0002 decided the former open items: materiality uses `CONFLICT_MARGIN`
(§5.4); semantic retrieval is a port with a lexical floor and an optional
embedded engine (§9); working-model updates and canon writes are one
receipted path (§4); provider precedence follows the authority order in
§5.

Those decisions require their own evidence and acceptance criteria. Agents
must not infer them from this product context.
