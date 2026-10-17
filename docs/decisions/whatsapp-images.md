# Images across surfaces

The owner clarified on 17 October 2026 that web, WhatsApp and future native/mobile clients are peer surfaces over the same product. Images are the next slice; voice, video and WhatsApp approvals follow separately.

| Decision | Consequence |
| --- | --- |
| Workspace owns image processing and storage. | Web and WhatsApp submit originals to one module. The browser's separate canvas pipeline is removed. Originals stay private in existing R2 storage, with a bounded JPEG preview for vision and display. |
| Use the Cloudflare Images binding. | Native decoding and resizing avoid another image server, sandbox boot or bundled imaging library. Preview work is bounded by input size, pixel count, output size and a small set of transformations. |
| Admit WhatsApp metadata durably before fetching media. | Acknowledged images have recoverable receipts. The selected agent owns the original and preview, with a deterministic file identity. Repeated delivery or a lost import acknowledgement reuses that file. |
| Image replies belong to the shared workspace/conversation. | The common `share_image` tool records which private images belong in a reply; web and WhatsApp render the same result. Channel adapters own delivery, never the capability itself. |
| Message origin does not determine agent capabilities. | The owner rejected the inherited report-only tool restriction as unnecessary. Every turn uses the agent's normal tools and saved permissions, including agent-generated reports. Explicitly clear stale session tool selections. Deliberately read-only delegated agents retain their selected extensions and explicit scope. A shared `view_image` tool can inspect saved photos again. |
| Track each outbound WhatsApp image independently. | A failed or ambiguous image send can be retried without repeating the text or other images. Native media uploads avoid making private files public. |
| Add receipt fields without rebuilding existing message tables. | Existing text receipts and retry references survive the migration. Decode and application rules validate the new image metadata. |

Local verification on 17 October 2026:

- Static validation, TypeScript, migration-manifest validation, lint and formatting pass.
- All 1,720 unit/integration tests pass. This includes signed image webhook admission, media hash/type checks, bounded decoding output and cancellation, private workspace import/export, original-only web upload, idempotent image replies, route pinning, retry bounds, uncertain sends and an upgrade retaining existing WhatsApp receipts and retry references.
- Native workerd exercises the production PersonalAgent and Pi image tool, vision admission, one text plus one private image send, duplicate delivery and restart without resend. Images decoding, model inference and provider delivery are synthetic external boundaries. A native failure exposed asynchronous hashing inside a SQLite transaction; hashing now occurs before entering the transaction while generation checks and receipt insertion remain atomic.
- The existing native communication, actor, delegation and recovery suite passes, plus 42 Drizzle transaction/interoperability cases with 41 persisted-state checks after restart, and Chat SDK native state persistence.
- Six desktop/mobile browser journeys pass, including original-only image upload, an image reply with a working preview, and reload. Browser journeys use the local fixture transport.

Meta onboarding, the real Images service and live WhatsApp acceptance remain deferred. Surface parity is the product direction; previously deferred media and approval capabilities are slice boundaries, not permanent web-only restrictions.
