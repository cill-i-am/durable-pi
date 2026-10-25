import { DirectionProvider } from "@base-ui/react/direction-provider"
import type { Preview } from "@storybook/react-vite"
import * as React from "react"

import "../src/styles/globals.css"

function Theme({
  theme,
  textScale,
  direction,
  children,
}: {
  theme: string
  textScale: number
  direction: "ltr" | "rtl"
  children: React.ReactNode
}) {
  React.useLayoutEffect(() => {
    const dark = theme === "dark"
    document.documentElement.classList.toggle("dark", dark)
    document.documentElement.style.colorScheme = dark ? "dark" : "light"
    document.documentElement.style.fontSize = textScale + "%"
    document.documentElement.dir = direction
  }, [theme, textScale, direction])
  return <DirectionProvider direction={direction}>{children}</DirectionProvider>
}

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Theme",
      toolbar: {
        icon: "circlehollow",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Night" },
        ],
        dynamicTitle: true,
      },
    },
    textScale: {
      description: "Text size",
      toolbar: {
        icon: "zoom",
        items: [
          { value: "100", title: "100% text" },
          { value: "200", title: "200% text" },
        ],
        dynamicTitle: true,
      },
    },
    direction: {
      description: "Reading direction",
      toolbar: {
        icon: "transfer",
        items: [
          { value: "ltr", title: "Left to right" },
          { value: "rtl", title: "Right to left" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: "light", textScale: "100", direction: "ltr" },
  decorators: [
    (Story, context) => (
      <Theme
        theme={String(context.globals.theme)}
        textScale={String(context.globals.textScale) === "200" ? 200 : 100}
        direction={context.globals.direction === "rtl" ? "rtl" : "ltr"}
      >
        <Story />
      </Theme>
    ),
  ],
  parameters: {
    layout: "padded",
    controls: {
      expanded: true,
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
    a11y: { test: "error" },
    viewport: {
      options: {
        narrow: {
          name: "Narrow · 320",
          styles: { width: "320px", height: "844px" },
        },
        phone: {
          name: "Phone · 390",
          styles: { width: "390px", height: "844px" },
        },
        tablet: {
          name: "Tablet · 768",
          styles: { width: "768px", height: "1024px" },
        },
        desktop: {
          name: "Desktop · 1280",
          styles: { width: "1280px", height: "900px" },
        },
      },
    },
    options: {
      storySort: {
        order: [
          "Start here",
          "Foundations",
          "Actions",
          "Forms",
          "Selection",
          "Surfaces",
          "Navigation",
          "Overlays",
          "Examination",
        ],
      },
    },
  },
}
export default preview
