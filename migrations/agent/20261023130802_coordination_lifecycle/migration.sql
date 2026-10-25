ALTER TABLE `agent_messages` ADD `schema_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `workflow_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `phase` text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_messages` ADD `attempt_id` text;--> statement-breakpoint
UPDATE `agent_messages` SET `phase` = CASE `state` WHEN 'accepted' THEN 'pending' WHEN 'delivered' THEN 'delivered' WHEN 'failed' THEN 'failed' END;
