import { expect, test, type Page } from "@playwright/test"
import { Schema } from "effect"

import { AgentId, homeAgentId } from "../../src/agents/contracts"
import {
  ConfigureWhatsApp,
  RetryWhatsApp,
  type WhatsAppView,
} from "../../src/whatsapp/contracts"

const researchId = Schema.decodeUnknownSync(AgentId)(
  "11111111-1111-4111-8111-111111111111"
)
const messageId = "33333333-3333-4333-8333-333333333333"

async function signIn(page: Page) {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Your agents" })).toBeVisible()
}

async function channelFixture(
  page: Page,
  availability: "active" | "archived" | "missing" = "active"
) {
  const fixture = {
    view: {
      configured: true,
      enabled: true,
      revision: 4,
      agentId: researchId,
      agentName: "Research",
      contactUrl: null,
      messages: [
        {
          id: messageId,
          agentId: researchId,
          state: "uncertain",
          error: "Synthetic provider acknowledgement lost.",
          createdAt: Date.now(),
          progress: {
            confirmed: 1,
            total: 2,
            next: { number: 2, kind: "text" },
          },
        },
      ],
    } as WhatsAppView,
    loseConfigureAck: false,
    loseRetryAck: false,
    configure: [] as { target: string | null; input: ConfigureWhatsApp }[],
    retry: [] as { target: string | null; input: typeof RetryWhatsApp.Type }[],
  }
  const configured = new Set<string>()
  await page.route("**/api/agent/bots", async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    await route.fulfill({
      response,
      json: {
        ...data,
        agents: [
          ...data.agents,
          ...(availability === "missing"
            ? []
            : [
                {
                  id: researchId,
                  slug: "research",
                  name: "Research",
                  instructions: "Synthetic channel target",
                  status: availability,
                  revision: 1,
                  createdAt: "2026-10-23T00:00:00.000Z",
                  updatedAt: "2026-10-23T00:00:00.000Z",
                },
              ]),
        ],
      },
    })
  })
  await page.route(
    (url) => url.pathname.startsWith("/api/agent/whatsapp"),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const target = url.searchParams.get("agent")
      if (request.method() === "GET") {
        expect(target).toBe(homeAgentId)
      } else if (url.pathname.endsWith("/configure")) {
        const input = Schema.decodeUnknownSync(ConfigureWhatsApp)(
          request.postDataJSON()
        )
        fixture.configure.push({ target, input })
        if (!configured.has(input.operationId)) {
          configured.add(input.operationId)
          fixture.view = {
            ...fixture.view,
            enabled: input.enabled,
            revision: fixture.view.revision + 1,
            agentId: Schema.decodeUnknownSync(AgentId)(target),
            agentName: target === researchId ? "Research" : "Navi",
          }
        }
        if (fixture.loseConfigureAck) {
          fixture.loseConfigureAck = false
          await route.fulfill({
            status: 503,
            json: { error: "Synthetic configure acknowledgement lost." },
          })
          return
        }
      } else if (url.pathname.endsWith("/retry")) {
        const input = Schema.decodeUnknownSync(RetryWhatsApp)(
          request.postDataJSON()
        )
        fixture.retry.push({ target, input })
        fixture.view = {
          ...fixture.view,
          messages: fixture.view.messages.map((message) =>
            message.id === input.id
              ? {
                  ...message,
                  state: "sent",
                  error: null,
                  progress: { confirmed: 2, total: 2, next: null },
                }
              : message
          ),
        }
        if (fixture.loseRetryAck) {
          fixture.loseRetryAck = false
          await route.fulfill({
            status: 503,
            json: { error: "Synthetic retry acknowledgement lost." },
          })
          return
        }
      } else {
        throw new Error(
          `Unexpected channel mutation: ${request.method()} ${url.pathname}`
        )
      }
      await route.fulfill({ json: fixture.view })
    }
  )
  return fixture
}

async function chooseAgent(page: Page, name: string) {
  await page
    .getByRole("combobox", { name: "WhatsApp agent", exact: true })
    .click()
  await page.getByRole("option", { name, exact: true }).click()
}

test("WhatsApp uses its persisted target, reroutes explicitly, and retains earlier reply ownership", async ({
  page,
}) => {
  const fixture = await channelFixture(page)
  await signIn(page)
  await page.goto(
    `/settings/channels?${new URLSearchParams({ returnTo: "/agents/navi" })}`
  )
  const picker = page.getByRole("combobox", {
    name: "WhatsApp agent",
    exact: true,
  })
  await expect(picker).toContainText("Research")
  await expect(
    page.getByText("New WhatsApp messages go to Research.", { exact: false })
  ).toBeVisible()
  const ledger = page.getByRole("region", {
    name: "Recent WhatsApp replies",
    exact: true,
  })
  await expect(ledger).toContainText("Agent: Research")
  expect(fixture.configure).toEqual([])
  await chooseAgent(page, "Navi")
  await expect(picker).toContainText("Navi")
  await expect(
    page.getByRole("button", { name: "Save WhatsApp agent", exact: true })
  ).toBeEnabled()
  await expect(
    ledger.getByRole("button", {
      name: "Retry remaining messages",
      exact: true,
    })
  ).toBeDisabled()
  expect(fixture.configure).toEqual([])
  await page
    .getByRole("button", { name: "Save WhatsApp agent", exact: true })
    .click()
  await expect(
    page.getByText("New WhatsApp messages go to Navi.", { exact: false })
  ).toBeVisible()
  expect(fixture.configure).toHaveLength(1)
  expect(fixture.configure[0]).toMatchObject({
    target: homeAgentId,
    input: { enabled: true, revision: 4 },
  })
  await expect(ledger).toContainText("Agent: Research")
  fixture.loseRetryAck = true
  await ledger
    .getByRole("button", { name: "Retry remaining messages", exact: true })
    .click()
  const confirmation = page.getByRole("alertdialog", {
    name: "Send this WhatsApp reply again?",
    exact: true,
  })
  await expect(confirmation).toContainText("may create a duplicate")
  expect(fixture.retry).toEqual([])
  await confirmation
    .getByRole("button", { name: "Send again", exact: true })
    .click()
  const retry = page.getByRole("button", {
    name: "Retry same request",
    exact: true,
  })
  await expect(retry).toBeEnabled()
  await expect(picker).toBeDisabled()
  expect(fixture.retry).toHaveLength(1)
  await retry.click()
  await expect(ledger).toContainText("Accepted by WhatsApp")
  expect(fixture.retry).toHaveLength(2)
  expect(fixture.retry[1]).toEqual(fixture.retry[0])
  expect(fixture.retry[0]).toMatchObject({
    target: homeAgentId,
    input: { id: messageId, acknowledgeDuplicateRisk: true },
  })
  expect(fixture.retry[0]!.input.operationId).toMatch(/^[a-f0-9-]{36}$/)
  await expect(ledger).toContainText("Agent: Research")
})

for (const availability of ["missing", "archived"] as const) {
  test(`a ${availability} WhatsApp target is left unavailable rather than defaulted`, async ({
    page,
  }) => {
    const fixture = await channelFixture(page, availability)
    await signIn(page)
    await page.goto(
      `/settings/channels?${new URLSearchParams({ returnTo: "/agents/navi" })}`
    )
    const picker = page.getByRole("combobox", {
      name: "WhatsApp agent",
      exact: true,
    })
    await expect(picker).toContainText("Choose an agent")
    await expect(
      page.getByText("Research is unavailable.", { exact: false })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Save WhatsApp agent", exact: true })
    ).toBeDisabled()
    await expect(
      page.getByRole("region", { name: "Recent WhatsApp replies", exact: true })
    ).toContainText("Agent: Research")
    await chooseAgent(page, "Navi")
    await expect(
      page.getByRole("button", { name: "Save WhatsApp agent", exact: true })
    ).toBeEnabled()
    expect(fixture.configure).toEqual([])
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(picker).toContainText("Choose an agent")
    expect(fixture.configure).toEqual([])
  })
}

test("an unconfirmed WhatsApp reroute retries its original operation and chosen target", async ({
  page,
}) => {
  const fixture = await channelFixture(page)
  fixture.loseConfigureAck = true
  await signIn(page)
  await page.goto(
    `/settings/channels?${new URLSearchParams({ returnTo: "/agents/research" })}`
  )
  await chooseAgent(page, "Navi")
  await page
    .getByRole("button", { name: "Save WhatsApp agent", exact: true })
    .click()
  await expect(
    page.getByText("Synthetic configure acknowledgement lost.", { exact: true })
  ).toBeVisible()
  const picker = page.getByRole("combobox", {
    name: "WhatsApp agent",
    exact: true,
  })
  await expect(picker).toBeDisabled()
  expect(fixture.configure).toHaveLength(1)
  await page
    .getByRole("button", { name: "Retry same request", exact: true })
    .click()
  await expect(
    page.getByText("New WhatsApp messages go to Navi.", { exact: false })
  ).toBeVisible()
  expect(fixture.configure).toHaveLength(2)
  expect(fixture.configure[1]).toEqual(fixture.configure[0])
  expect(fixture.configure[0]).toMatchObject({
    target: homeAgentId,
    input: { enabled: true, revision: 4 },
  })
  expect(fixture.configure[0]!.input.operationId).toMatch(/^[a-f0-9-]{36}$/)
  await expect(
    page.getByRole("region", { name: "Recent WhatsApp replies", exact: true })
  ).toContainText("Agent: Research")
})
