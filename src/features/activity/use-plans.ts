import { Cause, Schema } from "effect"

import { AccessState } from "@/access/contracts"
import { PlanDetail, PlanList } from "@/planning/contracts"
import { nativeFailure } from "@/shared/interop"

import { activityJsonRequest } from "./query-owner"
import { useActivityQuery } from "./use-activity-query"

export function usePlans(
  agentId: string,
  selected: string | null,
  offset: number,
  enabled = true
) {
  const query = useActivityQuery({
    key: JSON.stringify(["plans", agentId, selected, offset]),
    enabled,
    interval: 2500,
    read: async (signal) => {
      const controller = new AbortController()
      const abort = () => controller.abort()
      if (signal.aborted) abort()
      signal.addEventListener("abort", abort, { once: true })
      try {
        const request = (path: string) =>
          activityJsonRequest(agentId, path, controller.signal).catch(
            (cause) => {
              controller.abort()
              throw cause
            }
          )
        // Every sibling settles before this observation releases ownership,
        // even when one request fails and aborts the other readers.
        const values = await Promise.allSettled([
          request(`plans?offset=${offset}`).then(
            Schema.decodeUnknownSync(PlanList)
          ),
          selected
            ? request(`plans/${selected}`).then(
                Schema.decodeUnknownSync(PlanDetail)
              )
            : Promise.resolve(null),
          request("access").then(Schema.decodeUnknownSync(AccessState)),
        ] as const)
        const failures = values.flatMap((value) =>
          value.status === "rejected"
            ? nativeFailure(value.reason, (cause) => cause).reasons
            : []
        )
        if (failures.length) throw Cause.fromReasons(failures)
        const [summary, detail, access] = values.map(
          (value) => (value as PromiseFulfilledResult<unknown>).value
        ) as [typeof PlanList.Type, PlanDetail | null, typeof AccessState.Type]
        if (
          detail &&
          (detail.plan.id !== selected ||
            detail.history.some((entry) => entry.plan.id !== selected))
        )
          throw new Error(
            "The response does not match the selected plan. Reconnect to try again."
          )
        return {
          list: summary,
          detail,
          approvals: access.approvals.filter(
            (approval) =>
              approval.status === "pending" &&
              (!detail || detail.plan.rootTurns.includes(approval.turnId))
          ),
        }
      } finally {
        signal.removeEventListener("abort", abort)
      }
    },
  })
  return {
    list: query.data?.list ?? { plans: [], nextOffset: null },
    detail: query.data?.detail?.plan.id === selected ? query.data.detail : null,
    approvals: query.data?.approvals ?? [],
    error: query.error,
    loading: query.loading,
    refresh: query.refresh,
  }
}
