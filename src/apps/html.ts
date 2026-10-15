import { AppConflict } from "./contracts"
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5"

const tags = new Set(
  "article section header footer main nav aside div span p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd strong em b i small s sub sup br hr pre code blockquote table caption thead tbody tfoot tr th td form label input textarea select option optgroup button fieldset legend details summary progress meter".split(
    " "
  )
)
const attributes = new Set(
  "id class title role aria-label aria-describedby aria-labelledby aria-live aria-hidden for name placeholder required disabled readonly checked selected multiple min max step minlength maxlength rows cols value data-action colspan rowspan scope open low high optimum".split(
    " "
  )
)
const inputTypes = new Set(
  "text number range checkbox radio date time datetime-local month week email url search color".split(
    " "
  )
)
const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
const voidTags = new Set(["br", "hr", "input"])
export function appHtml(source: string) {
  const fragment = parseFragment(source)
  let nodes = 0
  function render(
    node: DefaultTreeAdapterTypes.ChildNode,
    depth: number
  ): string {
    if (++nodes > 1000 || depth > 40)
      throw new AppConflict({ message: "App markup is too complex" })
    if (node.nodeName === "#text")
      return escape((node as DefaultTreeAdapterTypes.TextNode).value)
    if (
      !("tagName" in node) ||
      node.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      !tags.has(node.tagName)
    )
      return ""
    const attrs = node.attrs
      .flatMap((attribute) => {
        if (attribute.namespace || attribute.prefix) return []
        if (attribute.name === "type") {
          if (node.tagName === "input" && inputTypes.has(attribute.value))
            return [`type="${escape(attribute.value)}"`]
          if (
            node.tagName === "button" &&
            ["button", "submit", "reset"].includes(attribute.value)
          )
            return [`type="${attribute.value}"`]
          return []
        }
        if (!attributes.has(attribute.name) || attribute.value.length > 1000)
          return []
        return [`${attribute.name}="${escape(attribute.value)}"`]
      })
      .join(" ")
    const open = `<${node.tagName}${attrs ? " " + attrs : ""}>`
    return voidTags.has(node.tagName)
      ? open
      : `${open}${node.childNodes.map((child) => render(child, depth + 1)).join("")}</${node.tagName}>`
  }
  const output = fragment.childNodes.map((node) => render(node, 0)).join("")
  if (output.length > 64000)
    throw new AppConflict({ message: "App markup is too large" })
  return output
}
