import type { ComponentProps } from "react"
import { CodeXml } from "lucide-react"
import ReactMarkdown, { type ExtraProps } from "react-markdown"
import remarkGfm from "remark-gfm"
import { CopyButton } from "@/components/copy-button"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockLine,
  CodeBlockTitle,
} from "@/components/ui/code-block"

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

function MarkdownCodeBlock({
  node,
  children,
}: ComponentProps<"pre"> & ExtraProps) {
  const code = node?.children.find(
    (child) => child.type === "element" && child.tagName === "code"
  )
  if (code?.type !== "element") return <pre>{children}</pre>
  const text = code.children
    .map((child) => (child.type === "text" ? child.value : ""))
    .join("")
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
      ? languageNames[language.toLowerCase()]!
      : language
    : "Code"

  return (
    <HighlightedBlock text={text} language={language ?? "text"} label={label} />
  )
}

function HighlightedBlock({
  text,
  language,
  label,
}: {
  text: string
  language: string
  label: string
}) {
  const lines = useHighlightedCode(text, language)
  return (
    <CodeBlock className="my-4 first:mt-0 last:mb-0">
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeXml aria-hidden="true" />
          <span>{label}</span>
        </CodeBlockTitle>
        <CodeBlockActions>
          <CopyButton text={text.replace(/\n$/, "")} label="Copy code" />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent>
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          pre: MarkdownCodeBlock,
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
