import * as fs from "fs/promises"
import * as path from "path"
import { describe, test, expect } from "./baseFixture"
import { PASSWORD } from "../utils/constants"

// One running server must open two distinct workspace files and persist an edit in each.
describe("managed workspaces", ["--disable-workspace-trust", "--auth", "password"], {}, () => {
  test("one server opens two workspace files", async ({ codeServerPage }) => {
    const root = await codeServerPage.workspaceDir
    const firstDir = path.join(root, "first")
    const secondDir = path.join(root, "second")
    await fs.mkdir(firstDir)
    await fs.mkdir(secondDir)
    const first = path.join(root, "first.code-workspace")
    const second = path.join(root, "second.code-workspace")
    await fs.writeFile(first, JSON.stringify({ folders: [{ path: "first" }] }))
    await fs.writeFile(second, JSON.stringify({ folders: [{ path: "second" }] }))
    await codeServerPage.page.fill(".password", PASSWORD)
    await codeServerPage.page.click(".submit")

    const openWorkspace = async (file: string, folder: string, text: string) => {
      await codeServerPage.navigate(`/?workspace=${encodeURIComponent(file)}`)
      await expect(codeServerPage.page.locator(".monaco-workbench")).toBeVisible()
      await expect(codeServerPage.page.locator(`text=${folder}`).first()).toBeVisible()
      await codeServerPage.navigateMenus(["File", "New Text File"])
      await expect(codeServerPage.page.locator(".monaco-editor.focused")).toBeVisible()
      await codeServerPage.page.keyboard.type(text)
      await codeServerPage.navigateMenus(["File", "Save"])
      const input = codeServerPage.page.locator(".quick-input-widget input")
      await expect(input).toBeVisible()
      await input.fill(path.join(root, folder, "saved.txt"))
      await codeServerPage.page.keyboard.press("Enter")
      await expect
        .poll(async () => {
          try {
            return await fs.readFile(path.join(root, folder, "saved.txt"), "utf8")
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
              return undefined
            }
            throw error
          }
        })
        .toBe(text)
    }

    await openWorkspace(first, "first", "first workspace")
    await openWorkspace(second, "second", "second workspace")
  })
})
