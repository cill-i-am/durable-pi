import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { build } from "esbuild"
import { expect, it } from "vitest"

it("initializes MCP schemas before a deferred Zod import in Worker bundles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "durable-pi-package-bundle-"))
  try {
    const output = join(directory, "probe.mjs")
    await build({
      stdin: {
        contents: `import { Client } from "@modelcontextprotocol/client";
          const client = new Client({ name: "probe", version: "1" });
          const z = await import("zod");
          console.log(z.string().parse(client.constructor.name));`,
        resolveDir: process.cwd(),
      },
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
    })
    const result = await promisify(execFile)(process.execPath, [output])
    expect(result.stdout.trim()).toBe("Client")
    expect(result.stderr).toBe("")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
