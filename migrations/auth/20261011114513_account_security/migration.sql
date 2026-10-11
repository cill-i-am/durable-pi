CREATE TABLE `twoFactor` (
	`id` text PRIMARY KEY,
	`userId` text NOT NULL UNIQUE,
	`secret` text NOT NULL,
	`backupCodes` text NOT NULL,
	`verified` integer DEFAULT true,
	`failedVerificationCount` integer DEFAULT 0,
	`lockedUntil` integer,
	CONSTRAINT `fk_twoFactor_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `user` ADD `twoFactorEnabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
