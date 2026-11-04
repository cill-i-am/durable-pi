import { Schema } from "effect"

import { isResultTab, type ResultTabId } from "./result-reference"

export const WorkbenchTab = Schema.Union([
  Schema.Literals([
    "browser",
    "terminal",
    "files",
    "apps",
    "activity",
    "objects",
    "memory",
    "code",
    "routines",
    "examples",
  ]),
  Schema.declare((value): value is ResultTabId => isResultTab(value)),
])
export type WorkbenchTab = typeof WorkbenchTab.Type
