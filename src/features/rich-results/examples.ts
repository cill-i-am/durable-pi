import { answerResult, type AnswerProps } from "@/rich-results/catalog"
import { briefInput, createBrief } from "@/rich-results/presentation"

const demo = {
  source: {
    label: "Illustrative sample data",
    url: "https://json-render.dev/",
  },
  asOf: "Example · not live",
}
const exampleWeatherDays: AnswerProps<"Weather">["days"] = Array.from(
  { length: 7 },
  (_, index) => ({
    date: `2026-10-${19 + index}`,
    low: [9, 9, 7, 6, 5, 7, 7][index]!,
    high: [13, 14, 11, 12, 10, 12, 17][index]!,
    condition: [
      "Rain",
      "Rain showers",
      "Rain",
      "Drizzle",
      "Overcast",
      "Drizzle",
      "Partly cloudy",
    ][index]!,
    rainPercent: [94, 59, 57, 82, 75, 57, 55][index]!,
    rainMm: [5.8, 2.1, 2.9, 1.4, 0.2, 1.8, 0.8][index]!,
    windKph: [28, 20, 19, 22, 18, 31, 24][index]!,
    gustKph: [46, 35, 32, 38, 29, 49, 39][index]!,
    feelsLikeHigh: [10, 12, 9, 10, 8, 9, 15][index]!,
    uvIndex: 1.2,
    sunrise: `2026-10-${19 + index}T07:10:00Z`,
    sunset: `2026-10-${19 + index}T17:15:00Z`,
  })
)
const detailedWeatherDays = exampleWeatherDays
  .slice(-2)
  .map((day, dayIndex) => ({
    ...day,
    hours: Array.from({ length: 12 }, (_, index) => ({
      time: `${day.date}T${String(7 + index).padStart(2, "0")}:00:00Z`,
      temperature: Math.round(day.high - Math.abs(6 - index) * 0.7),
      condition: index < 4 ? "Drizzle" : "Partly cloudy",
      rainPercent: [60, 55, 50, 35, 25, 20, 20, 25, 30, 35, 45, 50][index]!,
      rainMm: index < 4 ? 0.2 : 0,
      windKph: dayIndex === 0 ? 24 : 18,
    })),
  }))
export const weatherExamples = [
  {
    id: "day",
    label: "1 day",
    question: "What is Sunday looking like?",
    prompt:
      "Look up the weather in Dublin, Ireland for 25 October 2026. Show a detailed single-day forecast with hourly rain and wind, and briefly explain what that means for a family walk.",
    days: detailedWeatherDays.slice(-1),
  },
  {
    id: "weekend",
    label: "2 days",
    question: "Which day looks better for a family walk?",
    prompt:
      "Compare this coming Saturday and Sunday in Dublin, Ireland for a family walk. Request a two-day weather comparison with hourly detail. Briefly explain the trade-offs without repeating the card in a Markdown table.",
    days: detailedWeatherDays,
  },
  {
    id: "week",
    label: "7 days",
    question: "How is the week shaping up?",
    prompt:
      "Look up a seven-day weather outlook for Dublin, Ireland and show a compact forecast card. Briefly point out any useful patterns.",
    days: exampleWeatherDays,
  },
].map(({ days, ...example }) => {
  const result = answerResult("Weather", {
    location: "Dublin, Ireland",
    timezone: "Europe/Dublin",
    days,
    ...demo,
  })
  return { ...example, result, output: JSON.stringify(result) }
})

const examples = [
  {
    id: "shopping",
    label: "Shopping",
    question: "Which headphones are right for me?",
    prompt:
      "Find three noise-cancelling headphones available in Ireland under €250. Research current prices, delivery and retailer links, then show a shoppable shortlist with comparable specs.",
    result: answerResult("Products", {
      title: "Find your everyday headphones",
      products: [
        {
          id: "everyday",
          name: "Everyday wireless",
          merchant: "Example retailer",
          price: 89,
          currency: "EUR",
          url: "https://example.com/everyday",
          detail: "An affordable option for the commute.",
          availability: "Illustrative product",
          specs: [
            { label: "Battery", value: "30 hours" },
            { label: "Weight", value: "240 g" },
            { label: "Noise cancelling", value: "Yes" },
          ],
        },
        {
          id: "studio",
          name: "Studio wireless",
          merchant: "Example retailer",
          price: 179,
          currency: "EUR",
          url: "https://example.com/studio",
          detail: "Longer battery life for days at your desk.",
          availability: "Illustrative product",
          specs: [
            { label: "Battery", value: "50 hours" },
            { label: "Weight", value: "260 g" },
            { label: "Noise cancelling", value: "Yes" },
          ],
        },
        {
          id: "travel",
          name: "Travel wireless",
          merchant: "Example retailer",
          price: 229,
          currency: "EUR",
          url: "https://example.com/travel",
          detail: "A lighter pair that folds for travel.",
          availability: "Illustrative product",
          specs: [
            { label: "Battery", value: "40 hours" },
            { label: "Weight", value: "210 g" },
            { label: "Noise cancelling", value: "Yes" },
          ],
        },
      ],
      ...demo,
    }),
  },
  {
    id: "weather",
    label: "Weather",
    question: "Will we need raincoats this weekend?",
    prompt:
      "Look up the weather in Dublin, Ireland. Show a forecast card and tell me which day this coming weekend looks best for a family walk.",
    result: weatherExamples[1]!.result,
  },
  {
    id: "places",
    label: "Maps",
    question: "Where is the National Gallery?",
    prompt:
      "Find the National Gallery of Ireland in Dublin and show its address with an embedded map and directions link.",
    result: answerResult("Places", {
      title: "National Gallery of Ireland",
      places: [
        {
          name: "National Gallery of Ireland",
          address: "Merrion Square West, Dublin 2, Ireland",
          latitude: 53.3409,
          longitude: -6.2526,
        },
        {
          name: "St Stephen’s Green",
          address: "Dublin 2, Ireland",
          latitude: 53.3382,
          longitude: -6.2591,
        },
      ],
      ...demo,
    }),
  },
  {
    id: "numbers",
    label: "Calculations",
    question: "What’s our share after the discount?",
    prompt:
      "Calculate a €186 bill with 15% off, split between four people. Show the expression and the amount per person.",
    result: answerResult("Calculation", {
      title: "A €186 bill, 15% off, split four ways",
      expression: "186 * (1 - 15%) / 4",
      result: 39.525,
      unit: "EUR per person",
      explanation:
        "The exact share is €39.525; round and reconcile cents when paying.",
    }),
  },
  {
    id: "table",
    label: "Data tables",
    question: "Help me make sense of these expenses.",
    prompt:
      "I’ll paste some expenses next. Turn them into a sortable, filterable table with numeric amounts and a CSV export, then chart the totals by category.",
    result: answerResult("DataTable", {
      title: "A week of household spending",
      columns: [
        { key: "item", label: "Item" },
        { key: "category", label: "Category" },
        {
          key: "amount",
          label: "Amount (EUR)",
          format: "currency",
          currency: "EUR",
        },
        { key: "paid", label: "Paid" },
      ],
      rows: [
        { item: "Groceries", category: "Food", amount: 86.4, paid: true },
        { item: "Train tickets", category: "Travel", amount: 24, paid: true },
        { item: "Swimming", category: "Family", amount: 18, paid: true },
        { item: "Electricity", category: "Home", amount: 112.8, paid: false },
        { item: "Lunch", category: "Food", amount: 16.5, paid: true },
        { item: "Books", category: "Family", amount: 29.9, paid: true },
        { item: "Bus", category: "Travel", amount: 4.6, paid: true },
        { item: "Vegetables", category: "Food", amount: 12.2, paid: true },
        { item: "Cinema", category: "Family", amount: 32, paid: false },
        { item: "Coffee", category: "Food", amount: 7.8, paid: true },
      ],
      ...demo,
    }),
  },
  {
    id: "compare",
    label: "Decisions",
    question: "Train or car for a family day out?",
    prompt:
      "Help me compare train and car for a family day trip. Ask for the route, date and group size, then research current costs and show a decision matrix with your trade-offs.",
    result: answerResult("Comparison", {
      title: "Train or car?",
      options: ["Train", "Car"],
      criteria: [
        {
          label: "Cost",
          values: ["Check group fares", "Fuel + parking + tolls"],
        },
        {
          label: "Flexibility",
          values: ["Fixed timetable", "Leave when you like"],
        },
        { label: "On the way", values: ["Time together", "One person drives"] },
        {
          label: "Arrival",
          values: ["Check station distance", "Check parking availability"],
        },
      ],
      verdict:
        "The train can make the journey part of the day. The car gives more flexibility. Price the actual route before deciding.",
      ...demo,
    }),
  },
  {
    id: "chart",
    label: "Charts",
    question: "Where is our budget going?",
    prompt:
      "Using the expenses I provide, show a bar chart of spending by category and a table of the underlying numbers. Keep the source amounts exact.",
    result: answerResult("BarChart", {
      title: "Household spending by category",
      unit: "EUR",
      values: [
        { label: "Home", value: 112.8 },
        { label: "Food", value: 122.9 },
        { label: "Family", value: 79.9 },
        { label: "Travel", value: 28.6 },
      ],
      ...demo,
    }),
  },
  {
    id: "timeline",
    label: "Plans",
    question: "Plan a slower day in Dublin.",
    prompt:
      "Plan a relaxed family day in Dublin with a gallery, lunch and a park. Check opening hours, show a proposed itinerary and map the stops. Don’t make bookings.",
    result: answerResult("Timeline", {
      title: "A slower Saturday · proposed plan",
      events: [
        {
          when: "10:00",
          title: "Start at the gallery",
          detail:
            "Leave time to wander. Check opening hours before setting out.",
        },
        {
          when: "12:00",
          title: "Lunch nearby",
          detail: "Choose somewhere within an easy walk; no booking made.",
        },
        {
          when: "14:00",
          title: "An afternoon in the park",
          detail: "Keep the afternoon open and check the forecast.",
        },
      ],
      ...demo,
    }),
  },
]
const cardFor = (id: string) => {
  const result = examples.find((example) => example.id === id)!.result
  const element = result.spec.elements[result.spec.root]!
  return { type: element.type, props: element.props }
}
const composedExamples = [
  {
    id: "route",
    label: "Routes",
    question: "How do we drive between the stops?",
    prompt:
      "Find a driving route from the National Gallery of Ireland to St Stephen’s Green in Dublin. Resolve the stop coordinates, show the route and distance, and distinguish estimated driving time from live traffic.",
    result: answerResult("Route", {
      title: "Gallery to St Stephen’s Green",
      stops: [
        {
          name: "National Gallery of Ireland",
          address: "Merrion Square West, Dublin",
          latitude: 53.3409,
          longitude: -6.2526,
        },
        {
          name: "St Stephen’s Green",
          address: "Dublin 2, Ireland",
          latitude: 53.3382,
          longitude: -6.2591,
        },
      ],
      coordinates: [
        [-6.252363, 53.341153],
        [-6.252531, 53.341208],
        [-6.252127, 53.341627],
        [-6.246355, 53.339594],
        [-6.251325, 53.334583],
        [-6.253429, 53.335378],
        [-6.253893, 53.33491],
        [-6.255255, 53.334401],
        [-6.25674, 53.33583],
        [-6.257259, 53.336145],
        [-6.257074, 53.336403],
        [-6.257099, 53.336516],
        [-6.255831, 53.33804],
        [-6.255626, 53.338491],
        [-6.255847, 53.338647],
        [-6.256768, 53.338882],
        [-6.256911, 53.338993],
        [-6.258196, 53.33934],
      ],
      distanceMeters: 2218.6,
      durationSeconds: 319.2,
      profile: "driving",
      source: {
        label: "OSRM · saved route example",
        url: "https://project-osrm.org/",
      },
      asOf: "2026-10-17T19:42:35.566Z",
    }),
  },
  {
    id: "brief",
    label: "Day brief",
    question: "Can we fit a gallery and a park around the rain?",
    prompt:
      "Make a day brief for a relaxed family day in Dublin: check the current forecast, suggest a gallery and park, map the stops, and show a proposed itinerary. Check opening hours and don’t make bookings.",
    result: createBrief(
      briefInput.parse({
        title: "A slower Saturday",
        summary:
          "Start indoors, leave the afternoon flexible, and keep the useful details together. This is an illustrative plan.",
        date: "Day brief · sample data",
        cards: [
          cardFor("timeline"),
          cardFor("weather"),
          cardFor("numbers"),
          cardFor("places"),
        ],
      })
    ),
  },
  {
    id: "question",
    label: "Questions",
    question: "What matters most when choosing?",
    prompt:
      "Help me choose headphones. First ask a short multiple-choice question about my budget, comfort, battery life and noise cancelling, then wait for my reply before researching current offers.",
    result: answerResult("Question", {
      question: "What matters most for your headphones?",
      description:
        "Choose the things you care about, or describe them in your own words.",
      multiple: true,
      options: [
        { label: "Comfort", description: "Easy to wear for a full day" },
        { label: "Battery life", description: "Fewer charging stops" },
        { label: "Noise cancelling", description: "A quieter commute" },
        { label: "Price", description: "Stay comfortably within budget" },
      ],
    }),
  },
]
export const answerExamples = [...examples, ...composedExamples].map(
  (example) => ({
    ...example,
    output: JSON.stringify(example.result),
  })
)
