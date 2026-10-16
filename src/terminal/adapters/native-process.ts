import { Cause, Schema } from "effect"
import { TerminalFailure } from "../contracts"
import { withReader } from "./stream"

/** Own the native output reader and process until both settle. */
export async function readNativeProcess(
  process: Pick<ExecProcess, "stdout" | "exitCode" | "kill">,
  append: (text: string) => void,
  signal: AbortSignal
) {
  const state = { exited: false }
  const exit = process.exitCode.then(
    (code) => {
      state.exited = true
      return { code }
    },
    (cause: unknown) => {
      state.exited = true
      return { cause }
    }
  )
  let failure: Cause.Cause<unknown> | undefined
  try {
    if (!process.stdout) throw new Error("Missing command output")
    await withReader(process.stdout, signal, async (read) => {
      const decoder = new TextDecoder()
      let bytes = 0
      const output = (text: string) => {
        if (!text) return
        try {
          append(text)
        } catch (cause) {
          throw Schema.is(TerminalFailure)(cause) ? cause : Cause.die(cause)
        }
      }
      for (;;) {
        const item = await read()
        signal.throwIfAborted()
        if (item.done) {
          output(decoder.decode())
          break
        }
        bytes += item.value.byteLength
        if (bytes > 256000) throw new Error("Output limit")
        output(decoder.decode(item.value, { stream: true }))
      }
    })
  } catch (cause) {
    failure = Cause.isCause(cause) ? cause : Cause.fail(cause)
    if (!state.exited) {
      try {
        process.kill(9)
      } catch (cause) {
        failure = Cause.combine(failure, Cause.die(cause))
      }
    }
  }
  const result = await exit
  if ("cause" in result) {
    const cause = Cause.isCause(result.cause)
      ? result.cause
      : Cause.fail(result.cause)
    failure = failure ? Cause.combine(failure, cause) : cause
  }
  if (failure) throw failure
  if (!("code" in result) || !Number.isSafeInteger(result.code))
    throw new Error("Invalid command exit code")
  return result.code
}

export async function nativeCommand(
  container: Pick<Container, "exec">,
  command: string,
  append: (text: string) => void,
  signal: AbortSignal
) {
  signal.throwIfAborted()
  const process = await container.exec(
    ["timeout", "--kill-after=5", "30", "/bin/bash", "-c", command],
    { cwd: "/workspace", stdout: "pipe", stderr: "combined", signal }
  )
  return readNativeProcess(process, append, signal)
}

export async function startNativeContainer(
  container: Pick<Container, "start" | "images" | "setInactivityTimeout">,
  unrestricted = false
) {
  const image = container.images.TerminalImage
  if (!image) throw new Error("Missing native terminal image")
  container.start({
    image,
    instance: "standard-1",
    enableInternet: unrestricted,
  })
  await container.setInactivityTimeout(60000)
}
