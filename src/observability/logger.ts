import { Logger } from "effect"

const errorLogger = Logger.withConsoleError(Logger.formatStructured)
export const OperationalLogger = Logger.layer([
  Logger.make((options) =>
    options.logLevel === "Error" || options.logLevel === "Fatal"
      ? errorLogger.log(options)
      : Logger.consoleStructured.log(options)
  ),
])
