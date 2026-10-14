import { Schema } from "effect"
import { CommandRun, TerminalState, type CommandInput } from "../contracts"

export async function runCommand(
  service: Fetcher,
  identity: string,
  input: CommandInput,
  signal: AbortSignal = new AbortController().signal
) {
  const stopped = () => signal.aborted
  if (stopped()) throw new Error("Command stopped")
  const request = async (path: string, body?: unknown) => {
    const result = await service.fetch(
      new Request(
        `https://terminal.internal/${identity}/terminal${path ? `/${path}` : ""}`,
        {
          method: body ? "POST" : "GET",
          headers: { "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined,
        }
      )
    )
    if (!result.ok)
      throw new Error(
        "The terminal request failed. Check its saved status before starting another command."
      )
    return result.json()
  }
  const id = encodeURIComponent(input.id)
  let cancellation: Promise<unknown> | undefined
  const stop = () => {
    cancellation = request(`${id}/cancel`, {}).catch(() => {})
  }
  signal.addEventListener("abort", stop, { once: true })
  try {
    let result = Schema.decodeUnknownSync(CommandRun)(
      await request("run", input)
    )
    for (;;) {
      if (stopped()) {
        await cancellation
        return Schema.decodeUnknownSync(CommandRun)(
          await request(`${id}/cancel`, {})
        )
      }
      if (result.status !== "running") {
        const state = Schema.decodeUnknownSync(TerminalState)(await request(""))
        if (state.cleanupError) return { ...result, error: state.cleanupError }
        if (!state.busy) return result
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, 500)
        function done() {
          clearTimeout(timer)
          signal.removeEventListener("abort", done)
          resolve()
        }
        signal.addEventListener("abort", done, { once: true })
      })
      result = Schema.decodeUnknownSync(CommandRun)(await request(id))
    }
  } finally {
    signal.removeEventListener("abort", stop)
    await cancellation
  }
}
