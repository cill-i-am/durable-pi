ALTER TABLE `memory_backup_status` ADD `schema_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_backup_status` ADD `workflow_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_backup_status` ADD `phase` text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_backup_status` ADD `target` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_backup_status` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_backup_status` ADD `attempt_id` text;--> statement-breakpoint
ALTER TABLE `memory_backup_status` ADD `retry_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `memory_ready` ADD `control` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_memory_ready` (
	`start` integer NOT NULL,
	`count` integer NOT NULL,
	`control` text,
	CONSTRAINT `memory_ready_pk` PRIMARY KEY(`count`, `start`),
	CONSTRAINT "memory_ready_start_check" CHECK("start" >= 0),
	CONSTRAINT "memory_ready_count_check" CHECK("count" > 0),
	CONSTRAINT "memory_ready_control_json" CHECK("control" is null or json_valid("control"))
);
--> statement-breakpoint
INSERT INTO `__new_memory_ready`(`start`, `count`) SELECT `start`, `count` FROM `memory_ready`;--> statement-breakpoint
DROP TABLE `memory_ready`;--> statement-breakpoint
ALTER TABLE `__new_memory_ready` RENAME TO `memory_ready`;--> statement-breakpoint
PRAGMA foreign_keys=ON;