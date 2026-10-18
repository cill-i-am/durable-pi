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
  noMarkdownTable?: boolean
  research?: boolean
  forbiddenTools?: string[]
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
  },
  {
    id: "weather-weekend",
    prompt:
      "Which day this coming weekend looks better for a family walk in Dublin, Ireland?",
    tools: ["lookup_weather"],
    cards: ["Weather"],
    weather: { period: "weekend", days: 2 },
    noMarkdownTable: true,
  },
  {
    id: "weather-today",
    prompt:
      "What's the weather looking like in Dublin, Ireland today? I'd like to see how the rain and wind change through the day.",
    tools: ["lookup_weather"],
    cards: ["Weather"],
    weather: { period: "today", days: 1 },
    noMarkdownTable: true,
  },
  {
    id: "weather-tomorrow",
    prompt: "Will I need a raincoat in Dublin, Ireland tomorrow?",
    tools: ["lookup_weather"],
    cards: ["Weather"],
    weather: { period: "tomorrow", days: 1 },
    noMarkdownTable: true,
  },
  {
    id: "weather-week",
    prompt:
      "How is the weather shaping up over the next seven days in Dublin, Ireland?",
    tools: ["lookup_weather"],
    cards: ["Weather"],
    weather: { days: 7 },
    noMarkdownTable: true,
  },
  {
    id: "split-bill",
    prompt:
      "A restaurant bill is €186. We have a 15% discount and four people splitting it equally. What does each person owe?",
    tools: ["calculate"],
    cards: ["Calculation"],
    result: 39.525,
  },
  {
    id: "units",
    prompt: "Convert 350 degrees Fahrenheit to Celsius for my oven.",
    tools: ["convert_units"],
    cards: ["Calculation"],
    result: 176.66666666666666,
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
  },
  {
    id: "comparison",
    prompt:
      "Help me compare two options using only these supplied facts: train costs €40 and takes 90 minutes; car costs €55 including parking and takes 60 minutes. Show a comparison I can scan.",
    tools: ["show_ui"],
    cards: ["Comparison"],
  },
  {
    id: "products-supplied",
    prompt:
      "These are illustrative headphone offers I'm supplying, not verified live prices: Everyday wireless, Example retailer A, €89, 30-hour battery, https://example.com/everyday; Studio wireless, Example retailer B, €149, 50-hour battery, https://example.com/studio. Show a shortlist where I can compare these two products. Use only this data and label it illustrative.",
    tools: ["compare_products"],
    cards: ["Products"],
  },
  {
    id: "shopping",
    prompt:
      "Find two noise-cancelling headphones sold by Irish retailers for under €250. Compare their current prices and battery life with links. Research only; do not buy anything.",
    tools: ["search_products"],
    cards: ["Products"],
    research: true,
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
]
