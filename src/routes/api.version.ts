import { createFileRoute } from "@tanstack/react-router"

import { buildRevision } from "../deployment/revision"

// Public build metadata only: no credentials, account reads, or agent wake-up.
export const Route = createFileRoute("/api/version")({
  server: {
    handlers: {
      GET: () =>
        Response.json(
          { revision: buildRevision },
          { headers: { "cache-control": "no-store" } }
        ),
    },
  },
})
