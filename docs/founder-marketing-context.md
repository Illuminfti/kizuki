# Kizuki founder positioning context

- Document kind: internal founder-conversation synthesis
- Status: directional messaging reference; not public copy or a product specification
- Source: founder conversation on 2026-09-02; synthesized, not a verbatim transcript
- Implementation claim: none; verify shipped behavior against the code and README

## Purpose

This document preserves the product and messaging reasoning that future Kizuki
marketing work should begin from. It records a working thesis, language worth
developing, boundaries that must remain intact, and the strongest objections
the story still has to answer.

It does not settle the product specification, authorize public claims, or
replace the repository's binding technical direction. Before describing
behavior as shipped, read [the current direction](CURRENT.md),
[the product context](product-context.md), and
[RFC 0002](../rfcs/0002-autonomous-canon.md), then verify the implementation.

## Executive product narrative

AI still starts cold.

People who direct serious work across assistants, coding agents, creative
tools, and models repeatedly explain the same history: what they are building,
who matters, which decisions were made, what a good result means, which
approaches already failed, and why. Some of that context survives in notes,
files, and old chats. Much of it remains scattered across tools that neither
understand one another nor travel together.

The loss is larger than missing facts. It is lost continuity of judgment.
Every fresh agent can rediscover the nouns while still missing the reasons,
relationships, corrections, and standards that made earlier work valuable.
The person pays again through setup, supervision, avoidable mistakes, and
generic output.

Kizuki's thesis is a private, local-first, portable memory layer for an AI
life. It turns scattered traces into a source-linked, living map of relevant
history, context, decisions, corrections, and demonstrated taste. Authorized
agents consult that map as clients. They do not own it, and changing agents or
models should not erase what was already learned.

The intended model is self-correcting rather than ceremonially curated.
Evidence can produce grounded best-guess updates to a readable working
understanding. Each material update should retain provenance, revision,
uncertainty, validity, and a path to correction or reversal. The owner corrects
Kizuki in the flow of conversation; they should not have to promote every
routine learning by hand. The binding product direction goes further: updates
to claims and canon are autonomous, budgeted, receipted, and reversible, with
the owner's word outranking other sources. That is direction, not a claim that
the complete experience ships today.

Kizuki does not make a person "queryable," as though a life could be reduced
to a database row. It makes the context around their life queryable. With
evidence and history, it should help answer questions such as:

- Why was this decision made?
- What did we learn the last time we tried this?
- Who has touched this project, and in what role?
- What does this person's standard of quality mean in this context?
- Which approach was rejected, and why?
- What important detail has the current agent forgotten?

The promise is continuity, not omniscience: a fallible, inspectable working
understanding that can become more useful without pretending to become the
person.

## The customer problem

The first customer is someone already directing substantial work through AI:
an AI-native builder, founder, creative director, operator, or researcher who
uses multiple agents and tools over time.

Their recurring costs are:

- repeating project history and personal working context in every new tool;
- teaching the same standards, references, and preferences again;
- correcting errors that an earlier conversation had already resolved;
- losing the reasoning behind decisions while retaining only their outcomes;
- searching fragmented chat histories for evidence that cannot travel with
  the next task; and
- becoming dependent on whichever platform currently holds the richest memory.

The initial wedge is not every fact in a person's life. It is the high-value
context that compounds for people directing AI work: demonstrated taste,
references, corrections, decisions, rejected approaches, and the evidence
that explains them.

## Product thesis

### Agents are clients, not owners

Kizuki is the continuity layer beneath replaceable tools. An assistant,
coding harness, model, or automation receives relevant, permission-bounded
context and returns evidence or relays the owner's corrections within its
grant. Personal memory remains portable when that client changes.

### A living map, not a larger transcript pile

Raw history matters as evidence, but storage alone does not produce
understanding. Kizuki should preserve relationships between people, projects,
decisions, preferences, and time; keep meaningful knowledge linked to sources;
and distinguish current belief from superseded or uncertain interpretation.

### Correction is part of memory

A useful memory system must remember not only an assertion but also its
revision history and the correction that changed it. A grounded working model
may be wrong. Its advantage is that the error is attributable, revisable, and
able to stop recurring across authorized agents.

### Readable ownership is the exit

Local-first is a trust and custody decision, not permission to burden the
owner with infrastructure. Durable knowledge should remain readable and
portable outside Kizuki. Derived indexes can be rebuilt; the person's
hard-won context should not be trapped inside a vendor's private format.

### Continuity of judgment is the value

Search retrieves what was said. Kizuki's higher ambition is to preserve why
it mattered, what changed afterward, and which standard should guide the next
decision. The product earns its place when the next agent begins with more of
the right judgment and less ritual re-explanation.

## Messaging pillars

### 1. Continuity, not storage

The category story is not "one more place for all your data." It is continuity
of context and judgment across sessions, models, and tools.

Useful motif: hard-won learning should not vanish when a chat ends or a
platform changes.

### 2. From scattered traces to a source-linked living map

The visual and verbal transformation is fragmentation becoming relationship:
isolated chats, decisions, corrections, references, and outcomes resolving
into an inspectable map whose claims still point back to evidence.

Useful motif: noticing or realization. The product helps surface the thread
that was present but difficult to see.

### 3. Agents consult the map; they do not own it

Portability is a product principle and a competitive argument. Context should
follow an authorized task without forcing the owner to stay with one model,
harness, or platform.

### 4. A working understanding that can correct itself

Kizuki should feel alive enough to update and humble enough to preserve
uncertainty, provenance, revisions, and reversibility. Conversational
correction is central to the experience, not an administrative afterthought.

### 5. Taste and judgment are real working context

People directing AI work lose quality when systems remember facts but forget
standards. Accepted work, rejected work, references, corrections, and their
contexts can form source-linked, revisable guidance without becoming permanent
personality labels.

## Working language

### Preferred strapline

> Kizuki — Let nothing learned be lost.

### Working positioning line

> Kizuki is the memory layer for your AI life: it makes your history,
> judgment, and context queryable—so every agent can start where you left off.

When using this line, retain the nearby distinction that Kizuki makes a
person's context queryable, not the person themselves. Public derivatives
must also make "every agent" mean every authorized agent operating within
the task's scope.

### Alternate lines to explore

These are alternates, not approved replacements for the preferred strapline:

- The memory of becoming.
- What matters, endures.
- A life, made legible.
- What you know, carried forward.
- Let the thread remain.

### Supporting phrases worth developing

- Continuity for an AI life.
- A private memory layer beneath every authorized agent.
- Your context should outlive the tool that learned it.
- A source-linked map of what changed, what mattered, and why.
- Begin where the last agent left off.

## Product boundaries and anti-slop rules

Future messaging must preserve these boundaries:

- Do not claim total understanding, perfect memory, or infallible recall.
- Do not say Kizuki captures a soul, becomes the user, or knows them
  completely.
- Do not reduce a person to a database, profile, score, or collection of
  traits.
- Do not present a best-guess interpretation as timeless truth. Preserve
  provenance, uncertainty, validity, revision, and correction.
- Do not imply that local-first automatically produces a good experience.
  Custody must coexist with progressive ingestion, sensible defaults, and
  low operational burden.
- Do not turn the owner into a data janitor. Routine learning and correction
  must happen in the work, not through a permanent filing ceremony.
- Do not describe Kizuki as merely notes, chat history, semantic search, a
  vector database, or generic retrieval over everything.
- Do not let category breadth obscure the first wedge: reusable taste,
  references, corrections, decisions, and rejected approaches for people
  directing AI work.
- Do not invent cultural claims about the name or use decorative mysticism
  as a substitute for explaining the product.
- Do not imply that future direction is shipped. Public claims require
  current implementation evidence.

The desired voice is emotionally resonant, precise, philosophical, restrained,
and concrete. Avoid generic AI superlatives, synthetic intimacy, and grand
claims that cannot survive a skeptical second reading.

## Adversarial critique and counter-thesis

### "The major AI platforms will add memory anyway."

They will, and first-party memory can be deeply convenient. The counter-thesis
is not that platform memory cannot work; it is that a platform is naturally
incentivized to make its own experience better and retain context within its
boundary. Kizuki matters only if portable ownership, source linkage, readable
exit, and cross-agent continuity are valuable enough to justify an independent
layer.

Evidence still needed: a cross-tool workflow where Kizuki materially reduces
re-explanation or repeated correction compared with native memories.

### "Local-first sounds worthy but painful."

That criticism is correct if custody becomes installation chores, connector
maintenance, or manual taxonomy. Local-first is trust architecture, not the
headline user task. Progressive ingestion, safe defaults, quiet maintenance,
and a readable exit must make ownership feel simpler rather than more pious.

Evidence still needed: time-to-first-useful-context and ongoing maintenance
burden on an ordinary single-owner setup.

### "This is semantic search over chat logs with better poetry."

If Kizuki returns only similar text, the criticism wins. The counter-thesis is
that continuity requires more: source identity, entities and relationships,
current and superseded claims, corrections, time, sensitivity, and evidence
that explains why a belief exists. Retrieval is necessary infrastructure, not
the product's complete value.

Evidence still needed: tasks where relationship, revision, or provenance
changes the answer in a way plain transcript search cannot.

### "The category is too broad to enter."

"Memory for your life" is too broad as a starting product. The wedge is the
compounding context of people who already direct work across several AI tools:
taste, references, corrections, decisions, rejected approaches, and project
history. Expansion should follow repeated value there, not precede it in the
story.

Evidence still needed: a narrow cohort with frequent cross-agent continuity
pain and an observable willingness to change workflow for relief.

### "A machine cannot understand a person's taste or judgment."

It cannot possess a complete, final representation of either, and Kizuki must
never claim otherwise. It can maintain a scoped, source-linked, fallible
working model based on demonstrated choices and explicit corrections. The
standard is not perfect personhood; it is fewer generic misses, visible
evidence, and faster correction when the model is wrong.

Evidence still needed: blind evaluations showing that relevant taste context
improves outputs without overgeneralizing preferences across projects or time.

### "The user will become the system's librarian."

That is the central product failure mode. The counter-thesis depends on useful
automatic ingestion, bounded autonomous updates, and correction inside normal
conversation. Taxonomy, promotion queues, and continual manual cleanup cannot
be the price of continuity.

Evidence still needed: longitudinal use showing that accumulated value exceeds
the owner's correction and maintenance cost.

## Handoff for a future marketing agent

Treat this document as founder context, not finished copy. Begin with the
customer's repeated loss of judgment and continuity, then make the independent
memory-layer thesis concrete through one narrow cross-agent workflow. Preserve
the distinction between making life context queryable and reducing a person to
data. Use the preferred strapline as the lead candidate; label every other line
as exploratory.

Before producing a landing page, launch narrative, category memo, or public
claim:

1. Read the current product and technical sources linked at the top.
2. Verify what is implemented at the repository's current head.
3. Choose one audience and one continuity failure rather than marketing the
   whole life-memory vision at once.
4. Pair each promise with an observable proof or explicitly mark it as vision.
5. Test the narrative against every adversarial critique above.
6. Keep the raw founder conversation private; use this scoped synthesis as the
   transferable reference.

The emotional center is simple: what a person and their agents worked hard to
learn should remain available, attributable, correctable, and theirs.
