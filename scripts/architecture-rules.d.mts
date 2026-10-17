import type { RuleTester } from "oxlint/plugins-dev"
export const domainBoundaries: Parameters<RuleTester["run"]>[1]
declare const plugin: {
  meta: { name: string }
  rules: { boundaries: typeof domainBoundaries }
}
export default plugin
