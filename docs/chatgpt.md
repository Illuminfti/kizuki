# Connect a private VPS vault to ChatGPT

Status: operator integration, with local synthetic proof. No live VPS, tunnel,
ChatGPT connection, dot tool discovery or Sign in with ChatGPT qualification is
claimed. Provider documentation checked **2026-09-30**.

The route is the existing scoped `kizuki-mcp` stdio adapter, launched on the
vault's VPS by OpenAI's **Secure MCP Tunnel** client. ChatGPT calls the
OpenAI-hosted tunnel; the VPS initiates outbound HTTPS. The Mac is not on this
data path. Kizuki adds no public listener, hosted memory store, new canon writer,
OAuth provider or agent runtime.

## What this change provides

- [`deploy/chatgpt/mcp.sh`](../deploy/chatgpt/mcp.sh) launches an existing
  executable with exactly `--vault` and `--token-ref`. No owner selector or raw
  token is accepted. Core authenticates the enrolled file binding and enforces
  current grants, sensitivity, source consent, rate limits and audit.
- [`run-tunnel.sh`](../deploy/chatgpt/run-tunnel.sh) validates required inputs
  without printing values, fixes one stdio channel and a loopback admin
  listener, and strips inherited configuration overrides. Its explicit `run`
  and `doctor` modes invoke the external tunnel client; `check` performs local
  existence/custody checks only and makes no network call.
- A [systemd user unit](../deploy/chatgpt/kizuki-chatgpt-tunnel.service) supervises
  the runtime, cleans its process group, and stops retrying invalid setup. A
  private file lock refuses another runner for the same tunnel in this user's
  runtime directory. This is not a fleet-wide lock: operators must keep exactly
  one instance per stdio tunnel across **all** users and hosts, including during
  replacement. An independently launched tunnel-client can bypass this helper.
- [`plugins/kizuki-memory`](../plugins/kizuki-memory/plugin.json) is a portable
  **skills-only** package. Its workflow uses already connected, granted Kizuki
  tools. Installing the skill does not establish a connection or grant access.

The integration scripts target **Linux x64 with systemd** and an existing installed
`kizuki-mcp` executable. They do not install software, create keys, enroll agents,
change grants, start services, register apps or alter an existing deployment
unless an operator separately performs those steps. Core's file-credential
custody is not supported on a Linux ARM VPS; these wrappers do not bypass that
platform refusal.

## Sign in with ChatGPT is a separate gate

The requested **Continue with ChatGPT** connector sign-in experience is real,
but [OpenAI's current plugin identity documentation](https://developers.openai.com/siwc/chatgpt-plugin)
limits it to selected commercial partners through a trial. The
[client-ID request page](https://developers.openai.com/siwc/request-client-id)
provides the enrollment path. Access and an approved client ID are not available
from a source-code change alone.

That experience has two independent OAuth transactions: ChatGPT authorizes a
connector against the application's authorization server; the application signs
the user in with OpenAI and validates the returned identity. Their state, PKCE,
callbacks, codes and credentials must stay separate. Kizuki does not implement
either transaction in this change. ChatGPT plan usage for an open-source client
is a different integration and does not authenticate a ChatGPT plugin to a vault.

The private tunnel is an explicitly different first slice of the requested
integration. It neither replaces the requested sign-in UX nor presents that UX
as shipped. A future identity adapter needs an approved provider client,
per-owner identity-to-agent mapping, resource-bound OAuth tokens and a scoped
authorization contract. It must preserve the existing Core policy and the
stdio-only MCP package boundary.

## Authority and disclosure before provisioning

Choose one owner's private account/workspace and one dedicated Kizuki agent.
Everyone able to call this tunnel shares that agent's grant; this is **not a
multi-user identity boundary**. Do not publish or distribute it to other users.
Tunnel association and OpenAI permissions restrict transport access but do not
replace Kizuki authorization.

Provisioning creates persistent access. Obtain the owner's approval for the
specific source/project scope, sensitivity ceiling, tools, correction-relay
choice, target OpenAI workspace, runtime key and always-on service before doing
it. Reads send the permitted response content to OpenAI/ChatGPT. The local
credential stays on the VPS; retrieved material already delivered to the host
cannot be recalled by revoking its Kizuki grant. This runbook is not authorization
to enable access, deploy, migrate an existing estate or cut over services.

Main's grant enforcement is not a guarantee that captured text contains no
secrets. Serving-redaction and other security fixes on separate branches require
their own integration and review. Start with synthetic or deliberately selected
safe source data; do not call a green tunnel production certification.

## Operator setup after approval

### 1. Verify the local vault and executable

Identify the actual initialized Kizuki vault, installed version and vault-owning
non-root account. A directory containing legacy Markdown is not necessarily an
initialized Kizuki vault. Run the installed `kizuki doctor --vault /absolute/vault`
and confirm its declared limits, source consent and model/extraction state.

For a source checkout, first install its locked dependencies with the pinned
Bun version. An operator can make a small executable that forwards the launcher
arguments, then use its absolute path for `KIZUKI_MCP_BIN`:

```sh
#!/bin/sh
exec /absolute/bun /absolute/checkout/packages/mcp/src/bin.ts "$@"
```

Do not embed an owner selector, token or additional authentication flag in that
executable. Keep it in an operator-owned location and make it executable.

### 2. Enroll only the approved read scope

Use [the existing agent enrollment contract](agent-enrollment.md). The
[complete example grant](../deploy/chatgpt/read-grant.example.json) has empty
type/subject arrays and a public ceiling: it is deliberately unable to retrieve
content. Select real project subjects/types and an approved sensitivity ceiling
in a private copy. `null` is unrestricted along a dimension; it is never a
fallback for an empty result. All eight fields are required.

Keep `propose` and `correct` out of the first connection. Reading an owner's
corrected world state also depends on `relay_owner_corrections`; set it only as
approved. Otherwise the superseded value is withdrawn and the owner's
replacement is withheld. This flag and scope are Core decisions, not a plugin
prompt's permissions.

Preview and enroll with the existing CLI's `agent add`, complete grant,
`--token-ref file:/absolute/private/chatgpt.credential` and stable operation ID.
Do not copy or relocate a bound credential. Its parent must already be private
and owned by the account; Core refuses unsupported or unsafe custody. A failed
authentication never falls back to owner access.

### 3. Configure the external tunnel runtime

Follow the [official Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).
The operator needs:

- A real tunnel ID associated with the target Platform organization **and**
  ChatGPT workspace
- Tunnels Read + Manage to create/edit it; runtime and app selection need Read +
  Use, separate from ChatGPT developer-mode permissions
- A dedicated runtime API key, not an admin key
- The official [tunnel-client release](https://github.com/openai/tunnel-client/releases/latest)
  on the VPS, with the selected version/checksum recorded in the deployment
  receipt
- Outbound HTTPS to `api.openai.com:443`; this helper implements the default
  route only, without custom proxies, control-plane mTLS or extra channels

The helper uses the official client's documented
[configuration flags](https://github.com/openai/tunnel-client/blob/master/docs/configuration.md)
directly. It never invents a profile schema. The control-plane key is passed as
an environment reference, not an argv value; Kizuki receives a fresh environment
with neither the control-plane key nor any inherited admin/API key.

Copy the [environment example](../deploy/chatgpt/tunnel.env.example) to
`~/.config/kizuki/chatgpt-tunnel.env` in a mode-0700 directory and set mode 0600.
Replace every example through the approved local secure flow. Never put the
real key, credential or personal source data in chat, Git, screenshots or a PR.
Systemd reads this as an EnvironmentFile, **not a shell script**.

Install the integration scripts at the unit's `/opt/kizuki/deploy/chatgpt` path,
or change its `ExecStart` to the chosen absolute location. Copy the unit to
`~/.config/systemd/user/kizuki-chatgpt-tunnel.service`. Run as the same non-root
account that owns the vault and credential.

For local checks, supply the same approved environment values through the
operator's secure shell/session tooling, with `XDG_RUNTIME_DIR` from the user
session. Create its private runtime subdirectory if the service has not yet done
so:

```sh
install -d -m 700 "$XDG_RUNTIME_DIR/kizuki-chatgpt"
/opt/kizuki/deploy/chatgpt/run-tunnel.sh check
/opt/kizuki/deploy/chatgpt/run-tunnel.sh doctor
```

`check` is not credential authentication or remote readiness. `doctor` invokes
the external client's real diagnostic flow. Neither command creates credentials
or grants. `doctor` may perform network/protocol probes.

Then, after approval to start persistent access:

```sh
systemctl --user daemon-reload
systemctl --user enable --now kizuki-chatgpt-tunnel.service
systemctl --user status kizuki-chatgpt-tunnel.service
```

For boot persistence without a login session, an administrator must deliberately
enable user lingering for this account. Reboot/session-exit persistence is
unproved until actually exercised; the unit alone does not prove it. Check the
official client's loopback `/healthz`, `/readyz` and `/ui` at port 8080. The admin
listener is local only; do not publish it. A port conflict is a setup error.

### 4. Create the private ChatGPT connection

In the target account, enable developer mode under **Settings → Security and
login**, then open [ChatGPT Plugins](https://chatgpt.com/plugins), use the plus
button and choose **Connection → Tunnel**. Select the actual associated tunnel.
If it is absent, check the workspace association and permissions; do not expose
a public endpoint as a shortcut. See [connect and test](https://developers.openai.com/plugins/deploy/connect-chatgpt).

No fabricated tunnel URL or `mcp.json` transport belongs in this package. After
the registered connection exists, copy its actual technical ID and use the
official plugin-creator to bind the skills package to it. The portable manifest
can then declare `extensions.com.openai.apps: "./.app.json"`, with the registered
mapping in `.app.json`. The [packaging guide](https://developers.openai.com/plugins/build/plugins)
and [submission validator](https://developers.openai.com/plugins/deploy/submission-errors)
currently describe different app-ID prefixes; preserve the actual ID and verify
import rather than silently transforming it. No registered mapping is committed
here because none has been created or tested.

The private developer connection and skills package are not a public plugin
submission. Confirm the Kizuki tools actually appear in a fresh ChatGPT chat and
in dot; documentation of a tunnel route does not prove either account's tool
discovery.

## Acceptance and rollback

Record the executable SHA/version, script revision, tunnel-client version,
non-secret service status, target workspace and each result. Keep receipts free
of keys, credential paths and private response bodies.

1. Start and restart the user service. Observe health/readiness and prove only
   one runtime per tunnel across the deployment. A second helper invocation must
   refuse. After reboot with the Mac offline, repeat discovery and a read
2. Confirm `tools/list` names only the approved tools. A scoped synthetic search
   and `context_packet` succeed; a forbidden subject and ungranted write fail
3. If a configured model and consented source are intended, prove that the
   source actually produces a typed Concept/Situation with evidence, coverage
   and a metered extraction receipt. A transport can be healthy over an empty
   world model; an empty result is not proof of successful extraction
4. Independently scoped client A and ChatGPT client B read the permitted card.
   Relay an explicit correction through an already authorized local/owner seam;
   the next read reflects it when the read grant includes correction relay.
   Keep the ChatGPT connection read-only unless a separate write grant is approved
5. Narrow the test agent's grant and repeat on an open connection. Revoke it;
   the next call refuses and reconnect fails. Removal of a plugin or deletion of
   a credential file alone is not Kizuki revocation
6. Separately prove restart, undo, backup/restore and purge on the selected
   deployment candidate. A local synthetic launcher test is not that proof

To disconnect, stop/disable this unit and remove the private ChatGPT connection.
Revoke the dedicated agent with the existing `agent revoke` command to stop live
sessions; stop the runtime before replacing it. Revoke the runtime key and
remove tunnel associations only under the operator's explicit authority. The
integration does not change or archive the vault or other estate services.

## Repository verification

`bun test deploy/proof/chatgpt-tunnel.test.ts` runs synthetic configuration,
environment-isolation, singleton/restart and actual stdio grant/revocation
checks. Linux operator tests do not certify another platform. Typecheck and
`bun run verify` remain the repository-wide gates. No real provider, account,
tunnel, key or owner's vault is used by these tests.
