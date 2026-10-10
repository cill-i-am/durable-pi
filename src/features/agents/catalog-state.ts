import type { AgentProfile } from "../../agents/contracts"

export type CatalogState = {
  agents: AgentProfile[]
  request: number
  loading: boolean
  error: string
}
type Action =
  | { type: "start"; request: number }
  | { type: "loaded"; request: number; agents: readonly AgentProfile[] }
  | { type: "failed"; request: number }

export const initialCatalog: CatalogState = {
  agents: [],
  request: 0,
  loading: true,
  error: "",
}

export function catalogReducer(
  state: CatalogState,
  action: Action
): CatalogState {
  if (action.type === "start") return { ...state, request: action.request }
  if (action.request !== state.request) return state
  return action.type === "loaded"
    ? { ...state, agents: [...action.agents], loading: false, error: "" }
    : {
        ...state,
        loading: false,
        error: "Could not load your bots. Try again.",
      }
}
