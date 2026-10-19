import { expect, it, vi } from "vitest"

import { deploymentResponse } from "../src/deployment/http"
import { deploymentReady, waitForDeployment } from "../src/deployment/readiness"

const revision = "a".repeat(40)
const previous = "b".repeat(40)
const ready = {
  website: revision,
  worker: revision,
  agents: [revision, revision],
}

it("requires the website, Worker and every sampled actor to serve the expected code", () => {
  expect(deploymentReady(ready, revision)).toBe(true)
  for (const value of [
    { ...ready, website: previous },
    { ...ready, worker: previous },
    { ...ready, agents: [revision, previous] },
    { ...ready, agents: [] },
    { website: revision },
    null,
  ])
    expect(deploymentReady(value, revision)).toBe(false)
})

it("waits through the actual old-worker/new-website rollout shape and missing RPC methods", async () => {
  let now = 0
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("Method does not exist"))
    .mockResolvedValueOnce({ ...ready, agents: [previous] })
    .mockResolvedValueOnce(ready)
  const wait = vi.fn(async () => {
    now += 1000
  })
  expect(
    await waitForDeployment(revision, { read, now: () => now, wait })
  ).toEqual(ready)
  expect(wait).toHaveBeenCalledTimes(2)
})

it("fails a rollout that never converges and refuses unstamped checks", async () => {
  let now = 0
  const host = {
    read: vi.fn(async () => ({ ...ready, worker: previous })),
    now: () => now,
    wait: async () => {
      now += 1000
    },
  }
  await expect(waitForDeployment("development", host)).rejects.toThrow(
    "full Git SHA"
  )
  expect(host.read).not.toHaveBeenCalled()
  await expect(waitForDeployment(revision, host, 2000)).rejects.toThrow(
    "did not converge"
  )
})

it("authenticates before any owner lookup or actor access and never returns private errors", async () => {
  const read = vi.fn(async () => ({ worker: revision, agents: [revision] }))
  const request = (secret?: string) =>
    new Request("https://app.example/api/deployment", {
      headers: secret ? { "x-setup-token": secret } : {},
    })
  for (const secret of [undefined, "wrong"]) {
    const response = await deploymentResponse(
      request(secret),
      "synthetic-secret",
      read
    )
    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  }
  expect(read).not.toHaveBeenCalled()
  const response = await deploymentResponse(
    request("synthetic-secret"),
    "synthetic-secret",
    read
  )
  expect(await response.json()).toEqual({
    website: "development",
    worker: revision,
    agents: [revision],
  })
  read.mockRejectedValueOnce(new Error("private owner details"))
  const unavailable = await deploymentResponse(
    request("synthetic-secret"),
    "synthetic-secret",
    read
  )
  expect(unavailable.status).toBe(503)
  expect(await unavailable.text()).not.toContain("private")
})
