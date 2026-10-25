import { DirectionProvider } from "@base-ui/react/direction-provider"
import {
  Controls,
  Description,
  Primary,
  Title,
} from "@storybook/addon-docs/blocks"
import type { Preview } from "@storybook/react-vite"
import { MotionProvider } from "@workspace/ui/components/motion-provider"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"
import * as React from "react"

import "../src/styles/globals.css"

function Theme({
  theme,
  textScale,
  direction,
  motion,
  children,
}: {
  theme: string
  textScale: number
  direction: "ltr" | "rtl"
  motion: "system" | "reduced"
  children: React.ReactNode
}) {
  const mobile = useIsMobile()
  const previousTheme = React.useRef(theme)
  React.useLayoutEffect(() => {
    document.documentElement.dataset.uiViewport = mobile ? "phone" : "desktop"
    document.documentElement.dataset.uiMotion = motion
    const changedTheme = previousTheme.current !== theme
    previousTheme.current = theme
    const freeze = changedTheme ? document.createElement("style") : undefined
    if (freeze) {
      freeze.textContent = "*,*::before,*::after{transition:none!important}"
      document.head.append(freeze)
    }
    const dark = theme === "dark"
    document.documentElement.classList.toggle("dark", dark)
    document.documentElement.style.colorScheme = dark ? "dark" : "light"
    document.documentElement.style.fontSize = textScale + "%"
    document.documentElement.dir = direction
    if (!freeze) return
    // Commit the new colors before restoring interactive transitions.
    void document.documentElement.offsetHeight
    let second = 0
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => freeze.remove())
    })
    return () => {
      cancelAnimationFrame(first)
      cancelAnimationFrame(second)
      freeze.remove()
    }
  }, [theme, textScale, direction, mobile, motion])
  return (
    <DirectionProvider direction={direction}>
      <MotionProvider reducedMotion={motion === "reduced" ? "always" : "user"}>
        {children}
      </MotionProvider>
    </DirectionProvider>
  )
}

const preview: Preview = {
  globalTypes: {
    motion: {
      description: "Motion preference",
      toolbar: {
        icon: "play",
        items: [
          { value: "system", title: "System motion" },
          { value: "reduced", title: "Reduced motion" },
        ],
        dynamicTitle: true,
      },
    },
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
  initialGlobals: {
    theme: "light",
    textScale: "100",
    direction: "ltr",
    motion: "system",
  },
  decorators: [
    (Story, context) => (
      <Theme
        theme={String(context.globals.theme)}
        motion={context.globals.motion === "reduced" ? "reduced" : "system"}
        textScale={String(context.globals.textScale) === "200" ? 200 : 100}
        direction={context.globals.direction === "rtl" ? "rtl" : "ltr"}
      >
        <Story />
      </Theme>
    ),
  ],
  parameters: {
    layout: "padded",
    docs: {
      page: () => (
        <>
          <Title />
          <Description />
          <Primary />
          <Controls />
        </>
      ),
    },
    controls: {
      expanded: true,
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
    a11y: {
      test: "error",
      // Empty desktop SDK sentinels redirect focus; their behavior is verified in browser tests.
      // https://github.com/mui/base-ui/issues/4668
      context: {
        exclude: [
          'html[data-ui-viewport="desktop"] span[data-base-ui-focus-guard][aria-hidden="true"]:empty',
        ],
      },
    },
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
        method: "alphabetical",
        order: [
          "Components",
          "Foundations",
          "Compositions",
          "Examination",
          "Start here",
        ],
      },
    },
  },
}
export default preview
