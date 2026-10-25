import type { Transition } from "motion/react"

export const motionEase = [0.2, 0, 0, 1] as const
export const motionSpring = {
  type: "spring",
  duration: 0.3,
  bounce: 0,
} satisfies Transition
export const motionFastSpring = {
  type: "spring",
  duration: 0.15,
  bounce: 0,
} satisfies Transition
