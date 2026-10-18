import { defineRegistry, JSONUIProvider, Renderer } from "@json-render/react"
import { Component, useMemo, type ReactNode } from "react"
import { useContext } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
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
import { WeatherCard } from "./weather"

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
}: {
  output: string
  onPrompt?: (text: string) => void
}) {
  const spec = useMemo(() => parseAnswerResult(output), [output])
  return (
    <AnswerDraftContext.Provider value={onPrompt}>
      <ResultBoundary key={output}>
        {spec ? (
          <JSONUIProvider registry={registry}>
            <Renderer spec={spec} registry={registry} />
          </JSONUIProvider>
        ) : (
          <UnavailableResult />
        )}
      </ResultBoundary>
    </AnswerDraftContext.Provider>
  )
}
