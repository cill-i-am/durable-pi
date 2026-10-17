CREATE TABLE `email_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`message_id` text NOT NULL,
	`sender` text NOT NULL,
	`recipient` text NOT NULL,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`references` text NOT NULL,
	`state` text NOT NULL,
	`reply` text DEFAULT '' NOT NULL,
	`provider_id` text,
	`error` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "email_messages_state" CHECK("state" in ('queued','waiting','sending','sent','failed','uncertain','cancelled'))
);
--> statement-breakpoint
CREATE TABLE `email_retries` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`email_id` text NOT NULL,
	`acknowledge_duplicate_risk` integer NOT NULL,
	CONSTRAINT `fk_email_retries_email_id_email_messages_id_fk` FOREIGN KEY (`email_id`) REFERENCES `email_messages`(`id`),
	CONSTRAINT "email_retries_acknowledgement" CHECK("acknowledge_duplicate_risk" in (0,1))
);
--> statement-breakpoint
CREATE TABLE `email_settings` (
	`id` integer PRIMARY KEY,
	`enabled` integer NOT NULL,
	`revision` integer NOT NULL,
	`generation` integer NOT NULL,
	`operation_id` text NOT NULL,
	CONSTRAINT "email_settings_singleton" CHECK("id" = 1),
	CONSTRAINT "email_settings_enabled" CHECK("enabled" in (0,1)),
	CONSTRAINT "email_settings_revision" CHECK("revision" >= 0),
	CONSTRAINT "email_settings_generation" CHECK("generation" >= 0)
);
--> statement-breakpoint
CREATE INDEX `email_messages_state_created` ON `email_messages` (`state`,`created_at`);--> statement-breakpoint
CREATE INDEX `email_retries_email` ON `email_retries` (`email_id`);