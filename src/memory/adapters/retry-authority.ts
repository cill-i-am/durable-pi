import { Effect } from "effect"
import type { ConfigurationLedger } from "../../agents/configuration"
import { MemoryStorageError } from "../domain"
import type { SummaryRetryAuthority } from "../retry"

export const summaryRetryAuthority = (
  configuration: Pick<ConfigurationLedger, "transactionGroup" | "read">
): SummaryRetryAuthority => ({
  transactionGroup: configuration.transactionGroup,
  archived: () =>
    configuration.read().pipe(
      Effect.map((current) => current?.status === "archived"),
      Effect.mapError(
        () =>
          new MemoryStorageError({ operation: "read summary retry authority" })
      )
    ),
})
