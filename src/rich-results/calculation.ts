// Small arithmetic grammar: no JavaScript evaluation, variables or function calls.
export function calculate(expression: string): number {
  if (!expression.trim() || expression.length > 300)
    throw new Error("Use an arithmetic expression of 1–300 characters")
  const tokens =
    expression.match(
      /(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?|[()+*/^%−×÷+-]|\S/gi
    ) ?? []
  let position = 0
  const take = () => tokens[position++]
  const peek = () => tokens[position]
  const atom = (): number => {
    const token = take()
    if (token === "(") {
      const value = sum()
      if (take() !== ")") throw new Error("Close each parenthesis")
      return value
    }
    if (!token || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(token))
      throw new Error("Use numbers, parentheses and + − × ÷ ^ % only")
    return Number(token)
  }
  const power = (): number => {
    let value = atom()
    while (peek() === "%") {
      take()
      value /= 100
    }
    if (peek() === "^") {
      take()
      value **= unary()
    }
    return value
  }
  const unary = (): number => {
    if (peek() === "+") {
      take()
      return unary()
    }
    if (peek() === "-" || peek() === "−") {
      take()
      return -unary()
    }
    return power()
  }
  const product = (): number => {
    let value = unary()
    while (["*", "/", "×", "÷"].includes(peek() ?? "")) {
      const operator = take()
      const right = unary()
      value =
        operator === "*" || operator === "×" ? value * right : value / right
    }
    return value
  }
  const sum = (): number => {
    let value = product()
    while (["+", "-", "−"].includes(peek() ?? "")) {
      const operator = take()
      const right = product()
      value = operator === "+" ? value + right : value - right
    }
    return value
  }
  const value = sum()
  if (position !== tokens.length || !Number.isFinite(value))
    throw new Error("The expression must produce a finite number")
  return Number(value.toPrecision(14))
}

const units = {
  mm: ["length", 0.001],
  cm: ["length", 0.01],
  m: ["length", 1],
  km: ["length", 1000],
  in: ["length", 0.0254],
  ft: ["length", 0.3048],
  mi: ["length", 1609.344],
  g: ["mass", 0.001],
  kg: ["mass", 1],
  oz: ["mass", 0.028349523125],
  lb: ["mass", 0.45359237],
  ml: ["volume", 0.001],
  l: ["volume", 1],
} as const
export const unitNames = [...Object.keys(units), "C", "F"]
export function convertUnits(value: number, from: string, to: string): number {
  if (!Number.isFinite(value)) throw new Error("Use a finite number")
  if (["C", "F"].includes(from) && ["C", "F"].includes(to)) {
    if ((from === "C" && value < -273.15) || (from === "F" && value < -459.67))
      throw new Error("Temperature is below absolute zero")
    return Number(
      (from === to
        ? value
        : from === "C"
          ? (value * 9) / 5 + 32
          : ((value - 32) * 5) / 9
      ).toPrecision(14)
    )
  }
  const definitions: Readonly<
    Record<string, readonly [string, number] | undefined>
  > = units
  const left = definitions[from],
    right = definitions[to]
  if (!left || !right || left[0] !== right[0])
    throw new Error(
      "Choose compatible units of length, mass, volume or temperature"
    )
  const result = (value * left[1]) / right[1]
  if (!Number.isFinite(result))
    throw new Error("The conversion exceeds the supported range")
  return Number(result.toPrecision(14))
}
