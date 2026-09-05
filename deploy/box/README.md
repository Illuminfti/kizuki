# Box golden snapshot and one-command setup

`bootstrap.sh` provisions a Box VM (box.ascii.dev), places this repository's
deploy tree on it at the exact commit the script is run from, and brings the
M1+M2 compose stack (`deploy/compose.yml`) up on it. It talks to the Box API
only through `commands` and `files` (never SSH — see the M2 2026-09-04
shell-removal finding in `docs/deploy-box-tailscale.md`), because a hosted
box deliberately exposes no shell.

```sh
deploy/box/bootstrap.sh <box-api-key-file> <ts-authkey-file> [ttl-seconds] [state-dir]
```

Both credential arguments are file paths, never values, and neither is ever
printed, logged, or committed. `ttl-seconds` (default 1800) sets the box's
own self-archive timer, so a lost or forgotten run cannot bill forever.
`state-dir` (default `deploy/box/.state/default`, gitignored) records the
box id this run created or is reusing, so re-running the script against the
same state directory resumes an existing box instead of orphaning one. On
any failure after a box exists, this run's own box is deleted before the
script exits non-zero, unless `KIZUKI_BOX_KEEP_ON_FAILURE=1` is set for
hands-on diagnosis.

On success it prints (to stdout, one `key=value` line each):

- `box_id` — the box's id, for `GET/DELETE /boxes/<id>` and the Box CLI.
- `box_public_ip` — the box's public address, the input `deploy/proof/tailnet.sh`
  needs for check 2.10 (public-ip-dark).
- `tailnet_hostname` / `tailnet_ip` — as seen from inside the box's own
  tailscale sidecar, for `KIZUKI_TAILNET_NODE`.
- `daemon_token_file` — a path under the run's own state directory (mode
  600) holding the standing endpoint's bearer token, needed for
  `deploy/proof/tailnet.sh` check 2.8 (mcp-over-tailnet). A tailnet peer has
  no shell on the box to read this itself; this is the one place with local
  API access to hand it over. `export KIZUKI_DAEMON_TOKEN="$(cat "$(cat
  daemon_token_file)")"` is wrong — read the file bootstrap.sh names, not
  its own name.

Known facts about the Box API this script relies on (verified 2026-09-04,
against `https://ascii.dev/api/box/v1`):

- `POST /boxes` accepts `ttlSeconds` and `type` (machine class; only
  `"default"`, 4 vCPU / 8 GB, is available on this account's plan — `"large"`
  403s with `trial_machine_class_not_allowed` until the trial ends). A
  `size` field, tried earlier, is silently ignored. A `name` field is also
  silently ignored; the server assigns its own `"Box <timestamp>"` name
  regardless of what is sent.
- `GET /boxes/{id}` reaches `idle` well under the M3 budget once created — a
  fork from a snapshot would be faster still, but no snapshot exists yet in
  this account (`GET /snapshots` returns an empty list) so this script
  always creates fresh rather than forking one.
- `POST /boxes/{id}/commands` has a hard ~30s execution budget regardless of
  any client-requested timeout. Anything slower (the compose build, image
  pull, tailscaled auth) runs backgrounded on the box with its own log file
  and completion marker; this script polls for the marker.
- `PUT /boxes/{id}/files` accepts `{"path","content","encoding":"base64"}`
  for arbitrary binary payloads (tested up to a 2.8 MB `git bundle` of this
  repository) as well as plain UTF-8 text.
- The box's GitHub remote requires authentication this script does not
  have, so the deploy tree travels as a `git bundle` of the exact commit
  under test (`git bundle create ... HEAD`), uploaded via the files API and
  cloned on the box — not a `git clone` from GitHub, and not a per-file copy
  of `deploy/` alone, since `deploy/Dockerfile`'s build context is the whole
  repository.
