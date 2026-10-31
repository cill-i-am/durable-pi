import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type ColumnFiltersState,
  type VisibilityState,
} from "@tanstack/react-table"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { ArrowDown, ArrowUp, ChevronsUpDown, Download } from "lucide-react"
import { useId, useMemo, useState } from "react"

import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"
import { webUrl, type AnswerProps } from "@/rich-results/catalog"

import {
  TableControls,
  matchesFilter,
  type ValueFilter,
} from "./table-controls"
import { AnswerWorkspace } from "./workspace"

type Row = AnswerProps<"DataTable">["rows"][number]
type Column = AnswerProps<"DataTable">["columns"][number]
export function cellText(value: unknown, column: Column) {
  if (value == null) return "—"
  if (typeof value === "boolean") return value ? "Yes" : "No"
  if (typeof value === "number") {
    if (column.format === "currency" && column.currency)
      return new Intl.NumberFormat("en-IE", {
        style: "currency",
        currency: column.currency,
      }).format(value)
    if (column.format === "percent")
      return new Intl.NumberFormat("en-IE", {
        style: "percent",
        maximumFractionDigits: 2,
      }).format(value)
    return value.toLocaleString("en-IE", { maximumSignificantDigits: 14 })
  }
  if (
    column.format === "date" &&
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
    return new Date(value).toLocaleDateString("en-IE", { timeZone: "UTC" })
  return String(value)
}
export function csvValue(value: unknown) {
  let text = value == null ? "" : String(value)
  if (typeof value === "string" && /^[\s]*[=+\-@]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}
export function tableCsv(
  columns: AnswerProps<"DataTable">["columns"],
  rows: Row[]
) {
  return [
    columns.map((column) => csvValue(column.label)).join(","),
    ...rows.map((row) =>
      columns
        .map((column) =>
          csvValue(Object.hasOwn(row, column.key) ? row[column.key] : null)
        )
        .join(",")
    ),
  ].join("\r\n")
}
export function DataTableView({
  title,
  columns,
  rows,
}: Pick<AnswerProps<"DataTable">, "title" | "columns" | "rows">) {
  // TanStack Table owns mutable state that React Compiler cannot memoize.
  "use no memo"

  const [sorting, setSorting] = useState<SortingState>([])
  const [search, setSearch] = useState("")
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([])
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({})
  const filterId = useId()
  const columnDefs = useMemo<ColumnDef<Row>[]>(
    () =>
      columns.map((column) => ({
        id: column.key,
        accessorFn: (row) =>
          Object.hasOwn(row, column.key) ? row[column.key] : null,
        header: column.label,
        cell: ({ getValue }) => {
          const value = getValue()
          const text = cellText(value, column)
          if (column.format === "badge" && value != null)
            return <Badge variant="secondary">{text}</Badge>
          const url = column.format === "link" ? webUrl.safeParse(value) : null
          if (url?.success)
            return (
              <a
                href={url.data}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline underline-offset-4"
              >
                {text}
              </a>
            )
          return text
        },
        sortUndefined: "last",
        filterFn: (row, id, filter: ValueFilter) =>
          matchesFilter(row.getValue(id), filter),
      })),
    [columns]
  )
  // TanStack Table intentionally exposes mutable state; this component opts out of compilation.
  // oxlint-disable-next-line react/incompatible-library
  const table = useReactTable({
    data: rows,
    columns: columnDefs,
    state: { sorting, globalFilter: search, columnFilters, columnVisibility },
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onSortingChange: setSorting,
    onGlobalFilterChange: setSearch,
    globalFilterFn: (row, columnId, value: string) => {
      const column = columns.find((item) => item.key === columnId)!
      return `${String(row.getValue(columnId) ?? "")} ${cellText(row.getValue(columnId), column)}`
        .toLocaleLowerCase()
        .includes(value.toLocaleLowerCase())
    },
    getColumnCanGlobalFilter: () => true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 8 } },
  })
  const filtered = table.getFilteredRowModel().rows.length
  function download() {
    const blob = new Blob(
      [
        "\uFEFF",
        tableCsv(
          columns.filter((column) =>
            table.getColumn(column.key)!.getIsVisible()
          ),
          table.getSortedRowModel().rows.map((row) => row.original)
        ),
      ],
      { type: "text/csv;charset=utf-8" }
    )
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = "pi-table.csv"
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <AnswerWorkspace
      title={title}
      description="Filter, sort and explore your data. CSV exports include visible columns and all filtered rows in their current sort order."
    >
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <FieldGroup className="max-w-xs flex-1">
            <Field>
              <FieldLabel className="sr-only" htmlFor={filterId}>
                Filter {title}
              </FieldLabel>
              <Input
                id={filterId}
                aria-label={`Filter ${title}`}
                placeholder="Filter all columns…"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value)
                  table.setPageIndex(0)
                }}
              />
            </Field>
          </FieldGroup>
          <Button variant="outline" size="sm" onClick={download}>
            <Download data-icon="inline-start" />
            Export CSV
          </Button>
        </div>
        <TableControls table={table} columns={columns} rows={rows} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted-foreground">
            Shift-click column headings to sort by more than one column.
          </p>
          {(search ||
            columnFilters.length > 0 ||
            sorting.length > 0 ||
            Object.values(columnVisibility).some((value) => !value)) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSearch("")
                setColumnFilters([])
                setSorting([])
                setColumnVisibility({})
                table.setPageIndex(0)
              }}
            >
              Reset view
            </Button>
          )}
        </div>
        <Table>
          <TableCaption className="sr-only">
            {title}. Use column buttons to sort.
          </TableCaption>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    aria-sort={
                      header.column.getIsSorted() === "asc"
                        ? "ascending"
                        : header.column.getIsSorted() === "desc"
                          ? "descending"
                          : "none"
                    }
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={header.column.getToggleSortingHandler()}
                      aria-label={`Sort by ${header.column.columnDef.header}`}
                    >
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext()
                      )}
                      {header.column.getIsSorted() === "asc" ? (
                        <ArrowUp data-icon="inline-end" />
                      ) : header.column.getIsSorted() === "desc" ? (
                        <ArrowDown data-icon="inline-end" />
                      ) : (
                        <ChevronsUpDown data-icon="inline-end" />
                      )}
                    </Button>
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
            {!filtered && (
              <TableRow>
                <TableCell colSpan={table.getVisibleLeafColumns().length}>
                  No matching rows. Try a different filter.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {filtered} of {rows.length} rows · Page{" "}
            {table.getState().pagination.pageIndex + 1} of{" "}
            {Math.max(1, table.getPageCount())}
          </span>
          <div className="flex gap-1">
            <Select
              value={String(table.getState().pagination.pageSize)}
              onValueChange={(value) => {
                if (value) table.setPageSize(Number(value))
              }}
            >
              <SelectTrigger size="sm" aria-label="Rows per page">
                <SelectValue>{(value) => `${value} rows`}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {[8, 20, 50].map((size) => (
                    <SelectItem key={size} value={String(size)}>
                      {size} rows
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="sm"
              disabled={!table.getCanPreviousPage()}
              onClick={() => table.previousPage()}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!table.getCanNextPage()}
              onClick={() => table.nextPage()}
            >
              Next
            </Button>
          </div>
        </div>
      </div>
    </AnswerWorkspace>
  )
}
