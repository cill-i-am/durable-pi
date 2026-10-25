import { addons } from "storybook/manager-api"
import { create } from "storybook/theming"

addons.setConfig({
  theme: create({
    base: "light",
    brandTitle: "Pi UI",
    brandUrl: "https://ui.cill-i-am.com",
    brandTarget: "_self",
    colorPrimary: "#535FC6",
    colorSecondary: "#535FC6",
    fontBase: '"Geist Variable", system-ui, sans-serif',
  }),
  showOnboarding: false,
  showWhatsNew: false,
})
