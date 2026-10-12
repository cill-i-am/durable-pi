import { runObserved } from "../src/observability/worker"
import { AsyncLocalStorage } from "node:async_hooks"
import { Effect } from "effect"
import { beforeEach, expect, it, vi } from "vitest"
import { inferenceFields, reportHarness } from "../src/observability/events"
import { resolveRoute } from "../src/inference/policy"

const native = vi.hoisted(() => ({
  spans: [] as {
    name: string
    parent?: string
    attributes: Record<string, unknown>
    ended: boolean
  }[],
  context: undefined as AsyncLocalStorage<string> | undefined,
}))
vi.mock("cloudflare:workers", () => ({
  tracing: {
    startActiveSpan(name: string, body: (span: unknown) => unknown) {
      const row = {
        name,
        parent: native.context!.getStore(),
        attributes: {},
        ended: false,
      }
      native.spans.push(row)
      return native.context!.run(name, () =>
        body({
          isTraced: true,
          setAttribute: (key: string, value: unknown) => {
            Object.assign(row.attributes, { [key]: value })
          },
          end: () => {
            row.ended = true
          },
        })
      )
    },
  },
}))

beforeEach(() => {
  native.context = new AsyncLocalStorage<string>()
  native.spans.length = 0
})

it("uses Alchemy's tracer with separate invocation parents and nested Effect spans", async () => {
  await Promise.all(
    ["request-a", "request-b"].map((id) =>
      native.context!.run(id, () =>
        runObserved(
          Effect.sleep("1 millis").pipe(
            Effect.andThen(
              Effect.sync(() => {
                expect(native.context!.getStore()).toBe(`child-${id}`)
              }).pipe(Effect.withSpan(`child-${id}`))
            ),
            Effect.withSpan(`root-${id}`)
          )
        )
      )
    )
  )
  for (const id of ["request-a", "request-b"]) {
    expect(native.spans.find((s) => s.name === `root-${id}`)?.parent).toBe(id)
    expect(native.spans.find((s) => s.name === `child-${id}`)?.parent).toBe(
      `root-${id}`
    )
  }
  expect(
    native.spans.every(
      (s) => s.ended && s.attributes["effect.exit"] === "success"
    )
  ).toBe(true)
})
it("ends failed and interrupted spans without converting either to successful work", async () => {
  const failure = new Error("synthetic failure")
  await expect(
    runObserved(Effect.fail(failure).pipe(Effect.withSpan("failed")))
  ).rejects.toBe(failure)
  const controller = new AbortController()
  const task = runObserved(Effect.never.pipe(Effect.withSpan("cancelled")), {
    signal: controller.signal,
  })
  await vi.waitFor(() =>
    expect(native.spans.some((s) => s.name === "cancelled")).toBe(true)
  )
  controller.abort()
  await expect(task).rejects.toBeDefined()
  expect(
    native.spans.find((s) => s.name === "failed")?.attributes["effect.exit"]
  ).toBe("failure")
  expect(
    native.spans.find((s) => s.name === "cancelled")?.attributes["effect.exit"]
  ).toBe("interrupted")
})
it("keeps unknown usage unknown and separates cached input from uncached input", () => {
  const attempt = {
    id: "request",
    turnId: "run",
    route: resolveRoute("conversation"),
    purpose: "conversation",
    startedAt: "2026-10-12T10:00:00Z",
    finishedAt: "2026-10-12T10:00:02Z",
    outcome: "completed" as const,
    error: null,
    reportedModel: null,
    input: 100,
    cached: 80,
    output: 4,
  }
  expect(inferenceFields(attempt)).toMatchObject({
    elapsedMs: 2000,
    inputTokens: 100,
    cachedInputTokens: 80,
    uncachedInputTokens: 20,
    outputTokens: 4,
  })
  expect(
    inferenceFields({ ...attempt, input: null, cached: null, output: null })
  ).toMatchObject({
    inputTokens: null,
    uncachedInputTokens: null,
    outputTokens: null,
  })
})
it("uses native console.error severity for a handled harness failure", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    reportHarness(new Error("synthetic"), "personal")
    expect(error).toHaveBeenCalledOnce()
    expect(error.mock.calls[0]?.[0]).toMatchObject({
      annotations: { event: "harness.operation_failed" },
    })
  } finally {
    error.mockRestore()
  }
})

it("observes the native slow-dispatch signal but excludes normal waits and cancellation", async () => {
  const { lifecycleIncident } = await import("../src/observability/lifecycle")
  expect(
    lifecycleIncident({
      type: "job:slow_dispatch",
      payload: { id: "pump", thresholdMs: 600000 },
    })._tag
  ).toBe("Some")
  expect(
    lifecycleIncident({ type: "tool:approval", payload: { approved: false } })
      ._tag
  ).toBe("None")
  expect(lifecycleIncident({ type: "message:cancel", payload: {} })._tag).toBe(
    "None"
  )
})
