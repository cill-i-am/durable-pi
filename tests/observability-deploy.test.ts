import { afterEach, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { configureObservability } from "../scripts/configure-observability"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
it("resolves truncated Worker names by ownership tags and preserves tracing settings", async () => {
  vi.stubEnv("GITHUB_REF", "refs/heads/main")
  vi.stubEnv("GITHUB_EVENT_NAME", "push")
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "synthetic")
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic")
  const scripts = [
    [
      "AgentWorkerDrizzleV1",
      "durable-pi-agentworkerdrizzlev5hoqp3cxfzpncljlz6qzw7c5",
    ],
    ["Website", "durable-pi-website-production-test"],
    ["DocumentWorker", "durable-pi-documentworker-production-test"],
    ["ExecutionWorker", "durable-pi-executionworker-production-test"],
    [
      "TerminalWorkerDrizzleV1",
      "durable-pi-terminalworkerdrizzayyx2ku63x7pdk7rakk3gtaw",
    ],
  ].map(([resourceId, id]) => ({
    id,
    tags: [
      "alchemy:stack:durable-pi",
      "alchemy:stage:production",
      `alchemy:id:${resourceId}`,
    ],
  }))
  const unrelated = [
    { id: "durable-pi-agentworkerdrizzlev1-production-untagged" },
    {
      id: "another-stack",
      tags: [
        "alchemy:stack:other",
        "alchemy:stage:production",
        "alchemy:id:AgentWorkerDrizzleV1",
      ],
    },
    {
      id: "another-stage",
      tags: [
        "alchemy:stack:durable-pi",
        "alchemy:stage:dev",
        "alchemy:id:AgentWorkerDrizzleV1",
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
    if (!url.endsWith("/settings"))
      return Response.json({
        success: true,
        result: [...scripts, ...unrelated],
      })
    if (init?.method === "PATCH") {
      expect(init.body).toBeInstanceOf(FormData)
      const part = (init.body as FormData).get("settings")
      expect(part).toBeInstanceOf(Blob)
      const payload = JSON.parse(await (part as Blob).text())
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
      scripts.map(
        ({ id }) =>
          `https://api.cloudflare.com/client/v4/accounts/synthetic/workers/scripts/${id}/settings`
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

it.each(["missing", "duplicate", "wrong-stack", "wrong-stage", "untagged"])(
  "rejects %s ownership before configuring a Worker",
  async (scenario) => {
    vi.stubEnv("GITHUB_REF", "refs/heads/main")
    vi.stubEnv("GITHUB_EVENT_NAME", "push")
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "synthetic")
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic")
    const owned = {
      id: "truncated-physical-name",
      tags: [
        "alchemy:stack:durable-pi",
        "alchemy:stage:production",
        "alchemy:id:AgentWorkerDrizzleV1",
      ],
    }
    const scripts =
      scenario === "missing"
        ? []
        : scenario === "duplicate"
          ? [owned, { ...owned, id: "another-physical-name" }]
          : [
              {
                ...owned,
                tags:
                  scenario === "untagged"
                    ? undefined
                    : owned.tags.map((tag) =>
                        scenario === "wrong-stack" &&
                        tag === "alchemy:stack:durable-pi"
                          ? "alchemy:stack:other"
                          : scenario === "wrong-stage" &&
                              tag === "alchemy:stage:production"
                            ? "alchemy:stage:dev"
                            : tag
                      ),
              },
            ]
    const network = vi.fn<typeof fetch>(async () =>
      Response.json({ success: true, result: scripts })
    )
    vi.stubGlobal("fetch", network)
    await expect(
      Effect.runPromise(configureObservability)
    ).rejects.toMatchObject({
      _tag: "ObservabilitySetupFailed",
      operation: "resolve AgentWorkerDrizzleV1",
    })
    expect(network).toHaveBeenCalledTimes(1)
  }
)
