// Adapted from dithercn (MIT). See licenses/dithercn-MIT.txt.
import type { CSSProperties } from "react"

export type FillVariant = "gradient" | "dotted" | "hatched" | "solid"
export type Bloom = "off" | "low" | "high"

/**
 * The named colours of the dithercn palette. `ink` is the theme's own
 * `--dither-ink`; the others are `--dither-color-<name>` from the
 * `dither-tokens` stylesheet, tuned separately for light and dark.
 */
export const DITHER_COLOR_NAMES = [
  "ink",
  "blue",
  "purple",
  "green",
  "pink",
  "orange",
  "red",
  "grey",
] as const

export type DitherColorName = (typeof DITHER_COLOR_NAMES)[number]

/**
 * Used when a named colour's variable is missing, as in a stylesheet from
 * before the palette existed. Mid lightness, so it reads on black and white.
 */
const FALLBACKS = {
  blue: "oklch(0.64 0.16 245)",
  green: "oklch(0.68 0.16 152)",
  grey: "oklch(0.6 0 0)",
  ink: "oklch(0.6 0.2 270)",
  orange: "oklch(0.72 0.16 58)",
  pink: "oklch(0.66 0.19 352)",
  purple: "oklch(0.62 0.2 302)",
  red: "oklch(0.62 0.21 26)",
} as const satisfies Record<DitherColorName, string>

/** The CSS variable behind each named colour. */
export const DITHER_COLORS = {
  blue: "--dither-color-blue",
  green: "--dither-color-green",
  grey: "--dither-color-grey",
  ink: "--dither-ink",
  orange: "--dither-color-orange",
  pink: "--dither-color-pink",
  purple: "--dither-color-purple",
  red: "--dither-color-red",
} as const satisfies Record<DitherColorName, `--${string}`>

/**
 * A colour the dither components accept: a palette name such as
 * `"green"`, a CSS variable name such as `"--dither-ink"`, or any CSS
 * colour such as `"var(--chart-1)"`, `"oklch(0.7 0.15 272)"` or `"#fff"`.
 * Palette names win over the CSS keywords they share (`"red"` is the
 * dithercn red, not `#f00`).
 */
// oxlint-disable-next-line typescript/ban-types -- `string & {}` keeps editor autocomplete for the names.
export type DitherColor = DitherColorName | (string & {})

const isColorName = (value: string): value is DitherColorName =>
  Object.hasOwn(DITHER_COLORS, value)

/**
 * A CSS colour for any `DitherColor`: `"green"` becomes
 * `"var(--dither-color-green, <fallback>)"`, `"--chart-1"` becomes `"var(--chart-1)"`,
 * and anything else passes through.
 */
export const cssColor = (value: DitherColor): string => {
  if (isColorName(value)) {
    return `var(${DITHER_COLORS[value]}, ${FALLBACKS[value]})`
  }
  return value.startsWith("--") ? `var(${value})` : value
}

// Bayer ranks: interleave the bits of (x xor y) and y, least significant
// first, so each 2x2 block of the previous size splits into four.
const bayerRanks = (size: number): Uint8Array => {
  const ranks = new Uint8Array(size * size)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let rank = 0
      for (let bit = 1; bit < size; bit *= 2) {
        const xBit = Math.floor(x / bit) % 2
        const yBit = Math.floor(y / bit) % 2
        rank = rank * 4 + 2 * ((xBit + yBit) % 2) + yBit
      }
      ranks[y * size + x] = rank
    }
  }
  return ranks
}

const bayer4 = bayerRanks(4)

/** The avatar uses only the 4 by 4 Bayer matrix. */
export const isInked = (
  _matrix: "bayer4",
  x: number,
  y: number,
  tone: number
) => {
  const wrap = (value: number) => ((Math.floor(value) % 4) + 4) % 4
  return tone > ((bayer4[wrap(y) * 4 + wrap(x)] ?? 0) + 0.5) / 16
}
/** Blur radius and strength of each bloom level. */
export const BLOOM_LEVELS = {
  high: { blur: 18, strength: 0.55 },
  low: { blur: 10, strength: 0.3 },
} as const satisfies Record<
  Exclude<Bloom, "off">,
  { blur: number; strength: number }
>

/**
 * A CSS `filter` that glows around an element in `color`, for DOM pieces
 * (buttons, bars) where a copy of the fill is not handy. `undefined` when off.
 */
export const bloomFilter = (
  color: DitherColor,
  bloom: Bloom
): string | undefined => {
  if (bloom === "off") {
    return undefined
  }
  const { blur, strength } = BLOOM_LEVELS[bloom]
  const tint = (share: number) =>
    `color-mix(in oklab, ${cssColor(color)} calc(var(--dither-bloom, 1) * ${Math.round(share * 100)}%), transparent)`
  return `drop-shadow(0 0 ${Math.round(blur / 3)}px ${tint(strength * 1.4)}) drop-shadow(0 0 ${blur}px ${tint(strength)})`
}

/** `{ filter }` for `bloomFilter`, ready to spread into `style`. */
export const bloomStyle = (color: DitherColor, bloom: Bloom): CSSProperties => {
  const filter = bloomFilter(color, bloom)
  return filter === undefined ? {} : { filter }
}
