import { Schema } from "effect"
import type { Effect } from "effect"
import type {
  BrowserAction,
  BrowserCapture,
  BrowserController,
  BrowserFailure,
  BrowserSession,
} from "./contracts"

export class BrowserUnavailable extends Schema.TaggedError<BrowserUnavailable>()(
  "BrowserUnavailable",
  {}
) {}
export interface BrowserDriver {
  open: (
    hosts: readonly string[],
    unrestricted?: boolean
  ) => Effect.Effect<BrowserSession, BrowserFailure | BrowserUnavailable>
  navigate: (
    session: BrowserSession,
    url: string,
    hosts: readonly string[],
    unrestricted?: boolean
  ) => Effect.Effect<BrowserCapture, BrowserFailure | BrowserUnavailable>
  capture: (
    session: BrowserSession,
    hosts: readonly string[],
    unrestricted?: boolean
  ) => Effect.Effect<BrowserCapture, BrowserFailure | BrowserUnavailable>
  interact: (
    session: BrowserSession,
    action: BrowserAction,
    expectedUrl: string,
    hosts: readonly string[],
    actor: BrowserController,
    unrestricted?: boolean
  ) => Effect.Effect<BrowserCapture, BrowserFailure | BrowserUnavailable>
  close: (
    id: string
  ) => Effect.Effect<void, BrowserFailure | BrowserUnavailable>
}
