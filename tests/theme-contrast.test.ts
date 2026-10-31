import { readFileSync } from "node:fs"

import { expect, it } from "vitest"

const stylesheet = readFileSync(
  new URL("../packages/ui/src/styles/globals.css", import.meta.url),
  "utf8"
)
function declarations(selector: string) {
  const body = stylesheet.split(`${selector} {`)[1]!.split("}")[0]!
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [
      match[1]!,
      match[2]!.trim(),
    ])
  )
}
const light = declarations(":root")
const dark = { ...light, ...declarations(".dark") }
function resolve(tokens: Record<string, string>, role: string): string {
  const value = tokens[role]!
  return value.startsWith("var(") ? resolve(tokens, value.slice(4, -1)) : value
}
function luminance(hex: string) {
  const full =
    hex.length === 4
      ? `#${[...hex.slice(1)].map((value) => value + value).join("")}`
      : hex
  const channels = full
    .slice(1)
    .match(/../g)!
    .map((channel) => parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    )
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
}
function contrast(first: string, second: string) {
  const [lighter, darker] = [luminance(first), luminance(second)].sort(
    (a, b) => b - a
  )
  return (lighter! + 0.05) / (darker! + 0.05)
}
for (const [theme, tokens] of [
  ["light", light],
  ["dark", dark],
] as const) {
  for (const surface of [
    "--background",
    "--card",
    "--sidebar",
    "--muted",
  ] as const) {
    it(`${theme}: readable primary and secondary text on ${surface}`, () => {
      for (const text of ["--foreground", "--muted-foreground"])
        expect(
          contrast(resolve(tokens, text), resolve(tokens, surface))
        ).toBeGreaterThanOrEqual(4.5)
    })
  }
  it(`${theme}: distinct input boundaries and focus against their surfaces`, () => {
    for (const surface of ["--background", "--card", "--sidebar"])
      for (const role of ["--input", "--ring"])
        expect(
          contrast(resolve(tokens, role), resolve(tokens, surface))
        ).toBeGreaterThanOrEqual(3)
  })
  it(`${theme}: primary actions and semantic status text remain readable`, () => {
    for (const [text, surface] of [
      ["--primary-foreground", "--primary"],
      ["--destructive", "--destructive-bg"],
      ["--warning", "--warning-bg"],
    ])
      expect(
        contrast(resolve(tokens, text!), resolve(tokens, surface!))
      ).toBeGreaterThanOrEqual(4.5)
  })
}
