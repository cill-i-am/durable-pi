import { expect, it } from "vitest"
import { Effect } from "effect"
import worker from "../src/workspace/document-worker"
import { documentService } from "../src/workspace/adapters/document-service"
import { pdfFixture } from "./pdf-fixture"

it("crosses the parser service boundary without exposing raw exceptions", async () => {
  const extract = documentService(worker)
  expect(
    (await Effect.runPromise(extract(pdfFixture(["isolated parser"])))).text
  ).toContain("isolated parser")
  await expect(
    Effect.runPromise(extract(new Uint8Array([1, 2, 3])))
  ).rejects.toMatchObject({ _tag: "DocumentUnreadable", reason: "invalid" })
  await expect(
    Effect.runPromise(
      documentService({
        fetch: async () => {
          throw new Error("CPU exceeded, internal details")
        },
      })(new Uint8Array())
    )
  ).rejects.toMatchObject({ _tag: "WorkspaceUnavailable" })
  await expect(
    Effect.runPromise(
      documentService({ fetch: async () => Response.json({ text: "bogus" }) })(
        new Uint8Array()
      )
    )
  ).rejects.toMatchObject({ _tag: "WorkspaceUnavailable" })
})
