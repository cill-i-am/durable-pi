import type { ConversationView, LiveState } from "@earendil-works/pi-durable"

/** The native state needed to reconcile a reply and render its activity. */
export type PiSnapshot = Pick<ConversationView, "entries" | "before"> &
  Pick<LiveState, "run" | "generation" | "tools" | "compactions">

export function snapshotFromView(view: ConversationView): PiSnapshot {
  // These are SDK-owned built-in documents, not external request data.
  const live = (view.docs["pi.live"] ?? {}) as Readonly<LiveState>
  return {
    entries: view.entries,
    before: view.before,
    run: live.run,
    generation: live.generation,
    tools: live.tools,
    compactions: live.compactions,
  }
}
