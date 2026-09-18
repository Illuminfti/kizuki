# Kizuki Reflex — evidence before action

Reflex checks a plan's explicit assumptions against **selected, current, authorized
ledger evidence**. It returns a typed contradiction matrix, prioritized findings,
source lineage, and a script-free report. It never executes a plan, changes canon,
or converts a model judgment into an authorization decision.

The useful shift is from “what does my memory say?” to **“what is my agent about
to assume, and where does my memory disagree?”** A launch agent can discover an
unresolved launch hold before scheduling a campaign. A coding agent can flag a
plan that contradicts a recorded requirement. The model is a fallible judge of
source/assumption pairs, not the owner of memory or the action executor.

## Run it from this checkout

Use the repository-pinned Bun version and install the workspace normally. Obtain
current bare event IDs through an authorized Kizuki read. Create a private JSON
file; replace the placeholder with actual event IDs:

```json
{
  "assumptions": [
    { "id": "launch", "statement": "The campaign is approved for Friday.", "importance": "critical" },
    { "id": "budget", "statement": "The approved campaign budget is £4,000.", "importance": "normal" }
  ],
  "event_ids": ["REPLACE_WITH_LEDGER_EVENT_ID"],
  "max_age_ms": 604800000
}
```

```sh
# No model calls. Returns an explicit unavailable report with unknown findings.
bun packages/cli/src/main.ts reflex --request ./plan.json

# Explicit owner opt-in to the configured SystemOne port.
# Source-level read and exact-destination model consent still apply.
bun packages/cli/src/main.ts reflex --request ./plan.json --allow-model

# Deliberate private export, with no external assets or scripts.
umask 077
bun packages/cli/src/main.ts reflex --request ./plan.json --allow-model --format html > reflex.html
```

The registered command is also `kizuki reflex` in a binary built from this
revision. A previously installed release does not gain the command automatically.
Exit 0 means the assessment completed, **not** permission to act. Exit 1 means
unavailable; malformed usage exits 2. JSON or HTML goes to stdout and diagnostics
go to stderr. No browser is opened and no report is saved automatically.

For a credential-free visual example using scripted judgments:

```sh
bun packages/core/test/reflex/demo.ts > reflex-demo.html
```

The demo is conspicuously labeled synthetic. It exercises the real matrix engine
and renderer, not Jev's semantic accuracy or a live vault.

## Model configuration and consent

The command reuses `[ports.systemone]` in `.kizuki/serve.toml` and the existing
Jev adapter. It does not need to start a generative LLM or the ingestion daemon.
For example:

```toml
[ports.systemone]
id = "kizuki.systemone.jev"
base_url = "https://api.typesafe.ai/v1"
model = "jev-latest"
secret_ref = "env:TYPESAFE_API_KEY"
```

Keep the actual key in the configured secret source, never in the request file,
TOML, shell command arguments, fixtures, or Git. File credentials use Kizuki's
existing managed credential reader; arbitrary unqualified file references are
not a new credential path.

Every source must independently permit:

- A current principal's read: tool, sensitivity, type, subject, occurrence window,
  source purpose and live provenance checks remain below the command layer.
- `recall` and `extract` purposes with the populated fields allowed.
- The **exact** model destination and model. In the example, that is
  `https://api.typesafe.ai/v1/systemone` and `jev-latest`.

The host binds the actual transport identity using `bindSourceModelPort`. A
source marked local-only does not become remotely accessible just because the
owner can read it. Epoch-zero legacy compatibility is not outbound consent.
Neither this command nor the library creates or widens source grants.

**Current policy limitation:** a source grant represents one remote endpoint /
model, not a list. Switching an existing grant to Jev can prevent an existing
LLM from extracting that source. Reflex does not silently solve this by widening
consent. Multi-destination grants require a separately reviewed policy change.
Provider-managed retention also remains an explicit consequence of remote
consent; vault purge cannot retract bytes already sent to a provider.

## Host integration

```ts
import { assessReflex, renderReflexHtml } from "@kizuki/core/reflex";

// ctx is the host's existing ServeContext for the actual caller.
// port is the host-selected SystemOnePort, bound to its real source destination.
const report = await assessReflex(ctx, {
  assumptions: [{ id: "launch", statement: "The Friday launch is approved.", importance: "critical" }],
  event_ids: authorizedCurrentEventIds,
}, { systemone: port, timeout_ms: 5000 });

const html = renderReflexHtml(report); // Rendering is pure; it does not save or send.
```

The library uses the existing `context_packet` capability, rate limit and audited
serving gate. It returns its own `kizuki.reflex/v1` report; it does **not** alter
the `context_packet` wire schema or register an MCP tool. Runtime composition
must remain trusted: agents cannot supply endpoints, ports, credentials, or
source-grant assertions in a Reflex request. Request statements are also sent
to the selected model when evaluation is explicitly enabled.

Only the public input parser, host entry point, report renderer, limits and
report types are exported through `@kizuki/core/reflex`. The raw matrix engine is
internal. Core does not depend on a vendor SDK or a concrete provider name.

## Decision and resource policy

Reflex evaluates at most 8 assumptions against 16 events: up to 128 atomic Choice
judgments. There are at most 4 sources per batch, a 24 KiB serialized state cap,
and 2 concurrent model batches. Statements are bounded at 512 UTF-8 bytes;
source bodies at 4 KiB. Oversized evidence is withheld from evaluation, never
truncated into apparent support. Date comparisons happen deterministically in
core. Stale and future-occurring events cannot support a current finding.

Each typed answer selects `supports`, `contradicts`, `irrelevant`, or `unclear`.
The response must contain exactly the expected question and category keys,
finite bounded probabilities and confidence, an approximately normalized
probability distribution, and a consistent winning category. Initial confidence
and winning-probability thresholds are both 0.8. **These are uncalibrated
application thresholds, not a measured probability of truth.**

Both support and contradiction produce `conflicted`, regardless of vote counts.
A contradiction alone produces `contradicted`. Support plus unresolved evidence
remains `unknown`. No evidence, low confidence, model failure or incomplete
batches cannot produce an affirmative finding. Even `supported` means only
supported in the examined sources, never a complete-world guarantee.

The overall deadline defaults to 10 seconds and is bounded at 30 seconds. Each
port call receives the remaining **duration**, as required by SystemOne, not an
absolute timestamp. The CLI disables adapter retries: each queued batch must
pass fresh consent checks. Host integrations must similarly keep retries inside
an authorization-aware transport boundary. Batches are dispatched lazily;
authority, source, claim, purge, canon and binding changes invalidate the result.

A hung port remains leased until its underlying work settles, preventing an
unbounded retry pile-up. The current port contract has no cancellation signal;
a timeout cannot unsend in-flight requests. Operational counts are actual
application dispatches and provider-reported token counts, not cost savings or
latency claims for Jev.

## Privacy and report lifecycle

Reports contain statements and authorized source metadata/hashes, not raw source
bodies or provider error text. They are ephemeral; there is no new database,
cache, daemon, telemetry stream or persistent derived store. Existing audit
records contain the normal bounded audit projection and served-source metadata.
The body hash is provenance information, not a cryptographic proof of truth.

The freshness timestamp is an upper bound of at most 60 seconds and never
extends the selected evidence's age window. Revocation or changed evidence can
invalidate it earlier. **A report is not an execution token.** An action runtime
must obtain current authority and current evidence before it acts. An old JSON
or HTML export cannot revalidate itself.

HTML is escaped, script-free, network-free, responsive and keyboard navigable.
It still contains private derived information. Explicitly saved or shared copies
are outside vault purge; do not put private reports in public artifacts or logs.

## Verification and launch boundary

```sh
bun test packages/core/test/reflex packages/cli/test/reflex.test.ts
bun run typecheck
bun run verify
```

Tests cover malformed responses, confidence thresholds, contradiction survival,
ambiguous evidence, state bounds, concurrent dispatch, deadline quarantine,
source/agent revocation, sensitivity and scope denials, exact endpoint consent,
privacy-safe HTML, bounded file input, stdout/stderr, a CLI subprocess, and the
real Jev adapter against a loopback fake endpoint. None requires a live provider.

This revision adds the library, explicit CLI command and report explorer. It does
not auto-intercept existing agents, add a local-app panel, continuously recheck
plans, simulate causal outcomes, or claim measured model accuracy. The next
product layer should connect these reports to agent plan checkpoints, add a
human-labeled evaluation set (especially negation, ambiguity and injection), and
only then consider consent-preserving, event-triggered reassessment. Do not add a
background watcher that quietly turns source reads into new model egress.

## Primary model references

- TypeSafe introduction: https://typesafe.ai/blog/introducing-system-one-models-and-jev
- Typed API: https://docs.typesafe.ai/api
- Confidence semantics: https://docs.typesafe.ai/confidence
- Jev limitations and prompt-injection warning: https://docs.typesafe.ai/model-jaggedness/jev-1.13

Typed output constrains the shape of a judgment, not its correctness. The model
provider's benchmark claims are not Kizuki results.
