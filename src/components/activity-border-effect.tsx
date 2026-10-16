import { BorderBeam } from "border-beam"

import { useAppTheme } from "@/hooks/use-app-theme"

/** Decoration is a sibling of the input, so loading or stopping it cannot
 * remount the composer or steal its focus. It has no pointer or tab target. */
export function ActivityBorderEffect() {
  const { resolvedTheme } = useAppTheme()
  return (
    <BorderBeam
      aria-hidden="true"
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        borderRadius: "inherit",
      }}
      borderRadius={0}
      size="line"
      colorVariant="ocean"
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      active
      duration={7}
      strength={0.3}
      glowSize={0.6}
      staticColors
      children={null}
    />
  )
}
