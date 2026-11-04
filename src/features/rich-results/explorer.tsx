import { DataLoading } from "@workspace/ui/components/data-loading"
import { lazy, Suspense, useCallback, useEffect, useRef } from "react"

import { ResultSurfaceActiveContext } from "./result-workspace-context"

import "./rich-results.css"

const AnswerGallery = lazy(() =>
  import("./gallery").then((module) => ({ default: module.AnswerGallery }))
)

export function AnswerExamples({
  onPrompt,
  active = true,
}: {
  onPrompt?: (prompt: string) => void
  active?: boolean
}) {
  const live = useRef({ active, onPrompt })
  live.current = { active, onPrompt }
  useEffect(
    () => () => {
      live.current = { active: false, onPrompt: undefined }
    },
    []
  )
  const append = useCallback((prompt: string) => {
    if (live.current.active) live.current.onPrompt?.(prompt)
  }, [])
  return (
    <ResultSurfaceActiveContext.Provider value={active}>
      <section
        className="answer-examples workbench-body"
        aria-label="Answer examples"
      >
        <p className="text-sm text-muted-foreground">Sample data</p>
        <Suspense fallback={<DataLoading loading label="Opening examples" />}>
          <AnswerGallery onPrompt={active && onPrompt ? append : undefined} />
        </Suspense>
      </section>
    </ResultSurfaceActiveContext.Provider>
  )
}
