CREATE TABLE `invitation` (
	`id` text PRIMARY KEY,
	`organizationId` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`delivery` text DEFAULT 'pending' NOT NULL,
	`inviterId` text NOT NULL,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	CONSTRAINT `fk_invitation_organizationId_organization_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_invitation_inviterId_user_id_fk` FOREIGN KEY (`inviterId`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `member` (
	`id` text PRIMARY KEY,
	`organizationId` text NOT NULL,
	`userId` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`createdAt` integer NOT NULL,
	CONSTRAINT `fk_member_organizationId_organization_id_fk` FOREIGN KEY (`organizationId`) REFERENCES `organization`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_member_userId_user_id_fk` FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `organization` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`slug` text NOT NULL UNIQUE,
	`logo` text,
	`metadata` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer
);
--> statement-breakpoint
ALTER TABLE `session` ADD `activeOrganizationId` text;--> statement-breakpoint
CREATE INDEX `invitation_organization_email` ON `invitation` (`organizationId`,`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `member_organization_user` ON `member` (`organizationId`,`userId`);--> statement-breakpoint
CREATE INDEX `member_user` ON `member` (`userId`);
--> statement-breakpoint
-- Earlier releases admitted only the configured owner. Preserve its namespace.
INSERT INTO organization (id, name, slug, createdAt)
SELECT 'family', 'Barron family', 'family', createdAt FROM user ORDER BY createdAt LIMIT 1;
--> statement-breakpoint
INSERT INTO member (id, organizationId, userId, role, createdAt)
SELECT 'family-owner', 'family', id, 'owner', createdAt FROM user ORDER BY createdAt LIMIT 1;
