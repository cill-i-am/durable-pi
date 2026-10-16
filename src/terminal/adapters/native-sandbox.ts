import type { Files } from "@cloudflare/sandbox"
import { MAX_CHECKPOINT } from "../contracts"
import type { ForeignTerminalRuntime } from "./interop"
import { readBounded } from "./stream"
import { nativeCommand } from "./native-process"
import { nativeTerminal } from "./native-terminal"
import { sandboxTransfers } from "./transfer-files"

export function nativeSandboxRuntime(
  container: Container,
  files: Files,
  hold: (task: Promise<unknown>) => void,
  lifecycle: {
    start: (unrestricted: boolean, signal: AbortSignal) => Promise<void>
    close: () => Promise<void>
  }
): ForeignTerminalRuntime {
  const execute = (
    command: string,
    append: (text: string) => void,
    signal: AbortSignal
  ) => nativeCommand(container, command, append, signal)
  const internal = async (command: string, signal: AbortSignal) => {
    if ((await execute(command, () => {}, signal)) !== 0)
      throw new Error("Workspace operation failed")
  }
  return {
    // Keep the existing path/symlink-safe transfer implementation during rehearsal.
    ...sandboxTransfers(
      {
        writeFile: (path, body) => files.writeFile(path, body),
        readFile: async (path) => {
          const response = await files.readFile(path)
          if (!response.body) throw new Error("Missing file body")
          return { content: response.body }
        },
      },
      internal
    ),
    close: () => lifecycle.close(),
    execute,
    restore: async (bytes, signal, unrestricted = false) => {
      signal.throwIfAborted()
      await lifecycle.start(unrestricted, signal)
      signal.throwIfAborted()
      await files.mkdir("/workspace", { recursive: true, signal })
      if (bytes) {
        await files.writeFile("/tmp/pi-workspace.tar.gz", bytes.slice(), {
          signal,
        })
        await internal(
          "tar -xzf /tmp/pi-workspace.tar.gz -C /workspace --no-same-owner",
          signal
        )
      }
    },
    snapshot: async (signal) => {
      await internal(
        "tar --one-file-system --exclude=node_modules --exclude=.git --exclude=.cache -czf /tmp/pi-workspace.tar.gz -C /workspace .",
        signal
      )
      const response = await files.readFile("/tmp/pi-workspace.tar.gz", {
        signal,
      })
      if (!response.body) throw new Error("Missing checkpoint body")
      return readBounded(response.body, MAX_CHECKPOINT, signal)
    },
    openInteractive: async (signal) => {
      signal.throwIfAborted()
      const connections = new Set<Awaited<ReturnType<typeof nativeTerminal>>>()
      return {
        connect: async (request) => {
          const connection = await nativeTerminal(container, request)
          connections.add(connection)
          hold(connection.closed.catch(() => {}))
          void connection.closed.then(
            () => connections.delete(connection),
            () => {}
          )
          return connection.response
        },
        close: async () => {
          for (const connection of connections) connection.close()
          await Promise.all(
            [...connections].map((connection) => connection.closed)
          )
          await internal(
            "tmux kill-session -t owner",
            new AbortController().signal
          )
        },
      }
    },
  }
}
