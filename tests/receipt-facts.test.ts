import { expect, it } from "vitest"
import { receiptFact, scopedReceiptFact } from "../src/access/receipt"
import type { ToolOperation } from "../src/access/ledger"

const operation: ToolOperation = {
  id: "receipt",
  turnId: "root",
  revision: 4,
  tool: "read_note",
  input: "{}",
  status: "done",
  result: '{"content":[]}',
  decision: null,
  grantRevision: 0,
  createdAt: 0,
  expiresAt: 100,
}

it("checks task and revision ownership before decoding a historical receipt", () => {
  const corrupt = { ...operation, result: "broken" }
  expect(
    scopedReceiptFact(corrupt, {
      id: operation.id,
      revision: 4,
      roots: ["other"],
    })
  ).toBeUndefined()
  expect(
    scopedReceiptFact(corrupt, {
      id: operation.id,
      revision: 5,
      roots: ["root"],
    })
  ).toBeUndefined()
  expect(() =>
    scopedReceiptFact(corrupt, {
      id: operation.id,
      revision: 4,
      roots: ["root"],
    })
  ).toThrow()
})

it.each(["content", "output"])(
  "normalizes %s execution failures without exposing result bytes",
  (channel) => {
    for (const tool of ["run_code", "run_command"]) {
      const result = JSON.stringify({
        [channel]: [
          {
            type: "text",
            text: JSON.stringify({
              status: "succeeded",
              exitCode: 2,
              output: { error: "private failure" },
            }),
          },
        ],
      })
      expect(receiptFact({ ...operation, tool, result })?.outcome).toBe(
        "failed"
      )
    }
    const fact = receiptFact({
      ...operation,
      result: '{"isError":true,"content":[]}',
    })
    expect(fact?.outcome).toBe("failed")
    expect(fact).not.toHaveProperty("result")
    expect(receiptFact(operation)?.outcome).toBe("succeeded")
  }
)

it.each(["content", "output"])(
  "recognizes successful %s command receipts",
  (channel) => {
    expect(
      receiptFact({
        ...operation,
        tool: "run_command",
        result: JSON.stringify({
          [channel]: [
            {
              type: "text",
              text: JSON.stringify({ status: "succeeded", exitCode: 0 }),
            },
          ],
        }),
      })?.outcome
    ).toBe("succeeded")
  }
)
