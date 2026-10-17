import {
  parseFragment,
  defaultTreeAdapter,
  type DefaultTreeAdapterTypes,
} from "parse5"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { Markdown } from "../src/components/markdown"

function codeBlocks(html: string) {
  const blocks: string[] = []
  const text = (node: DefaultTreeAdapterTypes.ChildNode): string =>
    defaultTreeAdapter.isTextNode(node)
      ? node.value
      : "childNodes" in node
        ? node.childNodes.map(text).join("")
        : ""
  const visit = (node: DefaultTreeAdapterTypes.ChildNode) => {
    if (
      defaultTreeAdapter.isElementNode(node) &&
      node.tagName === "code" &&
      node.attrs.some(
        (attr) => attr.name === "data-slot" && attr.value === "code-block-code"
      )
    ) {
      blocks.push(
        node.childNodes
          .map((line) => (text(line) === "\n" ? "" : text(line)))
          .join("\n")
      )
    } else if ("childNodes" in node) node.childNodes.forEach(visit)
  }
  parseFragment(html).childNodes.forEach(visit)
  return blocks
}

describe("shared Markdown rendering", () => {
  it("gives fenced and indented code their own copy control, while leaving inline code inline", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={
          'Use `npm` first.\n\n```bash\nprintf "hello"\n```\n\nThen check:\n\n    exit 0'
        }
      />
    )
    expect(html.match(/aria-label="Copy code"/g)).toHaveLength(2)
    expect(html).toContain("<span>Bash</span>")
    expect(html).toContain("<span>Code</span>")
    expect(html).toContain("<p>Use <code>npm</code> first.</p>")
    expect(codeBlocks(html)).toEqual(['printf "hello"', "exit 0"])
    expect(html).toContain('dir="ltr" tabindex="0"')
    expect(html).not.toMatch(/<pre>\s*<(?:div|figure)/)
  })

  it("preserves whitespace and escapes code while continuing to skip raw HTML", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={
          "<script>bad()</script>\n\n```html\n<div>\n\t  café & tea\n\n</div>\n```"
        }
      />
    )
    expect(html).not.toContain("bad()")
    expect(codeBlocks(html)).toEqual(["<div>\n\t  café & tea\n\n</div>"])
    expect(html).not.toContain("<div>\n\t")
  })

  it("keeps unfinished streaming fences copyable and supports blocks in lists", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={
          "1. Run this:\n\n   ```sh\n   echo ready\n   ```\n\nThen:\n\n```custom\necho pending"
        }
      />
    )
    expect(html.match(/aria-label="Copy code"/g)).toHaveLength(2)
    expect(html).toContain("<span>Shell</span>")
    expect(html).toContain("<span>custom</span>")
    expect(codeBlocks(html)).toEqual(["echo ready", "echo pending"])
  })

  it("keeps a deliberate trailing blank line when the fence closes", () => {
    const html = renderToStaticMarkup(
      <Markdown text={"```text\nfirst\n\n```"} />
    )
    expect(codeBlocks(html)).toEqual(["first\n"])
  })

  it("renders arbitrary language labels as text without consulting object prototypes", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={"```__proto__\nexample\n```\n\n```constructor\nexample\n```"}
      />
    )
    expect(html).toContain("<span>__proto__</span>")
    expect(html).toContain("<span>constructor</span>")
  })
})
