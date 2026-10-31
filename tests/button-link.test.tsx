import { Button, buttonVariants } from "@workspace/ui/components/button"
import { parseFragment, defaultTreeAdapter } from "parse5"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"

it("gives native navigation links the same layout overrides as buttons", () => {
  const props = {
    variant: "ghost" as const,
    size: "sm" as const,
    className: "h-auto w-full justify-between gap-3 py-2 text-left",
  }
  const markup = renderToStaticMarkup(<Button {...props}>History</Button>)
  const node = parseFragment(markup).childNodes[0]!
  const buttonClass = defaultTreeAdapter.isElementNode(node)
    ? node.attrs.find((attribute) => attribute.name === "class")?.value
    : undefined
  expect(buttonVariants(props)).toBe(buttonClass)
})
