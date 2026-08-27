CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_audit_logs_workspace_created` ON `audit_logs` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`company` text,
	`name` text NOT NULL,
	`title` text,
	`department` text,
	`email` text,
	`phone` text,
	`address` text,
	`website` text,
	`company_profile` text,
	`meeting_note` text,
	`generation_context` text,
	`status` text NOT NULL,
	`confidence` integer,
	`image_key` text,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_contacts_workspace_created` ON `contacts` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_contacts_workspace_status` ON `contacts` (`workspace_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_contacts_workspace_email` ON `contacts` (`workspace_id`,`email`);--> statement-breakpoint
CREATE TABLE `mail_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`contact_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`status` text NOT NULL,
	`provider_message_id` text,
	`subject` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_mail_events_workspace_created` ON `mail_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_memberships_workspace_user` ON `memberships` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_memberships_user` ON `memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`created_at` integer NOT NULL,
	`last_login_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_email` ON `users` (`email`);--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_workspaces_owner` ON `workspaces` (`owner_user_id`);