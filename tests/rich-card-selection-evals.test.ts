import { describe, expect, it } from "vitest"

import {
  adaptiveDataChecks,
  cardChecks,
} from "../evals/rich-answers/card-checks"
import { cases } from "../evals/rich-answers/cases"
import { answerExamples } from "../src/features/rich-results/examples"
import { answerResult } from "../src/rich-results/catalog"
import { analyzeData } from "../src/rich-results/presentation"

const cardsFor = (id: string) =>
  Object.values(
    answerExamples.find((example) => example.id === id)!.result.spec.elements
  )
const testFor = (id: string) => cases.find((test) => test.id === id)!
const demo = { source: { label: "Supplied data", url: null }, asOf: "Supplied" }

describe("adaptive card graders (synthetic evidence, not model evaluations)", () => {
  it("accepts equivalent journey times and rejects a matrix with incorrect costs", () => {
    const cards = Object.values(
      answerResult("Comparison", {
        title: "Transport",
        options: ["Train", "Car", "Bus"],
        criteria: [
          {
            label: "Cost",
            values: ["EUR 40", "EUR 55 incl parking", "EUR 20"],
          },
          {
            label: "Journey time",
            values: ["1 hour 30 minutes", "1 h", "2 hours"],
          },
        ],
        verdict: "Choose based on cost or time.",
        ...demo,
      }).spec.elements
    )
    expect(
      adaptiveDataChecks("three-way-decision", cards).every(
        (check) => check.pass
      )
    ).toBe(true)
    cards[0]!.props.criteria = [
      { label: "Cost", values: ["EUR 400", "EUR 55", "EUR 20"] },
      { label: "Time", values: ["90 min", "60 min", "120 min"] },
    ]
    expect(
      adaptiveDataChecks("three-way-decision", cards).every(
        (check) => check.pass
      )
    ).toBe(false)
  })
  it("rejects a repeated rich card even if its display title changes", () => {
    const cards = cardsFor("chart")
    const duplicate = structuredClone(cards[0]!)
    duplicate.props.title = "The same numbers again"
    expect(
      cardChecks(
        { id: "fixture", prompt: "fixture" },
        [...cards, duplicate],
        ""
      )
    ).toContainEqual({ name: "no-duplicate-rich-card", pass: false })
  })
  it.each([
    ["shopping", "Everyday wireless costs €89. Studio wireless costs €179."],
    [
      "places",
      "National Gallery of Ireland: Merrion Square West, Dublin 2, Ireland. St Stephen’s Green: Dublin 2, Ireland.",
    ],
    [
      "route",
      "National Gallery of Ireland: Merrion Square West, Dublin. St Stephen’s Green: Dublin 2, Ireland.",
    ],
    ["table", "Groceries cost €86.4. Train tickets cost €24."],
    ["chart", "Home: €112.8. Food: €122.9."],
    ["timeline", "10:00 Start at the gallery. 12:00 Lunch nearby."],
    ["compare", "Train: Fixed timetable. Car: Leave when you like."],
    ["question", "Choose Comfort, Battery life or Noise cancelling."],
  ])("rejects a prose recap of %s data", (id, recap) => {
    expect(
      cardChecks({ id: "fixture", prompt: "fixture" }, cardsFor(id), recap)
    ).toContainEqual({ name: "no-prose-data-recap", pass: false })
    expect(
      cardChecks(
        { id: "fixture", prompt: "fixture" },
        cardsFor(id),
        "Choose based on your priorities; verify uncertain details before acting."
      )
    ).toContainEqual({ name: "no-prose-data-recap", pass: true })
  })
  it("permits one decisive fact while rejecting an arithmetic walkthrough of both scenarios", () => {
    const cards = [4, 6].flatMap((people) =>
      Object.values(
        answerResult("Calculation", {
          title: `${people} people`,
          expression: `120 / ${people}`,
          result: 120 / people,
          unit: "EUR per person",
          computed: "arithmetic",
        }).spec.elements
      )
    )
    expect(
      cardChecks(
        testFor("calculation-scenarios"),
        cards,
        "With four people, each pays €30."
      )
    ).toContainEqual({ name: "no-prose-data-recap", pass: true })
    expect(
      cardChecks(
        testFor("calculation-scenarios"),
        cards,
        "120 / 4 = 30; 120 / 6 = 20."
      )
    ).toContainEqual({ name: "no-prose-data-recap", pass: false })
  })
  it("rejects an extra table, extra chart or artificial Brief even if the required card exists", () => {
    const test = testFor("chart-ranking")
    expect(cardChecks(test, cardsFor("chart"), "")).toContainEqual({
      name: "question-matched-card-selection",
      pass: true,
    })
    for (const extra of [
      cardsFor("table"),
      cardsFor("chart"),
      [{ type: "Brief" as const, props: {}, children: [] }],
    ])
      expect(
        cardChecks(test, [...cardsFor("chart"), ...extra], "")
      ).toContainEqual({ name: "question-matched-card-selection", pass: false })
  })
  it("checks grouped-only and chart-only output with numeric totals, not just tool presence", () => {
    const input = {
      table: {
        title: "Hours",
        columns: [
          { key: "team", label: "Department" },
          { key: "hours", label: "Hours", format: "number" as const },
        ],
        rows: [
          { team: "Design", hours: 12 },
          { team: "Engineering", hours: 8 },
          { team: "Design", hours: 18 },
          { team: "Engineering", hours: 16 },
        ],
        ...demo,
      },
      groupBy: "team",
      valueKey: "hours",
      operation: "average" as const,
    }
    const summary = Object.values(
      analyzeData({ ...input, views: ["summary"] }).spec.elements
    )
    expect(
      adaptiveDataChecks("grouped-summary", summary).every(
        (check) => check.pass
      )
    ).toBe(true)
    expect(
      cardChecks(testFor("grouped-summary"), summary, "").every(
        (check) => check.pass
      )
    ).toBe(true)
    const all = Object.values(analyzeData(input).spec.elements)
    expect(cardChecks(testFor("grouped-summary"), all, "")).toContainEqual({
      name: "question-matched-card-selection",
      pass: false,
    })
    const wrong = structuredClone(summary)
    const table = wrong.find((item) => item.type === "DataTable")!
    table.props.rows = [
      { label: "Design", value: "15" },
      { label: "Engineering", value: 12 },
    ]
    expect(
      adaptiveDataChecks("grouped-summary", wrong).every((check) => check.pass)
    ).toBe(false)
  })
  it("checks choice modes, exact labels and count", () => {
    const question = answerResult("Question", {
      question: "Which mode?",
      description: "Choose one.",
      multiple: false,
      options: ["Train", "Car", "Bus"].map((label) => ({
        label,
        description: "",
      })),
    })
    const cards = Object.values(question.spec.elements)
    expect(
      adaptiveDataChecks("question-single", cards).every((check) => check.pass)
    ).toBe(true)
    cards[0]!.props.multiple = true
    expect(
      adaptiveDataChecks("question-single", cards).every((check) => check.pass)
    ).toBe(false)
    expect(
      adaptiveDataChecks("question-multiple", cards).every(
        (check) => check.pass
      )
    ).toBe(false)
  })
  it("rejects a reordered route, padded map and dropped place", () => {
    const places = [
      {
        name: "Gallery",
        address: "Merrion Square West, Dublin",
        latitude: 53.3409,
        longitude: -6.2526,
      },
      {
        name: "Green",
        address: "Dublin",
        latitude: 53.3382,
        longitude: -6.2591,
      },
      {
        name: "Castle",
        address: "Dame Street, Dublin",
        latitude: 53.3429,
        longitude: -6.2674,
      },
    ]
    const cards = Object.values(
      answerResult("Places", { title: "Landmarks", places, ...demo }).spec
        .elements
    )
    expect(
      adaptiveDataChecks("place-shortlist", cards).every((check) => check.pass)
    ).toBe(true)
    expect(
      adaptiveDataChecks("single-place", cards).every((check) => check.pass)
    ).toBe(false)
    cards[0]!.props.places = [...places].reverse()
    expect(
      adaptiveDataChecks("place-shortlist", cards).every((check) => check.pass)
    ).toBe(true)
    const route = Object.values(
      answerResult("Route", {
        title: "Route",
        stops: [...places].reverse(),
        coordinates: [
          [-6.25, 53.34],
          [-6.26, 53.34],
        ],
        distanceMeters: 1000,
        durationSeconds: 300,
        profile: "driving",
        ...demo,
      }).spec.elements
    )
    expect(
      adaptiveDataChecks("ordered-route", route).every((check) => check.pass)
    ).toBe(false)
    cards[0]!.props.places = places.slice(0, 2)
    expect(
      adaptiveDataChecks("place-shortlist", cards).every((check) => check.pass)
    ).toBe(false)
  })
})
