import { Schema } from "effect"
import type { ConfigurationLedger } from "../../agents/configuration"
import { AgentStorageError } from "../../agents/domain"
import { MemoryStorageError } from "../domain"
import type { SummaryRetryAuthority } from "../retry"

export const summaryRetryAuthority = (
  configuration: Pick<ConfigurationLedger, "transactionGroup" | "read">
): SummaryRetryAuthority => ({
  transactionGroup: configuration.transactionGroup,
  archived: () => {
    try {
      return configuration.read()?.status === "archived"
    } catch (cause) {
      const agentStorageError =
        Schema.decodeUnknownOption(AgentStorageError)(cause)
      if (agentStorageError._tag === "Some")
        throw new MemoryStorageError({
          operation: "read summary retry authority",
        })
      throw cause
    }
  },
})
