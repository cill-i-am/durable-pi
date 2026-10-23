-- Add constrained columns in place: rebuilding chat_turns inside the shared
-- migration transaction cannot disable its existing self-referential foreign key.
ALTER TABLE `chat_turns` ADD `schema_version` integer DEFAULT 1 NOT NULL CONSTRAINT `chat_turns_schema_version_check` CHECK (`schema_version` >= 1);--> statement-breakpoint
ALTER TABLE `chat_turns` ADD `workflow_version` integer DEFAULT 1 NOT NULL CONSTRAINT `chat_turns_workflow_version_check` CHECK (`workflow_version` >= 1);--> statement-breakpoint
ALTER TABLE `chat_turns` ADD `control` text DEFAULT '{"owner":null,"deadline":null,"unconfirmed":null}' NOT NULL CONSTRAINT `chat_turns_control_json` CHECK (json_valid(`control`));
