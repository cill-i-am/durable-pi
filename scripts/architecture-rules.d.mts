import type { RuleTester } from "oxlint/plugins-dev"
export const domainBoundaries: Parameters<RuleTester["run"]>[1]
export const effectMachines: Parameters<RuleTester["run"]>[1]
declare const plugin: {
  meta: { name: string }
  rules: {
    boundaries: typeof domainBoundaries
    "effect-machines": typeof effectMachines
  }
}
export default plugin
