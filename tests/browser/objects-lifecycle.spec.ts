import { expect, test, type Page } from "@playwright/test"

import {
  type ObjectDetail,
  type ObjectMutation,
  objectSummary,
} from "../../src/objects/contracts"

const id = "11111111-1111-4111-8111-111111111111"
const source = {
  actor: "user" as const,
  surface: "workbench" as const,
  turnId: null,
  toolCallId: null,
}
const detail = (
  revision: number,
  title: string,
  objectId = id
): ObjectDetail => ({
  object: {
    id: objectId,
    type: "project_checklist",
    schemaVersion: 1,
    revision,
    title,
    notes: "",
    tasks: [],
    archived: false,
    origin: source,
    createdAt: "2026-10-23",
    updatedAt: "2026-10-23",
    lastEvent: revision,
  },
  events: [
    {
      id: `${objectId}:${revision}`,
      objectId,
      revision,
      sequence: revision,
      source,
      at: "2026-10-23",
      changes: [],
    },
  ],
  nextHistory: null,
})
async function openObjects(page: Page, selected?: string) {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Your agents" })).toBeVisible()
  await page.goto(`/agents/navi/objects${selected ? `/${selected}` : ""}`)
}

test("uncertain creation survives reload and retries the identical mutation", async ({
  page,
}) => {
  const mutations: ObjectMutation[] = []
  let saved: ObjectDetail | undefined
  await page.route("**/api/agent/objects**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/mutate")) {
      const input = route.request().postDataJSON() as ObjectMutation
      mutations.push(input)
      if (mutations.length === 1) {
        await route.abort("failed")
        return
      }
      saved = detail(
        1,
        input.action.type === "create" ? input.action.title : "unexpected",
        input.id
      )
      await route.fulfill({
        json: { objectId: input.id, revision: 1, eventId: `${input.id}:1` },
      })
      return
    }
    await route.fulfill({
      json: path.endsWith("/objects")
        ? { objects: saved ? [objectSummary(saved.object)] : [] }
        : (saved ?? detail(0, "Not saved")),
    })
  })
  await openObjects(page)
  await page.getByRole("button", { name: "New checklist", exact: true }).click()
  await page
    .getByLabel("Project title", { exact: true })
    .fill("Retained project")
  await page
    .getByRole("button", { name: "Create checklist", exact: true })
    .click()
  await expect(
    page.getByText("Save not confirmed", { exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Retry same save", exact: true })
  ).toBeEnabled()
  expect(mutations).toHaveLength(1)
  await page
    .getByRole("button", { name: "Retry same save", exact: true })
    .click()
  await expect(
    page.getByRole("link", { name: /Retained project/ })
  ).toBeVisible()
  expect(mutations).toHaveLength(2)
  expect(mutations[1]).toEqual(mutations[0])
  await page.getByRole("link", { name: /Retained project/ }).click()
  await expect(
    page.getByRole("heading", { name: "Retained project", exact: true })
  ).toBeVisible()
})

test("conflict draft survives reload and only explicit reapply changes operation identity", async ({
  page,
}) => {
  let saved = detail(1, "Server project")
  const mutations: ObjectMutation[] = []
  await page.route("**/api/agent/objects**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/mutate")) {
      const input = route.request().postDataJSON() as ObjectMutation
      mutations.push(input)
      if (mutations.length === 1) {
        saved = detail(2, "Newer server title")
        await route.fulfill({
          status: 409,
          json: { error: "A newer version is saved." },
        })
        return
      }
      saved = detail(3, "My retained draft")
      await route.fulfill({
        json: { objectId: id, revision: 3, eventId: `${id}:3` },
      })
      return
    }
    await route.fulfill({
      json: path.endsWith("/objects")
        ? { objects: [objectSummary(saved.object)] }
        : saved,
    })
  })
  await openObjects(page, id)
  await page
    .getByRole("button", { name: "Edit checklist", exact: true })
    .click()
  await page.getByLabel("Title", { exact: true }).fill("My retained draft")
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(
    page.getByText("A newer version may be saved", { exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Newer server title", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("My retained draft", { exact: true })
  ).toBeVisible()
  expect(mutations).toHaveLength(1)
  await page
    .getByRole("button", { name: "Apply my change to revision 2", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "My retained draft", exact: true })
  ).toBeVisible()
  expect(mutations).toHaveLength(2)
  expect(mutations[1]?.operationId).not.toBe(mutations[0]?.operationId)
  expect(mutations[1]?.expectedRevision).toBe(2)
  expect(mutations[1]?.action).toEqual(mutations[0]?.action)
})

test("cancel after uncertain edit uses its original operation and waits for a valid acknowledgement", async ({
  page,
}) => {
  const mutations: ObjectMutation[] = [],
    cancels: unknown[] = []
  await page.route("**/api/agent/objects**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/mutate")) {
      mutations.push(route.request().postDataJSON())
      await route.abort("failed")
      return
    }
    if (path.endsWith("/cancel")) {
      cancels.push(route.request().postDataJSON())
      await route.fulfill({ json: { applied: false } })
      return
    }
    await route.fulfill({
      json: path.endsWith("/objects")
        ? { objects: [objectSummary(detail(1, "Server project").object)] }
        : detail(1, "Server project"),
    })
  })
  await openObjects(page, id)
  await page
    .getByRole("button", { name: "Edit checklist", exact: true })
    .click()
  await page.getByLabel("Title", { exact: true }).fill("Unconfirmed draft")
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Cancel pending save", exact: true })
  ).toBeEnabled()
  await page
    .getByRole("button", { name: "Cancel pending save", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Edit checklist", exact: true })
  ).toBeEnabled()
  await expect(page.getByLabel("Title", { exact: true })).toHaveCount(0)
  expect(cancels).toEqual([{ operationId: mutations[0]?.operationId }])
  expect(mutations).toHaveLength(1)
})
