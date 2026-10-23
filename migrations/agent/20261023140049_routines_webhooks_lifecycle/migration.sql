ALTER TABLE `webhooks` ADD `schema_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `workflow_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_routine_runs` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`routine_id` text NOT NULL,
	`turn_id` text NOT NULL UNIQUE,
	`status` text NOT NULL,
	`record` text NOT NULL,
	CONSTRAINT `fk_routine_runs_routine_id_routines_id_fk` FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON DELETE RESTRICT,
	CONSTRAINT "routine_runs_status_check" CHECK("status" in ('pending', 'queued', 'stopping', 'unconfirmed', 'done', 'failed', 'cancelled')),
	CONSTRAINT "routine_runs_record_json" CHECK(json_valid("record"))
);
--> statement-breakpoint
INSERT INTO `__new_routine_runs`(`sequence`, `id`, `routine_id`, `turn_id`, `status`, `record`) SELECT `sequence`, `id`, `routine_id`, `turn_id`, `status`, `record` FROM `routine_runs`;--> statement-breakpoint
DROP TABLE `routine_runs`;--> statement-breakpoint
ALTER TABLE `__new_routine_runs` RENAME TO `routine_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `routine_runs_routine_sequence` ON `routine_runs` (`routine_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `routine_runs_status_sequence` ON `routine_runs` (`status`,`sequence`);
--> statement-breakpoint
UPDATE `routines`
SET `record` = json_set(`record`, '$.schemaVersion', 1, '$.workflowVersion', 1)
WHERE json_type(`record`, '$.schemaVersion') IS NULL
  AND json_type(`record`, '$.workflowVersion') IS NULL;
--> statement-breakpoint
UPDATE `routine_runs`
SET `record` = json_set(`record`, '$.schemaVersion', 1, '$.workflowVersion', 1,
  '$.controlRevision', 0, '$.admissionDeadline', json_extract(`record`, '$.createdAt') + 86400000)
WHERE json_type(`record`, '$.schemaVersion') IS NULL
  AND json_type(`record`, '$.workflowVersion') IS NULL;
