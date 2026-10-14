import * as cloudflare from "cloudflare:workers"
import type { WebsiteEnv } from "../alchemy.run"

export function getEnv(): WebsiteEnv {
  return cloudflare.env as WebsiteEnv
}

export function runInBackground(task: Promise<unknown>): void {
  cloudflare.waitUntil(task)
}
