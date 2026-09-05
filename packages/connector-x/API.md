# X owned-post API connector

Evidence date: 2026-09-05. This implementation captures the authenticated
account's own posts through the official API. Offline tests exercise the actual
wire parser, core OAuth helper, host state store, and ledger. Provider enrollment,
paid access, the deployed API dialect, and provider deletion coverage have not
been qualified against a real account. The API connector is an explicit package
subpath and is not registered in the native CLI.

## Scope and enrollment

Import `createXApiConnector` from `@kizuki/connector-x/api`. The trusted host must
supply `client_id`, an owner-controlled `secret_ref`, an explicit selection, and
`deps.persist` bound to that connection's native compare-and-swap state handle.
The reference contains a `kizuki.x-api-state/v1` envelope. The envelope binds
the public client ID digest, provider account ID, selected fields, history start,
OAuth state, pending page plan, and cooldown. Token strings never belong in
connector configuration, cursors, health, or event metadata.
The envelope also records authorization as `active`, `pending` revocation, or
`revoked`; restoring either revocation state performs no automatic egress.

```ts
const connector = createXApiConnector({
  client_id: registeredPublicClientId,
  secret_ref: connection.secret_ref,
  expected_account: enrolledAccountId,
  selection: {
    history_start: "2026-01-01T00:00:00Z",
    fields: ["relationships", "links", "media"],
    wire_profile: "tweet-v2",
  },
}, { persist: stateHandle.persist });
await connector.connect(secretResolver);
```

The OAuth scopes are `tweet.read`, `users.read`, and `offline.access`. There is
no embedded application secret. `signIn` uses the core PKCE helper and a host
writer, verifies scopes and `/2/users/me`, and requires reconnecting from saved
state after enrollment. Interactive sign-in additionally requires an explicitly
injected trusted `OAuthTransport`: the default core ephemeral loopback listener
has not been qualified against the provider's exact registered callback rule.
A failed sign-in cannot silently register an application or obtain paid access.

This connector advertises contract minor 2 and requires the trusted host's
explicit third `signIn` argument. Core `enrollConnection` supplies `{ mode: "new" }`;
`ConnectionStateStore.replace` supplies `{ mode: "replace", previous_state }`
with copied prior bytes. Direct context-less calls refuse before any egress.
The connector validates saved app, account, selection, and revocation before
starting replacement sign-in. Allowed active or terminal reauthentication keeps
the previous capture checkpoint, pending page plan, and cooldown. Legacy
two-argument connectors retain their host behavior through the additive argument.

The host must approve the source capture grant before calling its ingestion
runner. Event sensitivity defaults to `private` and has a `private` floor.
Configuration, saved scopes, client identity, and selected fields are checked
before API requests; account identity is verified before every capture call.
History starts normalize to UTC only when millisecond precision preserves the
exact supplied instant; a finer nonzero fractional boundary is refused.

## Projection and wire contract

Only fixed `https://api.x.com` routes are used: `/2/users/me`,
`/2/users/{id}/tweets`, `/2/tweets` for exact pending-page replay, and the OAuth
token and revocation endpoints. GET redirects are refused. No likes, bookmarks,
DMs, foreign timeline expansion, browser scraping, or media downloads occur.

Each post keeps its native ID (`post:{id}`), owner identity, provider occurrence
time, full long-post text when supplied, edit-history IDs, and selected optional
relationships, links, and media references. No provider error prose is copied
into events or failure receipts. A response containing partial errors, a foreign
author, missing required fields, conflicting aliases, or incomplete selected
media references refuses the whole page.

Selected mentions use inline native IDs or the documented same-page
`entities.mentions.username` user expansion, requested with `user.fields=id,username`.
Username-only mentions require an unambiguous native ID in `includes.users`;
missing or conflicting bindings refuse. At most 6,400 expanded user identities
are examined within the same 2 MiB response bound. Expanded profile prose is
discarded. No extra user-lookup request or guessed username identity is used.

`tweet-v2` explicitly selects the official timeline integration guide's
`tweet.fields` query and `/tweets` routes. The parser accepts documented
`note_post`/`note_tweet`, `referenced_posts`/`referenced_tweets`, and
`edit_history_post_ids`/`edit_history_tweet_ids` aliases when their normalized
values agree. It never retries an alternative field dialect automatically.
The newer endpoint reference and integration guide differ in field spelling;
real provider qualification must establish that this selected wire profile works
for the enrolled application.

## Pagination and recovery

One capture call yields at most one page of 100 posts. A walk freezes its upper
time and keeps the previously committed post ID as its lower frontier. The new
frontier is promoted only after a terminal provider page. Continuation tokens
are opaque, bounded, and cycle checked. A rejected continuation may restart that
same frozen window once; it cannot move the lower frontier or switch dialects.
The cumulative continuation count survives that restart. Only its per-traversal
token-cycle history resets. Exhausting the 64-continuation allowance refuses the
page with the previous host cursor and unpromoted frontier.

Before yielding, the connector persists a content-free plan containing the exact
IDs, event hashes, fixed observation time, and proposed cursor. A retry with the
old host checkpoint looks up those IDs and must reproduce the exact projection.
Missing or changed data refuses with the old checkpoint. The next host cursor
acknowledges the previous page, which clears its plan before more data is read.
Ledger partial acceptance therefore deduplicates accepted events on restart
without skipping the rest of that page.

An empty page with a continuation retains the walk and reports continuation
pending. The current host runner stops on an empty page, so the next invocation
resumes that continuation. Draining an available window is bounded coverage,
not proof that the provider returned all historical posts. Provider history caps
and gaps outside the available API window remain unqualified. New-post sync
uses the committed ID; it does not rescan older posts for later edits.

## Limits and custody

Each operation admits at most five provider requests, including token work, in
45 seconds; each request and durable write has a five-second deadline.
Interactive enrollment has a 120-second outer deadline. GET response headers are
limited to 64 entries and 16 KiB of delivered name/value bytes before status or
body normalization. This bounds processing after `fetch` delivers the response;
it cannot bound the HTTP implementation's earlier header allocation. Bodies are
limited to 2 MiB, normalized batches to 3 MiB, post text to 128 KiB, selected mentions to
64, links to 32, and media references to 16 per post. Walks permit at most 64
continuations; tokens are at most 2 KiB, cursors 8 KiB, and state 256 KiB.

Refresh rotates through the core session and the original host persistence
handle before any protected GET uses the new access token. An admitted token
request that times out fences the session; late rotation may still persist
through its original compare-and-swap handle, but cannot revive the connector or
overwrite a replacement enrollment. A deadline refusal before transport leaves
the old refresh token usable in a fresh operation on the same session.

A 401 permits one refresh and one retry. Payment and permission errors stay
distinct. GET 429 hints are untrusted input: valid numeric or HTTP-date hints
are clamped to a local automatic delay between one second and 24 hours;
absent or malformed hints use 60 seconds. This cap is a local scheduling rule,
not a claim about the provider's actual reset time. OAuth transport does not
expose headers, so token-endpoint 429 uses the same fixed 60-second default.
Both paths persist cooldown before returning rate limited. Token 429 retains
the old session only after durable original-CAS persistence; a failed/timed-out
write fences the caller, while a late write can preserve cooldown through its
original custody. A restarted connector observes saved cooldown without provider
requests. Health is local and remains degraded because coverage is incomplete.

Contract `revoke` and `close` stop local work immediately. The separate explicit
`revokeProviderAccess` first persists pending revocation, then revokes the offline
refresh credential and the access credential, and records terminal revocation
only after both succeed. Capture and refresh are forbidden throughout. A
partial failure or late pending write leaves a fence that a restored connector
can load without egress; only another explicit `revokeProviderAccess` call may
retry the provider revocations. Already revoked tokens are handled idempotently
by the core OAuth helper. Local instances always close after an attempted revoke.
Sign-in refuses before browser or provider work while saved or loaded revocation
is pending, including a fresh connector in the actual host replacement path,
preserving the old credentials needed for retry. After terminal
revocation, a new explicit sign-in may establish fresh authorization through the
normal PKCE and host-writer flow; it cannot undo either completed remote revoke.
Native CAS prevents a stale refresh, cooldown, or competing revoke from replacing
a newer enrollment or revocation fence. This flow does not delete provider
content. Missing posts and HTTP 404 never imply deletion. The manifest declares
neither tombstones nor purge, and `purgeSource` returns `not_supported`.

## Verification

All provider fixtures and credentials are synthetic. Tests include real PKCE
callbacks, parser aliases, frozen pagination, exact replay after partial ledger
acceptance, an actual child exit after durable plan write, request/body limits,
same-session token admission retry, late rotation, and native state replacement
for both the same and a different account. Additional cases cover token 429,
late/stale cooldown persistence, cumulative restart limits, bounded headers,
pending provider-revoke retry, and concurrent native revocation. The shared legacy conformance suite
checks contract behavior; dedicated native tests prove unavailable batches are
recorded by the host without cursor advancement.

```bash
cd /home/ubuntu/LifeOS/workspace/kizuki-x-api-resume-20260905
npx -y bun@1.3.10 test packages/connector-x/test
npx -y bun@1.3.10 run typecheck
npx -y bun@1.3.10 run verify:network
```

Provider references: [timeline integration](https://docs.x.com/x-api/posts/timelines/integrate),
[user posts endpoint](https://docs.x.com/x-api/users/get-posts),
[pagination](https://docs.x.com/x-api/fundamentals/pagination), and
[OAuth 2.0 PKCE](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code).
Username-only mention shapes and user expansions are illustrated in the
[official data dictionary](https://docs.x.com/x-api/fundamentals/data-dictionary/reference).
