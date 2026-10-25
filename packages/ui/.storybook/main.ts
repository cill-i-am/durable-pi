import type { StorybookConfig } from "@storybook/react-vite"

const config: StorybookConfig = {
  stories: ["../src/stories/**/*.stories.@(ts|tsx)"],
  addons: [
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
    "storybook-addon-pseudo-states",
  ],
  framework: { name: "@storybook/react-vite", options: {} },
  core: { disableTelemetry: true },
  docs: { defaultName: "Reference" },
}
export default config
