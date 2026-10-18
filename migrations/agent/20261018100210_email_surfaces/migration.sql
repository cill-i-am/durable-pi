ALTER TABLE `agent_catalog` ADD `slug` text;--> statement-breakpoint
ALTER TABLE `email_messages` ADD `files` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `email_messages` ADD `purpose` text DEFAULT 'request' NOT NULL;--> statement-breakpoint
ALTER TABLE `email_messages` ADD `notice_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_catalog_slug` ON `agent_catalog` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `email_messages_notice` ON `email_messages` (`notice_key`);