ALTER TABLE `email_messages` ADD `work_deadline` integer;--> statement-breakpoint
ALTER TABLE `whatsapp_messages` ADD `work_deadline` integer;--> statement-breakpoint
UPDATE `email_messages` SET `work_deadline` = CAST(unixepoch('subsec') * 1000 AS integer) + 60000 WHERE `state` IN ('queued', 'waiting');
--> statement-breakpoint
UPDATE `whatsapp_messages` SET `work_deadline` = CAST(unixepoch('subsec') * 1000 AS integer) + 60000 WHERE `state` IN ('queued', 'waiting');
