import { Schema } from "effect"
import { ApiError } from "@/http/client"
import { Control } from "@/delegation/contracts"

export function controlKey(
  bot: string,
  group: number,
  child: number,
  action: Control["action"]["type"]
) {
  return `delegation-control:${bot}:${group}:${child}:${action}`
}
/** Keep uncertain controls through sheet close and tab reload, without changing identity or payload. */
export function pendingControl(
  storage: Pick<Storage, "getItem">,
  key: string
): Control | null {
  try {
    const value = storage.getItem(key)
    return value ? Schema.decodeUnknownSync(Control)(JSON.parse(value)) : null
  } catch {
    return null
  }
}
export function acknowledgeControl(
  storage: Pick<Storage, "getItem" | "removeItem">,
  key: string,
  id: string
) {
  if (pendingControl(storage, key)?.operationId === id) storage.removeItem(key)
}

export function confirmedRejection(cause: unknown) {
  return (
    cause instanceof ApiError &&
    ["invalid", "not_found", "conflict", "cancelled", "limit"].includes(
      cause.code ?? ""
    )
  )
}
