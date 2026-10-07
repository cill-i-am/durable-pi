import * as cloudflare from "cloudflare:workers"
import type { WebsiteEnv } from "../alchemy.run"
// Defer access until the request: Start evaluates server modules outside workerd during development.
export function getEnv(): WebsiteEnv {
  return cloudflare.env as WebsiteEnv
}
