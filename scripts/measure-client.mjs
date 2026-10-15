import { readdir, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { gzipSync } from "node:zlib"

// Use Start's generated preload graph, including shared dependencies, rather
// than counting just the route chunk or every optional panel in the build.
const directory = resolve("dist/server/assets")
const manifestFile = (await readdir(directory)).find((file) =>
  file.startsWith("_tanstack-start-manifest")
)
if (!manifestFile) throw new Error("Build the application before measuring it.")
const { tsrStartManifest } = await import(
  pathToFileURL(resolve(directory, manifestFile)).href
)
const { routes } = tsrStartManifest()
const matched = ["__root__", "/_workspace", "/_workspace/agents/$agentId/"]
const assets = [...new Set(matched.flatMap((route) => routes[route].preloads))]
const files = await Promise.all(
  assets.map(async (asset) => {
    const body = await readFile(resolve("dist/client", asset.slice(1)))
    return { asset, bytes: body.length, gzipBytes: gzipSync(body).length }
  })
)
console.log(
  JSON.stringify(
    {
      route: "/agents/home",
      compression: "local gzip, default level; not observed network bytes",
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      gzipBytes: files.reduce((sum, file) => sum + file.gzipBytes, 0),
      files,
    },
    null,
    2
  )
)
