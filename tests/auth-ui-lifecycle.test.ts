import { it } from "@effect/vitest"
import { createEffectActor, send, waitFor } from "@xstate/effect"
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Redacted,
  Scope,
} from "effect"
import { TestClock } from "effect/testing"
import { afterEach, describe, expect, vi } from "vitest"

import { AuthIssue } from "@/features/auth/auth-contracts"
import {
  authEntryMachine,
  type EntryRequest,
} from "@/features/auth/auth-entry.machine"
import { authOwner } from "@/features/auth/auth-owner"
import { downloadCodes } from "@/features/auth/factor-owner"
import {
  factorMachine,
  type FactorRequest,
} from "@/features/auth/factor.machine"
import {
  passkeysMachine,
  type PasskeyRequest,
} from "@/features/auth/passkeys.machine"
import { photoMachine } from "@/features/auth/photo.machine"
import {
  securityMachine,
  type BrowserSession,
  type SecurityConfirmation,
} from "@/features/auth/security.machine"
import { nativeOperation } from "@/shared/interop"

class NativeRequestId extends Context.Service<NativeRequestId, string>()(
  "AuthUiNativeRequestId"
) {}

const secret = (value: Record<string, string>) => Redacted.make(value)
const material = Redacted.make({
  uri: "otpauth://totp/Pi?secret=fixture",
  codes: ["first-code", "second-code"],
})
const session = (id: string): BrowserSession => ({
  id,
  token: Redacted.make(`token-${id}`),
  createdAt: new Date(0),
  expiresAt: new Date(10000),
  userAgent: "Fixture",
})
afterEach(() => vi.unstubAllGlobals())

describe("Auth admission, challenges, and owned resources", () => {
  it.effect(
    "admits one immutable challenge, rejects mode changes while pending, and retries only explicitly",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void, AuthIssue>()
        const calls: EntryRequest[] = []
        let completed = 0
        const actor = yield* createEffectActor(
          authEntryMachine({
            request: (input) =>
              Effect.gen(function* () {
                calls.push(input)
                if (calls.length === 1) {
                  yield* Deferred.succeed(started, undefined)
                  yield* Deferred.await(release)
                }
              }),
            completed: () =>
              Effect.sync(() => {
                completed++
              }),
          }),
          { input: { kind: "totp", error: "" } }
        )
        yield* send(actor, {
          type: "SUBMIT",
          secret: secret({ code: "123456" }),
        })
        yield* Deferred.await(started)
        yield* send(actor, { type: "MODE", kind: "backup" })
        yield* send(actor, {
          type: "SUBMIT",
          secret: secret({ code: "stale-code" }),
        })
        yield* Effect.yieldNow
        expect(calls.length).toBe(1)
        expect(calls[0]?.kind).toBe("totp")
        expect(Redacted.value(calls[0]!.secret)).toEqual({ code: "123456" })
        expect(JSON.stringify(calls)).not.toContain("123456")
        yield* Deferred.fail(
          release,
          new AuthIssue({
            message: "That code did not work.",
            code: "INVALID_CODE",
          })
        )
        yield* waitFor(actor, (state) => state.matches("form"))
        yield* TestClock.adjust("1 minute")
        expect(calls.length).toBe(1)
        expect(completed).toBe(0)
        yield* send(actor, { type: "MODE", kind: "backup" })
        yield* send(actor, {
          type: "SUBMIT",
          secret: secret({ code: "recovery-code" }),
        })
        yield* waitFor(actor, (state) => state.matches("completed"))
        expect(calls.map((call) => call.kind)).toEqual(["totp", "backup"])
        expect(completed).toBe(1)
        expect(actor.getSnapshot().context.request).toBeNull()
      }).pipe(Effect.scoped)
  )

  it.effect(
    "validates matching reset passwords before admission and treats an expired token as terminal for that link",
    () =>
      Effect.gen(function* () {
        let calls = 0
        const actor = yield* createEffectActor(
          authEntryMachine({
            request: () =>
              Effect.suspend(() => {
                calls++
                return Effect.fail(
                  new AuthIssue({ message: "expired", code: "INVALID_TOKEN" })
                )
              }),
            completed: () => Effect.die("unexpected reset completion"),
          }),
          { input: { kind: "reset", error: "" } }
        )
        yield* send(actor, {
          type: "SUBMIT",
          secret: secret({ password: "one", confirm: "two", token: "old" }),
        })
        yield* waitFor(actor, (state) => !!state.context.error)
        expect(calls).toBe(0)
        yield* send(actor, {
          type: "SUBMIT",
          secret: secret({ password: "same", confirm: "same", token: "old" }),
        })
        yield* waitFor(actor, (state) => state.matches("invalid"))
        yield* send(actor, { type: "RESET" })
        yield* send(actor, {
          type: "SUBMIT",
          secret: secret({ password: "same", confirm: "same", token: "old" }),
        })
        yield* Effect.yieldNow
        expect(calls).toBe(1)
        expect(actor.getSnapshot().matches("invalid")).toBe(true)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "aborts and joins an unfinished native challenge, retains every late Cause reason, and never completes it",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>(),
          aborted = yield* Deferred.make<void>()
        let reject!: (cause: unknown) => void
        let completions = 0
        const scope = yield* Scope.make()
        const actor = yield* authOwner((observe) =>
          createEffectActor(
            authEntryMachine({
              request: () =>
                observe(
                  nativeOperation(
                    (signal) => {
                      signal.addEventListener(
                        "abort",
                        () =>
                          Effect.runSync(Deferred.succeed(aborted, undefined)),
                        { once: true }
                      )
                      Effect.runSync(Deferred.succeed(started, undefined))
                      return new Promise<void>((_, fail) => {
                        reject = fail
                      })
                    },
                    (cause) => cause
                  )
                ),
              completed: () =>
                Effect.sync(() => {
                  completions++
                }),
            }),
            { input: { kind: "passkey", error: "" } }
          )
        ).pipe(Effect.provideService(Scope.Scope, scope))
        yield* send(actor, { type: "SUBMIT", secret: secret({}) })
        yield* Deferred.await(started)
        const closing = yield* Effect.exit(Scope.close(scope, Exit.void)).pipe(
          Effect.forkChild
        )
        yield* Deferred.await(aborted)
        expect(closing.pollUnsafe()).toBeUndefined()
        const defect = new Error("native authenticator cleanup")
        reject(
          Cause.fromReasons([
            Cause.makeFailReason("checked cleanup"),
            Cause.makeDieReason(defect).annotate(
              Context.make(NativeRequestId, "original native request")
            ),
            Cause.makeInterruptReason(88234),
          ])
        )
        const exit = yield* Fiber.join(closing)
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) {
          expect(
            exit.cause.reasons.some(
              (reason) =>
                reason._tag === "Die" &&
                reason.defect === defect &&
                reason.annotations.get(NativeRequestId.key) ===
                  "original native request"
            )
          ).toBe(true)
          expect(
            exit.cause.reasons.some(
              (reason) =>
                reason._tag === "Die" &&
                typeof reason.defect === "object" &&
                reason.defect !== null &&
                "error" in reason.defect &&
                reason.defect.error === "checked cleanup"
            )
          ).toBe(true)
        }
        if (Exit.isFailure(exit)) {
          expect(
            exit.cause.reasons.some(
              (reason) =>
                reason._tag === "Interrupt" && reason.fiberId === 88234
            )
          ).toBe(true)
        }
        expect(completions).toBe(0)
      })
  )

  it.effect(
    "stopping photo preparation joins its native release without starting an upload or session refresh",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>(),
          aborted = yield* Deferred.make<void>()
        let release!: (blob: Blob) => void
        let uploads = 0,
          refreshes = 0,
          released = 0
        const scope = yield* Scope.make()
        const actor = yield* authOwner((observe) =>
          createEffectActor(
            photoMachine({
              prepare: () =>
                observe(
                  nativeOperation(
                    (signal) => {
                      signal.addEventListener(
                        "abort",
                        () =>
                          Effect.runSync(Deferred.succeed(aborted, undefined)),
                        { once: true }
                      )
                      Effect.runSync(Deferred.succeed(started, undefined))
                      return new Promise<Blob>((resolve) => {
                        release = resolve
                      }).finally(() => {
                        released++
                      })
                    },
                    (cause) => cause
                  )
                ),
              save: () =>
                Effect.sync(() => {
                  uploads++
                }),
              refresh: () =>
                Effect.sync(() => {
                  refreshes++
                }),
            })
          )
        ).pipe(Effect.provideService(Scope.Scope, scope))
        yield* send(actor, {
          type: "SAVE",
          file: new File(["fixture"], "photo.png", { type: "image/png" }),
        })
        yield* Deferred.await(started)
        const closing = yield* Scope.close(scope, Exit.void).pipe(
          Effect.forkChild
        )
        yield* Deferred.await(aborted)
        expect(closing.pollUnsafe()).toBeUndefined()
        release(new Blob(["prepared"], { type: "image/webp" }))
        yield* Fiber.join(closing)
        expect({ uploads, refreshes, released }).toEqual({
          uploads: 0,
          refreshes: 0,
          released: 1,
        })
      })
  )

  it.effect(
    "photo preparation, save, and authoritative session refresh occur once in order",
    () =>
      Effect.gen(function* () {
        const calls: string[] = []
        const actor = yield* createEffectActor(
          photoMachine({
            prepare: () =>
              Effect.sync(() => {
                calls.push("prepare")
                return new Blob(["p"], { type: "image/webp" })
              }),
            save: (blob) =>
              Effect.sync(() => {
                calls.push(blob ? "upload" : "remove")
              }),
            refresh: () =>
              Effect.sync(() => {
                calls.push("session")
              }),
          })
        )
        yield* send(actor, { type: "SAVE", file: new File(["f"], "photo.png") })
        yield* waitFor(actor, (state) => !!state.context.notice)
        expect(calls).toEqual(["prepare", "upload", "session"])
        expect(actor.getSnapshot().context.photo).toBeNull()
        yield* send(actor, { type: "SAVE", file: null })
        yield* waitFor(
          actor,
          (state) => state.context.notice === "Profile photo removed."
        )
        expect(calls).toEqual([
          "prepare",
          "upload",
          "session",
          "remove",
          "session",
        ])
      }).pipe(Effect.scoped)
  )

  it.effect(
    "requires enrollment verification then explicit recovery-code acknowledgement before completion",
    () =>
      Effect.gen(function* () {
        const doneSignal = yield* Deferred.make<void>()
        const calls: FactorRequest[] = []
        let done = 0,
          verification = 0
        const actor = yield* createEffectActor(
          factorMachine({
            request: (input) =>
              Effect.suspend(() => {
                calls.push(input)
                if (input.action === "verify" && ++verification === 1)
                  return Effect.fail(
                    new AuthIssue({
                      message: "Try the current code.",
                      code: "INVALID_CODE",
                    })
                  )
                return Effect.succeed(
                  input.action === "enable" ? material : null
                )
              }),
            done: () =>
              Effect.gen(function* () {
                done++
                yield* Deferred.succeed(doneSignal, undefined)
              }),
            download: () => Effect.void,
          }),
          { input: { enabled: false } }
        )
        yield* waitFor(actor, (state) => state.matches("password"))
        yield* send(actor, {
          type: "SUBMIT",
          secret: secret({ password: "private-password" }),
        })
        yield* waitFor(actor, (state) => state.matches("verify"))
        expect(done).toBe(0)
        yield* send(actor, {
          type: "SUBMIT",
          secret: secret({ code: "123456" }),
        })
        yield* waitFor(
          actor,
          (state) => state.matches("verify") && !!state.context.error
        )
        expect(actor.getSnapshot().context.material).toBe(material)
        yield* send(actor, {
          type: "SUBMIT",
          secret: secret({ code: "654321" }),
        })
        yield* waitFor(actor, (state) => state.matches("codes"))
        yield* send(actor, { type: "CHOOSE", action: "disable" })
        yield* send(actor, {
          type: "SUBMIT",
          secret: secret({ password: "should-not-admit" }),
        })
        yield* Effect.yieldNow
        expect(done).toBe(0)
        expect(calls.map((call) => call.action)).toEqual([
          "enable",
          "verify",
          "verify",
        ])
        expect(JSON.stringify(actor.getSnapshot().context)).not.toContain(
          "first-code"
        )
        yield* send(actor, { type: "DONE" })
        yield* waitFor(actor, (state) => state.matches("done"))
        yield* Deferred.await(doneSignal)
        expect(done).toBe(1)
        expect(actor.getSnapshot().context.material).toBeNull()
      }).pipe(Effect.scoped)
  )

  it.effect(
    "revokes an owned recovery-code object URL immediately when its scope closes",
    () =>
      Effect.gen(function* () {
        const urls: string[] = [],
          clicks: string[] = []
        vi.stubGlobal("URL", {
          createObjectURL: () => "blob:fixture",
          revokeObjectURL: (url: string) => urls.push(url),
        })
        vi.stubGlobal("document", {
          createElement: () => ({
            href: "",
            download: "",
            click: () => clicks.push("download"),
          }),
        })
        const download = yield* downloadCodes(material).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(clicks).toEqual(["download"])
        expect(urls).toEqual([])
        yield* Fiber.interrupt(download)
        expect(urls).toEqual(["blob:fixture"])
      })
  )

  it.effect(
    "passkey read failure and uncertain change require a successful explicit refresh before another command",
    () =>
      Effect.gen(function* () {
        let reads = 0,
          saves = 0
        const actor = yield* createEffectActor(
          passkeysMachine({
            read: () =>
              Effect.suspend(() =>
                ++reads === 1
                  ? Effect.fail("unavailable")
                  : Effect.succeed([{ id: "one", name: "Phone" }])
              ),
            save: () =>
              Effect.suspend(() => {
                saves++
                return Effect.fail(
                  new AuthIssue({
                    message: "Unknown outcome",
                    code: "UNCONFIRMED",
                  })
                )
              }),
            signOut: () => Effect.void,
          }),
          { input: { disabled: false, available: true } }
        )
        yield* waitFor(actor, (state) => state.matches("ready"))
        yield* send(actor, { type: "EDIT", editor: { kind: "add" } })
        yield* send(actor, { type: "SAVE", name: "Phone" })
        yield* Effect.yieldNow
        expect(saves).toBe(0)
        yield* send(actor, { type: "REFRESH" })
        yield* waitFor(
          actor,
          (state) => state.matches("ready") && !state.context.readFailed
        )
        yield* send(actor, {
          type: "EDIT",
          editor: { kind: "rename", key: { id: "one", name: "Phone" } },
        })
        yield* send(actor, { type: "SAVE", name: "New name" })
        yield* waitFor(actor, (state) => state.context.readFailed)
        yield* send(actor, { type: "SAVE", name: "No duplicate" })
        yield* TestClock.adjust("1 minute")
        expect(saves).toBe(1)
        expect(reads).toBe(2)
        yield* send(actor, { type: "REFRESH" })
        yield* waitFor(actor, (state) => !state.context.readFailed)
        expect(actor.getSnapshot().context.editor).toBeNull()
        expect(reads).toBe(3)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "unknown SDK verification errors cannot reopen passkey mutation before authoritative refresh",
    () =>
      Effect.gen(function* () {
        let saves = 0
        const actor = yield* createEffectActor(
          passkeysMachine({
            read: () => Effect.succeed([]),
            save: () =>
              Effect.suspend(() => {
                saves++
                return Effect.fail(
                  new AuthIssue({
                    code: "UNKNOWN_ERROR",
                    message: "Verification response was lost.",
                  })
                )
              }),
            signOut: () => Effect.void,
          }),
          { input: { disabled: false, available: true } }
        )
        yield* waitFor(actor, (state) => state.matches("ready"))
        yield* send(actor, { type: "EDIT", editor: { kind: "add" } })
        yield* send(actor, { type: "SAVE", name: "Phone" })
        yield* waitFor(actor, (state) => state.context.readFailed)
        yield* send(actor, { type: "SAVE", name: "Phone" })
        yield* Effect.yieldNow
        expect(saves).toBe(1)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "an admitted passkey command retains its selected key while later edits and refresh are ignored",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>()
        const calls: PasskeyRequest[] = []
        let reads = 0
        const actor = yield* createEffectActor(
          passkeysMachine({
            read: () =>
              Effect.sync(() => {
                reads++
                return [{ id: "one" }, { id: "two" }]
              }),
            save: (input) =>
              Effect.gen(function* () {
                calls.push(input)
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
              }),
            signOut: () => Effect.void,
          }),
          { input: { disabled: false, available: true } }
        )
        yield* waitFor(actor, (state) => state.matches("ready"))
        yield* send(actor, {
          type: "EDIT",
          editor: { kind: "remove", key: { id: "one" } },
        })
        yield* send(actor, { type: "SAVE", name: "" })
        yield* Deferred.await(started)
        yield* send(actor, {
          type: "EDIT",
          editor: { kind: "remove", key: { id: "two" } },
        })
        yield* send(actor, { type: "REFRESH" })
        yield* send(actor, { type: "SAVE", name: "" })
        yield* Effect.yieldNow
        expect(calls).toEqual([
          { editor: { kind: "remove", key: { id: "one" } }, name: "" },
        ])
        expect(reads).toBe(1)
        yield* Deferred.succeed(release, undefined)
        yield* waitFor(actor, (state) => state.matches("ready"))
        expect(reads).toBe(2)
      }).pipe(Effect.scoped)
  )

  it.effect(
    "protects current-session identity, child recovery review locks, and exact revocation confirmation",
    () =>
      Effect.gen(function* () {
        const calls: SecurityConfirmation[] = []
        const started = yield* Deferred.make<void>(),
          release = yield* Deferred.make<void>()
        let closes = 0,
          reads = 0
        const actor = yield* createEffectActor(
          securityMachine({
            read: () =>
              Effect.sync(() => {
                reads++
                return [session("current"), session("other")]
              }),
            revoke: (input) =>
              Effect.gen(function* () {
                calls.push(input)
                yield* Deferred.succeed(started, undefined)
                yield* Deferred.await(release)
              }),
            signOut: () => Effect.void,
            close: () =>
              Effect.sync(() => {
                closes++
              }),
          }),
          { input: { currentId: "current" } }
        )
        yield* waitFor(actor, (state) => state.matches("ready"))
        yield* send(actor, {
          type: "ASK",
          confirmation: { kind: "one", session: session("current") },
        })
        yield* Effect.yieldNow
        expect(actor.getSnapshot().context.confirm).toBeNull()
        yield* send(actor, { type: "CHILD_BUSY", child: "factor", busy: true })
        yield* send(actor, { type: "CLOSE" })
        yield* send(actor, { type: "ASK", confirmation: { kind: "others" } })
        yield* send(actor, { type: "REVOKE" })
        yield* Effect.yieldNow
        expect(closes).toBe(0)
        expect(calls).toEqual([])
        yield* send(actor, { type: "CHILD_BUSY", child: "factor", busy: false })
        yield* send(actor, {
          type: "ASK",
          confirmation: { kind: "one", session: session("other") },
        })
        yield* send(actor, { type: "REVOKE" })
        yield* Deferred.await(started)
        yield* send(actor, { type: "ASK", confirmation: { kind: "others" } })
        yield* send(actor, { type: "CLOSE" })
        yield* send(actor, { type: "REFRESH" })
        yield* Effect.yieldNow
        expect(closes).toBe(0)
        expect(reads).toBe(1)
        expect(calls[0]?.kind).toBe("one")
        if (calls[0]?.kind === "one")
          expect(Redacted.value(calls[0].session.token)).toBe("token-other")
        yield* Deferred.succeed(release, undefined)
        yield* waitFor(actor, (state) => state.matches("ready"))
        expect(reads).toBe(2)
        expect(actor.getSnapshot().context.confirm).toBeNull()
      }).pipe(Effect.scoped)
  )
})
