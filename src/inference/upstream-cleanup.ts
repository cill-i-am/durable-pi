import { Cause } from "effect"

/** Start every independent release before joining any. Native Effect Causes
 * retain their checked failures, defects and interruption annotations. */
export async function joinUpstreamCleanup(
  tasks: readonly PromiseLike<unknown>[],
  finalizers: readonly (() => unknown)[] = []
) {
  const settled = await Promise.allSettled(tasks)
  // Native handles can be released only after their I/O joins. A later
  // releaseLock/dispose defect must not overwrite earlier cleanup failures.
  for (const finalize of finalizers) {
    try {
      await finalize()
    } catch (reason) {
      settled.push({ status: "rejected", reason })
    }
  }
  let failed: Cause.Cause<unknown> | undefined
  for (const result of settled) {
    if (result.status !== "rejected") continue
    const cause = Cause.isCause(result.reason)
      ? result.reason
      : Cause.die(result.reason)
    failed = failed ? Cause.combine(failed, cause) : cause
  }
  if (failed) throw failed
}
