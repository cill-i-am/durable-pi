import { createContext, useContext, type ReactNode } from "react"

import type { ResultIdentity } from "@/navigation/result-reference"

import {
  ResultViewStateContext,
  type createResultViewStore,
} from "./result-view-state"

export type ResultSource = {
  turn: string
  tool: string
  output: string
}
export const ResultWorkspaceContext = createContext<{
  store: ReturnType<typeof createResultViewStore>
  opened: readonly string[]
  open: (reference: string) => void
} | null>(null)
export const ResultSourceContext = createContext<{
  source: Pick<ResultSource, "turn" | "tool">
  surface: "inline" | "workbench"
  reference?: string
} | null>(null)
export const ResultElementContext = createContext<ResultIdentity | null>(null)
export const ResultSurfaceActiveContext = createContext(true)

export function ResultElementScope({
  element,
  children,
}: {
  element: string
  children: ReactNode
}) {
  const workspace = useContext(ResultWorkspaceContext)
  const source = useContext(ResultSourceContext)
  const identity = source ? { ...source.source, element } : null
  return (
    <ResultElementContext.Provider value={identity}>
      <ResultViewStateContext.Provider
        value={
          workspace && identity
            ? {
                store: workspace.store,
                scope: JSON.stringify(identity),
              }
            : null
        }
      >
        {children}
      </ResultViewStateContext.Provider>
    </ResultElementContext.Provider>
  )
}
