import { it as effectIt } from "@effect/vitest"
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { expect, it, onTestFinished, vi } from "vitest"

import { effectInteractiveRuntime } from "../src/terminal/adapters/interop"
import { runCommand } from "../src/terminal/adapters/service"
import { terminalToolResult } from "../src/terminal/adapters/tools"
import {
  completeCommand,
  type CommandClient,
} from "../src/terminal/command-client"
import { TerminalFailure } from "../src/terminal/contracts"
import type { CommandRun } from "../src/terminal/contracts"
import { TerminalRuntimeError } from "../src/terminal/runtime"
import {
  makeInteractiveSession,
  type TerminalRelay,
} from "../src/terminal/session"

async function ownedSession(
  ...args: Parameters<typeof makeInteractiveSession>
) {
  const scope = Effect.runSync(Scope.make())
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  return Effect.runPromise(
    makeInteractiveSession(...args).pipe(
      Effect.provideService(Scope.Scope, scope)
    )
  )
}

const input = { id: "command:original", command: "printf hello" }
const running: CommandRun = {
  ...input,
  status: "running",
  kind: "command",
  output: "",
  exitCode: null,
  error: null,
  createdAt: 1,
  finishedAt: null,
  savedAt: null,
}
const done: CommandRun = {
  ...running,
  status: "succeeded",
  exitCode: 0,
  output: "hello",
  finishedAt: 2,
  savedAt: 2,
}
const idle = {
  runs: [],
  savedAt: 2,
  busy: false,
  cleanupError: null,
  session: null,
}
function gate<T = void>() {
  let release!: (value: T) => void
  const waiting = new Promise<T>((resolve) => {
    release = resolve
  })
  return { waiting, release }
}
function reasons(exit: Exit.Exit<unknown, unknown>) {
  return Exit.isFailure(exit) ? exit.cause.reasons : []
}
function client(overrides: Partial<CommandClient> = {}): CommandClient {
  return {
    start: Effect.succeed(done),
    read: Effect.succeed(done),
    state: Effect.succeed(idle),
    cancel: Effect.succeed(null),
    ...overrides,
  }
}
function interrupted(exit: Exit.Exit<unknown, unknown>) {
  return Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)
}

effectIt.effect(
  "waits for the original receipt and confirmed cleanup using the invocation clock",
  () =>
    Effect.gen(function* () {
      let reads = 0,
        states = 0
      const entered = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        completeCommand(
          input,
          client({
            start: Deferred.succeed(entered, undefined).pipe(
              Effect.as(running)
            ),
            read: Effect.sync(() => {
              reads++
              return done
            }),
            state: Effect.sync(() => ({ ...idle, busy: ++states === 1 })),
          })
        )
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("500 millis")
      expect(reads).toBe(1)
      expect(fiber.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust("500 millis")
      expect(yield* Fiber.join(fiber)).toEqual(done)
      expect(reads).toBe(2)
      expect(states).toBe(2)
    })
)

effectIt.effect(
  "bounds command observation and cancels the original identity once at its deadline",
  () =>
    Effect.gen(function* () {
      let cancelled = 0
      const entered = yield* Deferred.make<void>()
      const fiber = yield* Effect.forkChild(
        Effect.exit(
          completeCommand(
            input,
            client({
              start: Deferred.succeed(entered, undefined).pipe(
                Effect.as(running)
              ),
              read: Effect.succeed(running),
              cancel: Effect.sync(() => {
                cancelled++
                return null
              }),
            })
          )
        )
      )
      yield* Deferred.await(entered)
      yield* TestClock.adjust("45 seconds")
      expect(reasons(yield* Fiber.join(fiber))).toContainEqual(
        expect.objectContaining({
          _tag: "Fail",
          error: expect.objectContaining({
            _tag: "TerminalFailure",
            message: expect.stringContaining("observation window"),
          }),
        })
      )
      expect(cancelled).toBe(1)
    })
)

it("preserves identity conflicts and cleanup warnings without another command admission", async () => {
  const conflict = await Effect.runPromiseExit(
    completeCommand(
      input,
      client({ start: Effect.succeed({ ...done, command: "different" }) })
    )
  )
  expect(reasons(conflict)).toContainEqual(
    expect.objectContaining({
      _tag: "Fail",
      error: expect.objectContaining({ _tag: "TerminalFailure" }),
    })
  )
  expect(
    await Effect.runPromise(
      completeCommand(
        input,
        client({
          state: Effect.succeed({
            ...idle,
            cleanupError: "Cleanup could not be confirmed.",
          }),
        })
      )
    )
  ).toEqual({ ...done, error: "Cleanup could not be confirmed." })
})

it("pre-cancelled and invalid command inputs make no binding request", async () => {
  const fetch = vi.fn(async () => Response.json(done)),
    controller = new AbortController()
  controller.abort()
  expect(
    interrupted(
      await Effect.runPromiseExit(runCommand({ fetch }, "owner", input), {
        signal: controller.signal,
      })
    )
  ).toBe(true)
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        runCommand({ fetch }, "owner", { ...input, command: "" })
      )
    )
  ).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
})

for (const phase of ["admission", "poll", "state"] as const) {
  it(`Stop fences the original command before joining a held ${phase} acknowledgement`, async () => {
    const entered = gate(),
      cancelled = gate(),
      reply = gate<Response>(),
      controller = new AbortController()
    let ended = false,
      cancellations = 0,
      admissions = 0
    const fetch = vi.fn(async (request: Request) => {
      const path = new URL(request.url).pathname
      if (path.endsWith("/cancel")) {
        cancellations++
        cancelled.release()
        return Response.json(null)
      }
      if (path.endsWith("/run")) {
        admissions++
        if (phase !== "admission")
          return Response.json(phase === "state" ? done : running)
      }
      entered.release()
      return reply.waiting
    })
    const pending = Effect.runPromiseExit(
      runCommand({ fetch }, "owner", input),
      { signal: controller.signal }
    ).then((exit) => {
      ended = true
      return exit
    })
    await entered.waiting
    controller.abort()
    await cancelled.waiting
    expect(ended).toBe(false)
    reply.release(Response.json(phase === "state" ? idle : running))
    expect(interrupted(await pending)).toBe(true)
    expect(cancellations).toBe(1)
    expect(admissions).toBe(1)
    expect(
      fetch.mock.calls.some(([request]) =>
        request.url.includes(encodeURIComponent(input.id) + "/cancel")
      )
    ).toBe(true)
  })
}

it.each(["unavailable", "wrong identity"] as const)(
  "joins and exposes an unconfirmed Stop with %s acknowledgement",
  async (acknowledgement) => {
    const entered = gate(),
      reply = gate<Response>(),
      controller = new AbortController()
    let cancellations = 0
    const fetch = async (request: Request) => {
      if (request.url.endsWith("/cancel")) {
        cancellations++
        return acknowledgement === "unavailable"
          ? new Response("private cancel unavailable", { status: 503 })
          : Response.json({ ...done, id: "another-command" })
      }
      entered.release()
      return reply.waiting
    }
    const pending = Effect.runPromiseExit(
      runCommand({ fetch }, "owner", input),
      {
        signal: controller.signal,
      }
    )
    await entered.waiting
    controller.abort()
    reply.release(Response.json(running))
    const exit = await pending
    expect(interrupted(exit)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(cancellations).toBe(1)
  }
)

it("rejects an already aborted socket request before acquiring a native upgrade", async () => {
  const requestController = new AbortController(),
    connect = vi.fn(async () => new Response())
  const session = await ownedSession(
    "session",
    new AbortController(),
    () => {
      throw new Error("Unexpected relay")
    },
    Effect.runSync(Clock.Clock)
  )
  await Effect.runPromise(
    session.ready(effectInteractiveRuntime({ connect, close: async () => {} }))
  )
  requestController.abort()
  const exit = await Effect.runPromiseExit(
    session.connect(
      new Request("https://terminal.internal", {
        signal: requestController.signal,
      })
    )
  )
  expect(Exit.isFailure(exit)).toBe(true)
  expect(connect).not.toHaveBeenCalled()
  session.dispose()
})

it("retains a late receipt cleanup defect after Stop while joining its body", async () => {
  const entered = gate(),
    cancelled = gate(),
    reply = gate<Response>(),
    cleaning = gate(),
    release = gate(),
    controller = new AbortController(),
    defect = new Error("late receipt cleanup")
  const fetch = async (request: Request) => {
    if (request.url.endsWith("/cancel")) {
      cancelled.release()
      return Response.json(null)
    }
    entered.release()
    return reply.waiting
  }
  let ended = false
  const pending = Effect.runPromiseExit(runCommand({ fetch }, "owner", input), {
    signal: controller.signal,
  }).then((exit) => {
    ended = true
    return exit
  })
  await entered.waiting
  controller.abort()
  await cancelled.waiting
  reply.release(
    new Response(
      new ReadableStream({
        async cancel() {
          cleaning.release()
          await release.waiting
          throw defect
        },
      })
    )
  )
  await cleaning.waiting
  expect(ended).toBe(false)
  release.release()
  expect(reasons(await pending)).toContainEqual(
    expect.objectContaining({ _tag: "Die", defect })
  )
})

it("bounds and validates command responses and releases rejected bodies", async () => {
  for (const response of [
    new Response("{private"),
    new Response(new Uint8Array(512 * 1024 + 1)),
    new Response("private", { status: 503 }),
  ]) {
    const exit = await Effect.runPromiseExit(
      runCommand({ fetch: async () => response }, "owner", input)
    )
    expect(reasons(exit)).toContainEqual(
      expect.objectContaining({
        _tag: "Fail",
        error: expect.objectContaining({ _tag: "TerminalRuntimeError" }),
      })
    )
    expect(response.body?.locked).toBe(false)
  }
})

it("projects safe expected tool failures and marks unconfirmed cleanup as an error", async () => {
  const failure = await Effect.runPromise(
    terminalToolResult(
      Effect.fail(
        new TerminalRuntimeError({
          operation: "private operation",
          cause: "private SDK response",
        })
      )
    )
  )
  expect(JSON.stringify(failure)).not.toContain("private")
  expect(failure.isError).toBe(true)
  expect(
    (
      await Effect.runPromise(
        terminalToolResult(
          Effect.fail(new TerminalFailure({ message: "Inspect Terminal." }))
        )
      )
    ).output[0]?.text
  ).toBe("Inspect Terminal.")
  const cleanup = await Effect.runPromise(
    terminalToolResult(
      Effect.succeed({ ...done, error: "Cleanup could not be confirmed." })
    )
  )
  expect(cleanup.isError).toBe(true)
})

it("does not turn a tool defect or interruption with an expected error into a normal result", async () => {
  const defect = new Error("private tool invariant")
  for (const operation of [
    Effect.die(defect),
    Effect.fail(new TerminalFailure({ message: "Expected" })).pipe(
      Effect.ensuring(Effect.die(defect))
    ),
    Effect.interrupt,
  ]) {
    const exit = await Effect.runPromiseExit(terminalToolResult(operation))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(
      Exit.isFailure(exit) &&
        (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
    ).toBe(true)
  }
})

function socket() {
  const value = {
    readyState: 1,
    accept: vi.fn(),
    close: vi.fn(() => {
      value.readyState = 3
    }),
  }
  // The native Response.webSocket extension is supplied by workerd in the
  // integration fixture; this unit fake verifies its ownership transitions.
  const response = { webSocket: value } as unknown as Response
  return { value, response }
}
it("a scoped upgrade closes an accepted socket until its owner explicitly transfers it", async () => {
  const first = socket(),
    runtime = effectInteractiveRuntime({
      connect: async () => first.response,
      close: async () => {},
    })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* runtime.connect(
          new Request("https://terminal.internal")
        )
        lease.accept()
        lease.accept()
      })
    )
  )
  expect(first.value.accept).toHaveBeenCalledOnce()
  expect(first.value.close).toHaveBeenCalledOnce()
  const next = socket(),
    transferred = effectInteractiveRuntime({
      connect: async () => next.response,
      close: async () => {},
    })
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* transferred.connect(
          new Request("https://terminal.internal")
        )
        lease.accept()
        lease.transfer()
      })
    )
  )
  expect(next.value.close).not.toHaveBeenCalled()
  const unclaimed = socket(),
    invalid = effectInteractiveRuntime({
      connect: async () => unclaimed.response,
      close: async () => {},
    })
  const invalidExit = await Effect.runPromiseExit(
    Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* invalid.connect(
          new Request("https://terminal.internal")
        )
        lease.transfer()
      })
    )
  )
  expect(Exit.isFailure(invalidExit) && Cause.hasDies(invalidExit.cause)).toBe(
    true
  )
  expect(unclaimed.value.close).toHaveBeenCalledOnce()
})

it("partial relay installation releases the socket and ends the unsafe session", async () => {
  const upstream = socket(),
    defect = new Error("relay installation"),
    runtime = effectInteractiveRuntime({
      connect: async () => upstream.response,
      close: async () => {},
    })
  const session = await ownedSession(
    "session",
    new AbortController(),
    (open) => {
      open()
      throw defect
    },
    Effect.runSync(Clock.Clock)
  )
  await Effect.runPromise(session.ready(runtime))
  const exit = await Effect.runPromiseExit(
    session.connect(new Request("https://terminal.internal"))
  )
  expect(reasons(exit)).toContainEqual(
    expect.objectContaining({ _tag: "Die", defect })
  )
  expect(session.live).toBe(false)
  expect(
    reasons(await Effect.runPromiseExit(session.settleConnections()))
  ).toContainEqual(expect.objectContaining({ _tag: "Die", defect }))
  expect(upstream.value.close).toHaveBeenCalledOnce()
  session.dispose()
})

it("retains both acceptance and closure defects while releasing an unclaimed socket", async () => {
  const upstream = socket(),
    accept = new Error("accept failed"),
    close = new Error("close failed")
  upstream.value.accept.mockImplementation(() => {
    throw accept
  })
  upstream.value.close.mockImplementation(() => {
    throw close
  })
  const runtime = effectInteractiveRuntime({
    connect: async () => upstream.response,
    close: async () => {},
  })
  const exit = await Effect.runPromiseExit(
    Effect.scoped(runtime.connect(new Request("https://terminal.internal")))
  )
  expect(reasons(exit)).toContainEqual(
    expect.objectContaining({ _tag: "Die", defect: accept })
  )
  expect(reasons(exit)).toContainEqual(
    expect.objectContaining({ _tag: "Die", defect: close })
  )
})

it("records native relay callback failures in the session's owned settlement and stops the session", async () => {
  const upstream = socket(),
    controller = new AbortController(),
    defect = new Error("native callback")
  let fault: ((cause: unknown) => void) | undefined
  const relay: TerminalRelay = (open, _allow, onClose, onFailure) => {
    const value = open()
    fault = onFailure
    return {
      response: new Response(),
      close: () => {
        value.close()
        onClose()
      },
    }
  }
  const session = await ownedSession(
    "session",
    controller,
    relay,
    Effect.runSync(Clock.Clock)
  )
  await Effect.runPromise(
    session.ready(
      effectInteractiveRuntime({
        connect: async () => upstream.response,
        close: async () => {},
      })
    )
  )
  await Effect.runPromise(
    session.connect(new Request("https://terminal.internal"))
  )
  fault!(defect)
  expect(controller.signal.aborted).toBe(true)
  expect(
    reasons(await Effect.runPromiseExit(session.settleConnections()))
  ).toContainEqual(expect.objectContaining({ _tag: "Die", defect }))
  expect(upstream.value.close).toHaveBeenCalledOnce()
})

it("uses an abstract interactive connection without inspecting a platform upgrade response", async () => {
  const reply = new Response(null),
    transfer = vi.fn()
  const session = await ownedSession(
    "abstract",
    new AbortController(),
    () => ({ response: reply, close: () => {} }),
    Effect.runSync(Clock.Clock)
  )
  try {
    await Effect.runPromise(
      session.ready({
        connect: () =>
          Effect.succeed({
            accept: () => {
              throw new Error("This relay needs no native socket")
            },
            transfer,
          }),
        close: () => Effect.void,
        settle: () => Effect.void,
      })
    )
    expect(
      await Effect.runPromise(
        session.connect(new Request("https://terminal.internal"))
      )
    ).toBe(reply)
    expect(transfer).toHaveBeenCalledOnce()
  } finally {
    session.dispose()
  }
})

it("the native interactive adapter rejects a missing upgrade and releases its body", async () => {
  const cancel = vi.fn(async () => {})
  const response = new Response(new ReadableStream({ cancel }))
  const runtime = effectInteractiveRuntime({
    connect: async () => response,
    close: async () => {},
  })
  const exit = await Effect.runPromiseExit(
    Effect.scoped(runtime.connect(new Request("https://terminal.internal")))
  )
  expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
    {
      _tag: "Fail",
      error: { _tag: "TerminalRuntimeError", operation: "connect shell" },
    },
  ])
  expect(cancel).toHaveBeenCalledOnce()
})
