import {
  definitions,
  type AnswerSpec,
  type AnswerProps,
  type AnswerType,
} from "../../src/rich-results/catalog"
import type { EvalCase } from "./cases"
import type { Check } from "./grade"

type Card = AnswerSpec["elements"][string]
const leaves = (cards: Card[]) => cards.filter((card) => card.type !== "Stack")

// Literal tuple overlap is a bounded recap detector, not a semantic judge.
// One decisive fact is allowed; two repeated data tuples are a recap.
function normalize(value: unknown) {
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/[^\p{L}\p{N}.:%]+/gu, " ")
    .replace(/(?<!\d):|:(?!\d)/g, " ")
    .replace(/\.(?!\d)/g, " ")
    .trim()
    .replace(/\s+/g, " ")
}

function facts(card: Card): unknown[][] {
  switch (card.type) {
    case "Timeline":
      return definitions.Timeline.props
        .parse(card.props)
        .events.map((event) => [event.when, event.title])
    case "BarChart":
      return definitions.BarChart.props
        .parse(card.props)
        .values.map((item) => [item.label, item.value])
    case "Places":
      return definitions.Places.props
        .parse(card.props)
        .places.map((place) => [place.name, place.address])
    case "Route":
      return definitions.Route.props
        .parse(card.props)
        .stops.map((place) => [place.name, place.address])
    case "Products":
      return definitions.Products.props
        .parse(card.props)
        .products.filter((product) => product.price !== null)
        .map((product) => [product.name, product.price])
    case "Comparison": {
      const props = definitions.Comparison.props.parse(card.props)
      return props.criteria.flatMap((criterion) =>
        criterion.values.map((value, i) => [props.options[i], value])
      )
    }
    case "Calculation": {
      const props = definitions.Calculation.props.parse(card.props)
      return [props.expression.match(/\d+(?:\.\d+)?/g) ?? [], [props.result]]
    }
    case "Question":
      return definitions.Question.props
        .parse(card.props)
        .options.map((option) => [option.label])
    case "DataTable":
      return definitions.DataTable.props
        .parse(card.props)
        .rows.flatMap((row) => {
          const values = Object.values(row)
          const label = values.find((value) => typeof value === "string")
          const numbers = values.filter((value) => typeof value === "number")
          return label !== undefined && numbers.length
            ? [[label, ...numbers]]
            : []
        })
    default:
      return []
  }
}

export function cardChecks(
  test: EvalCase,
  cards: Card[],
  text: string
): Check[] {
  const checks: Check[] = []
  const content = cards
    .filter((card) => !["Stack", "Brief"].includes(card.type))
    .map((card) =>
      JSON.stringify([
        card.type,
        Object.fromEntries(
          Object.entries(card.props).filter(
            ([key]) => !["title", "source", "asOf"].includes(key)
          )
        ),
      ])
    )
  checks.push({
    name: "no-duplicate-rich-card",
    pass: new Set(content).size === content.length,
  })
  if (test.selection)
    checks.push({
      name: "question-matched-card-selection",
      pass:
        leaves(cards)
          .map((card) => card.type)
          .sort()
          .join() === [...test.selection].sort().join(),
    })
  const normalized = ` ${normalize(text)} `
  const repeated = new Set(
    cards
      .flatMap(facts)
      .map((tuple) => tuple.map(normalize))
      .filter(
        (tuple) =>
          tuple.length > 0 &&
          tuple.every(
            (value) => value.length > 0 && normalized.includes(` ${value} `)
          )
      )
      .map((tuple) => JSON.stringify(tuple))
  )
  checks.push({ name: "no-prose-data-recap", pass: repeated.size < 2 })
  return checks
}

function props<T extends AnswerType>(cards: Card[], type: T): AnswerProps<T>[] {
  // The type key selects the matching runtime schema.
  return cards
    .filter((card) => card.type === type)
    .map((card) =>
      definitions[type].props.parse(card.props)
    ) as AnswerProps<T>[]
}

const dataChecks: Record<string, (cards: Card[]) => Check> = {
  "timeline-plan": (cards) => {
    const events = props(cards, "Timeline").flatMap((p) => p.events)
    return {
      name: "exact-chronological-events",
      pass:
        events.length === 3 &&
        [
          /10(?::00|\s*a\.?m)/i,
          /12(?::00|\s*p\.?m|\s*noon)/i,
          /14:00|2\s*p\.?m/i,
        ].every((time, i) => time.test(events[i]?.when ?? "")) &&
        [/museum/i, /lunch/i, /park/i].every((title, i) =>
          title.test(events[i]?.title ?? "")
        ) &&
        /propos/i.test(JSON.stringify(cards)),
    }
  },
  "chart-ranking": (cards) =>
    chartValues(cards, [
      ["Kitchen", 42],
      ["Office", 18],
      ["Bedroom", 27],
    ]),
  "grouped-chart": (cards) =>
    chartValues(cards, [
      ["Food", 20],
      ["Travel", 5],
    ]),
  "grouped-summary": (cards) =>
    tableValues(cards, [
      ["Design", 15],
      ["Engineering", 12],
    ]),
  "signed-values": (cards) =>
    tableValues(cards, [
      ["Kitchen", -12],
      ["Office", 8],
      ["Bedroom", -3],
    ]),
  "single-place": (cards) =>
    placeValues(
      props(cards, "Places").flatMap((p) => p.places),
      1
    ),
  "place-shortlist": (cards) =>
    placeValues(
      props(cards, "Places").flatMap((p) => p.places),
      3
    ),
  "ordered-route": (cards) =>
    placeValues(
      props(cards, "Route").flatMap((p) => p.stops),
      3,
      true
    ),
  "question-single": (cards) =>
    questionValues(cards, false, [/train/i, /car/i, /bus/i]),
  "question-multiple": (cards) =>
    questionValues(cards, true, [/comfort/i, /battery/i, /noise/i]),
  "calculation-scenarios": (cards) => {
    const values = props(cards, "Calculation")
    return {
      name: "exact-two-verified-scenarios",
      pass:
        values.length === 2 &&
        [20, 30].every((value) =>
          values.some((p) => p.result === value && p.computed === "arithmetic")
        ),
    }
  },
  "single-offer": (cards) => {
    const products = props(cards, "Products").flatMap((p) => p.products)
    return {
      name: "exact-single-illustrative-offer",
      pass:
        products.length === 1 &&
        products[0]!.price === 89 &&
        products[0]!.currency === "EUR" &&
        products[0]!.url === "https://example.com/everyday" &&
        /everyday wireless/i.test(products[0]!.name) &&
        products[0]!.specs.some(
          (spec) => /battery/i.test(spec.label) && /\b30\b/.test(spec.value)
        ) &&
        /illustrative|example/i.test(JSON.stringify(cards)),
    }
  },
  "three-way-decision": (cards) => {
    const comparisons = props(cards, "Comparison")
    return {
      name: "three-options-relevant-criteria",
      pass:
        comparisons.length === 1 &&
        comparisons[0]!.options.length === 3 &&
        [/train/i, /car/i, /bus/i].every((pattern) =>
          comparisons[0]!.options.some((option) => pattern.test(option))
        ) &&
        comparisons[0]!.criteria.length === 2 &&
        comparisons[0]!.criteria.some((row) =>
          /cost|price|fare/i.test(row.label)
        ) &&
        comparisons[0]!.criteria.some((row) =>
          /time|duration/i.test(row.label)
        ) &&
        decisionValues(comparisons[0]!),
    }
  },
}

function chartValues(cards: Card[], expected: [string, number][]): Check {
  const values = props(cards, "BarChart").flatMap((p) => p.values)
  return {
    name: "exact-requested-chart-values",
    pass:
      values.length === expected.length &&
      expected.every(([label, value]) =>
        values.some((item) => item.label === label && item.value === value)
      ),
  }
}

function tableValues(cards: Card[], expected: [string, number][]): Check {
  const rows = props(cards, "DataTable").flatMap((p) => p.rows)
  return {
    name: "exact-requested-numeric-rows",
    pass:
      rows.length === expected.length &&
      expected.every((values) =>
        rows.some((row) =>
          values.every((value) => Object.values(row).includes(value))
        )
      ),
  }
}

function placeValues(
  places: AnswerProps<"Places">["places"],
  count: number,
  ordered = false
): Check {
  const expected = [
    [53.3409, -6.2526],
    [53.3382, -6.2591],
    [53.3429, -6.2674],
  ].slice(0, count)
  return {
    name: "exact-supplied-places-and-order",
    pass:
      places.length === expected.length &&
      expected.every(([lat, lon], i) =>
        ordered
          ? places[i]?.latitude === lat && places[i]?.longitude === lon
          : places.some(
              (place) => place.latitude === lat && place.longitude === lon
            )
      ),
  }
}

function questionValues(
  cards: Card[],
  multiple: boolean,
  labels: RegExp[]
): Check {
  const questions = props(cards, "Question")
  return {
    name: "appropriate-choice-mode-and-options",
    pass:
      questions.length === 1 &&
      questions[0]!.multiple === multiple &&
      questions[0]!.options.length === labels.length &&
      labels.every((pattern) =>
        questions[0]!.options.some((option) => pattern.test(option.label))
      ),
  }
}

export function adaptiveDataChecks(id: string, cards: Card[]): Check[] {
  const check = dataChecks[id]
  return check ? [check(cards)] : []
}

function decisionValues(comparison: AnswerProps<"Comparison">) {
  const cost = comparison.criteria.find((row) =>
    /cost|price|fare/i.test(row.label)
  )
  const time = comparison.criteria.find((row) =>
    /time|duration/i.test(row.label)
  )
  const expected: [RegExp, number, number][] = [
    [/train/i, 40, 90],
    [/car/i, 55, 60],
    [/bus/i, 20, 120],
  ]
  return expected.every(([mode, price, minutes]) => {
    const index = comparison.options.findIndex((option) => mode.test(option))
    const number = (value?: string) =>
      Number(value?.match(/\d+(?:\.\d+)?/)?.[0])
    return (
      index >= 0 &&
      number(cost?.values[index]) === price &&
      durationMinutes(time?.values[index]) === minutes
    )
  })
}

function durationMinutes(value = "") {
  const hours = value.match(/(\d+(?:\.\d+)?)\s*(?:h\b|hours?\b)/i)
  if (!hours) return Number(value.match(/\d+(?:\.\d+)?/)?.[0])
  const minutes = value.match(/(\d+(?:\.\d+)?)\s*(?:m\b|mins?\b|minutes?\b)/i)
  return Number(hours[1]) * 60 + Number(minutes?.[1] ?? 0)
}
