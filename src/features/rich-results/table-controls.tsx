import type { Table } from "@tanstack/react-table"
import { Columns3, ListFilter, Plus, X } from "lucide-react"
import { useId, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"
import type { AnswerProps } from "@/rich-results/catalog"

type Row = AnswerProps<"DataTable">["rows"][number]
type Column = AnswerProps<"DataTable">["columns"][number]
export type ValueFilter = {
  operator: "contains" | "is" | "not" | "gt" | "gte" | "lt" | "lte" | "in"
  values: string[]
}
export function matchesFilter(value: unknown, filter: ValueFilter) {
  const text = value == null ? "" : String(value)
  const expected = filter.values[0] ?? ""
  switch (filter.operator) {
    case "in":
      return filter.values.includes(text)
    case "contains":
      return text.toLocaleLowerCase().includes(expected.toLocaleLowerCase())
    case "is":
      return typeof value === "number"
        ? expected.trim() !== "" &&
            Number.isFinite(Number(expected)) &&
            value === Number(expected)
        : text.toLocaleLowerCase() === expected.toLocaleLowerCase()
    case "not":
      return text.toLocaleLowerCase() !== expected.toLocaleLowerCase()
    default: {
      if (
        value == null ||
        typeof value !== "number" ||
        !Number.isFinite(Number(expected))
      )
        return false
      const number = Number(expected)
      return filter.operator === "gt"
        ? value > number
        : filter.operator === "gte"
          ? value >= number
          : filter.operator === "lt"
            ? value < number
            : value <= number
    }
  }
}

export function TableControls({
  table,
  columns,
  rows,
}: {
  table: Table<Row>
  columns: Column[]
  rows: Row[]
}) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState(columns[0]!.key)
  const [operator, setOperator] = useState<ValueFilter["operator"]>("contains")
  const [inputValue, setValue] = useState("")
  const id = useId()
  const activeColumn = columns.find((column) => column.key === key)!
  const numeric =
    ["number", "currency", "percent"].includes(activeColumn.format ?? "") ||
    rows.some((row) => typeof row[key] === "number")
  const operators = numeric
    ? [
        { value: "is", label: "Equals" },
        { value: "gt", label: "Greater than" },
        { value: "gte", label: "At least" },
        { value: "lt", label: "Less than" },
        { value: "lte", label: "At most" },
      ]
    : [
        { value: "contains", label: "Contains" },
        { value: "is", label: "Is" },
        { value: "not", label: "Is not" },
      ]
  const facets = columns
    .flatMap((column) => {
      if (
        ["number", "currency", "percent", "date", "link"].includes(
          column.format ?? ""
        )
      )
        return []
      const values = [
        ...new Set(
          rows.map((row) =>
            row[column.key] == null ? "" : String(row[column.key])
          )
        ),
      ].sort()
      return values.length >= 2 &&
        values.length <= 8 &&
        !rows.some((row) => typeof row[column.key] === "number")
        ? [{ column, values }]
        : []
    })
    .slice(0, 2)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {facets.map(({ column, values }) => {
          const target = table.getColumn(column.key)!
          const filter = target.getFilterValue() as ValueFilter | undefined
          return (
            <DropdownMenu key={column.key}>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant={filter ? "secondary" : "outline"}
                    size="sm"
                  />
                }
              >
                <ListFilter data-icon="inline-start" />
                {column.label}
                {filter?.operator === "in" ? ` (${filter.values.length})` : ""}
              </DropdownMenuTrigger>
              <DropdownMenuContent mobileTitle={`Filter ${column.label}`}>
                <DropdownMenuGroup>
                  <DropdownMenuLabel>{column.label}</DropdownMenuLabel>
                  {values.map((item) => (
                    <DropdownMenuCheckboxItem
                      key={item}
                      checked={
                        filter?.operator === "in" &&
                        filter.values.includes(item)
                      }
                      closeOnClick={false}
                      onCheckedChange={(checked) => {
                        const current =
                          filter?.operator === "in" ? filter.values : []
                        const next = checked
                          ? [...current, item]
                          : current.filter((value) => value !== item)
                        target.setFilterValue(
                          next.length
                            ? { operator: "in", values: next }
                            : undefined
                        )
                        table.setPageIndex(0)
                      }}
                    >
                      {item === ""
                        ? "Not supplied"
                        : item === "true"
                          ? "Yes"
                          : item === "false"
                            ? "No"
                            : item}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )
        })}
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button variant="outline" size="sm" />}>
            <Plus data-icon="inline-start" />
            Add filter
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add a table filter</DialogTitle>
              <DialogDescription>
                Filters combine across columns. Numeric values use the original
                units; percentages use fractions.
              </DialogDescription>
            </DialogHeader>
            <form
              className="flex flex-col gap-4"
              onSubmit={(event) => {
                event.preventDefault()
                if (
                  !inputValue.trim() ||
                  (numeric && !Number.isFinite(Number(inputValue)))
                )
                  return
                table.getColumn(key)!.setFilterValue({
                  operator: operators.some((item) => item.value === operator)
                    ? operator
                    : operators[0]!.value,
                  values: [inputValue],
                })
                table.setPageIndex(0)
                setOpen(false)
                setValue("")
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor={`${id}-column`}>Column</FieldLabel>
                  <Select
                    items={columns.map((column) => ({
                      value: column.key,
                      label: column.label,
                    }))}
                    value={key}
                    onValueChange={(value) => {
                      if (value) {
                        setKey(value)
                        setOperator("is")
                      }
                    }}
                  >
                    <SelectTrigger id={`${id}-column`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {columns.map((column) => (
                          <SelectItem key={column.key} value={column.key}>
                            {column.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-operator`}>Condition</FieldLabel>
                  <Select
                    items={operators}
                    value={
                      operators.some((item) => item.value === operator)
                        ? operator
                        : operators[0]!.value
                    }
                    onValueChange={(value) => {
                      if (value) setOperator(value as ValueFilter["operator"])
                    }}
                  >
                    <SelectTrigger id={`${id}-operator`}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {operators.map((item) => (
                          <SelectItem key={item.value} value={item.value}>
                            {item.label}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${id}-value`}>Value</FieldLabel>
                  <Input
                    id={`${id}-value`}
                    type={numeric ? "number" : "text"}
                    step="any"
                    value={inputValue}
                    onChange={(event) => setValue(event.target.value)}
                    required
                    maxLength={1000}
                  />
                </Field>
              </FieldGroup>
              <Button type="submit" disabled={!inputValue.trim()}>
                Apply filter
              </Button>
            </form>
          </DialogContent>
        </Dialog>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
            <Columns3 data-icon="inline-start" />
            Columns
          </DropdownMenuTrigger>
          <DropdownMenuContent mobileTitle="Visible columns">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Visible columns</DropdownMenuLabel>
              {table.getAllLeafColumns().map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  checked={column.getIsVisible()}
                  closeOnClick={false}
                  disabled={
                    column.getIsVisible() &&
                    table.getVisibleLeafColumns().length === 1
                  }
                  onCheckedChange={(checked) =>
                    column.toggleVisibility(checked)
                  }
                >
                  {String(column.columnDef.header)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {!!table.getState().columnFilters.length && (
        <div className="flex flex-wrap gap-2" aria-label="Active table filters">
          {table.getState().columnFilters.map((filter) => {
            const value = filter.value as ValueFilter
            const label = columns.find(
              (column) => column.key === filter.id
            )!.label
            return (
              <Button
                key={filter.id}
                variant="secondary"
                size="sm"
                className="h-auto max-w-full py-1 whitespace-normal"
                aria-label={`Remove ${label} filter`}
                onClick={() =>
                  table.getColumn(filter.id)!.setFilterValue(undefined)
                }
              >
                {label}{" "}
                {
                  {
                    in: "is",
                    contains: "contains",
                    is: "is",
                    not: "is not",
                    gt: ">",
                    gte: "≥",
                    lt: "<",
                    lte: "≤",
                  }[value.operator]
                }{" "}
                {value.values
                  .map((item) =>
                    item === "true"
                      ? "Yes"
                      : item === "false"
                        ? "No"
                        : item || "Not supplied"
                  )
                  .join(", ")}
                <X data-icon="inline-end" />
              </Button>
            )
          })}
        </div>
      )}
    </div>
  )
}
