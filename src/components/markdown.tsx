import type { ComponentProps } from "react"
import { CodeXml } from "lucide-react"
import ReactMarkdown, { type ExtraProps } from "react-markdown"
import remarkGfm from "remark-gfm"
import { CopyButton } from "@/components/copy-button"

const languageNames: Record<string, string> = {
  bash: "Bash",
  sh: "Shell",
  shell: "Shell",
  js: "JavaScript",
  javascript: "JavaScript",
  ts: "TypeScript",
  typescript: "TypeScript",
  jsx: "JSX",
  tsx: "TSX",
  json: "JSON",
  py: "Python",
  python: "Python",
  html: "HTML",
  css: "CSS",
  sql: "SQL",
  yaml: "YAML",
  yml: "YAML",
  text: "Text",
}

function CodeBlock({ node, children }: ComponentProps<"pre"> & ExtraProps) {
  const code = node?.children.find(
    (child) => child.type === "element" && child.tagName === "code"
  )
  if (code?.type !== "element") return <pre>{children}</pre>
  const text = code.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("")
    // Remark appends one newline when converting a code block to HTML.
    .replace(/\n$/, "")
  const classes = code.properties.className
  const language = Array.isArray(classes)
    ? classes
        .find(
          (name): name is string =>
            typeof name === "string" && name.startsWith("language-")
        )
        ?.slice("language-".length)
    : undefined
  const label = language
    ? Object.hasOwn(languageNames, language.toLowerCase())
      ? languageNames[language.toLowerCase()]
      : language
    : "Code"

  return (
    <figure className="markdown-code-block">
      <figcaption className="markdown-code-header">
        <span className="markdown-code-language">
          <CodeXml aria-hidden="true" />
          <span>{label}</span>
        </span>
        <CopyButton
          text={text}
          label="Copy code"
          className="size-11 sm:size-8"
        />
      </figcaption>
      <pre>{children}</pre>
    </figure>
  )
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre: CodeBlock,
          img: ({ alt }) => <span>[Image: {alt}]</span>,
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
