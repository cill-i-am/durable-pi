import * as cloudflare from "cloudflare:workers"

import type { WebsiteEnv } from "../stacks/resources/website"

export function getEnv(): WebsiteEnv {
  return cloudflare.env as WebsiteEnv
}

export function runInBackground(task: Promise<unknown>): void {
  cloudflare.waitUntil(task)
}
