# Google Calendar native CLI

The CLI can enroll one explicitly selected canonical Google calendar through the read-only provider component. This is synthetic-qualified native wiring, not a claim of a registered application, live Google account qualification, or release artifact acceptance.

An operator must configure `KIZUKI_GOOGLE_CALENDAR_CLIENT_ID` with a Google desktop OAuth client. An optional `KIZUKI_GOOGLE_CALENDAR_CLIENT_SECRET_REF` names an existing supported `env:` or `file:` secret reference. These are runtime inputs; no app secret or token is serialized into connection configuration, SQLite, command output, or documentation. Missing app configuration refuses before browser, provider, or terminal interaction. This change does not register an application or acquire an account grant.

In a supported Linux/macOS desktop terminal:

```
kizuki connect google-calendar --calendar CANONICAL_ID --fields summary,description,location,attendees,attachments
```

Choose only fields to persist, or explicitly use `--fields none` for minimal schedule/revision metadata and event-resource identity. Literal `primary` is refused: use the provider's actual calendar ID. The fixed system-browser launcher opens only Google's expected HTTPS authorization origin/path, uses shell-free arguments, does not echo the authorization URL, and bounds launch/cleanup. OAuth requests `calendar.events.readonly` plus minimal `openid email`; no event modification scope. Google's event scope permits viewing events on all calendars; it is broader than Kizuki's acquisition. Kizuki reads only the explicitly selected calendar and stores only selected fields plus required identity/schedule metadata. Captured account identity is OIDC `sub`, not mutable email.

Enrollment captures no history. Source consent is a separate native `connect grant` operation with an explicit policy file. Every Calendar source needs allowed fields `metadata` and `subjects` because the non-person event-resource `about` identity is baseline evidence. Summary/description/location additionally need `text`; selected attachments need `attachments`. Attendee selection adds attendee identities only when explicitly selected. Provider authorization may allow more than the selected local projection; request projection and local field consent remain distinct. Capture lists/selects only an opaque connection descriptor and checks native source admission before opening protected state. Field compatibility is checked before app-secret resolution, factory construction, or provider calls. A concurrent grant revision change refuses composition.

After an explicit compatible grant:

```
kizuki backfill google-calendar --source KEY
kizuki sync google-calendar --source KEY
```

Reauthorize with the same account, calendar and field selection:

```
kizuki connect google-calendar --calendar CANONICAL_ID --fields summary,description,location,attendees,attachments --source KEY
```

The existing native CAS replacement preserves the source key, checkpoint, pending page fingerprints, cancellation anchors and cooldown. Different account/calendar/fields or concurrent drift refuses. Omitted `--source` follows existing native sign-in selection: the sole existing Calendar source is reauthorized; multiple sources require an explicit key. Use `--new-source` instead of `--source KEY` to enroll another account or a different canonical calendar. The new source has its own checkpoint and requires its own source grant. The same account/calendar cannot be enrolled twice, even with different selected fields or when the existing source is disconnected or revoked. Reauthorization does not activate revoked source consent. Disconnect remains stop-sync, not upstream Google revocation or a claim of physical erasure.

Capture is limited to 20 revisions per batch, 25 GET requests/45 seconds per method, five-second remaining-aware requests and writes, a 1,000-event initial scan and 1,000 cancellation anchors. Meaningful live revision time is provider `updated`; all-day dates, scheduled times/zones and recurrence metadata remain distinct. Recurrences are not expanded and attachment bodies are unsupported. Only explicit cancellations become tombstones; missing provider deletion time remains unknown with a durable observation anchor. A 410 rescan reports a history gap and never infers deletion from absence. Changed provider pages after interruption refuse as unresolved snapshot gaps instead of advancing the checkpoint. See the [component contract](../packages/connector-google-calendar/README.md).

Native host cleanup terminally closes the local session and drains actual token/write custody under one five-second deadline before allowing the vault context to close. A delivered late rotated token may be saved only through its original host CAS handle; it cannot overwrite a competing enrollment or reactivate capture. A stuck exchange/write reports `custody_unknown` and retains its bookkeeping. Process exit, closed storage, drain expiry, or a lost provider response can still require reauthorization; no second token store or stale-handle reopening conceals that uncertainty. This local close does not revoke Google permission.

Primary documentation checked 2026-09-05: [installed-app OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Calendar authorization](https://developers.google.com/workspace/calendar/api/auth), [events list and sync restrictions](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), and [sync-token expiry](https://developers.google.com/workspace/calendar/api/guides/sync). All implementation fixtures use synthetic PKCE callbacks, transports, protected state files and temporary Core databases; no real browser or account was used.

New-enrollment identity verification uses the existing Core write transaction and protected state store. It checks current same-provider state before publishing the new file/row, so concurrent duplicate enrollments cannot both succeed. At most 32 sources per provider and 8 MiB aggregate candidate/existing opaque state are supported; excess, unreadable state or unresolved recovery refuses without a partial scan. A refused local enrollment may follow a completed Google authorization; it cannot undo that provider permission or guarantee the earlier provider token remains valid. Recovery may require explicit reauthorization of the existing source. No second identity or token store is created.
