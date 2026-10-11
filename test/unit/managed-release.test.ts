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

  // Packaging is the upstream source release plus an archive. It must not grow
  // a second package format or silently omit checksums.
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
