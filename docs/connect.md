# Connect local sources

`kizuki connect` shows the source catalog. `kizuki connect --json` gives the
same catalog as a CLI envelope, and `kizuki connect status [--json]` reports
the enrolled sources, privacy defaults, last run, stored count, and errors.

File folders and exports remain local imports. The available catalog is the
truth for this revision; entries marked unavailable are not wired through the
CLI.

## Beeper Desktop

Kizuki can read history exposed by the local Beeper Desktop API. First enable
the Desktop API and create an approved connection token in **Beeper Desktop →
Settings → Integrations**. Keep the token outside the repository and shell
history where possible.

```bash
export BEEPER_TOKEN='approved-token'
kizuki connect beeper --token-ref env:BEEPER_TOKEN --sensitivity private
kizuki backfill beeper
kizuki connect status
```

The default endpoint is `http://127.0.0.1:23373`. To use an explicitly chosen
local endpoint:

```bash
kizuki connect beeper \
  --token-ref file:/absolute/path/to/beeper-token \
  --endpoint http://127.0.0.1:23373 \
  --sensitivity private
```

The `env:` reference accepts an environment-variable name. The `file:`
reference must be absolute and name an owner-only regular local file. Kizuki
stores the reference, never the token value.

This is read-only message ingestion. Kizuki does not send messages, mark them
read, launch an OAuth flow, or relay data through a Kizuki cloud service.
Beeper Desktop determines which linked accounts and how much local history are
available. This repository has synthetic coverage for the connector; it does
not claim a live Beeper account test.

The connector design follows the local-first connection model described by
[Sealgate Connect](https://sealgate.ai/connect.md) and uses Beeper's documented
[Desktop API](https://developers.beeper.com/desktop-api/index.md) and
[authentication model](https://developers.beeper.com/desktop-api/auth/index.md).
