import { afterEach, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { configureObservability } from "../scripts/configure-observability"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})
it("enables Issues after deploy while preserving Alchemy tracing settings and excluding bindings", async () => {
  vi.stubEnv("GITHUB_REF", "refs/heads/main")
  vi.stubEnv("GITHUB_EVENT_NAME", "push")
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "synthetic")
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "synthetic")
  const scripts = [
    "agentworker",
    "website",
    "documentworker",
    "executionworker",
    "terminalworker",
  ].map((p) => ({ id: `durable-pi-${p}-production-test` }))
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
      return Response.json({ success: true, result: scripts })
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
  expect(updated.size).toBe(5)
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
