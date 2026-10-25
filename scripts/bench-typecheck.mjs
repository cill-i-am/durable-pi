import { spawnSync, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { cpus, totalmem } from "node:os"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"

const root = fileURLToPath(new URL("../", import.meta.url))
const { values } = parseArgs({
  options: {
    samples: { type: "string", default: "5" },
    output: { type: "string", default: "test-results/typecheck-benchmark" },
  },
})
const samples = Number(values.samples)
if (!Number.isInteger(samples) || samples < 1 || samples > 50)
  throw new Error("--samples must be an integer from 1 to 50")
if (!["darwin", "linux"].includes(process.platform))
  throw new Error("Memory measurement requires macOS time or GNU time on Linux")
if (process.env.TSRS_BINARY || process.env.EFFECT_TSRS_BINARY)
  throw new Error(
    "Unset compiler binary overrides to benchmark locked packages"
  )

const output = resolve(root, values.output)
mkdirSync(output, { recursive: true })
const commands = {
  tsc: [
    "node_modules/@typescript/native/bin/tsc",
    "--noEmit",
    "--pretty",
    "false",
  ],
  tsrs: ["node_modules/tsrs/bin/tsrs", "--noEmit", "--pretty", "false"],
  effect: [
    "node_modules/@yielded/effect-tsrs/bin/effect-tsrs.js",
    "diagnostics",
    "--project",
    "tsconfig.json",
    "--format",
    "json",
    "--lspconfig",
    "{}",
  ],
}
const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}
const results = Object.fromEntries(
  Object.keys(commands).map((name) => [name, []])
)
function run(name, round) {
  const args =
    process.platform === "darwin" ? ["-l"] : ["-f", "BENCH_RSS_KIB=%M"]
  const start = performance.now()
  const result = spawnSync(
    "/usr/bin/time",
    [...args, process.execPath, ...commands[name]],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 180_000,
    }
  )
  const seconds = (performance.now() - start) / 1000
  if (result.error) throw result.error
  writeFileSync(resolve(output, `${name}-${round}.stdout`), result.stdout)
  writeFileSync(resolve(output, `${name}-${round}.stderr`), result.stderr)
  const memory =
    process.platform === "darwin"
      ? result.stderr.match(/(\d+)\s+maximum resident set size/)
      : result.stderr.match(/BENCH_RSS_KIB=(\d+)/)
  if (!memory)
    throw new Error(`No memory measurement for ${name}; inspect ${output}`)
  const peakMiB =
    Number(memory[1]) / (process.platform === "darwin" ? 1024 * 1024 : 1024)
  const diagnosticSummary =
    name === "effect" ? JSON.parse(result.stdout).summary : undefined
  const sample = {
    seconds,
    peakMiB,
    exitCode: result.status,
    signal: result.signal,
    diagnosticSummary,
  }
  console.log(
    `${name} ${round}: ${seconds.toFixed(3)}s, ${peakMiB.toFixed(1)} MiB, exit ${result.status}`
  )
  return sample
}

// Warm each compiler once, then rotate execution order. Never run samples concurrently.
const names = Object.keys(commands)
const warmups = Object.fromEntries(
  names.map((name) => [name, run(name, "warmup")])
)
for (let round = 0; round < samples; round++) {
  for (let offset = 0; offset < names.length; offset++) {
    const name = names[(round + offset) % names.length]
    results[name].push(run(name, round + 1))
  }
}
const summaries = Object.fromEntries(
  names.map((name) => [
    name,
    {
      medianSeconds: median(results[name].map((run) => run.seconds)),
      medianPeakMiB: median(results[name].map((run) => run.peakMiB)),
      allPassed: [warmups[name], ...results[name]].every(
        (run) => run.exitCode === 0
      ),
    },
  ])
)
const files = execFileSync("git", ["ls-files", "-z", "*.ts", "*.tsx"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean)
const hash = createHash("sha256")
for (const file of [
  ...files,
  "tsconfig.json",
  "package.json",
  "pnpm-lock.yaml",
].sort())
  hash
    .update(file)
    .update("\0")
    .update(readFileSync(resolve(root, file)))
const versions = Object.fromEntries(
  ["typescript", "@typescript/native", "tsrs", "@yielded/effect-tsrs"].map(
    (name) => [
      name,
      JSON.parse(
        readFileSync(
          resolve(root, "node_modules", name, "package.json"),
          "utf8"
        )
      ).version,
    ]
  )
)
const report = {
  timestamp: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim(),
  sourceAndConfigSha256: hash.digest("hex"),
  trackedTypeScriptFiles: files.length,
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryGiB: totalmem() / 1024 ** 3,
  },
  versions,
  commands,
  warmups,
  results,
  summaries,
  speedup:
    summaries.tsc.allPassed && summaries.tsrs.allPassed
      ? summaries.tsc.medianSeconds / summaries.tsrs.medianSeconds
      : null,
  memoryReductionPercent:
    summaries.tsc.allPassed && summaries.tsrs.allPassed
      ? 100 * (1 - summaries.tsrs.medianPeakMiB / summaries.tsc.medianPeakMiB)
      : null,
}
writeFileSync(
  resolve(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n"
)
console.table(summaries)
console.log(`Report and raw outputs: ${output}`)
if (Object.values(summaries).some((summary) => !summary.allPassed))
  process.exitCode = 1
