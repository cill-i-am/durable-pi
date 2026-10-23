ALTER TABLE `email_messages` ADD `schemaVersion` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_messages` ADD `workflowVersion` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_messages` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `email_messages` ADD `attempt_id` text;--> statement-breakpoint
ALTER TABLE `email_messages` ADD `send_index` integer;--> statement-breakpoint
ALTER TABLE `email_messages` ADD `send_deadline` integer;--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `schemaVersion` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `workflowVersion` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `attempt_id` text;--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `send_index` integer;--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `send_deadline` integer;