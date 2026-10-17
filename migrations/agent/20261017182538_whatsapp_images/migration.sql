CREATE TABLE `workspace_image_replies` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`turn_id` text NOT NULL,
	`file_id` text NOT NULL,
	CONSTRAINT `fk_workspace_image_replies_file_id_workspace_files_id_fk` FOREIGN KEY (`file_id`) REFERENCES `workspace_files`(`id`)
);
--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `image` text;--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `image_file_id` text;--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `outbound_image_id` text;--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `image_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `workspace_image_replies_turn` ON `workspace_image_replies` (`turn_id`);--> statement-breakpoint
CREATE INDEX `workspace_image_replies_file` ON `workspace_image_replies` (`file_id`);