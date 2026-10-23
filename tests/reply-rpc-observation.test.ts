import { Cause, Context, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"

import {
  AgentOutcome,
  agentRpc,
  observeAgentRpc,
} from "../src/agents/adapters/rpc"
import {
  AgentStorageError,
  AgentSynchronizationError,
  homeAgentId,
} from "../src/agents/domain"
import {
  WhatsAppOutcome,
  whatsappRemote,
  whatsappRpc,
} from "../src/whatsapp/adapters/rpc"
import {
  WhatsAppRejected,
  WhatsAppStorageError,
  WhatsAppUnavailable,
} from "../src/whatsapp/contracts"

class Marker extends Context.Service<Marker, string>()(
  "ReplyRpcObservationReason"
) {}

interface Observer {
  name: string
  observe: <A>(start: () => Promise<A>) => Effect.Effect<A, unknown>
  rpc: (request: () => Promise<unknown>) => Promise<unknown>
  encode: (exit: Exit.Exit<null, unknown>) => unknown
  errors: readonly { readonly _tag: string }[]
  transportError: string
  privateDefect: string
}

const observers: readonly Observer[] = [
  {
    name: "agent",
    observe: observeAgentRpc,
    rpc: (request) => agentRpc({ agentV1: request }).profile(homeAgentId),
    encode: (exit) => AgentOutcome.encode(exit),
    errors: [
      new AgentStorageError(),
      new AgentSynchronizationError({ operation: "read profile" }),
    ],
    transportError: "AgentSynchronizationError",
    privateDefect: "Agent operation failed unexpectedly.",
  },
  {
    name: "WhatsApp",
    observe: whatsappRemote,
    rpc: (request) =>
      whatsappRpc({ whatsappV1: request }).turn("owner", "message"),
    encode: (exit) => WhatsAppOutcome.encode(exit),
    errors: [
      new WhatsAppRejected({ message: "This request is no longer active." }),
      new WhatsAppStorageError({ operation: "read turn" }),
      new WhatsAppUnavailable(),
    ],
    transportError: "WhatsAppUnavailable",
    privateDefect: "WhatsApp operation failed unexpectedly.",
  },
]

const failed = <A, E>(exit: Exit.Exit<A, E>) => {
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isSuccess(exit)) throw new Error("Expected the observation to fail")
  return exit.cause
}

function deferred<A>() {
  let resolve!: (value: A) => void, reject!: (cause: unknown) => void
  const promise = new Promise<A>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}

async function promptly<A>(promise: Promise<A>): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Observation waited for remote settlement")),
          1000
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe.each(observers)("$name RPC observation", (observer) => {
  it("starts lazily once and returns the original successful value", async () => {
    let calls = 0
    const value = { result: "ready" }
    const work = observer.observe(() => {
      calls++
      return Promise.resolve(value)
    })
    expect(calls).toBe(0)
    expect(await Effect.runPromise(work)).toBe(value)
    expect(calls).toBe(1)
  })

  it.each(["ordinary", "declared"] as const)(
    "keeps a synchronous %s callback throw as a defect",
    async (kind) => {
      const defect =
        kind === "ordinary"
          ? new Error("Synchronous RPC setup failed")
          : observer.errors[0]!
      let calls = 0,
        recovered = false
      const work = observer.observe(() => {
        calls++
        throw defect
      })
      expect(calls).toBe(0)
      const cause = failed(
        await Effect.runPromiseExit(
          work.pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                recovered = true
              })
            )
          )
        )
      )
      expect(cause.reasons).toHaveLength(1)
      expect(cause.reasons[0]).toMatchObject({ _tag: "Die", defect })
      expect(calls).toBe(1)
      expect(recovered).toBe(false)
    }
  )

  it("classifies an asynchronous transport rejection as a checked failure", async () => {
    const cause = failed(
      await Effect.runPromiseExit(
        observer.observe(() =>
          Promise.reject(new Error("Remote connection was unavailable"))
        )
      )
    )
    expect(cause.reasons).toHaveLength(1)
    expect(cause.reasons[0]).toMatchObject({
      _tag: "Fail",
      error: { _tag: observer.transportError },
    })
  })

  it.each(observer.errors)(
    "retains declared remote $_tag as a checked RPC failure",
    async (error) => {
      let requests = 0
      const cause = failed(
        await Effect.runPromiseExit(
          observer.observe(() =>
            observer.rpc(() => {
              requests++
              return Promise.resolve(
                structuredClone(observer.encode(Exit.fail(error)))
              )
            })
          )
        )
      )
      expect(cause.reasons).toHaveLength(1)
      expect(cause.reasons[0]).toMatchObject({ _tag: "Fail", error })
      expect(requests).toBe(1)
    }
  )

  it("retains every checked, defective and interrupted reason with its annotations", async () => {
    const error = observer.errors[0]!,
      defect = new Error("Private remote cleanup failed")
    const original = Cause.fromReasons([
      Cause.makeFailReason(error).annotate(Context.make(Marker, "checked")),
      Cause.makeDieReason(defect).annotate(Context.make(Marker, "cleanup")),
      Cause.makeInterruptReason(71).annotate(Context.make(Marker, "remote")),
    ])
    const cause = failed(
      await Effect.runPromiseExit(
        observer.observe(() => Promise.reject(original))
      )
    )
    expect(cause.reasons.map((reason) => reason._tag)).toEqual([
      "Fail",
      "Die",
      "Interrupt",
    ])
    expect(cause.reasons[0]).toMatchObject({ error })
    expect(cause.reasons[1]).toBe(original.reasons[1])
    expect(cause.reasons[2]).toBe(original.reasons[2])
    expect(
      cause.reasons.map((reason) => reason.annotations.get(Marker.key))
    ).toEqual(["checked", "cleanup", "remote"])
  })

  it("converts an undeclared checked failure to a defect without losing other reasons or annotations", async () => {
    const unknown = { _tag: "UnexpectedRemoteFailure", detail: "preserve" },
      defect = new Error("Independent cleanup defect")
    const original = Cause.fromReasons([
      Cause.makeFailReason(unknown).annotate(Context.make(Marker, "unknown")),
      Cause.makeDieReason(defect),
      Cause.makeInterruptReason(72),
    ])
    const cause = failed(
      await Effect.runPromiseExit(
        observer.observe(() => Promise.reject(original))
      )
    )
    expect(cause.reasons.map((reason) => reason._tag)).toEqual([
      "Die",
      "Die",
      "Interrupt",
    ])
    expect(cause.reasons[0]).toMatchObject({ defect: unknown })
    expect(cause.reasons[0]?.annotations.get(Marker.key)).toBe("unknown")
    expect(cause.reasons[1]).toBe(original.reasons[1])
    expect(cause.reasons[2]).toBe(original.reasons[2])
  })

  it("keeps all compound RPC reasons while the wire codec sanitizes private defects and annotations", async () => {
    const error = observer.errors[0]!
    const original = Cause.fromReasons([
      Cause.makeFailReason(error).annotate(Context.make(Marker, "checked")),
      Cause.makeDieReason(new Error("Private server secret")).annotate(
        Context.make(Marker, "cleanup")
      ),
      Cause.makeInterruptReason(73).annotate(Context.make(Marker, "remote")),
    ])
    const raw = JSON.parse(
      JSON.stringify(observer.encode(Exit.failCause(original)))
    ) as unknown
    const cause = failed(
      await Effect.runPromiseExit(
        observer.observe(() => observer.rpc(() => Promise.resolve(raw)))
      )
    )
    expect(cause.reasons).toHaveLength(3)
    expect(cause.reasons[0]).toMatchObject({ _tag: "Fail", error })
    expect(cause.reasons[1]).toMatchObject({
      _tag: "Die",
      defect: observer.privateDefect,
    })
    expect(cause.reasons[2]).toMatchObject({ _tag: "Interrupt", fiberId: 73 })
    expect(
      cause.reasons.map((reason) => reason.annotations.get(Marker.key))
    ).toEqual([undefined, undefined, undefined])
  })

  it.each(["success", "rejection"] as const)(
    "interrupts a held observation before remote settlement and suppresses late %s",
    async (late) => {
      const entered = deferred<void>(),
        reply = deferred<unknown>(),
        controller = new AbortController(),
        exits: Exit.Exit<unknown, unknown>[] = []
      let requests = 0,
        continuations = 0,
        remoteSettled = false,
        native: Promise<unknown> | undefined
      const running = Effect.runPromiseExit(
        observer
          .observe(() => {
            requests++
            native = observer.rpc(() => reply.promise)
            void native.then(
              () => {
                remoteSettled = true
              },
              () => {
                remoteSettled = true
              }
            )
            entered.resolve()
            return native
          })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                continuations++
              })
            ),
            Effect.onExit((exit) =>
              Effect.sync(() => {
                exits.push(exit)
              })
            )
          ),
        { signal: controller.signal }
      )
      try {
        await entered.promise
        controller.abort()
        const exit = await promptly(running)
        expect(failed(exit).reasons.map((reason) => reason._tag)).toEqual([
          "Interrupt",
        ])
        expect(remoteSettled).toBe(false)
        expect(requests).toBe(1)
        expect(continuations).toBe(0)
        expect(exits).toEqual([exit])
        if (late === "success")
          reply.resolve(observer.encode(Exit.succeed(null)))
        else
          reply.reject(
            Cause.fromReasons([
              Cause.makeFailReason(observer.errors[0]!),
              Cause.makeDieReason(new Error("Late remote defect")),
              Cause.makeInterruptReason(74),
            ])
          )
        await native!.then(
          () => undefined,
          () => undefined
        )
        await Promise.resolve()
        expect(remoteSettled).toBe(true)
        expect(requests).toBe(1)
        expect(continuations).toBe(0)
        expect(exits).toEqual([exit])
        expect(await running).toBe(exit)
      } finally {
        reply.resolve(observer.encode(Exit.succeed(null)))
        await native?.then(
          () => undefined,
          () => undefined
        )
        await running
      }
    }
  )
})
