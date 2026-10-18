import type { AnswerType } from "../../src/rich-results/catalog"

export type EvalCase = {
  id: string
  prompt: string
  tools?: string[]
  cards?: AnswerType[]
  noCards?: boolean
  weather?:
    | { period: "today" | "tomorrow" | "weekend"; days: number }
    | { days: number }
  result?: number
  clarify?: boolean
  markdownSource?: boolean
  research?: boolean
  forbiddenTools?: string[]
  selection?: AnswerType[]
  suppliedOnly?: boolean
}

// Ordinary user requests: no tool names, expected answers or grading hints.
export const cases: EvalCase[] = [
  {
    id: "day-brief",
    prompt:
      "Make me a compact day brief using only these supplied facts: a €40 group lunch split four ways; a proposed schedule of museum at 10:00, lunch at 12:00, and park at 14:00. Put the cost calculation and proposed itinerary together in one view. No bookings or research needed.",
    tools: ["show_brief"],
    cards: ["Brief", "Calculation", "Timeline"],
    result: 10,
    selection: ["Brief", "Calculation", "Timeline"],
  },
  {
    id: "driving-route",
    prompt:
      "Show me a driving route from the National Gallery of Ireland, Merrion Square West, Dublin (53.3409, -6.2526), to St Stephen's Green, Dublin (53.3382, -6.2591). These are public landmark coordinates supplied from OpenStreetMap. No bookings.",
    tools: ["lookup_route"],
    cards: ["Route"],
  },
  {
    id: "clarify-options",
    prompt:
      "Help me choose headphones. Start with one question about which priorities matter to me, using choices I can select before we research anything.",
    tools: ["ask_question"],
    cards: ["Question"],
    selection: ["Question"],
  },
  {
    id: "weather-weekend",
    prompt:
      "Which day this coming weekend looks better for a family walk in Dublin, Ireland?",
    tools: ["lookup_weather"],
    cards: ["Weather"],
    weather: { period: "weekend", days: 2 },
  },
  {
    id: "weather-today",
    prompt:
      "What's the weather looking like in Dublin, Ireland today? I'd like to see how the rain and wind change through the day.",
    tools: ["lookup_weather"],
    cards: ["Weather"],
    weather: { period: "today", days: 1 },
  },
  {
    id: "weather-tomorrow",
    prompt: "Will I need a raincoat in Dublin, Ireland tomorrow?",
    tools: ["lookup_weather"],
    cards: ["Weather"],
    weather: { period: "tomorrow", days: 1 },
  },
  {
    id: "weather-week",
    prompt:
      "How is the weather shaping up over the next seven days in Dublin, Ireland?",
    tools: ["lookup_weather"],
    cards: ["Weather"],
    weather: { days: 7 },
  },
  {
    id: "split-bill",
    prompt:
      "A restaurant bill is €186. We have a 15% discount and four people splitting it equally. What does each person owe?",
    tools: ["calculate"],
    cards: ["Calculation"],
    result: 39.525,
    selection: ["Calculation"],
  },
  {
    id: "units",
    prompt: "Convert 350 degrees Fahrenheit to Celsius for my oven.",
    tools: ["convert_units"],
    cards: ["Calculation"],
    result: 176.66666666666666,
    selection: ["Calculation"],
  },
  {
    id: "landmark",
    prompt:
      "Where is the National Gallery of Ireland in Dublin? Show me its address and a map.",
    tools: ["lookup_places"],
    cards: ["Places"],
  },
  {
    id: "expenses",
    prompt:
      "Here are my expenses in EUR: Food 12.50, Travel 5.00, Food 7.50. Show the underlying numbers in a table I can sort and filter, and chart the total for each category.",
    tools: ["analyze_data"],
    cards: ["DataTable", "BarChart"],
    selection: ["DataTable", "BarChart"],
  },
  {
    id: "table-default",
    prompt:
      "Put these working-hour records into a table: Ada, Design, 12.5 hours; Ben, Engineering, 8 hours; Cara, Design, 16 hours. Use only those records.",
    cards: ["DataTable"],
    selection: ["DataTable"],
  },
  {
    id: "markdown-source",
    prompt:
      "I'm writing a README. Give me only a fenced Markdown table snippet with columns Name and Hours, containing Ada with 12 hours and Ben with 8 hours. I need the source text to paste into the file.",
    noCards: true,
    markdownSource: true,
  },
  {
    id: "comparison",
    prompt:
      "Help me compare two options using only these supplied facts: train costs €40 and takes 90 minutes; car costs €55 including parking and takes 60 minutes. Show a comparison I can scan.",
    tools: ["show_ui"],
    cards: ["Comparison"],
    selection: ["Comparison"],
  },
  {
    id: "products-supplied",
    prompt:
      "These are illustrative headphone offers I'm supplying, not verified live prices: Everyday wireless, Example retailer A, €89, 30-hour battery, https://example.com/everyday; Studio wireless, Example retailer B, €149, 50-hour battery, https://example.com/studio. Show a shortlist where I can compare these two products. Use only this data and label it illustrative.",
    tools: ["compare_products"],
    cards: ["Products"],
    selection: ["Products"],
  },
  {
    id: "shopping",
    prompt:
      "Find two noise-cancelling headphones sold by Irish retailers for under €250. Compare their current prices and battery life with links. Research only; do not buy anything.",
    tools: ["search_products"],
    cards: ["Products"],
    research: true,
    selection: ["Products"],
  },
  {
    id: "clarify",
    prompt: "What is the weather like in Springfield today?",
    clarify: true,
  },
  {
    id: "explain-only",
    prompt:
      "What does a 60% chance of rain mean? Just explain the concept; I am not asking for a local forecast.",
    noCards: true,
    forbiddenTools: ["lookup_weather"],
  },
  {
    id: "thanks",
    prompt: "Thanks, that's all for now.",
    noCards: true,
    forbiddenTools: ["lookup_weather", "show_ui"],
  },
  {
    id: "beyond-horizon",
    prompt:
      "Can you give me a precise daily weather forecast for Dublin, Ireland exactly one year from today?",
    noCards: true,
    forbiddenTools: ["lookup_weather"],
  },
  {
    id: "timeline-plan",
    prompt:
      "Arrange this proposed Saturday plan chronologically: park at 14:00, museum at 10:00, lunch at 12:00. Use only those three events. Nothing is booked.",
    selection: ["Timeline"],
    suppliedOnly: true,
  },
  {
    id: "chart-ranking",
    prompt:
      "Help me see which room uses the most electricity. Plot only these readings as a bar chart: Kitchen 42 kWh, Office 18 kWh, Bedroom 27 kWh. Use only the supplied readings.",
    selection: ["BarChart"],
    suppliedOnly: true,
  },
  {
    id: "grouped-summary",
    prompt:
      "These are hours worked: Design 12, Engineering 8, Design 18, Engineering 16. Give me just a table of the average hours by department, using only these records.",
    tools: ["analyze_data"],
    selection: ["DataTable"],
    suppliedOnly: true,
  },
  {
    id: "grouped-chart",
    prompt:
      "These are expenses in EUR: Food 12.50, Travel 5.00, Food 7.50. Show only a chart of the total by category, using these records.",
    tools: ["analyze_data"],
    selection: ["BarChart"],
    suppliedOnly: true,
  },
  {
    id: "single-place",
    prompt:
      "Show me just this one public landmark on a map using my supplied OpenStreetMap data: National Gallery of Ireland, Merrion Square West, Dublin, Ireland, latitude 53.3409, longitude -6.2526. No research needed.",
    selection: ["Places"],
    suppliedOnly: true,
  },
  {
    id: "place-shortlist",
    prompt:
      "Put these three public landmarks on one map so I can explore their locations, using my supplied OpenStreetMap data: National Gallery of Ireland, Merrion Square West, Dublin, Ireland (53.3409, -6.2526); St Stephen's Green, Dublin, Ireland (53.3382, -6.2591); Dublin Castle, Dame Street, Dublin, Ireland (53.3429, -6.2674). I don't need a route or research.",
    selection: ["Places"],
    suppliedOnly: true,
  },
  {
    id: "ordered-route",
    prompt:
      "Show a driving route visiting these public landmarks in this exact order: National Gallery of Ireland, Merrion Square West, Dublin (53.3409, -6.2526), then St Stephen's Green, Dublin (53.3382, -6.2591), then Dublin Castle, Dame Street, Dublin (53.3429, -6.2674). The coordinates are supplied OpenStreetMap data. Don't add stops or make bookings.",
    tools: ["lookup_route"],
    selection: ["Route"],
  },
  {
    id: "three-way-decision",
    prompt:
      "Compare three proposed ways of getting there using only these facts. Train: EUR 40 and 90 minutes. Car: EUR 55 including parking and 60 minutes. Bus: EUR 20 and 120 minutes. I care only about cost and journey time. Show the trade-off so I can decide.",
    selection: ["Comparison"],
    suppliedOnly: true,
  },
  {
    id: "single-offer",
    prompt:
      "Show this one illustrative offer so I can inspect it: Everyday wireless headphones, Example retailer A, EUR 89, battery life 30 hours, https://example.com/everyday. This is supplied example data, not a live price. No research or alternative offers.",
    selection: ["Products"],
    suppliedOnly: true,
  },
  {
    id: "question-multiple",
    prompt:
      "Before researching headphones, ask me one question with selectable priorities: comfort, battery life and noise cancellation. I might choose more than one. Wait for my answer.",
    tools: ["ask_question"],
    selection: ["Question"],
    suppliedOnly: true,
  },
  {
    id: "question-single",
    prompt:
      "Before researching transport, ask me one question to choose a single preferred mode from train, car or bus. Wait for my answer.",
    tools: ["ask_question"],
    selection: ["Question"],
    suppliedOnly: true,
  },
  {
    id: "calculation-scenarios",
    prompt:
      "A supplied lunch bill is EUR 120. Show what each person would pay if split equally among four people versus six people. Use only that bill and those two scenarios.",
    selection: ["Calculation", "Calculation"],
    suppliedOnly: true,
  },
  {
    id: "signed-values",
    prompt:
      "Here are net changes in EUR: Kitchen -12, Office 8, Bedroom -3. Show only a sortable table of those three records, using no other data.",
    selection: ["DataTable"],
    suppliedOnly: true,
  },
  {
    id: "prose-only-plan",
    prompt:
      "In two plain-text sentences, explain what makes a useful project timeline. I'm asking for advice, not a schedule or a table.",
    noCards: true,
    suppliedOnly: true,
  },
]
