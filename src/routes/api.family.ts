import { createFileRoute } from "@tanstack/react-router"

import { getEnv } from "../env"
import { familyRequest } from "../family/adapters/http"

export const Route = createFileRoute("/api/family")({
  server: {
    handlers: { GET: ({ request }) => familyRequest(request, getEnv()) },
  },
})
