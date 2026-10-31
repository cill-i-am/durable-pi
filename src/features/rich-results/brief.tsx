import type { ReactNode } from "react"

import type { AnswerProps } from "@/rich-results/catalog"

import { AnswerWorkspace } from "./workspace"

export function BriefLayout({
  children,
  ...props
}: AnswerProps<"Brief"> & { children: ReactNode }) {
  return (
    <section
      className="rich-brief @container flex min-w-0 flex-col gap-5 whitespace-normal"
      aria-label={props.title}
    >
      <header className="flex flex-col gap-2">
        <p className="text-sm text-muted-foreground">{props.date}</p>
        <h2 className="text-xl font-semibold tracking-tight">{props.title}</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {props.summary}
        </p>
      </header>
      <AnswerWorkspace title={props.title} description={props.summary}>
        <div className="rich-brief-grid grid min-w-0 items-start gap-4 @3xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          {children}
        </div>
      </AnswerWorkspace>
    </section>
  )
}
