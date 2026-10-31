import {
  DataLoading,
  DataLoadingProvider,
} from "@workspace/ui/components/data-loading"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it } from "vitest"

import { ObjectStore } from "../src/features/objects/store"

it("labels the loading region and keeps sample controls inert without mounting live content", () => {
  function LiveContent(): never {
    throw new Error("Live content must not mount before its data arrives")
  }
  const html = renderToStaticMarkup(
    <DataLoadingProvider>
      <DataLoading
        loading
        label="Loading saved items"
        sample={<button>Sample item</button>}
      >
        <LiveContent />
      </DataLoading>
    </DataLoadingProvider>
  )
  expect(html).toContain('aria-busy="true"')
  expect(html).toContain("Loading saved items")
  expect(html).toContain('aria-hidden="true" inert=""')
})

it("renders settled empty and error content without a loading state", () => {
  for (const content of [
    <p>No items yet</p>,
    <p role="alert">Could not load items</p>,
  ]) {
    const html = renderToStaticMarkup(
      <DataLoading loading={false} label="Loading saved items">
        {content}
      </DataLoading>
    )
    expect(html).not.toContain('aria-busy="true"')
    expect(html).not.toContain("Latest saved item")
    expect(html).toContain(renderToStaticMarkup(content))
  }
})

it("distinguishes a checklist list that has not loaded from a successful empty result and a failed refresh", async () => {
  let fail = true
  const store = new ObjectStore(async <T,>() => {
    if (fail) throw new Error("Offline")
    return { objects: [] } as T
  }, "loading-test")
  expect(store.getSnapshot().loaded).toBe(false)
  await store.refresh()
  expect(store.getSnapshot()).toMatchObject({ loaded: false, error: "Offline" })
  fail = false
  await store.refresh()
  expect(store.getSnapshot()).toMatchObject({
    loaded: true,
    list: [],
    error: "",
  })
  fail = true
  await store.refresh()
  expect(store.getSnapshot()).toMatchObject({
    loaded: true,
    list: [],
    error: "Offline",
  })
  await store.dispose()
})
