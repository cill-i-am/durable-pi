import { Context, type Effect } from "effect"
import type { CommunicationError, Outcome, Task } from "./contracts"

/**
 * Advance an already claimed durable task. Repeated calls must resume its native
 * execution, never admit a second conversation. A missing outcome means it is
 * still running. Settlement releases only transient model pins; durable records
 * remain available for restart, inspection and replay.
 */
export class TaskExecution extends Context.Service<
  TaskExecution,
  {
    readonly advance: (
      task: Task
    ) => Effect.Effect<Outcome | undefined, CommunicationError>
    readonly settled: (id: string) => Effect.Effect<void, CommunicationError>
  }
>()("durable-pi/communication/TaskExecution") {}
