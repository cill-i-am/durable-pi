import { it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, expect, vi } from "vitest"

import { configureObservability } from "../scripts/configure-observability"

const deployed = (id: string, resource: string, stage = "production") => ({
  id,
  tags: [
    "alchemy:stack:durable-pi",
    `alchemy:stage:${stage}`,
    `alchemy:id:${resource}`,
  ],
})
const productionScripts = [
  deployed("shortened-agent-script", "AgentWorkerDrizzleV1"),
  deployed("website-script", "Website"),
  deployed("document-script", "DocumentWorker"),
  deployed("execution-script", "ExecutionWorker"),
  deployed("native-terminal-script", "TerminalWorkerSandboxV1"),
]

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
it("updates script-level Issues without reconciling Durable Object exports or changing tracing and bindings", async () => {
  vi.stubEnv("GITHUB_REF", "refs/heads/main")
  vi.stubEnv("GITHUB_EVENT_NAME", "push")
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "synthetic")
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic")
  const scripts = [
    ...productionScripts,
    deployed(
      "durable-pi-agentworkerdrizzlev1-production-decoy",
      "AgentWorkerDrizzleV1",
      "dev"
    ),
    deployed("retired-agent", "AgentWorker"),
    { id: "unmanaged-worker" },
    { id: "untagged-worker", tags: null },
    {
      id: "different-stack",
      tags: [
        "alchemy:stack:other",
        "alchemy:stage:production",
        "alchemy:id:Website",
      ],
    },
  ]
  const obs = {
    enabled: true,
    traces: { enabled: true, head_sampling_rate: 1, persist: true },
    logs: { enabled: true, invocation_logs: true },
    issues: { enabled: false },
  }
  const updated = new Set<string>()
  const network = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith("/settings"))
      return init?.method === "PATCH"
        ? Response.json(
            { success: false, errors: [{ code: 100402 }] },
            { status: 400 }
          )
        : Response.json({ success: true, result: { observability: obs } })
    if (!url.endsWith("/script-settings"))
      return Response.json({ success: true, result: scripts })
    if (init?.method === "PATCH") {
      expect(init.headers).toMatchObject({
        "content-type": "application/json",
      })
      const payload = JSON.parse(String(init.body))
      expect(payload).toEqual({
        observability: { ...obs, issues: { enabled: true } },
      })
      updated.add(url)
      return Response.json({ success: true, result: {} })
    }
    return Response.json({
      success: true,
      result: {
        bindings: [{ type: "secret_text", name: "unrelated" }],
        observability: { ...obs, issues: { enabled: updated.has(url) } },
      },
    })
  })
  vi.stubGlobal("fetch", network)
  await Effect.runPromise(configureObservability)
  expect(updated).toEqual(
    new Set(
      productionScripts.map(
        ({ id }) =>
          `https://api.cloudflare.com/client/v4/accounts/synthetic/workers/scripts/${id}/script-settings`
      )
    )
  )
  expect(network).toHaveBeenCalledTimes(16)
})
it("rejects a non-main invocation before contacting Cloudflare", async () => {
  vi.stubEnv("GITHUB_REF", "refs/heads/topic")
  vi.stubEnv("GITHUB_EVENT_NAME", "push")
  const network = vi.fn()
  vi.stubGlobal("fetch", network)
  await expect(Effect.runPromise(configureObservability)).rejects.toMatchObject(
    { _tag: "ObservabilitySetupFailed", operation: "main deployment guard" }
  )
  expect(network).not.toHaveBeenCalled()
})

it("reports invalid list metadata before making any settings changes", async () => {
  vi.stubEnv("GITHUB_REF", "refs/heads/main")
  vi.stubEnv("GITHUB_EVENT_NAME", "push")
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "synthetic")
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic")
  const network = vi.fn<typeof fetch>(async () =>
    Response.json({ success: true, result: [{ id: "invalid", tags: 123 }] })
  )
  vi.stubGlobal("fetch", network)
  await expect(Effect.runPromise(configureObservability)).rejects.toMatchObject(
    {
      _tag: "ObservabilitySetupFailed",
      operation: "Worker list metadata schema",
    }
  )
  expect(network).toHaveBeenCalledTimes(1)
})

it.effect(
  "waits for stale readbacks without repeating the accepted patch",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("GITHUB_REF", "refs/heads/main")
      vi.stubEnv("GITHUB_EVENT_NAME", "push")
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "synthetic")
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic")
      const updated = new Set<string>()
      let terminalReadbacks = 0
      const network = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input)
        if (url.endsWith("/scripts"))
          return Response.json({ success: true, result: productionScripts })
        if (init?.method === "PATCH") {
          updated.add(url)
          return Response.json({ success: true, result: {} })
        }
        const terminal =
          url.includes("native-terminal-script") && updated.has(url)
        if (terminal) terminalReadbacks++
        return Response.json({
          success: true,
          result: {
            observability: {
              enabled: true,
              issues: {
                enabled:
                  updated.has(url) && (!terminal || terminalReadbacks > 2),
              },
            },
          },
        })
      })
      vi.stubGlobal("fetch", network)
      const running = yield* configureObservability.pipe(Effect.forkChild)
      yield* TestClock.adjust("30 seconds")
      yield* Fiber.join(running)
      expect(terminalReadbacks).toBe(3)
      expect(
        network.mock.calls.filter(([, init]) => init?.method === "PATCH")
      ).toHaveLength(5)
    })
)

it.effect(
  "still fails after bounded readbacks if the provider never confirms Issues",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("GITHUB_REF", "refs/heads/main")
      vi.stubEnv("GITHUB_EVENT_NAME", "push")
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "synthetic")
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic")
      const network = vi.fn<typeof fetch>(async (input) =>
        Response.json({
          success: true,
          result: String(input).endsWith("/scripts")
            ? productionScripts
            : { observability: { enabled: true } },
        })
      )
      vi.stubGlobal("fetch", network)
      const running = yield* configureObservability.pipe(
        Effect.flip,
        Effect.forkChild
      )
      yield* TestClock.adjust("30 seconds")
      expect(yield* Fiber.join(running)).toMatchObject({
        _tag: "ObservabilitySetupFailed",
        operation: "Verify Issues enabled: shortened-agent-script",
      })
      expect(
        network.mock.calls.filter(([, init]) => init?.method === "PATCH")
      ).toHaveLength(1)
      expect(network).toHaveBeenCalledTimes(13)
    })
)

it("does not retry a rejected readback or repeat the patch", async () => {
  vi.stubEnv("GITHUB_REF", "refs/heads/main")
  vi.stubEnv("GITHUB_EVENT_NAME", "push")
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "synthetic")
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic")
  let patched = false
  const network = vi.fn<typeof fetch>(async (input, init) => {
    if (String(input).endsWith("/scripts"))
      return Response.json({ success: true, result: productionScripts })
    if (init?.method === "PATCH") {
      patched = true
      return Response.json({ success: true, result: {} })
    }
    return patched
      ? Response.json({ success: false }, { status: 403 })
      : Response.json({
          success: true,
          result: { observability: { enabled: true } },
        })
  })
  vi.stubGlobal("fetch", network)
  await expect(Effect.runPromise(configureObservability)).rejects.toMatchObject(
    {
      _tag: "ObservabilitySetupFailed",
      operation: "Cloudflare response",
      status: 403,
    }
  )
  expect(network).toHaveBeenCalledTimes(4)
})

it.effect(
  "interrupts a stalled readback at the deadline without another patch",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("GITHUB_REF", "refs/heads/main")
      vi.stubEnv("GITHUB_EVENT_NAME", "push")
      vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "synthetic")
      vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic")
      let patched = false
      let interrupted = false
      const network = vi.fn<typeof fetch>(async (input, init) => {
        if (String(input).endsWith("/scripts"))
          return Response.json({ success: true, result: productionScripts })
        if (init?.method === "PATCH") {
          patched = true
          return Response.json({ success: true, result: {} })
        }
        if (!patched)
          return Response.json({
            success: true,
            result: { observability: { enabled: true } },
          })
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              interrupted = true
              reject(new DOMException("Aborted", "AbortError"))
            },
            { once: true }
          )
        })
      })
      vi.stubGlobal("fetch", network)
      const running = yield* configureObservability.pipe(
        Effect.flip,
        Effect.forkChild
      )
      yield* TestClock.adjust("30 seconds")
      expect(yield* Fiber.join(running)).toMatchObject({
        _tag: "ObservabilitySetupFailed",
        operation: "Verify Issues enabled: shortened-agent-script",
      })
      expect(interrupted).toBe(true)
      expect(network).toHaveBeenCalledTimes(4)
    })
)

it.each(["missing", "ambiguous"])(
  "rejects %s ownership before changing any settings",
  async (mode) => {
    vi.stubEnv("GITHUB_REF", "refs/heads/main")
    vi.stubEnv("GITHUB_EVENT_NAME", "push")
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "synthetic")
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic")
    const scripts =
      mode === "missing"
        ? productionScripts.slice(0, -1)
        : [
            ...productionScripts,
            deployed("duplicate-terminal-script", "TerminalWorkerSandboxV1"),
          ]
    const network = vi.fn<typeof fetch>(async () =>
      Response.json({ success: true, result: scripts })
    )
    vi.stubGlobal("fetch", network)
    await expect(
      Effect.runPromise(configureObservability)
    ).rejects.toMatchObject({
      _tag: "ObservabilitySetupFailed",
      operation: "resolve TerminalWorkerSandboxV1",
    })
    expect(network).toHaveBeenCalledTimes(1)
  }
)
