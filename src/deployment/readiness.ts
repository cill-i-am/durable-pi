import { Schema } from "effect"

export const Deployment = Schema.Struct({
  website: Schema.String,
  worker: Schema.String,
  agents: Schema.Array(Schema.String).check(Schema.isMinLength(1)),
})
export type Deployment = typeof Deployment.Type

/** Every sampled producer must acknowledge the requested build. A new website
 * calling an old Worker/actor is still rolling out, even if all return 200. */
export function deploymentReady(value: unknown, expected: string): boolean {
  const result = Schema.decodeUnknownOption(Deployment)(value)
  return (
    result._tag === "Some" &&
    result.value.website === expected &&
    result.value.worker === expected &&
    result.value.agents.every((revision) => revision === expected)
  )
}

export async function waitForDeployment(
  expected: string,
  host: {
    read: () => Promise<unknown>
    now: () => number
    wait: () => Promise<void>
  },
  timeout = 8 * 60_000
): Promise<Deployment> {
  if (!/^[a-f0-9]{40}$/.test(expected))
    throw new Error("Expected deployment revision must be a full Git SHA.")
  const deadline = host.now() + timeout
  for (;;) {
    try {
      const value = await host.read()
      if (deploymentReady(value, expected))
        return Schema.decodeUnknownSync(Deployment)(value)
    } catch {
      // Missing methods and temporary transport errors are normal during the
      // rolling update. None may be mistaken for readiness.
    }
    if (host.now() >= deadline)
      throw new Error(`Deployment did not converge on revision ${expected}.`)
    await host.wait()
  }
}
