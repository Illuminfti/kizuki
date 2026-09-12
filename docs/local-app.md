# Local Kizuki app

Run `kizuki app` from an installed CLI to open a bundled, offline local frontend. It uses system fonts and static assets inside the executable. The app listens only on a random 127.0.0.1 port and is a client of the existing Core; it does not run another writer or replace daemon credentials.

From a downloaded package, keep both executables in their final folder, open a
terminal there, and run `./kizuki app`. You need a graphical desktop and a default
web browser. Linux launches `/usr/bin/xdg-open`, usually supplied by `xdg-utils`;
macOS launches `/usr/bin/open`. If `app_browser_unavailable` appears, check the
desktop session, opener and default browser, then retry the same command.
`--no-open` is for diagnostics: the printed address does not sign you in.
The package includes its runtime; Bun, Node and a separate compiler are not
required to run it.

If a default vault exists, it opens that vault without reinstalling its service. Otherwise the screen shows the proposed HOME/Kizuki location and lets you create it or choose another path. Setup invokes native init, which installs the existing background service by default on a supported supervisor. The setup checkbox or `kizuki app --no-service` explicitly opts out. Setup refuses to adopt an unmarked existing folder. This is not an OS application installer or a claim of application registration. `--no-open` starts a diagnostic host without launching a browser; its printed address alone is intentionally not an authenticated session.

Settings checks the native supervisor and shows the observation time separately from the saved installation intent. The periodic privacy-epoch check does not run OS commands. An unavailable supervisor is never shown as active. If activation fails after vault creation, the selected workspace is retained; Settings can retry the same native service installation with its existing journal, rollback and vault identity. The app does not start a second loop. Devices without a supported supervisor retain capture and search but have no automatic background service.

Start with a local Markdown folder. Enrollment records the selected path, consent specifies the actual source purposes/fields/retention/egress, and capture reads evidence only after native admission. Search returns existing evidence and citations; it does not invent an answer or turn arbitrary text into an owner claim. Freeform Save note is not offered because native tell is a targeted correction API.

Enter the full path to the existing folder containing your Markdown notes. This
source folder must be outside the new Kizuki workspace. Kizuki leaves the
original files in place; the workspace is where it keeps admitted information.

Gmail and Google Calendar use the existing operator Desktop client configuration and native OAuth/opaque-state/CAS machinery. A browser owner action supplies native SignInIo; terminal flags are never fabricated. Missing app configuration refuses before browser/provider work. No tokens or credential references are editable in the frontend. Provider permission, local field selection and source consent remain distinct. A new source still needs its own grant.

Settings can save an OpenAI-compatible model endpoint and model name, with an optional private API key. Saving makes no provider call and grants no source access. Test connection sends one fixed synthetic prompt, with no source content. A separate source permission names the exact endpoint and model; changing either requires new permission before source text can be sent. Turning the model off preserves capture and search. Each processing pass reports its recorded model-call, extracted-claim and memory-write counts.

Before enabling a model, have a reachable compatible API endpoint, its exact
model ID and any required provider API credential, or a compatible local server
you have already configured. Kizuki does not supply a hosted account or model.
You can complete your first capture and search with the model off. When ready,
save the model settings, test the connection, grant that model access to the
intended source, and choose **Organise now** in Memory.

Memory pages offer Correct memory. Choose an admitted belief, explain the correction, and either deny it or supply its exact replacement value. Preview shows the current affected-page count without writing. Editing the correction invalidates that preview. Apply checks current permissions again and records the resulting page changes; Activity can undo a completed write. Source evidence is not presented as an editable owner belief.

Settings can enroll a read-only agent with its own name and explicit permissions. The initial sensitivity ceiling is public, so private imports require a deliberate higher ceiling. Review all eight grant fields, then copy the generated MCP configuration into the assistant you use. It contains a private file reference, not a raw token or owner access. Revoke access ends that agent's authority, including requests from an already-running MCP process.

Removing a source first denies its use through existing revocation. Physical erasure is a separate resumable native operation, with actual store inventory and blockers retained. The GUI does not equate denial with erasure. Audit and undo invoke existing receipt APIs; no GUI code writes canon. History capture is a bounded pass of at most ten existing native batches, with counts shown while active; source-specific coverage limits remain visible. The app does not promise full history from a bounded pass.

The local app uses its own in-memory bearer. The native launcher places it in a URL fragment, the frontend removes the fragment and retains only the bearer in tab/origin-scoped sessionStorage. No private content is stored in browser storage, and no app bearer is written to the daemon token file or logs. Reload resumes an active app session; disconnect/401 clears it. A new host process requires a new launch. Status exposes existing source/claims epochs so the UI can discard stale query results after permission changes. The app's bounded operation summaries are in memory; after process loss an unknown operation is not falsely reported complete. Existing native checkpoints and receipts remain authoritative.

All APIs require the exact bound Host and Origin plus the app bearer. Foreign origins, DNS-rebinding hostnames, unsupported routes and oversized bodies refuse. Assets have no-store, restrictive CSP, frame denial, nosniff and no-referrer headers. Captured content is rendered as text. There is no external hosting, CDN, service worker, generic command endpoint, token resolver endpoint, or second data store.

App shutdown first closes the listener, then waits a bounded five seconds for native operations to settle. A still-running operation or credential exchange can remain uncertain after that deadline; this does not claim cancellation or token recovery after process exit. Tests use temporary vaults, synthetic transports and simulated supervisor activation; a separate copied-artifact proof uses an explicit service opt-out. These checks do not prove a real OS supervisor lifecycle. Real-account, OS packaging and broader release acceptance are separate gates.

## Terminal install and recovery

The local app is the guided path. These are the current CLI forms for the same
workspace, including devices without a browser. They are not a signed or
published installer, and they do not prove a macOS native run or that an
unfamiliar person completed setup.

Create a workspace without installing a background service:

```sh
./kizuki init /absolute/workspace --no-service
./kizuki import markdown-folder --source /absolute/notes --policy /absolute/policy.json --expected-revision 0 --operation-id first-import --vault /absolute/workspace
./kizuki query acme --vault /absolute/workspace
./kizuki doctor --vault /absolute/workspace
```

`import` is capture. `query` is search. Both work with no model. `doctor` then
reports `canon writing: off`. There is no `kizuki capture` or `kizuki search`
verb.

Stop, reinstall, and uninstall the user service without deleting the workspace:

```sh
./kizuki serve stop --vault /absolute/workspace
./kizuki serve --install --vault /absolute/workspace
./kizuki serve --uninstall --vault /absolute/workspace
```

`serve stop` queues a stop request for the current daemon instance; it does not
signal a PID or claim the process has exited. There is no start subcommand;
`--install` activates the current executable. `--uninstall` removes the service
definition after it is stopped and disabled. Stop and uninstall do not delete the vault.

Backup and restore:

```sh
./kizuki export --out /absolute/backup --vault /absolute/workspace
./kizuki restore --from /absolute/backup --verify
./kizuki restore --from /absolute/backup --into /absolute/restored
```

Export needs a source grant that includes the export purpose. `--verify` writes
nothing. `--into` restores into an empty directory. The copied-artifact proof
exercises import, query, export, and restore with `--no-service`; it does not
install a user service.

## Connect Codex CLI

This guide assumes Codex CLI is already installed and working on the same device.
Its local MCP command can launch the packaged `kizuki-mcp` executable. A remote
browser-only assistant cannot launch that local executable or read its private
credential file.

In Kizuki Settings, choose **Set up an agent**. Review its permissions and create
it. Imported notes are private by default, so a public-only agent cannot read
them. Choose a ceiling that permits the notes you intend to share; source
permissions still apply. The result contains a `command` and an `args` list.

Use those exact values in Codex's stdio registration command. Replace all three
example paths below with the generated values; quote each path so spaces remain
part of the same argument. The `--` separates Codex options from the MCP command.

```sh
codex mcp add kizuki-local -- "/absolute/package/kizuki-mcp" \
  --vault "/absolute/workspace" \
  --token-ref "file:/absolute/private/credential"
codex mcp get kizuki-local --json
```

These command forms were checked with installed Codex CLI 0.153.4. `mcp add`
saves the server in Codex's user configuration; `mcp get` confirms registration,
not a successful connection. Start a new Codex session and ask it to search
Kizuki for a phrase from a permitted note. Check that the result includes the
expected source reference. Keep the credential file and both package executables
at their generated paths. Other assistants may need a different configuration
format; the generated object is not a complete configuration file for every app.

To end access, use **Revoke access** in Kizuki. To remove the saved Codex entry,
run `codex mcp remove kizuki-local`. Removing that entry alone does not revoke
the Kizuki agent. See the [agent enrollment guide](agent-enrollment.md) for
credential recovery and current authorization behavior.
