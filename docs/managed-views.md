# Managed views

This fork (`4.141.0-kk.2`, Code `1.141.0`) exposes isolated code-server views to
the KK Studio daemon. A view is a browser workbench bound to one workspace,
binding epoch, extension host, terminal set and management connection.

## View traffic

A view is addressed internally as:

```text
/__kk/ide/view/<viewId>/<bindingEpoch>/...
```

`viewId` is a lowercase canonical UUID and `bindingEpoch` is a positive decimal
string up to `Long.MAX_VALUE`. The view router authenticates the normal
code-server session, checks that the exact view/epoch is `OPEN`, and then adds
the server-verified `x-kk-view-id` and `x-kk-binding-epoch` headers before
delegating to VS Code. Browser-supplied `x-kk-*` identity headers are stripped
from every request and WebSocket upgrade, including management requests.

An old epoch is rejected with HTTP 410. A view cannot be reached through
another view's URL, and its browser session/WebSocket scope does not authorize a
different view.

## Management API

The local daemon uses these routes:

| Request                                        | Body/query                      | Result                              |
| ---------------------------------------------- | ------------------------------- | ----------------------------------- |
| `GET /__kk/ide/views`                          | none                            | `{views: [...]}` for active records |
| `GET /__kk/ide/views/:viewId?bindingEpoch=...` | epoch                           | one inspection                      |
| `POST /__kk/ide/views/:viewId`                 | `{bindingEpoch, workspacePath}` | register or rebind                  |
| `DELETE /__kk/ide/views/:viewId`               | `{bindingEpoch, mode}`          | close result                        |

The token comes from `KK_STUDIO_IDE_MANAGEMENT_TOKEN` and is sent as
`x-kk-studio-management-token`. Management requests are accepted only from an
exact loopback peer (`127.0.0.1`, `::1` or `::ffff:127.0.0.1`) with a
constant-time token match. The API is disabled with HTTP 503 when the token is
not configured. Tokens, request headers and request bodies are never logged.

`workspacePath` must already exist and is canonicalized to a directory or a
`.code-workspace` file. Registering the same view/epoch is idempotent.
Registering the same view with a higher epoch rebinds it; a lower epoch is
rejected as `VIEW_EPOCH_ROLLBACK`. Request bodies are strict: unknown fields,
wrong types, non-canonical IDs and epochs, and bodies above 16 KiB are rejected.
Errors use `{error: "<UPPER_TOKEN>", message: "..."}` with bounded, sanitized
messages.

## Lifecycle and exit evidence

- **Rebind (higher epoch):** the old code-server HTTP/WebSocket traffic,
  management connections and extension host are closed. Existing terminals and
  their PTY-host state are retained for the same view. Other views and the
  shared PTY host are not touched.
- **Close (`discard` or `expired`):** the view's HTTP/WebSocket traffic,
  management connections, extension hosts and terminals are terminated. The
  result is `CLOSED` only after the recorded resources report exit. A timeout or
  failed termination leaves the view in `CLEANUP_FAILED`; it is not reported as
  closed and the same close can be retried. A retry closes only the remaining
  handles.
- **Terminal creation races:** terminal creation is reserved before the shell is
  spawned. A close/rebind waits for admitted creations to settle, and a terminal
  that arrives after the view starts closing is tracked and shut down instead of
  becoming an untracked shell.
- **Extension-host startup races:** extension-host starts are also reserved, so
  a close/rebind cannot return before a child that was already starting has
  actually exited.
- **`normal` close:** rejected with `409 DRAFT_STATE_UNKNOWN`. code-server
  cannot observe renderer-only unsaved buffers, so it never claims that a
  workspace is clean. The daemon bridge performs its own dirty check and calls
  this API with `discard` only after that check passes.
- **Closed-history retention:** both the local manager and the embedded VS Code
  tracker retain at most 256 confirmed `CLOSED` records. `inspect` and `close`
  idempotency is guaranteed only while a record remains in that window; older
  closed identities are forgotten and return `VIEW_NOT_FOUND`. `OPEN`,
  `CLOSING` and `CLEANUP_FAILED` records are never evicted.

## Current limitations

- `dirty` is always `unknown`; `draftBackup.supported` is always `false`.
  Renderer-only edits and custom-editor state are not guaranteed to survive a
  discard.
- Management is local-only; there is no remote management transport.
- The managed view path is fixed at `/__kk/ide/view`; a higher-level proxy is
  responsible for the external `/environment-ide/...` URL.
- Closing a view never deletes user files.

## Build and verification

```bash
# Node 24 is required by .node-version and lib/vscode/.nvmrc.
nvm use
npm ci
npm run build
VERSION=4.141.0-kk.2 npm run build:vscode
KEEP_MODULES=1 npm run release
npm --prefix test ci
CODE_SERVER_TEST_ENTRY="$PWD/release" npm run test:e2e -- \
  --project Chromium --retries 0 e2e/managed-views.test.ts
```

The focused real-browser test opens two workspaces in one server, creates a
terminal in each, rebinds one view to a higher epoch, verifies the old extension
host exited while its terminal stayed alive, verifies the other view is
unaffected, and closes both with PID exit evidence. It also checks normal-close
dirty rejection, the service-worker scope, and a close-during-terminal-start
race.

## Release entry

The managed release workflow is `.github/workflows/managed-release.yml`. A branch
push to `kk-studio` builds all five packages; publishing requires an explicit
workflow dispatch with `publish=true` or a `v*-kk.*` tag. The candidate tag is:

```text
v4.141.0-kk.2
```

Expected assets per target:

```text
code-server-4.141.0-kk.2-linux-amd64.tar.gz
code-server-4.141.0-kk.2-linux-arm64.tar.gz
code-server-4.141.0-kk.2-windows-amd64.tar.gz
code-server-4.141.0-kk.2-macos-amd64.tar.gz
code-server-4.141.0-kk.2-macos-arm64.tar.gz
```

Each archive has a `.sha256` file and a `-source.json` file. The publish job
creates a draft release, uploads the artifacts, and refuses to replace an
existing release or asset.
