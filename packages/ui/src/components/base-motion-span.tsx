"use client"

import { mergeProps } from "@base-ui/react/merge-props"
import { useRender, type HTMLProps } from "@base-ui/react/use-render"
import { motion } from "motion/react"
import type * as React from "react"

type Props = React.ComponentPropsWithRef<"span"> & {
  baseProps: HTMLProps<HTMLSpanElement>
}

function NativeBaseSpan({ baseProps, ref, ...motionProps }: Props) {
  return useRender({
    defaultTagName: "span",
    props: {
      ...mergeProps<"span">(baseProps, motionProps),
      children: baseProps.children,
    },
    ref,
  })
}

// Compose Base UI's native events/ref with Motion's differently typed events.
const BaseMotionSpan = motion.create(NativeBaseSpan)
export { BaseMotionSpan }
