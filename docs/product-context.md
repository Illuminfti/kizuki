# Kizuki product context

Document kind: product direction for humans and agents  
Implementation claim: none; verify shipped behavior against the code and README  
Product stage: single-person private brain first

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

## The current design tension

Two requirements must coexist:

- Owner-gated canon and the prohibition on silent canon merges remain in
  force for high-impact canonical truth.
- Beneath canon, the working model must support automatic, reversible updates
  and low-friction reconciliation.

The working model is the pressure-release layer between raw evidence and
canon. Automation may update this reversible layer, preserve competing
evidence, and prepare proposed canonical changes. High-impact canon still
requires the owner's explicit promotion. This document does not define the
final boundary between low-impact working knowledge and high-impact canon.

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

1. **Approval by default.** Consequential changes and high-impact canon wait
   for explicit owner approval.
2. **Delegated scope.** The owner may grant a bounded agent or automation
   authority within an explicit scope.
3. **Bounded YOLO.** The owner may explicitly authorize a tightly bounded
   autonomous scope with deterministic limits and stop conditions.

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

- the materiality threshold for surfacing ambiguity;
- the exact storage or embedding implementation for semantic/vector search;
- the final boundary between working-model updates and canonical promotion;
- the federation protocol or shared-world permission model;
- the default proactive delivery channels; or
- provider precedence when sources disagree;
- the representation and compilation format for reusable agent skills; or
- the confidence, review, and expiry rules for inferred taste.

Those decisions require their own evidence and acceptance criteria. Agents
must not infer them from this product context.
