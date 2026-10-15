type Stage =
  "session" | "catalog" | "conversation" | "history" | "composer" | "models"

/** Bounded, local User Timing entries. No identities, content, or network
 * collection; browser traces can correlate these with Resource Timing. */
export function markReady(stage: Stage) {
  const name = `pi:${stage}:ready`
  if (performance.getEntriesByName(name, "mark").length === 0)
    performance.mark(name)
}
