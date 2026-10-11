import type { Sandbox } from "@cloudflare/sandbox"
import { MAX_CHECKPOINT } from "../contracts"
import type { TerminalRuntime } from "../terminal"
import { sandboxTransfers } from "./transfer-files"

// SDK 0.12.10's getSandbox({ enableDefaultSession: false }) sends this token.
// We already own the Sandbox instance: use the same typed execution path without
// self-RPC. Its sessionless pipes drain before completion; the default shell's
// background labelers can lose fast command output. Revisit when upgrading 0.x.
// https://github.com/cloudflare/sandbox-sdk/blob/e4877c7368f8b1620bd4400ff831e28fba152eff/packages/sandbox/src/sandbox.ts
const SESSIONLESS = "__DISABLE_SESSION__"

function live(signal: AbortSignal) {
  if (signal.aborted) throw new Error("Stopped")
}
export async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal
) {
  const reader = stream.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  const stop = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", stop, { once: true })
  try {
    live(signal)
    for (;;) {
      const item = await reader.read()
      live(signal)
      if (item.done) break
      size += item.value.length
      if (size > limit) throw new Error("Output limit")
      chunks.push(item.value)
    }
  } finally {
    signal.removeEventListener("abort", stop)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}
export async function readCommand(
  stream: ReadableStream<Uint8Array>,
  append: (text: string) => void,
  signal: AbortSignal
) {
  const reader = stream.getReader(),
    decoder = new TextDecoder()
  let buffer = "",
    total = 0
  const stop = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener("abort", stop, { once: true })
  try {
    live(signal)
    for (;;) {
      const item = await reader.read()
      live(signal)
      if (item.done) throw new Error("Missing command completion")
      total += item.value.length
      if (total > 256000) throw new Error("Protocol limit")
      buffer += decoder.decode(item.value, { stream: true })
      if (buffer.length > 128000) throw new Error("Event limit")
      let end: number
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = event
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n")
        if (!data) continue
        const value = JSON.parse(data) as {
          type?: unknown
          data?: unknown
          exitCode?: unknown
          result?: { exitCode?: unknown }
        }
        if (
          (value.type === "stdout" || value.type === "stderr") &&
          typeof value.data === "string"
        )
          append(value.data)
        if (value.type === "error") throw new Error("Command failed")
        if (value.type === "complete") {
          const code = value.exitCode ?? value.result?.exitCode
          if (!Number.isSafeInteger(code)) throw new Error("Invalid exit code")
          return code as number
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", stop)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
/** SDK 0.x RPC compatibility adapter; untrusted streams are bounded outside the SDK. */
export function sandboxRuntime(sandbox: Sandbox): TerminalRuntime {
  const execute = async (
    command: string,
    append: (text: string) => void,
    signal: AbortSignal
  ) => {
    live(signal)
    const stream = await sandbox.execStream(command, {
      sessionId: SESSIONLESS,
      cwd: "/workspace",
      timeout: 30000,
      signal,
    })
    if (signal.aborted) {
      await stream.cancel().catch(() => {})
      live(signal)
    }
    return readCommand(stream, append, signal)
  }
  const internal = async (command: string, signal: AbortSignal) => {
    const code = await execute(command, () => {}, signal)
    if (code !== 0) throw new Error("Workspace operation failed")
  }
  return {
    ...sandboxTransfers(sandbox, internal),
    close: () => sandbox.destroy(),
    openInteractive: async (signal) => {
      const { proxyTerminal } = await import("@cloudflare/sandbox")
      live(signal)
      await sandbox.createSession({
        id: "owner",
        cwd: "/workspace",
        env: { HISTFILE: "/dev/null" },
      })
      live(signal)
      return {
        connect: (request) =>
          proxyTerminal(sandbox, "owner", request, {
            cols: 80,
            rows: 24,
            shell: "/usr/local/bin/pi-shell",
          }),
        close: async () => {
          await sandbox.deleteSession("owner")
        },
      }
    },
    restore: async (bytes, signal) => {
      live(signal)
      // Drain the previous native stop event before opening a new SDK RPC
      // connection; otherwise that event can interrupt the first restore call.
      await sandbox.startAndWaitForPorts({
        ports: 3000,
        cancellationOptions: {
          instanceGetTimeoutMS: 15000,
          portReadyTimeoutMS: 15000,
        },
      })
      live(signal)
      await sandbox.mkdir("/workspace", { recursive: true })
      live(signal)
      if (bytes) {
        await sandbox.writeFile(
          "/tmp/pi-workspace.tar.gz",
          new Response(bytes.slice().buffer).body!
        )
        live(signal)
        await internal(
          "tar -xzf /tmp/pi-workspace.tar.gz -C /workspace --no-same-owner",
          signal
        )
      }
    },
    execute,
    snapshot: async (signal) => {
      live(signal)
      await internal(
        "tar --one-file-system --exclude=node_modules --exclude=.git --exclude=.cache -czf /tmp/pi-workspace.tar.gz -C /workspace .",
        signal
      )
      live(signal)
      const file = await sandbox.readFile("/tmp/pi-workspace.tar.gz", {
        encoding: "none",
      })
      live(signal)
      return readBounded(file.content, MAX_CHECKPOINT, signal)
    },
  }
}
