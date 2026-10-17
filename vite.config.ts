import tailwindcss from "@tailwindcss/vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const config = defineConfig({
  resolve: { tsconfigPaths: true },
  ssr: {
    external: ["cloudflare:workers"],
    // Keep plugin and auth error constructors in the same server module graph.
    noExternal: ["@better-auth/passkey"],
  },
  build: {
    sourcemap: "hidden",
    rolldownOptions: { external: ["cloudflare:workers"] },
  },
  plugins: [tailwindcss(), tanstackStart(), viteReact()],
})

export default config
