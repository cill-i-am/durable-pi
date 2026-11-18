import * as Cloudflare from "@alchemy.run/cloudflare"

export const observability = {
  enabled: true,
  headSamplingRate: 1,
  logs: {
    enabled: true,
    invocationLogs: true,
    headSamplingRate: 1,
    persist: true,
  },
  traces: { enabled: true, headSamplingRate: 1, persist: true },
} satisfies Cloudflare.WorkerObservability

export const privateWorker = {
  workersDev: { enabled: false, previewsEnabled: false },
  observability,
}

export const productionDomain = (stage: string, name: string) =>
  stage === "production"
    ? { name, zoneId: "37e485d6619dee244939e66e1ee90d3f" }
    : undefined
