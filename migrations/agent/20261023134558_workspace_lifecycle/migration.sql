ALTER TABLE `workspace_extractions` ADD `lifecycle_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_extractions` ADD `attempt_id` text;--> statement-breakpoint
ALTER TABLE `workspace_extractions` ADD `artifact_hash` text;--> statement-breakpoint
ALTER TABLE `workspace_extractions` ADD `recovery_deadline` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_files` ADD `lifecycle_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_files` ADD `attempt_id` text;--> statement-breakpoint
ALTER TABLE `workspace_video_preparations` ADD `lifecycle_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `workspace_video_preparations` ADD `attempt_id` text;--> statement-breakpoint
ALTER TABLE `workspace_video_preparations` ADD `artifact_hash` text;--> statement-breakpoint
ALTER TABLE `workspace_video_preparations` ADD `recovery_deadline` integer DEFAULT 0 NOT NULL;