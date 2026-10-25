import type { Meta, StoryObj } from "@storybook/react-vite"

const meta = {
  title: "Start here/Review",
  parameters: { layout: "padded", controls: { disable: true } },
} satisfies Meta
export default meta
type Story = StoryObj<typeof meta>

export const Overview: Story = {
  render: () => (
    <main className="flex max-w-3xl flex-col gap-7">
      <h1 className="text-xl font-semibold">Pi UI</h1>
      <p className="text-md">
        The Paper primitives, implemented as a shared UI package.
      </p>
      <p className="text-base text-muted-foreground">
        Choose Button, Input or another component in the sidebar. Each has its
        own props, examples and states. The toolbar switches Light/Night, text
        size, viewport and motion preference. Every example uses synthetic data
        and local work.
      </p>
      <section className="flex flex-col gap-3">
        <h2 className="text-md font-semibold">What to review</h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-base">
          <li>Type, geometry, spacing and colour roles in Foundations.</li>
          <li>
            Default, hover, pressed, focus, disabled and working states under
            each component.
          </li>
          <li>
            Card headers, exposed frame headers, context/action/split footers
            and separated panels under CardFrame.
          </li>
          <li>
            Sheet, Dialog and AlertDialog in isolation; nested settings drawers
            under Compositions.
          </li>
          <li>
            Success, failure, retry, cancellation and uncertain results in the
            state explorer.
          </li>
        </ul>
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-md font-semibold">Verification boundaries</h2>
        <p className="text-base text-muted-foreground">
          The catalogue exposes finite state and variant matrices. Model tests
          check lifecycle transitions and cleanup; browser tests check rendered
          stories, keyboard journeys and automated accessibility. This does not
          claim every possible prop/content combination or replace manual
          assistive-technology testing.
        </p>
      </section>
      <div className="flex flex-wrap gap-5 text-base">
        <a
          className="text-primary underline underline-offset-4"
          href="https://app.paper.design/file/01M4GJ8G5KNDADJRVDDC3PQ6CT/p-A-1"
          target="_blank"
          rel="noreferrer"
        >
          Paper source
        </a>
        <a
          className="text-primary underline underline-offset-4"
          href="https://coss.com/ui/docs/components/card"
          target="_blank"
          rel="noreferrer"
        >
          Card frame reference
        </a>
      </div>
    </main>
  ),
}
