import { useCallback, useEffect, useRef, useState } from "react"
import { Schema } from "effect"
import { PlanDetail, PlanList } from "@/planning/contracts"
import { AccessState, type Approval } from "@/access/contracts"
import { agentApi } from "@/http/client"
import { poll } from "@/http/poll"

export function usePlans(
  agentId: string,
  selected: string | null,
  offset: number
) {
  const [list, setList] = useState<typeof PlanList.Type>({
    plans: [],
    nextOffset: null,
  })
  const [detail, setDetail] = useState<PlanDetail | null>(null)
  const [approvals, setApprovals] = useState<readonly Approval[]>([])
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true)
  const sequence = useRef(0)
  const refresh = useCallback(async () => {
    const current = ++sequence.current
    try {
      const request = agentApi(agentId)
      const [summary, value, access] = await Promise.all([
        request(`plans?offset=${offset}`).then(
          Schema.decodeUnknownSync(PlanList)
        ),
        selected
          ? request(`plans/${selected}`).then(
              Schema.decodeUnknownSync(PlanDetail)
            )
          : Promise.resolve(null),
        request("access").then(Schema.decodeUnknownSync(AccessState)),
      ])
      if (current !== sequence.current) return
      setList(summary)
      setDetail(value)
      setApprovals(
        access.approvals.filter(
          (approval) =>
            approval.status === "pending" &&
            (!value || value.plan.rootTurns.includes(approval.turnId))
        )
      )
      setLoading(false)
      setError("")
    } catch (cause) {
      if (current !== sequence.current) return
      setLoading(false)
      setError(
        cause instanceof Error ? cause.message : "Activity could not reconnect."
      )
    }
  }, [agentId, selected, offset])
  useEffect(() => {
    setDetail(null)
    setApprovals([])
    setLoading(true)
    const stop = poll(
      async () => {
        if (document.visibilityState === "visible") await refresh()
      },
      2500,
      true
    )
    const reconnect = () => {
      void refresh()
    }
    window.addEventListener("online", reconnect)
    return () => {
      stop()
      sequence.current++
      window.removeEventListener("online", reconnect)
    }
  }, [refresh])
  return { list, detail, approvals, error, loading, refresh }
}
