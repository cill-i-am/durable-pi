CREATE TABLE `access_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`revision` integer NOT NULL,
	`active` integer NOT NULL,
	CONSTRAINT "access_connections_active_check" CHECK("active" in (0, 1)),
	CONSTRAINT "access_connections_revision_check" CHECK("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `bot_remote_tools` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	`tools` text NOT NULL,
	CONSTRAINT "bot_remote_tools_tools_json" CHECK(json_valid("tools")),
	CONSTRAINT "bot_remote_tools_revision_check" CHECK("revision" >= 0),
	CONSTRAINT "bot_remote_tools_id_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `tool_grants` (
	`name` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`revision` integer NOT NULL,
	CONSTRAINT "tool_grants_mode_check" CHECK("mode" in ('allow', 'ask', 'deny')),
	CONSTRAINT "tool_grants_revision_check" CHECK("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `tool_operation_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`operationId` text NOT NULL,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	`at` integer NOT NULL,
	CONSTRAINT `fk_tool_operation_history_operationId_tool_operations_id_fk` FOREIGN KEY (`operationId`) REFERENCES `tool_operations`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "tool_operation_history_status_check" CHECK("status" in ('pending', 'approved', 'running', 'done', 'denied', 'cancelled', 'expired', 'interrupted')),
	CONSTRAINT "tool_operation_history_revision_check" CHECK("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `tool_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`turnId` text NOT NULL,
	`tool` text NOT NULL,
	`input` text NOT NULL,
	`createdAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	`status` text NOT NULL,
	`grantRevision` integer NOT NULL,
	`result` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`decision` text,
	CONSTRAINT "tool_operations_status_check" CHECK("status" in ('pending', 'approved', 'running', 'done', 'denied', 'cancelled', 'expired', 'interrupted')),
	CONSTRAINT "tool_operations_revision_check" CHECK("revision" >= 0),
	CONSTRAINT "tool_operations_grantRevision_check" CHECK("grantRevision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `agent_catalog` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`instructions` text NOT NULL,
	`status` text NOT NULL,
	`createdAt` text NOT NULL,
	`updatedAt` text NOT NULL,
	`creation` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_catalog_status" CHECK("status" in ('active', 'archived')),
	CONSTRAINT "agent_catalog_revision_check" CHECK("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `bot_admission` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	`status` text NOT NULL,
	CONSTRAINT "bot_admission_status_check" CHECK("status" in ('active', 'archived')),
	CONSTRAINT "bot_admission_revision_check" CHECK("revision" >= 0),
	CONSTRAINT "bot_admission_id_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `bot_configuration` (
	`id` integer PRIMARY KEY,
	`owner` text NOT NULL,
	`instructions` text NOT NULL,
	CONSTRAINT "bot_configuration_id_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `generated_app_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`app_id` text NOT NULL,
	`record` text NOT NULL,
	`queued` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_generated_app_events_app_id_generated_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `generated_apps`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "generated_app_events_record_json" CHECK(json_valid("record")),
	CONSTRAINT "generated_app_events_queued_check" CHECK("queued" in (0, 1))
);
--> statement-breakpoint
CREATE TABLE `generated_app_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`input` text NOT NULL,
	`result` text NOT NULL,
	CONSTRAINT "generated_app_operations_result_json" CHECK(json_valid("result"))
);
--> statement-breakpoint
CREATE TABLE `generated_app_versions` (
	`id` text NOT NULL,
	`version` integer NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT `generated_app_versions_pk` PRIMARY KEY(`id`, `version`),
	CONSTRAINT `fk_generated_app_versions_id_generated_apps_id_fk` FOREIGN KEY (`id`) REFERENCES `generated_apps`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "generated_app_versions_record_json" CHECK(json_valid("record")),
	CONSTRAINT "generated_app_versions_version_check" CHECK("version" > 0)
);
--> statement-breakpoint
CREATE TABLE `generated_apps` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`record` text NOT NULL,
	CONSTRAINT "generated_apps_record_json" CHECK(json_valid("record"))
);
--> statement-breakpoint
CREATE TABLE `bot_browser` (
	`id` integer PRIMARY KEY,
	`record` text NOT NULL,
	CONSTRAINT "bot_browser_record_json" CHECK(json_valid("record")),
	CONSTRAINT "bot_browser_id_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `retired_browsers` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `communication_cancellations` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT "communication_cancellations_body_json" CHECK(json_valid("body"))
);
--> statement-breakpoint
CREATE TABLE `communication_identity` (
	`id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	CONSTRAINT "communication_identity_body_json" CHECK(json_valid("body"))
);
--> statement-breakpoint
CREATE TABLE `communication_inbox` (
	`id` text PRIMARY KEY NOT NULL,
	`content` text NOT NULL,
	`receipt` text NOT NULL,
	CONSTRAINT "communication_inbox_content_json" CHECK(json_valid("content")),
	CONSTRAINT "communication_inbox_receipt_json" CHECK(json_valid("receipt"))
);
--> statement-breakpoint
CREATE TABLE `communication_outbox` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`next_at` integer,
	CONSTRAINT "communication_outbox_status_check" CHECK("status" in ('pending', 'delivering', 'accepted', 'failed', 'expired')),
	CONSTRAINT "communication_outbox_body_json" CHECK(json_valid("body"))
);
--> statement-breakpoint
CREATE TABLE `communication_tasks` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`lease_until` integer,
	`deadline` integer NOT NULL,
	`direction` text NOT NULL,
	CONSTRAINT "communication_tasks_status_check" CHECK("status" in ('accepted', 'running', 'waiting', 'completed', 'failed', 'expired', 'cancelling', 'cancelled', 'awaiting_input')),
	CONSTRAINT "communication_tasks_direction_check" CHECK("direction" in ('incoming', 'outgoing')),
	CONSTRAINT "communication_tasks_body_json" CHECK(json_valid("body"))
);
--> statement-breakpoint
CREATE TABLE `chat_activity` (
	`turn_id` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT `fk_chat_activity_turn_id_chat_turns_id_fk` FOREIGN KEY (`turn_id`) REFERENCES `chat_turns`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chat_activity_payload_json" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE TABLE `chat_recovery_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`turn_id` text NOT NULL,
	`at` text NOT NULL,
	`view` text NOT NULL,
	CONSTRAINT `fk_chat_recovery_history_turn_id_chat_turns_id_fk` FOREIGN KEY (`turn_id`) REFERENCES `chat_turns`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chat_recovery_history_view_json" CHECK(json_valid("view"))
);
--> statement-breakpoint
CREATE TABLE `chat_settings` (
	`id` integer PRIMARY KEY,
	`model` text NOT NULL,
	`thinking` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "chat_settings_revision_check" CHECK("revision" >= 0),
	CONSTRAINT "chat_settings_id_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `chat_turns` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`answer` text DEFAULT '' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	`session_id` text,
	`prompt` text,
	`parent_id` text,
	`started_at` text,
	`finished_at` text,
	`stopped_at` text,
	`recovery` text,
	`mode` text DEFAULT 'followUp' NOT NULL,
	`delivery` text DEFAULT 'queued' NOT NULL,
	`model` text,
	`routing` text,
	`origin` text,
	`thinking` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`creation` text,
	`attachments` text DEFAULT '[]' NOT NULL,
	`input` text DEFAULT '[]' NOT NULL,
	`skills` text DEFAULT '[]' NOT NULL,
	`skill_context` text DEFAULT '' NOT NULL,
	CONSTRAINT `fk_chat_turns_parent_id_chat_turns_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `chat_turns`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "chat_turns_status_check" CHECK("status" in ('queued', 'preparing', 'running', 'stopping', 'done', 'failed', 'cancelled')),
	CONSTRAINT "chat_turns_mode_check" CHECK("mode" in ('followUp', 'steer')),
	CONSTRAINT "chat_turns_delivery_check" CHECK("delivery" in ('queued', 'accepted', 'consumed', 'answered', 'unanswered')),
	CONSTRAINT "chat_turns_attachments_json" CHECK(json_valid("attachments")),
	CONSTRAINT "chat_turns_skills_json" CHECK(json_valid("skills")),
	CONSTRAINT "chat_turns_input_json" CHECK(json_valid("input")),
	CONSTRAINT "chat_turns_routing_json" CHECK("routing" is null or json_valid("routing")),
	CONSTRAINT "chat_turns_origin_json" CHECK("origin" is null or json_valid("origin")),
	CONSTRAINT "chat_turns_recovery_json" CHECK("recovery" is null or json_valid("recovery")),
	CONSTRAINT "chat_turns_revision_check" CHECK("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `job_model_settings` (
	`job` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`thinking` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `background_handoffs` (
	`id` integer PRIMARY KEY,
	`turn_id` text NOT NULL UNIQUE,
	`handoff` text NOT NULL,
	`status` text NOT NULL,
	`report` text,
	`error` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`next_at` integer,
	CONSTRAINT "background_handoffs_status_check" CHECK("status" in ('pending', 'running', 'ready', 'delivered', 'cancelled', 'paused')),
	CONSTRAINT "background_handoffs_handoff_json" CHECK(json_valid("handoff")),
	CONSTRAINT "background_handoffs_failures_check" CHECK("failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE `background_retries` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`group_id` integer NOT NULL,
	CONSTRAINT `fk_background_retries_group_id_background_handoffs_id_fk` FOREIGN KEY (`group_id`) REFERENCES `background_handoffs`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `code_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`created` integer NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT "code_runs_record_json" CHECK(json_valid("record"))
);
--> statement-breakpoint
CREATE TABLE `inference_attempts` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`payload` text NOT NULL,
	CONSTRAINT "inference_attempts_payload_json" CHECK(json_valid("payload"))
);
--> statement-breakpoint
CREATE TABLE `model_credential_refresh` (
	`provider` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_credentials` (
	`provider` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`seed` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `model_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`input` integer NOT NULL,
	`cached` integer NOT NULL,
	`output` integer NOT NULL,
	`date` text NOT NULL,
	CONSTRAINT "model_usage_input_check" CHECK("input" >= 0),
	CONSTRAINT "model_usage_cached_check" CHECK("cached" >= 0),
	CONSTRAINT "model_usage_output_check" CHECK("output" >= 0)
);
--> statement-breakpoint
CREATE TABLE `memory_backup_status` (
	`id` integer PRIMARY KEY,
	`date` text,
	`watermark` text NOT NULL,
	`error` text,
	CONSTRAINT "memory_backup_status_id_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `memory_compaction_view` (
	`start` integer PRIMARY KEY,
	`count` integer NOT NULL,
	CONSTRAINT "memory_compaction_view_start_check" CHECK("start" >= 0),
	CONSTRAINT "memory_compaction_view_count_check" CHECK("count" > 0)
);
--> statement-breakpoint
CREATE TABLE `memory_failures` (
	`start` integer NOT NULL,
	`count` integer NOT NULL,
	`retry_at` integer NOT NULL,
	`attempts` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `memory_failures_pk` PRIMARY KEY(`start`, `count`),
	CONSTRAINT "memory_failures_start_check" CHECK("start" >= 0),
	CONSTRAINT "memory_failures_count_check" CHECK("count" > 0),
	CONSTRAINT "memory_failures_attempts_check" CHECK("attempts" between 1 and 3)
);
--> statement-breakpoint
CREATE TABLE `memory_log` (
	`id` integer PRIMARY KEY,
	`source` text NOT NULL UNIQUE,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`date` text NOT NULL,
	CONSTRAINT "memory_log_kind_check" CHECK("kind" in ('user', 'talk', 'tool', 'echo', 'note')),
	CONSTRAINT "memory_log_id_check" CHECK("id" >= 0)
);
--> statement-breakpoint
CREATE TABLE `memory_migrations` (
	`name` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_nodes` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`start` integer NOT NULL,
	`count` integer NOT NULL,
	`text` text NOT NULL,
	`bytes` integer NOT NULL,
	CONSTRAINT `memory_nodes_start_count_unique` UNIQUE(`start`,`count`),
	CONSTRAINT "memory_nodes_start_check" CHECK("start" >= 0),
	CONSTRAINT "memory_nodes_bytes_check" CHECK("bytes" >= 0),
	CONSTRAINT "memory_nodes_count_check" CHECK("count" > 0)
);
--> statement-breakpoint
CREATE TABLE `memory_note_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`path` text NOT NULL,
	`body` text NOT NULL,
	`source_id` integer NOT NULL,
	`date` text NOT NULL,
	CONSTRAINT `fk_memory_note_history_source_id_memory_log_id_fk` FOREIGN KEY (`source_id`) REFERENCES `memory_log`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `memory_notes` (
	`path` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`source_id` integer NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_memory_notes_source_id_memory_log_id_fk` FOREIGN KEY (`source_id`) REFERENCES `memory_log`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE TABLE `memory_ready` (
	`start` integer NOT NULL,
	`count` integer NOT NULL,
	CONSTRAINT `memory_ready_pk` PRIMARY KEY(`count`, `start`),
	CONSTRAINT "memory_ready_start_check" CHECK("start" >= 0),
	CONSTRAINT "memory_ready_count_check" CHECK("count" > 0)
);
--> statement-breakpoint
CREATE TABLE `memory_view` (
	`start` integer PRIMARY KEY,
	`count` integer NOT NULL,
	CONSTRAINT "memory_view_start_check" CHECK("start" >= 0),
	CONSTRAINT "memory_view_count_check" CHECK("count" > 0)
);
--> statement-breakpoint
CREATE TABLE `memory_view_state` (
	`id` integer PRIMARY KEY,
	`compacting` integer NOT NULL,
	CONSTRAINT "memory_view_state_compacting_check" CHECK("compacting" in (0, 1)),
	CONSTRAINT "memory_view_state_id_singleton" CHECK("id" in (1, 2))
);
--> statement-breakpoint
CREATE TABLE `summary_routes` (
	`start` integer NOT NULL,
	`count` integer NOT NULL,
	`revision` integer NOT NULL,
	`operation` text NOT NULL UNIQUE,
	`route` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `summary_routes_pk` PRIMARY KEY(`start`, `count`, `revision`),
	CONSTRAINT "summary_routes_route_json" CHECK(json_valid("route")),
	CONSTRAINT "summary_routes_requests_check" CHECK("requests" >= 0),
	CONSTRAINT "summary_routes_count_check" CHECK("count" > 0),
	CONSTRAINT "summary_routes_revision_check" CHECK("revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `routine_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`input` text NOT NULL,
	`result` text NOT NULL,
	CONSTRAINT "routine_operations_result_json" CHECK(json_valid("result"))
);
--> statement-breakpoint
CREATE TABLE `routine_runs` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`routine_id` text NOT NULL,
	`turn_id` text NOT NULL UNIQUE,
	`status` text NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT `fk_routine_runs_routine_id_routines_id_fk` FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "routine_runs_status_check" CHECK("status" in ('pending', 'queued', 'done', 'failed', 'cancelled')),
	CONSTRAINT "routine_runs_record_json" CHECK(json_valid("record"))
);
--> statement-breakpoint
CREATE TABLE `routines` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`record` text NOT NULL,
	CONSTRAINT "routines_record_json" CHECK(json_valid("record"))
);
--> statement-breakpoint
CREATE TABLE `bot_skills` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	`skills` text NOT NULL,
	CONSTRAINT "bot_skills_skills_json" CHECK(json_valid("skills")),
	CONSTRAINT "bot_skills_revision_check" CHECK("revision" >= 0),
	CONSTRAINT "bot_skills_id_singleton" CHECK("id" = 1)
);
--> statement-breakpoint
CREATE TABLE `workspace_skill_versions` (
	`id` text NOT NULL,
	`revision` integer NOT NULL,
	`name` text NOT NULL,
	`body` text NOT NULL,
	`createdAt` text NOT NULL,
	`source` text,
	CONSTRAINT `workspace_skill_versions_pk` PRIMARY KEY(`id`, `revision`),
	CONSTRAINT `fk_workspace_skill_versions_id_workspace_skills_id_fk` FOREIGN KEY (`id`) REFERENCES `workspace_skills`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "workspace_skill_versions_source_json" CHECK("source" is null or json_valid("source")),
	CONSTRAINT "workspace_skill_versions_revision_check" CHECK("revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `workspace_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`archived` integer DEFAULT 0 NOT NULL,
	`stateRevision` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "workspace_skills_archived_check" CHECK("archived" in (0, 1)),
	CONSTRAINT "workspace_skills_revision_check" CHECK("revision" > 0),
	CONSTRAINT "workspace_skills_stateRevision_check" CHECK("stateRevision" > 0)
);
--> statement-breakpoint
CREATE TABLE `terminal_authority` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	`active` integer NOT NULL,
	`revoked_through` integer DEFAULT -1 NOT NULL,
	CONSTRAINT "terminal_authority_singleton" CHECK("id" = 1),
	CONSTRAINT "terminal_authority_active_check" CHECK("active" in (0, 1)),
	CONSTRAINT "terminal_authority_revision_check" CHECK("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `terminal_cancellations` (
	`id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `terminal_checkpoint` (
	`id` integer PRIMARY KEY,
	`record` text NOT NULL,
	CONSTRAINT "terminal_checkpoint_singleton" CHECK("id" = 1),
	CONSTRAINT "terminal_checkpoint_record_json" CHECK(json_valid("record"))
);
--> statement-breakpoint
CREATE TABLE `terminal_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT "terminal_exports_record_json" CHECK(json_valid("record"))
);
--> statement-breakpoint
CREATE TABLE `terminal_network` (
	`id` integer PRIMARY KEY,
	`revision` integer NOT NULL,
	`unrestricted` integer NOT NULL,
	CONSTRAINT "terminal_network_singleton" CHECK("id" = 1),
	CONSTRAINT "terminal_network_unrestricted_check" CHECK("unrestricted" in (0, 1)),
	CONSTRAINT "terminal_network_revision_check" CHECK("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `terminal_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`created` integer NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT "terminal_runs_record_json" CHECK(json_valid("record"))
);
--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`routine_id` text NOT NULL,
	`event_id` text NOT NULL,
	`hash` text NOT NULL,
	`run_id` text NOT NULL,
	CONSTRAINT `webhook_events_pk` PRIMARY KEY(`routine_id`, `event_id`)
);
--> statement-breakpoint
CREATE TABLE `webhook_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`input` text NOT NULL,
	`result` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhooks` (
	`routine_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`hash` text,
	CONSTRAINT "webhooks_revision_check" CHECK("revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE `workspace_extractions` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`pages` integer DEFAULT 0 NOT NULL,
	`readPages` integer DEFAULT 0 NOT NULL,
	`characters` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT 0 NOT NULL,
	`error` text,
	CONSTRAINT `fk_workspace_extractions_id_workspace_files_id_fk` FOREIGN KEY (`id`) REFERENCES `workspace_files`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workspace_extractions_status_check" CHECK("status" in ('pending', 'running', 'ready', 'empty', 'failed')),
	CONSTRAINT "workspace_extractions_truncated_check" CHECK("truncated" in (0, 1)),
	CONSTRAINT "workspace_extractions_attempts_check" CHECK("attempts" >= 0),
	CONSTRAINT "workspace_extractions_pages_check" CHECK("pages" >= 0),
	CONSTRAINT "workspace_extractions_readPages_check" CHECK("readPages" >= 0),
	CONSTRAINT "workspace_extractions_characters_check" CHECK("characters" >= 0)
);
--> statement-breakpoint
CREATE TABLE `workspace_files` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`mime` text NOT NULL,
	`kind` text NOT NULL,
	`size` integer NOT NULL,
	`createdAt` text NOT NULL,
	`status` text NOT NULL,
	`trashed` integer DEFAULT 0 NOT NULL,
	`hash` text NOT NULL,
	`visionHash` text,
	CONSTRAINT "workspace_files_kind_check" CHECK("kind" in ('image', 'text', 'video', 'document')),
	CONSTRAINT "workspace_files_status_check" CHECK("status" in ('uploading', 'ready')),
	CONSTRAINT "workspace_files_trashed_check" CHECK("trashed" in (0, 1)),
	CONSTRAINT "workspace_files_size_check" CHECK("size" >= 0)
);
--> statement-breakpoint
CREATE TABLE `workspace_video_preparations` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`duration` real DEFAULT 0 NOT NULL,
	`frames` integer DEFAULT 0 NOT NULL,
	`captions` integer DEFAULT 0 NOT NULL,
	`error` text,
	`retry_at` integer DEFAULT 0 NOT NULL,
	CONSTRAINT `fk_workspace_video_preparations_id_workspace_files_id_fk` FOREIGN KEY (`id`) REFERENCES `workspace_files`(`id`) ON DELETE CASCADE,
	CONSTRAINT "workspace_video_preparations_status_check" CHECK("status" in ('pending', 'running', 'ready', 'failed')),
	CONSTRAINT "workspace_video_preparations_captions_check" CHECK("captions" in (0, 1)),
	CONSTRAINT "workspace_video_preparations_attempts_check" CHECK("attempts" >= 0),
	CONSTRAINT "workspace_video_preparations_duration_check" CHECK("duration" >= 0),
	CONSTRAINT "workspace_video_preparations_frames_check" CHECK("frames" >= 0),
	CONSTRAINT "workspace_video_preparations_retry_at_check" CHECK("retry_at" >= 0)
);
--> statement-breakpoint
CREATE TABLE `__durable_pi_migrations` (
	`id` text PRIMARY KEY NOT NULL,
	`checksum` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tool_operation_history_operation` ON `tool_operation_history` (`operationId`,`id`);--> statement-breakpoint
CREATE INDEX `tool_operations_run` ON `tool_operations` (`turnId`,`createdAt`,`id`);--> statement-breakpoint
CREATE INDEX `generated_app_events_app_sequence` ON `generated_app_events` (`app_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `generated_app_events_queued_sequence` ON `generated_app_events` (`queued`,`sequence`);--> statement-breakpoint
CREATE INDEX `communication_outbox_due` ON `communication_outbox` (`status`,`next_at`);--> statement-breakpoint
CREATE INDEX `communication_tasks_direction_status_sequence` ON `communication_tasks` (`direction`,`status`,`sequence`);--> statement-breakpoint
CREATE INDEX `chat_recovery_run` ON `chat_recovery_history` (`turn_id`,`id`);--> statement-breakpoint
CREATE INDEX `chat_turns_status_sequence` ON `chat_turns` (`status`,`sequence`);--> statement-breakpoint
CREATE INDEX `chat_turns_parent_sequence` ON `chat_turns` (`parent_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `background_retries_group` ON `background_retries` (`group_id`);--> statement-breakpoint
CREATE INDEX `inference_attempts_run` ON `inference_attempts` (json_extract("payload", '$.turnId'));--> statement-breakpoint
CREATE INDEX `memory_note_history_source` ON `memory_note_history` (`source_id`);--> statement-breakpoint
CREATE INDEX `memory_notes_source` ON `memory_notes` (`source_id`);--> statement-breakpoint
CREATE INDEX `routine_runs_routine_sequence` ON `routine_runs` (`routine_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `routine_runs_status_sequence` ON `routine_runs` (`status`,`sequence`);--> statement-breakpoint
CREATE INDEX `workspace_files_created_id` ON `workspace_files` (`createdAt`,`id`);