CREATE TABLE `whatsapp_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`message_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`sender` text NOT NULL,
	`body` text NOT NULL,
	`timestamp` integer NOT NULL,
	`agent_id` text NOT NULL,
	`generation` integer NOT NULL,
	`control` integer NOT NULL,
	`state` text NOT NULL,
	`reply` text DEFAULT '' NOT NULL,
	`provider_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "whatsapp_messages_state" CHECK("state" in ('queued','waiting','sending','sent','failed','uncertain','cancelled','expired')),
	CONSTRAINT "whatsapp_messages_control" CHECK("control" in (0,1))
);
--> statement-breakpoint
CREATE TABLE `whatsapp_retries` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`acknowledge_duplicate_risk` integer NOT NULL,
	CONSTRAINT `fk_whatsapp_retries_message_id_whatsapp_messages_id_fk` FOREIGN KEY (`message_id`) REFERENCES `whatsapp_messages`(`id`),
	CONSTRAINT "whatsapp_retries_acknowledgement" CHECK("acknowledge_duplicate_risk" in (0,1))
);
--> statement-breakpoint
CREATE TABLE `whatsapp_settings` (
	`id` integer PRIMARY KEY,
	`enabled` integer NOT NULL,
	`agent_id` text NOT NULL,
	`revision` integer NOT NULL,
	`generation` integer NOT NULL,
	`operation_id` text NOT NULL,
	`last_inbound_at` integer NOT NULL,
	CONSTRAINT "whatsapp_settings_singleton" CHECK("id" = 1),
	CONSTRAINT "whatsapp_settings_enabled" CHECK("enabled" in (0,1)),
	CONSTRAINT "whatsapp_settings_revision" CHECK("revision" >= 0),
	CONSTRAINT "whatsapp_settings_generation" CHECK("generation" >= 0)
);
--> statement-breakpoint
CREATE INDEX `whatsapp_messages_state_created` ON `whatsapp_messages` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `whatsapp_retries_message` ON `whatsapp_retries` (`message_id`);