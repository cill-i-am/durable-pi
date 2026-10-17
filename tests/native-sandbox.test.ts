import { Cause } from "effect"
import { expect, it, vi } from "vitest"

import {
  nativeCommand,
  readNativeProcess,
  startNativeContainer,
} from "../src/terminal/adapters/native-process"

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

it("starts the named image with the explicitly saved internet policy", async () => {
  const container = {
    images: { TerminalImage: "registry/terminal@sha256:verified" },
    start: vi.fn(),
    setInactivityTimeout: vi.fn(async () => {}),
  }
  await startNativeContainer(container, true)
  await startNativeContainer(container, false)
  expect(container.start.mock.calls).toEqual([
    [
      {
        image: container.images.TerminalImage,
        instance: "standard-1",
        enableInternet: true,
      },
    ],
    [
      {
        image: container.images.TerminalImage,
        instance: "standard-1",
        enableInternet: false,
      },
    ],
  ])
  expect(container.setInactivityTimeout).toHaveBeenCalledWith(60000)
})

it("waits for process completion after EOF and decodes UTF-8 across native chunks", async () => {
  const exit = pending<number>()
  const bytes = new TextEncoder().encode("café 🧭")
  const process = {
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        for (const byte of bytes) c.enqueue(Uint8Array.of(byte))
        c.close()
      },
    }),
    exitCode: exit.promise,
    kill: vi.fn(),
  }
  const received = pending<void>()
  let ended = false,
    text = ""
  const result = readNativeProcess(
    process,
    (chunk) => {
      text += chunk
      if (text === "café 🧭") received.resolve()
    },
    new AbortController().signal
  ).then((code) => {
    ended = true
    return code
  })
  await received.promise
  expect(text).toBe("café 🧭")
  expect(ended).toBe(false)
  expect(process.kill).not.toHaveBeenCalled()
  exit.resolve(7)
  expect(await result).toBe(7)
})

it("passes shell text as one argument with a process-group deadline and merged output", async () => {
  const signal = new AbortController().signal
  const exec = vi.fn(async () => ({
    stdout: new Response("done").body!,
    stderr: null,
    stdin: null,
    exitCode: Promise.resolve(0),
    kill: vi.fn(),
    resize: vi.fn(),
    pid: 1,
    isPty: false,
    output: async () => {
      throw new Error("Streaming expected")
    },
  }))
  const command = "printf 'quoted value'; cat /workspace/proof"
  expect(await nativeCommand({ exec }, command, () => {}, signal)).toBe(0)
  expect(exec).toHaveBeenCalledWith(
    ["timeout", "--kill-after=5", "30", "/bin/bash", "-c", command],
    { cwd: "/workspace", stdout: "pipe", stderr: "combined", signal }
  )
})

it("kills and joins a process after an output callback defect, retaining cleanup failure", async () => {
  const exit = pending<number>()
  const primary = new Error("callback invariant"),
    cleanup = new Error("kill invariant")
  const kill = vi.fn(() => {
    exit.resolve(137)
    throw cleanup
  })
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode("output"))
    },
  })
  const problem = await readNativeProcess(
    { stdout: stream, exitCode: exit.promise, kill },
    () => {
      throw primary
    },
    new AbortController().signal
  ).catch((cause: unknown) => cause)
  expect(kill).toHaveBeenCalledWith(9)
  expect(stream.locked).toBe(false)
  expect(
    Cause.isCause(problem) &&
      problem.reasons.filter((r) => r._tag === "Die").map((r) => r.defect)
  ).toEqual([primary, cleanup])
})

it("cancels the reader and joins native execution when Stop interrupts a read", async () => {
  const controller = new AbortController(),
    exit = pending<number>()
  const cancel = vi.fn(),
    kill = vi.fn(() => {
      exit.resolve(137)
    })
  const process = {
    stdout: new ReadableStream<Uint8Array>({ cancel }),
    exitCode: exit.promise,
    kill,
  }
  const result = readNativeProcess(process, () => {}, controller.signal).catch(
    (cause: unknown) => cause
  )
  controller.abort()
  expect(Cause.isCause(await result)).toBe(true)
  expect(cancel).toHaveBeenCalledOnce()
  expect(kill).toHaveBeenCalledWith(9)
  expect(process.stdout.locked).toBe(false)
})
