CREATE TABLE `agent_messages` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`operation_id` text NOT NULL UNIQUE,
	`sender_session` text NOT NULL,
	`sender_agent` text NOT NULL,
	`recipient_session` text NOT NULL,
	`recipient_agent` text NOT NULL,
	`payload` text NOT NULL,
	`state` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer NOT NULL,
	`error` text,
	CONSTRAINT "agent_messages_payload_json" CHECK(json_valid("payload")),
	CONSTRAINT "agent_messages_state_check" CHECK("state" in ('accepted','delivered','failed')),
	CONSTRAINT "agent_messages_attempts_check" CHECK("attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE `agent_session_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`closed` integer DEFAULT false NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "agent_session_requests_check" CHECK("requests" >= 0),
	CONSTRAINT "agent_session_closed_check" CHECK("closed" in (0, 1))
);
--> statement-breakpoint
ALTER TABLE `chat_turns` ADD `provenance` text;--> statement-breakpoint
ALTER TABLE `memory_log` ADD `provenance` text;--> statement-breakpoint
CREATE INDEX `agent_messages_pending` ON `agent_messages` (`state`,`retry_at`);--> statement-breakpoint
CREATE INDEX `agent_messages_recipient` ON `agent_messages` (`recipient_session`,`recipient_agent`,`sequence`);--> statement-breakpoint
CREATE INDEX `agent_messages_sender` ON `agent_messages` (`sender_session`,`sender_agent`);