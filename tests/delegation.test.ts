import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory"
import { Effect } from "effect"
import { expect, it } from "vitest"

import { delegationsRequest } from "../src/delegation/adapters/http"
import { piDelegations } from "../src/delegation/adapters/pi"
import { sharedReference, validateBrief } from "../src/delegation/delegation"
import {
  acknowledgeControl,
  confirmedRejection,
  controlKey,
  pendingControl,
} from "../src/features/activity/delegation-commands"
import { ApiError } from "../src/http/client"

it("copies textual references but never encoded image or sampled video pixels into child instructions", () => {
  const parts = [
    { type: "text", text: "Source: file-123. Do not publish." },
    ...Array.from({ length: 6 }, () => ({
      type: "image",
      data: "PRIVATE_ENCODED_PIXELS",
      mimeType: "image/jpeg",
    })),
  ]
  const value = sharedReference(JSON.stringify(parts))
  expect(value).toContain("file-123")
  expect(value).toContain("Do not publish")
  expect(value).toContain("pixels remain with the parent")
  expect(value).not.toContain("PRIVATE_ENCODED_PIXELS")
  expect(sharedReference("x".repeat(64001))).toContain("too large")
  expect(sharedReference("Ordinary legacy context")).toBe(
    "Ordinary legacy context"
  )
})
it("validates bounded branches and rejects implicit tool escalation", () => {
  const task = { name: "Read", task: "Review files", tools: ["read_file"] }
  expect(
    validateBrief({ objective: "Review", tasks: [task] }).tasks
  ).toHaveLength(1)
  for (const tasks of [
    [task, task],
    [task, { ...task, name: " read " }],
    [{ ...task, tools: ["run_command"] }],
    [{ ...task, tools: ["read_file", "read_file"] }],
    Array(4).fill(task),
  ])
    expect(() => validateBrief({ objective: "Review", tasks })).toThrow()
})
it("isolates bot-local state and rejects foreign task inspection and controls", async () => {
  const h = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    ctx
  )
  const service = piDelegations(
    async () => h,
    { current: () => true, cancelled: () => false },
    () => ({ name: "reader" }),
    () => []
  )
  try {
    expect(await Effect.runPromise(service.list())).toEqual([])
    for (const path of ["delegations/123", "delegations/123/456"])
      expect(
        (
          await Effect.runPromise(
            delegationsRequest(
              service,
              new Request(`https://app/${path}`),
              path
            )
          )
        ).status
      ).toBe(404)
    const input = {
      groupId: 123,
      childId: 456,
      operationId: crypto.randomUUID(),
      action: { type: "stop" },
    }
    expect(
      (
        await Effect.runPromise(
          delegationsRequest(
            service,
            new Request("https://app/delegations/control", {
              method: "POST",
              body: JSON.stringify(input),
            }),
            "delegations/control"
          )
        )
      ).status
    ).toBe(404)
    expect(await Effect.runPromise(service.list())).toEqual([])
  } finally {
    await h.close(ctx)
  }
})
it("retains uncertain control identity through authentication errors and ignores late acknowledgements", () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => {
      values.delete(key)
    },
  }
  const key = controlKey("bot-one", 1, 2, "steer"),
    control = {
      groupId: 1,
      childId: 2,
      operationId: crypto.randomUUID(),
      action: { type: "steer", text: "Use metric units" },
    }
  values.set(key, JSON.stringify(control))
  expect(pendingControl(storage, key)).toEqual(control)
  expect(
    pendingControl(storage, controlKey("bot-two", 1, 2, "steer"))
  ).toBeNull()
  for (const error of [
    new ApiError(401, "Sign in"),
    new ApiError(403, "Denied"),
    new ApiError(429, "Rate limit"),
    new ApiError(503, "Unavailable", "unavailable"),
    new Error("Response lost"),
  ])
    expect(confirmedRejection(error)).toBe(false)
  expect(
    confirmedRejection(new ApiError(409, "Different payload", "conflict"))
  ).toBe(true)
  acknowledgeControl(storage, key, crypto.randomUUID())
  expect(pendingControl(storage, key)).toEqual(control)
  acknowledgeControl(storage, key, control.operationId)
  expect(pendingControl(storage, key)).toBeNull()
})
