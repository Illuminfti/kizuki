# Gmail native enrollment candidate

The CLI implements bounded read-only Gmail enrollment and capture through the existing connector, opaque connection state, and source-consent interfaces. This is synthetic-qualified code, not a registered Google application or live-account qualification.

An operator must supply an existing Google **Desktop app** client through `KIZUKI_GMAIL_CLIENT_ID`. If that client requires a secret, configure `KIZUKI_GMAIL_CLIENT_SECRET_REF=env:VARIABLE` or `file:/absolute/private/file` using the existing secret resolver. These are runtime configuration, never copied into vault config or SQLite. Missing configuration refuses before browser, prompts, or provider calls. This implementation does not register an application or create account grants for the operator.

On a supported Linux or macOS desktop terminal:

```
kizuki connect gmail --fields text,subjects,headers,labels,attachments
```

Select only the fields to persist. The flow opens the system browser at Google's fixed authorization endpoint, uses core PKCE and a loopback callback, and requests `openid`, `email`, and `gmail.readonly`. No pasted key/code flow, send scope, or modify scope is offered. Native launch uses fixed executable paths with no shell, a bounded wait, and no authorization URL in output. Unsupported/headless browser launch refuses; remote terminal browser forwarding is not implemented.

The command stores OAuth state under a core-minted owner-only connection file and returns a source key. Enrollment captures no mail history. Use the existing explicit `connect grant --source KEY --policy FILE --expected-revision N --operation-id ID` workflow separately. Gmail output always includes provider/version/coverage metadata, so a compatible policy must permit `metadata`, plus any selected `text`, `subjects`, and `attachments` fields. Header/label selections are persisted within metadata. A narrowed incompatible grant refuses before app-secret resolution or provider transport; it is never widened automatically.

Once explicitly authorized:

```
kizuki backfill gmail --source KEY
kizuki sync gmail --source KEY
```

Capture is bounded to twenty messages, twenty-five requests and forty-five seconds per method, with remaining-aware five-second request/state-persistence waits, bounded JSON, a 1000-message initial cap, an 8 KiB cursor and a 128 KiB pending plan. Initial caps, expired history and unavailable messages report partial coverage. Only provider-explicit deletion observations produce tombstones; provider deletion time is unknown, and absence does not infer deletion. Attachments are metadata only; body download, HTML interpretation and unsupported text encodings are not implemented. Minimal provider structure needed to parse a selected field is distinct from the fields persisted; see the connector README for projection details.

Reauthorize an existing source with the same selected fields:

```
kizuki connect gmail --source KEY --fields text,subjects,headers,labels,attachments
```

The account must match its stable OIDC subject. Core replacement preserves the source key and checkpoint, while the connector preserves its exact pending history witness. Changed account/fields/history or concurrent state drift refuses rather than orphaning a checkpoint. Changing a source's selected projection through reauthorization is unsupported. Revoked consent stays revoked after reauthorization. Disconnect retains its existing stop-sync meaning; it does not silently revoke upstream Google permission or claim native payload erasure.

An unresolved OAuth exchange or started host write fences reconnect until actual
settlement. If a successful refresh returns after a timeout or local close, its
rotated token is offered only to the original host state handle; the native
store's compare-and-swap refuses any newer enrollment. Saving that token does
not reactivate the closed session. A timed-out instance must reload durable
state. Enrollment uses one two-minute authorization budget, including profile
verification, and at most five seconds waiting for the final state write.

This custody rule cannot recover a provider rotation whose response is lost,
or save through a host handle after its database or process has closed. Those
outcomes remain unavailable and may require explicit reauthorization; no
automatic token reset or retry against a newer account hides the uncertainty.
Changed live Gmail observations on retry remain `snapshot_gap_unresolved` with
no history advance. No automatic skip/reset hides that gap.

Primary documentation verified 2026-09-05: [Google installed-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Gmail authorization scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), and [Gmail synchronization](https://developers.google.com/workspace/gmail/api/guides/sync). Operator app verification and live-account qualification remain outside the synthetic test evidence.
