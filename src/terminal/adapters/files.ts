import type { ImportFile } from "../transfers"
import { planImport } from "../transfers"

export async function fileDigest(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer))
  )
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
}
export async function importPlan(
  input: typeof ImportFile.Type,
  bytes: Uint8Array
) {
  return planImport(input, bytes.length, await fileDigest(bytes))
}
