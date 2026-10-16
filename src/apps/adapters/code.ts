import { Cause, Effect } from "effect"

import {
  executionWithSignal,
  type ExecutionTransport,
} from "../../execution/adapters/interop"
import { codeService } from "../../execution/adapters/service"
import { AppConflict } from "../contracts"
import type { WebExecutor } from "../web"

export const webExecutor = (service: ExecutionTransport): WebExecutor => {
  const executor = codeService(service)
  return (input, signal) =>
    executionWithSignal(executor.run(input), signal).pipe(
      Effect.catchCause((cause) =>
        Effect.failCause(
          Cause.map(
            cause,
            () =>
              new AppConflict({
                message:
                  "The app could not render within its limits. Its saved state is unchanged.",
              })
          )
        )
      )
    )
}
