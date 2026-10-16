import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"

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
  deployed("shortened-terminal-script", "TerminalWorkerDrizzleV1"),
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
            deployed("duplicate-terminal-script", "TerminalWorkerDrizzleV1"),
          ]
    const network = vi.fn<typeof fetch>(async () =>
      Response.json({ success: true, result: scripts })
    )
    vi.stubGlobal("fetch", network)
    await expect(
      Effect.runPromise(configureObservability)
    ).rejects.toMatchObject({
      _tag: "ObservabilitySetupFailed",
      operation: "resolve TerminalWorkerDrizzleV1",
    })
    expect(network).toHaveBeenCalledTimes(1)
  }
)
