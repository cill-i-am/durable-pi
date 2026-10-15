import {
  prepareRemoteTool,
  identifyRemoteTool,
  type RemoteTool,
} from "../connections"

export async function remoteTool(
  ...input: Parameters<typeof prepareRemoteTool>
): Promise<RemoteTool> {
  const { identity, reference } = prepareRemoteTool(...input)
  return identifyRemoteTool(
    reference,
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))
    )
  )
}
