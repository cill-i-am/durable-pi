ALTER TABLE `background_handoffs` ADD `schema_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `background_handoffs` ADD `workflow_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `background_handoffs` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `background_handoffs` ADD `stop_state` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `background_handoffs` ADD `stop_attempt` text;--> statement-breakpoint
ALTER TABLE `background_handoffs` ADD `stop_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `background_handoffs` ADD `stop_next_at` integer;--> statement-breakpoint
ALTER TABLE `background_handoffs` ADD `stop_deadline` integer;--> statement-breakpoint
ALTER TABLE `background_handoffs` ADD `stop_error` text;--> statement-breakpoint
ALTER TABLE `email_settings` ADD `schemaVersion` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_settings` ADD `workflowVersion` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `whatsapp_settings` ADD `schemaVersion` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `whatsapp_settings` ADD `workflowVersion` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
UPDATE `background_handoffs` SET `stop_state` = 'pending', `stop_next_at` = 0 WHERE `status` = 'cancelled';
