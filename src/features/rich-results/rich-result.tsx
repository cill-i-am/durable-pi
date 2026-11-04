import {
  defineRegistry,
  JSONUIProvider,
  Renderer,
  type ComponentRenderProps,
} from "@json-render/react"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Component, useMemo, type ReactNode } from "react"
import { useContext } from "react"

import {
  parseResultReference,
  type ResultIdentity,
} from "@/navigation/result-reference"
import { answerCatalog, parseAnswerResult } from "@/rich-results/catalog"

import { BriefLayout } from "./brief"
import {
  BarChartCard,
  CalculationCard,
  ComparisonCard,
  PlacesCard,
  ResultCard,
  TimelineCard,
  RouteCard,
} from "./cards"
import { DataTableView } from "./data-table"
import { ProductsCard } from "./products"
import { AnswerDraftContext, QuestionCard } from "./question"
import {
  ResultElementScope,
  ResultSourceContext,
  ResultSurfaceActiveContext,
} from "./result-workspace-context"
import { WeatherCard } from "./weather"

import "./rich-results.css"

const { registry } = defineRegistry(answerCatalog, {
  components: {
    Stack: ({ children }) => (
      <div className="flex min-w-0 flex-col gap-4">{children}</div>
    ),
    Brief: ({ props, children }) => (
      <BriefLayout {...props}>{children}</BriefLayout>
    ),
    Question: ({ props }) => <QuestionCard {...props} />,
    Route: ({ props }) => <RouteCard {...props} />,
    Weather: ({ props }) => <WeatherCard {...props} />,
    Calculation: ({ props }) => <CalculationCard {...props} />,
    Places: ({ props }) => <PlacesCard {...props} />,
    Products: ({ props }) => <ProductsCard {...props} />,
    DataTable: ({ props }) => (
      <ResultCard title={props.title} provenance={props}>
        <DataTableView {...props} />
      </ResultCard>
    ),
    Comparison: ({ props }) => <ComparisonCard {...props} />,
    BarChart: ({ props }) => <BarChartCard {...props} />,
    Timeline: ({ props }) => <TimelineCard {...props} />,
  },
})

// Local presentation keys preserve the public, validated answer schema.
const presentationRegistry = Object.fromEntries(
  Object.entries(registry).map(([type, Render]) => [
    type,
    (props: ComponentRenderProps) => (
      <ResultElementScope
        element={String(
          Reflect.get(props.element, "presentationKey") ?? "answer"
        )}
      >
        <Render {...props} />
      </ResultElementScope>
    ),
  ])
)

function UnavailableResult() {
  const onPrompt = useContext(AnswerDraftContext)
  return (
    <Alert>
      <AlertTitle>Couldn’t display this result</AlertTitle>
      <AlertDescription>
        The recorded tool output is still available in the activity above. Ask
        Pi to regenerate the card.
        {onPrompt && (
          <Button
            variant="outline"
            size="sm"
            className="mt-2 self-start"
            onClick={() =>
              onPrompt(
                "Please regenerate the previous interactive result using its original sources, resolving any invalid data."
              )
            }
          >
            Ask for a new result
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}
type ResultBoundaryProps = { children: ReactNode }
class ResultBoundary extends Component<
  ResultBoundaryProps,
  { failed: boolean }
> {
  constructor(props: ResultBoundaryProps) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? <UnavailableResult /> : this.props.children
  }
}
export function RichResult({
  output,
  onPrompt,
  identity,
  surface = "inline",
  reference,
  active,
}: {
  output: string
  onPrompt?: (text: string) => void
  identity?: Pick<ResultIdentity, "turn" | "tool">
  surface?: "inline" | "workbench"
  reference?: string
  active?: boolean
}) {
  const parentActive = useContext(ResultSurfaceActiveContext)
  const spec = useMemo(() => parseAnswerResult(output), [output])
  const presentation = useMemo(
    () =>
      spec
        ? {
            ...spec,
            root: reference
              ? parseResultReference(reference).element
              : spec.root,
            elements: Object.fromEntries(
              Object.entries(spec.elements).map(([key, value]) => [
                key,
                { ...value, presentationKey: key },
              ])
            ),
          }
        : null,
    [spec, reference]
  )
  return (
    <ResultSurfaceActiveContext.Provider value={active ?? parentActive}>
      <ResultSourceContext.Provider
        value={identity ? { source: identity, surface, reference } : null}
      >
        <AnswerDraftContext.Provider value={onPrompt}>
          <ResultBoundary key={output}>
            {presentation ? (
              <JSONUIProvider registry={presentationRegistry}>
                <Renderer spec={presentation} registry={presentationRegistry} />
              </JSONUIProvider>
            ) : (
              <UnavailableResult />
            )}
          </ResultBoundary>
        </AnswerDraftContext.Provider>
      </ResultSourceContext.Provider>
    </ResultSurfaceActiveContext.Provider>
  )
}
