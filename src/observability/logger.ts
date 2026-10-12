import { Logger } from "effect"

// Effect's consoleJson uses console.log even for errors. Preserve native error
// severity so Cloudflare Issues can detect handled operational failures.
const errorLogger = Logger.withConsoleError(Logger.formatStructured)
export const OperationalLogger = Logger.layer([
  Logger.make((options) =>
    options.logLevel === "Error" || options.logLevel === "Fatal"
      ? errorLogger.log(options)
      : Logger.consoleStructured.log(options)
  ),
])
