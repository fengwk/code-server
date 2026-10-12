import * as fs from "fs"
import * as path from "path"
import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { fileURLToPath } from "node:url"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

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
      assert.ok(workflow.includes(`-$target.tar.gz`), target)
    }
    assert.ok(workflow.includes("runs-on: ${{ matrix.runner }}"))
    assert.ok(workflow.includes("macos-15-intel"))
    assert.ok(workflow.includes("windows-2022"))
    assert.ok(workflow.includes("ubuntu-22.04"))
    assert.ok(workflow.includes("ubuntu-22.04-arm"))
    assert.ok(workflow.includes("code-server-$version-$target-source.json"))
    assert.ok(workflow.includes("bundledNode"))
    assert.ok(workflow.includes("first configuration snapshot"))
    assert.ok(workflow.includes("managed-workspaces.test.ts"))
    assert.ok(workflow.includes("--draft"))
    assert.ok(workflow.includes("upstreamTag"))
    assert.ok(workflow.includes("forkCommit"))
    assert.ok(workflow.includes("submoduleCommit"))
    assert.ok(workflow.includes("buildNode"))
    assert.ok(!workflow.includes("softprops/action-gh-release"))
    assert.ok(workflow.includes('gh release view "$tag" --repo "$repo"'))
    assert.ok(workflow.includes("already exists and will not be replaced"))
  })

  // Source downloads need authenticated API access; package jobs never need
  // release write permissions or an x86_64 compiler on their ARM64 host.
  it("uses read-only authenticated source downloads and host-compatible ARM64 compilers", () => {
    assert.match(workflow, /permissions:\n  contents: read/)
    assert.match(workflow, /name: Build from source\n        env:\n          GITHUB_TOKEN: \$\{\{ github.token \}\}/)
    assert.ok(workflow.includes("::add-mask::"))
    assert.ok(workflow.includes('if [[ "$OS" == linux && "$ARCH" == amd64 ]]'))
    assert.ok(workflow.includes("export CC=gcc CXX=g++"))
    assert.ok(workflow.includes("export VSCODE_REMOTE_CC=gcc VSCODE_REMOTE_CXX=g++"))
  })

  // The browser runner resolves --run against the selected build output and
  // can otherwise exit successfully without executing a single test.
  it("runs the built workspace snapshot suite and rejects missing or skipped cases", () => {
    assert.ok(workflow.includes("--run out-build/vs/workbench/services/configuration/test/browser/configurationService.test.js"))
    assert.ok(workflow.includes("--reporter full-json-stream"))
    assert.ok(workflow.includes("stats.tests >= 5"))
    assert.ok(workflow.includes("assert.equal(stats.passes, stats.tests)"))
    assert.ok(workflow.includes("assert.equal(stats.failures, 0)"))
    assert.ok(workflow.includes("assert.equal(stats.pending, 0)"))
  })

  // Search uses the universal package API, not the build-only ripgrep layout.
  // Windows setup must actually install rsync before the source build starts.
  it("executes the bundled search binary and verifies the Windows copy tool", () => {
    assert.ok(workflow.includes('requireServer("@vscode/ripgrep-universal")'))
    assert.ok(workflow.includes('spawnSync(rgPath, ["--version"]'))
    assert.doesNotMatch(workflow, /"@vscode", "ripgrep", "bin"/)
    assert.ok(workflow.includes('MSYS_NO_PATHCONV=1 cmd.exe /c'))
    assert.ok(workflow.includes("test -x /c/msys64/usr/bin/rsync.exe"))
  })

  // Every bundled addon is still loaded: CI supplies MSAL's GTK dependency, and
  // Darwin builds Kerberos against its system libraries rather than Linux RTLD names.
  it("supplies native verification dependencies without skipping addon loads", () => {
    assert.match(workflow, /sudo apt-get install -y .*libwebkit2gtk-4\.1-0/)
    assert.match(workflow, /name: Install macOS build dependencies\n        if: matrix\.os == 'macos'\n        run: \|/)
    assert.ok(workflow.includes('echo "GYP_DEFINES=kerberos_use_rtld=false" >> "$GITHUB_ENV"'))
    assert.ok(workflow.includes("for (const native of natives)"))
    assert.ok(workflow.includes("if (loaded.status !== 0) throw new Error"))
  })

  // Packaging is the upstream source release plus an archive. It must not grow
  // a second package format or silently omit checksums.
  it("removes only the unused Unix deviceid target and verifies the storage entry point", () => {
    assert.ok(workflow.includes('if (process.platform !== "win32")'))
    assert.ok(workflow.includes('"@vscode", "deviceid", "build", "Release", "windows.node"'))
    assert.ok(workflow.includes('requireServer("@vscode/deviceid").getDeviceId'))
    assert.ok(workflow.includes('for (const native of natives)'))
    assert.ok(workflow.includes('if (loaded.status !== 0) throw new Error'))
  })

  // The release archive and checksum remain the only distribution format.
  it("packages only the platform archive and checksum", () => {
    const script = fs.readFileSync(path.join(root, "ci/build/build-packages.sh"), "utf8")
    assert.ok(script.includes('local release_name="code-server-$VERSION-$OS-$ARCH"'))
    assert.ok(script.includes('createHash("sha256")'))
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
  const reh = fs
    .readFileSync(path.join(root, "patches/managed-runtime.diff"), "utf8")
    .split("\n")
    .filter(line => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n")

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
