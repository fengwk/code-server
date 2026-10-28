import * as fs from "fs/promises"
import * as path from "path"
import { PASSWORD } from "../utils/constants"
import { describe, test, expect } from "./baseFixture"

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
      await expect(
        codeServerPage.page.locator(".explorer-folders-view").getByText(folder, { exact: true }),
      ).toBeVisible()
      await codeServerPage.navigateMenus(["File", "New Text File"])
      const editor = codeServerPage.page.locator(".part.editor .monaco-editor").first()
      const editorInput = editor.getByRole("textbox").first()
      await editorInput.focus()
      await expect(editorInput).toBeFocused()
      await codeServerPage.page.keyboard.type(text)
      await expect(editor.locator(".view-lines")).toContainText(text)
      await editorInput.press(process.platform === "darwin" ? "Meta+s" : "Control+s")
      const dialog = codeServerPage.page.locator(".quick-input-widget")
      const input = dialog.locator("input")
      await expect(input).toBeVisible()
      await expect(dialog.locator(".quick-input-title")).toHaveText("Save As")

      // SimpleFileDialog shows the dialog before updateItems() finishes. Its
      // initialization then force-writes the suggested path, so typing before
      // that completes is overwritten. The suggested valueSelection is applied
      // only after updateItems() resolves and just before busy is cleared
      // (simpleFileDialog.ts pickResource()), making this full semantic state
      // the observable ready condition for accepting the user's path.
      const expectedSuggestion = path.join(root, folder, text)
      const suggestionName = path.basename(expectedSuggestion)
      const readSaveInput = () =>
        input.evaluate((element) => {
          const field = element as HTMLInputElement
          return {
            value: field.value,
            selectionStart: field.selectionStart,
            selectionEnd: field.selectionEnd,
          }
        })
      await expect
        .poll(async () => {
          const state = await readSaveInput()
          return {
            folder: path.dirname(state.value),
            value: state.value,
            selection: [state.selectionStart, state.selectionEnd],
          }
        })
        .toEqual({
          folder: path.join(root, folder),
          value: expectedSuggestion,
          selection: [
            expectedSuggestion.length - suggestionName.length,
            expectedSuggestion.length - path.extname(suggestionName).length,
          ],
        })

      const target = path.join(root, folder, "saved.txt")
      await input.fill(target)
      await expect(input).toHaveValue(target)
      await dialog.getByRole("button", { name: "OK", exact: true }).click()
      await expect(input).toBeHidden()
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
