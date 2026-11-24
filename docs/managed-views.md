# Managed views

This fork (`4.146.0-kk.1` candidate) exposes isolated code-server views to
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

## Workbench actions in Studio

The server passes the registered workspace file to the Workbench; a managed view ignores `folder`, `workspace`, `ew`, and `payload` from the browser URL. Studio can register an empty workspace (`folders: []`) without selecting a directory. Workspace menus cannot replace that binding, but the Daemon bridge can still update workspace folders through the VS Code extension API. This is not a filesystem sandbox.

Open Folder uses the VS Code picker and sends the remote URI path to Studio as-is. New Window asks Studio for another tab, and Close This Workspace (including the File menu's Close Workspace action) asks Studio to close the current tab through its normal close flow. The fixed `kk-studio.ide.native-action` message carries the view ID and binding epoch, and the directory only for Open Folder. Delivery is to the same-origin parent; a top-level managed Workbench does not open another browser tab as a fallback. Open File stays in the current editor. Standalone code-server keeps its usual commands and navigation.

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

`workspacePath` must canonicalize to an existing `.code-workspace` file. Registering the same view/epoch is idempotent.
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
  becoming an untracked shell. A request that revives a terminal for a view that
  stopped accepting terminals is rejected before the PTY host is asked for an id,
  so no untracked shell is created.
- **Extension-host startup races:** extension-host starts are also reserved, so
  a close/rebind cannot return before a child that was already starting has
  actually exited. When the view refuses to register the extension host, the
  exact child that was forked is terminated and its exit is awaited before the
  pending start is released, so the extension host cannot outlive the view that
  rejected it.
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

With the VS Code submodule checked out and patches applied as described in the
[development workflow](CONTRIBUTING.md#development-workflow):

```bash
# Use the Node version in .node-version and pnpm version in package.json.
nvm use
(cd lib/vscode/build && CI=1 pnpm install --frozen-lockfile)
(
  cd lib/vscode
  if [[ $(uname -sm) == 'Linux x86_64' ]]; then
    export VSCODE_ARCH=x64 npm_config_arch=x64
    source ./build/azure-pipelines/linux/setup-env.sh
  fi
  pnpm run preinstall
  CI=1 pnpm install --frozen-lockfile
)
CI=1 SKIP_SUBMODULE_DEPS=1 pnpm install --frozen-lockfile
export VERSION=4.146.0-kk.1
pnpm run build
pnpm run build:vscode
KEEP_MODULES=1 pnpm run release
./test/node_modules/.bin/playwright install chromium
CODE_SERVER_TEST_ENTRY="$PWD/release" pnpm run test:e2e \
  --project Chromium --retries 0 e2e/managed-workspaces.test.ts e2e/managed-views.test.ts
```

The embedded tracker and the extension-host and terminal races are covered by the
VS Code node test:

```bash
cd lib/vscode
pnpm run gulp core-ci
node test/unit/node/index.js --build \
  --run out-build/vs/server/test/node/managedViews.test.ts --timeout 30000
```

The focused real-browser tests save edits in two workspace files on one server
and exercise isolated managed views. The managed-view test creates a terminal in
each view, rebinds one view to a higher epoch, verifies the old extension host
exited while its terminal stayed alive, verifies the other view is unaffected,
and closes both with PID exit evidence. It also checks normal-close dirty
rejection, the service-worker scope, and a close-during-terminal-start race. The native-action case exercises the candidate Workbench in a same-origin iframe with a registered empty workspace, verifies that URL parameters do not replace it, and checks the three messages without a Studio or Daemon deployment.

## Release entry

The managed release workflow is `.github/workflows/managed-release.yml`. A branch
push to `kk-studio` builds all five packages; publishing requires an explicit
workflow dispatch with `publish=true` or a `v*-kk.*` tag. The candidate tag is:

```text
v4.146.0-kk.1
```

To validate without releasing, dispatch the workflow with `publish=false`.
Check all five native builds, including the managed-view node suite, native
module loading, and Copilot exclusion. Both Linux targets must pass the workspace
snapshot browser suite, and Linux AMD64 must pass the managed workspace and view
smoke tests against its packaged build. Confirm that each target uploads its
archive, checksum, and source metadata.

Expected assets per target:

```text
code-server-4.146.0-kk.1-linux-amd64.tar.gz
code-server-4.146.0-kk.1-linux-arm64.tar.gz
code-server-4.146.0-kk.1-windows-amd64.tar.gz
code-server-4.146.0-kk.1-macos-amd64.tar.gz
code-server-4.146.0-kk.1-macos-arm64.tar.gz
```

Each archive has a `.sha256` file and a `-source.json` file. The publish job
creates a draft release, uploads the artifacts, and refuses to replace an
existing release or asset.
