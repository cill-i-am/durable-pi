# Infrastructure ownership

`alchemy.run.ts` composes the application and selects local state for development or the existing Cloudflare state service for deployments. Resource declarations live in `resources/`:

| Module | Owns |
| --- | --- |
| `storage.ts` | Authentication D1 database and private R2 buckets |
| `services.ts` | Document extraction and generated-code Workers |
| `terminal.ts` | Native sandbox image, capacity namespace, native Worker and legacy rehearsal Worker |
| `agent.ts` | PersonalAgent Worker, durable namespaces and service bindings |
| `channels.ts` | Email and WhatsApp ingress Workers |
| `website.ts` | Vite website, authentication bindings and canonical URL |
| `worker-settings.ts` | Shared private-worker exposure, observability and production domain selection |

Import environment types from the module that owns the Worker. These are type-only imports; runtime code must not import the deployment entrypoint. Rehearsal stacks import terminal resources directly. The GitHub setup stack remains independently deployable.

Resource IDs are persisted identities. Moving declarations between files does not rename them; changing IDs, introducing namespaces or changing the stack name can replace deployed resources. Keep the existing migration paths, durable class names, container image/namespace separation and state store when reorganizing code.

`pnpm build:workers` bundles entrypoints locally without evaluating infrastructure. The modernization audit compiled the old and new resource graphs with fixture configuration, empty provider layers and in-memory state to compare identities and bindings. That check does not query deployed state or predict provider reconciliation. `alchemy plan` loads the configured remote state service and may need to bootstrap or upgrade it; run it only in the intended authenticated deployment context. Review its replacements, deletions and state-service changes before deploying.
