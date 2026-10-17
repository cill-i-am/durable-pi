# Voice input across surfaces

Voice notes receive text replies. WhatsApp, web and future clients share the same workspace processing. Speech generation, real-time calls, video and approval interactions follow separately.

| Decision | Consequence |
| --- | --- |
| Transcribe the request, then use the agent's configured model. | Cloudflare Workers AI runs multilingual Whisper large v3 turbo. The existing agent execution writes the text response. This slice adds no speech-generation tool or separate voice model for answers. |
| Workspace owns audio processing and private assets. | Every surface uploads an original through the existing durable reservation path. The transcript is a derived, content-addressed asset committed with the completed file. Retries reuse ready files; concurrent results cannot replace a completed transcript. Short voice notes use the existing upload lifecycle without another queue. |
| Keep processing independent of transport and provider. | One `WorkspaceProcessing` configuration supplies image, document, video and transcription adapters. Cloudflare's native AI binding needs no separate API credential or speech server. Additional surfaces reuse this pipeline. |
| Generalize the channel's incoming image path to media. | Images and voice notes share durable admission, download validation, private storage, retries and archive fences. Existing image IDs, fingerprint encoding and send receipts remain stable. Image sharing retains the common reply-file path. |
| Preserve live storage identities. | The migration adds one nullable audio metadata column. The SQLite adapter retains physical receipt names and translates the historical generic document bucket to the public audio kind. File IDs, foreign keys, image replies and retries survive without rebuilding live tables. |
| Retain originals and provide a text alternative. | Web supports recording, file upload, playback and transcript disclosure. Finishing a recording attaches it for review before sending. Microphone tracks close on completion, cancellation, navigation and late permission resolution. Automatic transcripts may contain errors; the agent receives that provenance. |
| Preserve owner instructions and ordinary tool access. | Email and WhatsApp requests are user messages. Only actual background and communication reports are labelled internal task results. The agent keeps its normal tools, saved permissions and existing approval flow across surfaces. |

Originals use the shared 8 MB limit; transcription accepts up to ten minutes and retains at most 32,000 characters with an explicit truncation marker. These are shared processing bounds. Workers AI transcription is metered separately from the ChatGPT subscription.

Provider details were checked against the [Whisper model](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/) and [Chat SDK WhatsApp adapter](https://chat-sdk.dev/adapters/official/whatsapp).

Local static checks, the complete unit suite and build, native runtime checks, and desktop/mobile browser journeys pass. The native voice case verifies transcript input, one text reply, duplicate handling and restart without resending. Meta onboarding and live model/media acceptance remain deferred. Local provider responses are synthetic; they do not prove transcription accuracy or live WhatsApp delivery.
