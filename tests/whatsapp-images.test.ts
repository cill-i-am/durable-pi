import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { AgentId, homeAgentId } from "../src/agents/domain"
import { exportWhatsAppImage } from "../src/whatsapp/adapters/images"
import { WhatsAppStore } from "../src/whatsapp/adapters/sqlite"
import {
  whatsappIdentity,
  WhatsAppRejected,
  WhatsAppUnavailable,
  type WhatsAppRecord,
  type WhatsAppImage,
} from "../src/whatsapp/contracts"
import { importWhatsAppImage } from "../src/whatsapp/images"
import { WhatsAppSendFailed } from "../src/whatsapp/pump"
import { whatsappApplication } from "../src/whatsapp/service"
import { imageBytes, imageMetadata, imageWorkspace } from "./image-fixture"

const run = Effect.runPromise
async function imageReceipt(
  messageId = "wamid.photo",
  body = "What is in this image?"
) {
  return {
    ...(await whatsappIdentity(messageId)),
    messageId,
    body,
    threadId: "whatsapp:123456:15550101010",
    sender: "15550101010",
    timestamp: Date.now(),
    image: imageMetadata,
  }
}
async function fixture() {
  const files = imageWorkspace(),
    store = new WhatsAppStore(files.db)
  const admitted: { files: readonly string[]; agentId: string }[] = [],
    sends: WhatsAppRecord[] = []
  const state = {
    finished: false,
    images: [] as string[],
    downloaded: 0,
    temporary: false,
    rejected: false,
    uncertain: false,
  }
  const importer = importWhatsAppImage(
    files.workspace,
    (_image: WhatsAppImage) =>
      Effect.suspend(
        (): Effect.Effect<
          Uint8Array,
          WhatsAppRejected | WhatsAppUnavailable
        > => {
          state.downloaded++
          return state.temporary
            ? Effect.fail(new WhatsAppUnavailable())
            : state.rejected
              ? Effect.fail(
                  new WhatsAppRejected({ message: "Synthetic invalid image" })
                )
              : Effect.succeed(imageBytes)
        }
      )
  )
  const app = whatsappApplication(store, {
    configured: () => true,
    contactUrl: () => null,
    wake: () => Effect.void,
    profiles: () => Effect.succeed([]),
    active: () => Effect.succeed(true),
    name: () => Effect.succeed("Home"),
    reviewUrl: () => "https://pi.example/agents/home",
    image: (record) => importer(record.id, record.image!),
    admit: (agentId, input) =>
      Effect.gen(function* () {
        const prepared = yield* files.workspace.attach(input.files ?? [])
        expect(prepared.content.some((block) => block.type === "image")).toBe(
          true
        )
        admitted.push({ agentId, files: input.files ?? [] })
      }).pipe(Effect.orDie),
    turn: () =>
      Effect.succeed({
        status: state.finished ? "done" : "running",
        answer: "Here is the image.",
        needsApproval: false,
        images: state.images,
      }),
    send: (record) =>
      Effect.suspend(() => {
        sends.push(record)
        return state.uncertain && record.outboundImageId
          ? Effect.fail(new WhatsAppSendFailed({ uncertain: true }))
          : Effect.succeed(`wamid.send-${sends.length}`)
      }),
  })
  await run(
    app.configure(
      { operationId: crypto.randomUUID(), revision: 0, enabled: true },
      homeAgentId
    )
  )
  return { ...files, store, state, app, admitted, sends, importer }
}
describe("images through the shared workspace and WhatsApp", () => {
  it("durably admits metadata, imports into the pinned agent once and includes vision content", async () => {
    const f = await fixture(),
      input = await imageReceipt()
    await run(f.app.receive(input))
    await run(f.app.receive(input))
    expect(f.state.downloaded).toBe(0)
    await run(f.app.pump())
    expect(f.state.downloaded).toBe(1)
    expect(f.admitted).toHaveLength(1)
    expect(f.admitted[0]!.agentId).toBe(homeAgentId)
    expect((await run(f.store.get(input.id)))?.imageFileId).toBe(
      f.admitted[0]!.files[0]
    )
    expect((await run(f.workspace.list()))[0]?.kind).toBe("image")
    await run(f.app.receive(input))
    await run(f.app.pump())
    expect(f.state.downloaded).toBe(1)
    expect(f.calls.prepared).toBe(1)
    expect(f.admitted).toHaveLength(1)
  })
  it("recovers a lost file-import acknowledgement without another download or duplicate asset", async () => {
    const f = await fixture(),
      input = await imageReceipt()
    await run(f.app.receive(input))
    const id = await run(f.importer(input.id, imageMetadata))
    expect((await run(f.store.get(input.id)))?.imageFileId).toBeNull()
    await run(f.app.pump())
    expect(f.admitted[0]!.files).toEqual([id])
    expect(f.state.downloaded).toBe(1)
    expect(await run(f.workspace.list())).toHaveLength(1)
  })
  it("preserves the agent selected at receipt admission across a route change", async () => {
    const f = await fixture(),
      input = await imageReceipt()
    await run(f.app.receive(input))
    const child = Schema.decodeUnknownSync(AgentId)(
      "12345678-1234-4234-8234-123456789abc"
    )
    await run(
      f.store.configure(
        { operationId: crypto.randomUUID(), revision: 1, enabled: true },
        child
      )
    )
    await run(f.app.pump())
    expect(f.admitted[0]!.agentId).toBe(homeAgentId)
  })
  it("bounds transient image attempts, exposes failure and permits an explicit retry", async () => {
    const f = await fixture(),
      input = await imageReceipt()
    f.state.temporary = true
    await run(f.app.receive(input))
    for (let n = 0; n < 8; n++) await run(f.app.pump())
    expect(f.state.downloaded).toBe(5)
    expect((await run(f.store.get(input.id)))?.state).toBe("failed")
    expect(f.admitted).toEqual([])
    f.state.temporary = false
    await run(f.store.retry(input.id, false, crypto.randomUUID()))
    await run(f.app.pump())
    expect(f.admitted).toHaveLength(1)
  })
  it("records invalid media without admitting inference", async () => {
    const f = await fixture(),
      input = await imageReceipt()
    f.state.rejected = true
    await run(f.app.receive(input))
    await run(f.app.pump())
    await run(f.app.pump())
    expect(f.state.downloaded).toBe(1)
    expect((await run(f.store.get(input.id)))?.error).toBe(
      "Synthetic invalid image"
    )
    expect(f.admitted).toEqual([])
  })
  it("does not interpret an image caption as a routing command", async () => {
    const f = await fixture()
    await run(f.app.receive(await imageReceipt("wamid.caption", "/agents")))
    await run(f.app.pump())
    expect(f.admitted).toHaveLength(1)
    expect(f.sends).toEqual([])
  })
  it("sends reply images independently and retries uncertainty without repeating text or other images", async () => {
    const f = await fixture(),
      input = await imageReceipt()
    await run(f.app.receive(input))
    await run(f.app.pump())
    f.state.images = [f.admitted[0]!.files[0]!]
    f.state.finished = true
    await run(f.app.pump())
    f.state.uncertain = true
    await run(f.app.pump())
    await run(f.app.pump())
    expect(f.sends).toHaveLength(2)
    const image = (await run(f.store.list())).find(
      (record) => record.outboundImageId
    )!
    expect(image.state).toBe("uncertain")
    await expect(
      run(f.store.retry(image.id, false, crypto.randomUUID()))
    ).rejects.toThrow()
    f.state.uncertain = false
    await run(f.store.retry(image.id, true, crypto.randomUUID()))
    await run(f.app.pump())
    expect(f.sends.filter((record) => !record.outboundImageId)).toHaveLength(1)
    expect(f.sends.filter((record) => record.outboundImageId)).toHaveLength(2)
    expect((await run(f.store.get(image.id)))?.state).toBe("sent")
  })
  it("exports private image bytes through the native file module without a public URL", async () => {
    const f = await fixture(),
      input = await imageReceipt()
    const id = await run(f.importer(input.id, imageMetadata))
    expect(await run(exportWhatsAppImage(f.workspace, id))).toEqual({
      name: `whatsapp-${id}.jpg`,
      mime: "image/jpeg",
      data: btoa(String.fromCharCode(...imageBytes)),
    })
    await run(f.workspace.trash(id, true))
    await expect(
      run(exportWhatsAppImage(f.workspace, id))
    ).rejects.toMatchObject({ _tag: "WhatsAppRejected" })
    await expect(
      run(f.importer(input.id, imageMetadata))
    ).rejects.toMatchObject({ _tag: "WhatsAppRejected" })
    expect(f.state.downloaded).toBe(1)
  })
})
