import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  AgentAvatar,
  AgentAvatarGroup,
} from "@workspace/ui/components/agent-avatar"

const agents = [
  { id: "home", name: "Pi" },
  { id: "meal-planner", name: "Meal planner" },
  { id: "research", name: "Research" },
  { id: "travel", name: "Travel" },
  { id: "projects", name: "Projects" },
  { id: "family", name: "Family" },
]

const meta = {
  title: "Components/Agent Avatar",
  component: AgentAvatar,
  tags: ["autodocs"],
  parameters: {
    layout: "centered",
    docs: {
      description: {
        component:
          "Generative SVG avatars from [dithercn](https://dithercn.dev/docs/interface/avatar). Pass the stable agent ID as `name` and its display name as `label`; renaming an agent preserves its face and colour. Hide the avatar from assistive technology when adjacent text already names the agent. Application runtime states keep their existing status markers; presence dots are optional.",
      },
    },
  },
  args: {
    name: "home",
    label: "Pi",
    size: 40,
    fill: "gradient",
    shape: "circle",
    ring: false,
    bloom: "off",
  },
  argTypes: {
    name: { control: "text", description: "Stable agent ID used as the seed." },
    label: { control: "text" },
    size: { control: { type: "range", min: 20, max: 96, step: 2 } },
    color: { control: "text" },
    fill: {
      control: "select",
      options: ["gradient", "dotted", "hatched", "solid"],
    },
    shape: { control: "inline-radio", options: ["circle", "square"] },
    ring: { control: "boolean" },
    bloom: { control: "select", options: ["off", "low", "high"] },
    status: {
      control: "select",
      options: [undefined, "online", "away", "busy", "offline"],
    },
  },
} satisfies Meta<typeof AgentAvatar>
export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}
export const Playground: Story = {
  args: { name: "meal-planner", label: "Meal planner", size: 80 },
}

export const Agents: Story = {
  render: () => (
    <div className="flex max-w-sm flex-col gap-4">
      {agents.map((agent) => (
        <div key={agent.id} className="flex items-center gap-3">
          <AgentAvatar
            name={agent.id}
            label={agent.name}
            size={30}
            aria-hidden="true"
          />
          <span className="text-sm">{agent.name}</span>
        </div>
      ))}
    </div>
  ),
}

export const Sizes: Story = {
  render: () => (
    <div className="flex max-w-sm flex-wrap items-end gap-4">
      {[22, 24, 30, 32, 36, 48, 80].map((size) => (
        <div key={size} className="flex flex-col items-center gap-2">
          <AgentAvatar name="home" label="Pi" size={size} />
          <span className="text-xs text-muted-foreground">{size}px</span>
        </div>
      ))}
    </div>
  ),
}

export const Fills: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      {(["gradient", "dotted", "hatched", "solid"] as const).map((fill) => (
        <div key={fill} className="flex flex-col gap-2">
          <span className="text-xs text-muted-foreground">{fill}</span>
          <div className="flex flex-wrap gap-3">
            {agents.map((agent) => (
              <AgentAvatar
                key={agent.id}
                name={agent.id}
                label={agent.name}
                fill={fill}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  ),
}

export const Presence: Story = {
  render: () => (
    <div className="flex flex-wrap gap-6">
      {(["online", "away", "busy", "offline"] as const).map((status) => (
        <div key={status} className="flex flex-col items-center gap-2">
          <AgentAvatar name="home" label="Pi" status={status} />
          <span className="text-xs text-muted-foreground">{status}</span>
        </div>
      ))}
    </div>
  ),
}

export const Group: Story = {
  render: () => (
    <AgentAvatarGroup
      max={4}
      size={40}
      aria-label="Your agents"
      moreLabel={(count) => `${count} more agents`}
    >
      {agents.map((agent) => (
        <AgentAvatar key={agent.id} name={agent.id} label={agent.name} />
      ))}
    </AgentAvatarGroup>
  ),
}

export const StableIdentity: Story = {
  render: () => (
    <div className="flex flex-wrap gap-6">
      {["Meal planner", "Dinner helper"].map((label) => (
        <div key={label} className="flex flex-col items-center gap-2">
          <AgentAvatar name="meal-planner" label={label} size={64} />
          <span className="text-sm">{label}</span>
        </div>
      ))}
    </div>
  ),
}

export const SquareWithRing: Story = {
  args: { shape: "square", ring: true, size: 64 },
}
