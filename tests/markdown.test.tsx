import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { Markdown } from "../src/components/markdown"

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
    expect(html).toContain(
      '<pre><code class="language-bash">printf &quot;hello&quot;\n</code></pre>'
    )
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
    expect(html).toContain("&lt;div&gt;\n\t  café &amp; tea\n\n&lt;/div&gt;\n")
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
    expect(html).toContain("echo pending\n</code>")
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
