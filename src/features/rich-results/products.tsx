import { Badge } from "@workspace/ui/components/badge"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFrame,
  CardHeader,
  CardFrameFooter,
  CardTitle,
} from "@workspace/ui/components/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@workspace/ui/components/empty"
import { Field, FieldGroup, FieldLabel } from "@workspace/ui/components/field"
import { Input } from "@workspace/ui/components/input"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@workspace/ui/components/toggle-group"
import { Bookmark, ExternalLink } from "lucide-react"
import { useContext, useMemo, useState, type ReactNode } from "react"

import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select"
import type { AnswerProps } from "@/rich-results/catalog"

import { ComparisonTable, ResultCard } from "./cards"
import { AnswerDraftContext } from "./question"
import { AnswerWorkspace } from "./workspace"

export function money(value: number | null, currency: string) {
  return value === null
    ? "Price not verified"
    : new Intl.NumberFormat("en-IE", { style: "currency", currency }).format(
        value
      )
}
export function ProductsCard(props: AnswerProps<"Products">) {
  const onPrompt = useContext(AnswerDraftContext)
  const [selected, setSelected] = useState<string[]>([])
  const [query, setQuery] = useState("")
  const [budget, setBudget] = useState("")
  const [sort, setSort] = useState(["recommended"])
  const [view, setView] = useState(["browse"])
  const [shortlistOnly, setShortlistOnly] = useState(false)
  const [merchant, setMerchant] = useState("")
  const visible = useMemo(
    () =>
      props.products
        .filter((product) => {
          const match = `${product.name} ${product.merchant} ${product.detail}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())
          return (
            match &&
            (!merchant || product.merchant === merchant) &&
            (!shortlistOnly || selected.includes(product.id)) &&
            (budget === "" ||
              (product.price !== null && product.price <= Number(budget)))
          )
        })
        .sort((a, b) =>
          sort[0] === "price"
            ? (a.price ?? Infinity) - (b.price ?? Infinity)
            : 0
        ),
    [props.products, query, budget, sort, shortlistOnly, selected, merchant]
  )
  const choices = props.products.filter((product) =>
    selected.includes(product.id)
  )
  const labels = [
    ...new Set(
      choices.flatMap((product) => product.specs.map((spec) => spec.label))
    ),
  ]
  const criteria = [
    {
      label: "Price",
      values: choices.map((product) => money(product.price, product.currency)),
    },
    { label: "Merchant", values: choices.map((product) => product.merchant) },
    {
      label: "Availability",
      values: choices.map((product) => product.availability),
    },
    ...labels.map((label) => ({
      label,
      values: choices.map(
        (product) =>
          product.specs.find((spec) => spec.label === label)?.value ??
          "Not supplied"
      ),
    })),
  ]
  if (props.products.length === 1)
    return (
      <ResultCard title={props.title} provenance={props}>
        <div className="flex flex-col gap-3">
          <ProductOffer product={props.products[0]!} />
          <p className="text-xs text-muted-foreground">
            Confirm price, delivery and availability with the retailer.
          </p>
        </div>
      </ResultCard>
    )
  return (
    <ResultCard
      title={props.title}
      description="Shortlist up to four products to compare."
      provenance={props}
    >
      <AnswerWorkspace
        title={props.title}
        description="Explore sourced offers, then compare the details that matter to you."
        toolbar={
          <>
            <ToggleGroup
              value={view}
              onValueChange={(value) => value.length && setView(value)}
              aria-label="Product view"
            >
              <ToggleGroupItem value="browse">Browse</ToggleGroupItem>
              <ToggleGroupItem value="compare">
                Compare ({selected.length})
              </ToggleGroupItem>
            </ToggleGroup>
            <Button
              className="ms-auto"
              size="sm"
              variant={shortlistOnly ? "secondary" : "ghost"}
              aria-pressed={shortlistOnly}
              onClick={() => {
                setShortlistOnly((current) => !current)
                setView(["browse"])
              }}
            >
              <Bookmark data-icon="inline-start" />
              Shortlist ({selected.length})
            </Button>
          </>
        }
        sidebar={
          <>
            {props.context?.question &&
              props.context.question !== props.title && (
                <p className="text-sm font-medium">{props.context.question}</p>
              )}
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">What to compare</p>
              <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
                {(
                  props.context?.priorities ?? [
                    "Price",
                    "Availability",
                    ...new Set(
                      props.products.flatMap((product) =>
                        product.specs.map((spec) => spec.label)
                      )
                    ),
                  ]
                ).map((label) => (
                  <li key={label}>{label}</li>
                ))}
              </ul>
            </div>
            <p className="text-xs text-muted-foreground">
              {props.source.label} · {props.asOf}
            </p>
          </>
        }
      >
        <div className="@container flex flex-col gap-4">
          {view[0] === "compare" ? (
            choices.length >= 2 ? (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  {choices.map((product) => (
                    <Button
                      key={product.id}
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setSelected((current) =>
                          current.filter((id) => id !== product.id)
                        )
                      }
                      aria-label={`Remove ${product.name} from comparison`}
                    >
                      {product.name} ×
                    </Button>
                  ))}
                </div>
                <ComparisonTable
                  title={props.title}
                  options={choices.map((product) => product.name)}
                  criteria={criteria}
                />
                {onPrompt && (
                  <Button
                    className="self-start"
                    variant="outline"
                    onClick={() =>
                      onPrompt(
                        `Help me decide between these shortlisted products: ${choices.map((product) => `${product.name} (${product.url})`).join(", ")}.${props.context?.priorities.length ? ` My priorities: ${props.context.priorities.join(", ")}.` : ""} Verify the current offers and explain the trade-offs.`
                      )
                    }
                  >
                    Ask Pi about this shortlist
                  </Button>
                )}
              </div>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>Choose at least two products</EmptyTitle>
                  <EmptyDescription>
                    Shortlist products in Browse to compare prices and
                    specifications.
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )
          ) : (
            <>
              <FieldGroup className="grid gap-3 @xl:grid-cols-[minmax(0,1fr)_9rem_minmax(9rem,0.65fr)]">
                <Field>
                  <FieldLabel>Search products</FieldLabel>
                  <Input
                    aria-label="Search products"
                    value={query}
                    placeholder="Name, merchant or feature…"
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>
                    Max price ({props.products[0]!.currency})
                  </FieldLabel>
                  <Input
                    aria-label="Maximum product price"
                    type="number"
                    min="0"
                    value={budget}
                    placeholder="Any budget"
                    onChange={(event) => setBudget(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel>Retailer</FieldLabel>
                  <Select
                    value={merchant}
                    onValueChange={(value) => setMerchant(value ?? "")}
                  >
                    <SelectTrigger aria-label="Filter retailer">
                      <SelectValue>{merchant || "All retailers"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        <SelectItem value="">All retailers</SelectItem>
                        {[
                          ...new Set(
                            props.products.map((product) => product.merchant)
                          ),
                        ].map((name) => (
                          <SelectItem key={name} value={name}>
                            {name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
              </FieldGroup>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span
                  className="text-xs text-muted-foreground"
                  aria-live="polite"
                >
                  {visible.length} of {props.products.length} products
                </span>
                <ToggleGroup
                  value={sort}
                  onValueChange={(value) => value.length && setSort(value)}
                  aria-label="Sort products"
                >
                  <ToggleGroupItem value="recommended">
                    Original order
                  </ToggleGroupItem>
                  <ToggleGroupItem value="price">
                    Price: low to high
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
              <div className="grid gap-3 @lg:grid-cols-2 @4xl:grid-cols-3">
                {visible.map((product) => (
                  <ProductOffer
                    key={product.id}
                    product={product}
                    shortlist={
                      <Button
                        variant={
                          selected.includes(product.id) ? "secondary" : "ghost"
                        }
                        size="sm"
                        aria-pressed={selected.includes(product.id)}
                        aria-label={`${selected.includes(product.id) ? "Remove" : "Shortlist"} ${product.name}`}
                        disabled={
                          !selected.includes(product.id) && selected.length >= 4
                        }
                        onClick={() =>
                          setSelected((current) =>
                            current.includes(product.id)
                              ? current.filter((id) => id !== product.id)
                              : [...current, product.id]
                          )
                        }
                      >
                        <Bookmark data-icon="inline-start" />
                        {selected.includes(product.id) ? "Saved" : "Shortlist"}
                      </Button>
                    }
                  />
                ))}
              </div>
              {!visible.length && (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No products match</EmptyTitle>
                    <EmptyDescription>
                      Try a higher budget, a different search, or turn off
                      Shortlist.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {selected.length >= 4 &&
              "Four products selected. Remove one to add another. "}
            Shortlists stay in this view. Confirm price, delivery and
            availability with the retailer.
          </p>
        </div>
      </AnswerWorkspace>
    </ResultCard>
  )
}

function ProductOffer({
  product,
  shortlist,
}: {
  product: AnswerProps<"Products">["products"][number]
  shortlist?: ReactNode
}) {
  return (
    <CardFrame className="min-w-0">
      <Card className="flex-1">
        {product.imageUrl && (
          <img
            src={product.imageUrl}
            alt={product.name}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="aspect-[4/3] w-full object-contain"
          />
        )}
        <CardHeader>
          <CardTitle>{product.name}</CardTitle>
          <CardDescription>{product.merchant}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xl font-medium tabular-nums">
            {money(product.price, product.currency)}
          </p>
          <p className="text-sm text-muted-foreground">{product.detail}</p>
          <Badge variant="outline" className="w-fit">
            {product.availability}
          </Badge>
          <dl className="flex flex-col gap-2">
            {product.specs.map((spec, index) => (
              <div
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-2 text-xs"
                key={index}
              >
                <dt className="text-muted-foreground">{spec.label}</dt>
                <dd className="text-right">{spec.value}</dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <CardFrameFooter className="justify-between px-4">
        {shortlist}
        <a
          href={product.url}
          target="_blank"
          rel="noopener noreferrer"
          className={buttonVariants({
            variant: "outline",
            size: "sm",
          })}
        >
          View retailer
          <ExternalLink data-icon="inline-end" />
        </a>
      </CardFrameFooter>
    </CardFrame>
  )
}
