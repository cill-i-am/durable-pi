import type { PlanRevision } from "@/planning/contracts"

/** Polling advances the head page. Fetch at the first gap, never from a stale mount-time cursor. */
export function historyPage(
  current: readonly PlanRevision[],
  older: readonly PlanRevision[]
) {
  const unique = new Map<number, PlanRevision>()
  for (const item of [...current, ...older])
    if (!unique.has(item.plan.revision)) unique.set(item.plan.revision, item)
  const history = [...unique.values()].sort(
    (a, b) => b.plan.revision - a.plan.revision
  )
  let next = history[0]?.plan.revision ?? 0
  while (unique.has(next)) next--
  return { history, cursor: next > 0 ? next + 1 : null }
}
