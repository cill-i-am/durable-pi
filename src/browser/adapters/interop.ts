import { Cause, Effect, Schema } from "effect"
import {
  BrowserFailure,
  type BrowserSession,
  type BrowserCapture,
  type BrowserAction,
  type BrowserController,
} from "../contracts"
import { BrowserUnavailable, type BrowserDriver } from "../driver"
import { BrowserCaptureRecord, BrowserSessionRecord } from "../domain"
import { nativeFailure, nativeOperation } from "../../shared/interop"

export interface ForeignBrowserDriver {
  open: (
    hosts: readonly string[],
    unrestricted?: boolean
  ) => Promise<BrowserSession>
  navigate: (
    session: BrowserSession,
    url: string,
    hosts: readonly string[],
    unrestricted?: boolean
  ) => Promise<BrowserCapture>
  capture: (
    session: BrowserSession,
    hosts: readonly string[],
    unrestricted?: boolean
  ) => Promise<BrowserCapture>
  interact: (
    session: BrowserSession,
    action: BrowserAction,
    expectedUrl: string,
    hosts: readonly string[],
    actor: BrowserController,
    unrestricted?: boolean
  ) => Promise<BrowserCapture>
  close: (id: string) => Promise<void>
}
const nativeError = (
  cause: unknown,
  channel: "failure" | "rejection",
  reject: (cause: unknown) => BrowserFailure | BrowserUnavailable = () =>
    new BrowserUnavailable()
) => {
  const expected = Schema.decodeUnknownOption(BrowserFailure)(cause)
  if (expected._tag === "Some") return expected.value
  if (
    channel === "failure" ||
    Schema.isSchemaError(cause) ||
    cause instanceof TypeError ||
    cause instanceof RangeError
  )
    throw cause
  return reject(cause)
}
/** Puppeteer has no per-operation abort contract. Join settlement before the tab's permit releases. */
export const browserNativeFailure = (
  cause: unknown,
  reject: (cause: unknown) => BrowserFailure | BrowserUnavailable = () =>
    new BrowserUnavailable()
) =>
  Effect.failCause(
    nativeFailure(cause, (value, channel) =>
      nativeError(value, channel, reject)
    )
  )
export const nativeBrowserOperation = <T>(
  start: () => Promise<T>,
  reject?: (cause: unknown) => BrowserFailure | BrowserUnavailable
) =>
  nativeOperation(start, (cause, channel) =>
    nativeError(cause, channel, reject)
  )
export function effectBrowserDriver(
  native: ForeignBrowserDriver
): BrowserDriver {
  return {
    open: (hosts, unrestricted) =>
      nativeBrowserOperation(() => native.open(hosts, unrestricted)).pipe(
        Effect.map(Schema.decodeUnknownSync(BrowserSessionRecord))
      ),
    navigate: (...args) =>
      nativeBrowserOperation(() => native.navigate(...args)).pipe(
        Effect.map(Schema.decodeUnknownSync(BrowserCaptureRecord))
      ),
    capture: (...args) =>
      nativeBrowserOperation(() => native.capture(...args)).pipe(
        Effect.map(Schema.decodeUnknownSync(BrowserCaptureRecord))
      ),
    interact: (...args) =>
      nativeBrowserOperation(() => native.interact(...args)).pipe(
        Effect.map(Schema.decodeUnknownSync(BrowserCaptureRecord))
      ),
    close: (id) => nativeBrowserOperation(() => native.close(id)),
  }
}
export const browserWake = (wake: () => Promise<void>) => () =>
  nativeBrowserOperation(wake).pipe(
    Effect.catchCause((cause) =>
      Effect.failCause(Cause.map(cause, () => new BrowserUnavailable()))
    )
  )
