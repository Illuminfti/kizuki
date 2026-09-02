# @kizuki/connector-ics

Calendar import from an iCalendar file on disk, or from an HTTPS calendar URL
you configure yourself.

Connector id: `kizuki.ics`. Emits `calendar_event` events. Zero runtime
dependencies: the parser, the timezone resolution and the recurrence expander
are all in this package.

## Two modes

**File.** Point it at an `.ics` file:

```
kizuki import kizuki.ics --vault ~/vault --source /path/to/team.ics
```

Nothing is persisted beyond the path. No credential is involved.

**URL.** Sign in with the calendar's address. Sign-in is interactive and asks
one question:

```
Calendar URL (https:// or webcal://): https://calendar.example.org/private/...
```

No CLI verb drives an interactive sign-in yet: `kizuki connect` enrolls a
none-mode source from a path. Today the walk-through runs through
`enrollConnection` from `@kizuki/core`, which is what
`packages/connector-ics/test/connector.test.ts` exercises.

`webcal://` is rewritten to `https://`. Plain `http://` is refused. The URL is
fetched and parsed once before anything is written, so a wrong address fails
immediately.

A private calendar URL embeds a capability token: anyone holding it can read
the calendar. It is therefore treated as a credential. It goes into
`~/.kizuki/connections/<id>.state` at mode 0600, and never into SQLite, an
error message or event metadata. Errors report the HTTP status, never the
address.

## What it reads

`VEVENT` only. `VTODO`, `VJOURNAL`, `VFREEBUSY` and `VALARM` are skipped
rather than smuggled in as events.

Per event: `SUMMARY`, `DESCRIPTION` and `LOCATION` as text; `ORGANIZER` and
`ATTENDEE` as subjects when they carry a `mailto:` address; `ATTACH` as
attachment refs; `CLASS` as the sensitivity hint (`PUBLIC` → public,
`PRIVATE`/`CONFIDENTIAL` → private, otherwise personal); `STATUS`, `SEQUENCE`,
`CREATED`, `LAST-MODIFIED` and `URL` in metadata.

Every event also gets an `about` subject naming the calendar, taken from
`X-WR-CALNAME` when the file has one, and from the file's base name or the
URL host when it does not.

A `VEVENT` whose own dates are unreadable is skipped rather than allowed to
cost the rest of the calendar, and the next `health()` reports `degraded`
with how many entries were dropped.

## Times

`metadata.tz.approximation` says exactly how much the connector had to guess:

| value                    | meaning                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `none`                   | a UTC time, an all-day date, or a TZID the platform resolved                                                |
| `floating`               | a local time with no zone; read as UTC                                                                      |
| `vtimezone-fixed-offset` | the platform did not know the TZID; the file's `VTIMEZONE` standard offset was used, so DST is not modelled |
| `unresolved`             | neither the platform nor the file knew the zone; read as UTC                                                |

Zoned times resolve in two passes, so a 10:00 Berlin meeting stays 10:00 local
on both sides of a daylight-saving transition.

## Recurrence

Supported: `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`, `COUNT`, `UNTIL`,
`WKST`, `EXDATE`, `RDATE`, and a `RECURRENCE-ID` override that replaces one
instance. The `BY*` parts are supported where the frequency gives them a
meaning:

| part          | with                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| `BYDAY`       | `WEEKLY` as a plain weekday list; `MONTHLY`/`YEARLY` with or without an ordinal (`2MO`, `-1FR`) |
| `BYMONTHDAY`  | `MONTHLY` and `YEARLY`, positive and negative                            |
| `BYMONTH`     | `YEARLY`                                                                |

A yearly rule without `BYMONTH` is scoped to the whole year, so
`BYDAY=20MO` is the twentieth Monday of the year.

Anything else — `BYSETPOS`, `BYYEARDAY`, `BYWEEKNO`, `BYHOUR`/`BYMINUTE`/
`BYSECOND`, sub-daily frequencies, a `BY*` part the frequency does not use
(`FREQ=DAILY;BYDAY=MO`), and a `RANGE=THISANDFUTURE` override — is not
expanded. The series is emitted once as its master with
`metadata.recurrence.expanded: false`, rather than expanded into a wrong set
of dates.

Expansion runs from `DTSTART` to one year from now, capped at 1000 instances.
When the cap bites, the most recent 1000 are kept and every emitted instance
carries `metadata.recurrence.truncated: true`. A series that begins past the
window still yields its first instance, so a conference booked two years out
is captured rather than dropped. An `RDATE`-only series obeys the same window
and the same cap.

## Change detection

The cursor holds a hash per record. On sync, a record that vanished or turned
`CANCELLED` produces a tombstone; a record whose hash changed is re-emitted;
an unchanged record produces nothing.

Two absences are not deletions and produce no tombstone: an entry the
calendar still carries but this run could not read, and an instance that fell
outside the kept window of a capped series as the clock moved. A document
whose components do not balance — a half-downloaded feed — is a `parse_error`
before any cursor is written, rather than an empty snapshot that would
tombstone the whole calendar.

In URL mode the cursor also carries `ETag` and `Last-Modified`, and the next
fetch is conditional. A `304` costs one request and emits nothing. A fresh
`200` replaces the validators with exactly what it returned, so one that the
server stopped sending is dropped rather than kept.

## Bounds

8 MiB of calendar text, 50 000 content lines, 20 000 components, nesting depth
8, 16 MiB over the network, at most 3 redirects (every hop re-checked for
https), a 30 second timeout, and no cookies or credentials on the request.

## Purge

`capabilities.purge` is `false`. The calendar is the owner's file or feed, and
this connector is read-only; purge is a ledger-side operation.

## Not implemented

`VTODO`, `VJOURNAL`, `VALARM`, `METHOD:REQUEST` scheduling semantics, CalDAV,
plain-HTTP calendar URLs, full timezone rules for a zone the platform does not
know (a fixed offset stands in, and says so), and the `RRULE` features listed
above as unsupported.

## Manual smoke test

File mode runs end to end through the CLI today:

```
bun run packages/cli/src/main.ts init /tmp/vault
bun run packages/cli/src/main.ts import kizuki.ics \
  --vault /tmp/vault --source /path/to/your.ics
bun run packages/cli/src/main.ts sync kizuki.ics --vault /tmp/vault
```

`import` connects the file and backfills it in one step, printing
`events_stored=1 duplicates=0 …` for a one-event calendar. The `sync` that
follows resumes from the stored checkpoint and prints `events_stored=0
duplicates=0 …` while the file is unchanged.

For URL mode, enroll the connection through `enrollConnection` and confirm
`health()` reports `ok`; `packages/connector-ics/test/connector.test.ts` does
exactly that against an in-memory fetcher.
