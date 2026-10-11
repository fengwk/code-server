import { spawnSync } from "child_process"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

function run(command: string, args: string[], cwd = root): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

describe("managed release", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/managed-release.yml"), "utf8")

  // The downstream release path is one workflow. Upstream npm, package, and
  // container workflows must not remain as competing publishers.
  it("keeps exactly one downstream release workflow", () => {
    const workflows = fs.readdirSync(path.join(root, ".github/workflows"))
    assert.deepEqual(workflows, ["managed-release.yml"])
    assert.doesNotMatch(workflow, /NPM_TOKEN|npm publish|id-token:|docker|nfpm|goreleaser|release-gcp/i)
    assert.ok(workflow.includes("contents: write"))
    assert.ok(workflow.includes("inputs.publish"))
  })

  // Asset names and provenance are fixed by the product contract, not derived
  // from the host that happens to run the job.
  it("publishes the five native platform archives without replacing an existing release", () => {
    for (const target of ["linux-amd64", "linux-arm64", "windows-amd64", "macos-amd64", "macos-arm64"]) {
      assert.ok(workflow.includes(`code-server-$VERSION-${target}.tar.gz`), target)
    }
    assert.ok(workflow.includes("runs-on: ${{ matrix.runner }}"))
    assert.ok(workflow.includes("macos-15-intel"))
    assert.ok(workflow.includes("windows-2022"))
    assert.ok(workflow.includes("ubuntu-22.04"))
    assert.ok(workflow.includes("ubuntu-22.04-arm"))
    assert.ok(workflow.includes("code-server-$VERSION-source.json"))
    assert.ok(workflow.includes("upstreamTag"))
    assert.ok(workflow.includes("forkCommit"))
    assert.ok(workflow.includes("submoduleCommit"))
    assert.ok(workflow.includes("nodeVersion"))
    assert.ok(!workflow.includes("softprops/action-gh-release"))
    assert.ok(workflow.includes('gh release view "$TAG"'))
    assert.ok(workflow.includes("already exists and will not be replaced"))
  })

  // Packaging is the upstream source release plus an archive. It must not grow
  // a second package format or silently omit checksums.
  it("packages only the platform archive and checksum", () => {
    const script = fs.readFileSync(path.join(root, "ci/build/build-packages.sh"), "utf8")
    assert.ok(script.includes('local release_name="code-server-$VERSION-$OS-$ARCH"'))
    assert.ok(script.includes('sha256sum "$release_name.tar.gz"'))
    assert.doesNotMatch(script, /release_nfpm/)
    assert.doesNotMatch(script, /release_gcp/)
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>
    }
    assert.equal(packageJson.scripts["publish:npm"], undefined)
    assert.equal(packageJson.scripts["publish:docker"], undefined)
  })
})

describe("copilot source exclusion", () => {
  const build = fs.readFileSync(path.join(root, "ci/build/build-vscode.sh"), "utf8")
  const reh = fs.readFileSync(path.join(root, "lib/vscode/build/gulpfile.reh.ts"), "utf8")

  // Removing the extension after packaging is not sufficient: the dedicated
  // compile and archive tasks must not run in the source build.
  it("removes the dedicated copilot compile and packaging tasks", () => {
    assert.doesNotMatch(build, /compile-copilot-extension-full-build/)
    assert.match(build, /extensions\/copilot/)
    assert.doesNotMatch(reh, /compileCopilotExtensionBuildTask/)
    assert.doesNotMatch(reh, /prepareCopilotRipgrepShim/)
    assert.doesNotMatch(reh, /ensureCopilotPlatformPackage/)
    assert.match(reh, /name !== 'copilot'/)
    assert.match(reh, /compileNonNativeExtensionsBuildTask/)
    assert.match(reh, /compileNativeExtensionsBuildTask/)
  })
})

describe("workspace snapshot regression", () => {
  const source = fs.readFileSync(
    path.join(
      root,
      "lib/vscode/src/vs/workbench/services/configuration/browser/configurationService.ts",
    ),
    "utf8",
  )
  const tests = fs.readFileSync(
    path.join(
      root,
      "lib/vscode/src/vs/workbench/services/configuration/test/browser/configurationService.test.ts",
    ),
    "utf8",
  )

  // The old fix marked the snapshot initialized without copying folders.
  // The regression must call the real method and inspect the lookup map.
  it("refreshes folders only for a stale configuration-backed workspace", () => {
    assert.match(source, /workspace\.folders = toWorkspaceFolders/)
    assert.match(source, /!workspace\.initialized && workspace\.configuration/)
    assert.doesNotMatch(source, /workspace\.initialized = true;\s*this\.workspace = workspace;/)
    assert.match(tests, /updateWorkspaceAndInitializeConfiguration/)
    assert.match(tests, /workspace\.getFolder/)
    assert.match(tests, /configuration initializes before assignment/)
    assert.match(tests, /configuration is still uninitialized/)
    assert.match(tests, /single-folder or empty workspace/)
  })
})

describe("node version contract", () => {
  it("uses the same Node 24 declared by code-server and VS Code", () => {
    const codeServer = fs.readFileSync(path.join(root, ".node-version"), "utf8").trim()
    const vscode = fs.readFileSync(path.join(root, "lib/vscode/.nvmrc"), "utf8").trim()
    assert.equal(codeServer, "24.21.0")
    assert.equal(vscode, "24.18.0")
    assert.equal(codeServer.startsWith("24."), true)
    assert.equal(vscode.startsWith("24."), true)
  })
})

describe("workspace snapshot runtime", () => {
  // Runs the patched assignment method on the real Workspace implementation.
  // The source contract above cannot prove that its folder setter rebuilds the lookup map.
  it("refreshes the real lookup map and leaves other workspace kinds unchanged", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-snapshot-"))
    const serviceSource = fs.readFileSync(
      path.join(root, "lib/vscode/src/vs/workbench/services/configuration/browser/configurationService.ts"),
      "utf8",
    )
    const start = serviceSource.indexOf("if (!workspace.initialized && workspace.configuration")
    const end = serviceSource.indexOf("this.workspace = workspace;", start)
    if (start < 0 || end < 0) {
      throw new Error("workspace snapshot refresh was not found")
    }
    const refresh = serviceSource.slice(start, end)
    fs.writeFileSync(
      path.join(directory, "snapshot.mjs"),
      `
        class URI {
          constructor(value) { this.value = value; this.path = "/" + value; }
          toString() { return this.value; }
          with() { return this; }
        }
        class WorkspaceFolder {
          constructor(data) { Object.assign(this, data); }
        }
        class Workspace {
          constructor(id, folders, transient, configuration) {
            this.id = id;
            this.transient = transient;
            this.configuration = configuration;
            this.folders = folders;
          }
          set folders(folders) {
            this._folders = folders;
            this.folderMap = new Map(folders.map((folder) => [folder.uri.toString(), folder]));
          }
          get folders() { return this._folders; }
          getFolder(resource) {
            const value = resource.toString();
            const match = [...this.folderMap.keys()].filter((candidate) => value === candidate || value.startsWith(candidate + "/")).sort((a, b) => b.length - a.length)[0];
            return match ? this.folderMap.get(match) : null;
          }
        }
        class ConfigurationWorkspace extends Workspace { initialized = false; }
        function toWorkspaceFolders(configuredFolders, workspaceConfigFile) {
          return configuredFolders.map((folder, index) => new WorkspaceFolder({ uri: new URI(workspaceConfigFile.value + "/" + folder.path), name: folder.path, index }));
        }
        const configuration = { initialized: false, stored: [], transient: false, getFolders() { return this.stored; }, isTransient() { return this.transient; } };
        const service = { workspaceConfiguration: configuration, uriIdentityService: { extUri: {} } };
        const assign = function (workspace) {
          ${refresh}
        };
        const folder = new URI("folder");
        const stale = new ConfigurationWorkspace("id", [], false, new URI("workspace"));
        const before = stale.getFolder(new URI("workspace/folder/file"));
        configuration.initialized = true;
        configuration.stored = [{ path: "folder" }];
        configuration.transient = true;
        assign.call(service, stale);
        const single = new ConfigurationWorkspace("single", [new WorkspaceFolder({ uri: folder, name: "folder", index: 0 })], false, null);
        single.initialized = true;
        const empty = new ConfigurationWorkspace("empty", [], false, null);
        empty.initialized = true;
        configuration.stored = [];
        assign.call(service, single);
        assign.call(service, empty);
        const found = stale.getFolder(new URI("workspace/folder/file"));
        if (before !== null || !stale.initialized || stale.transient !== true || found?.uri.toString() !== "workspace/folder" || single.folders.length !== 1 || empty.folders.length !== 0) {
          throw new Error("workspace snapshot was not refreshed consistently: " + JSON.stringify({ before, initialized: stale.initialized, transient: stale.transient, found: found?.uri.toString(), folders: stale.folders.map((item) => item.uri.toString()), single: single.folders.length, empty: empty.folders.length }));
        }
      `,
    )
    try {
      run(process.execPath, [path.join(directory, "snapshot.mjs")])
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
