ALTER TABLE `agent_catalog` ADD `schemaVersion` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_catalog` ADD `workflowVersion` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_admission` ADD `schemaVersion` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `bot_admission` ADD `workflowVersion` integer DEFAULT 1 NOT NULL;