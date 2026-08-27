import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(), email: text('email').notNull(), displayName: text('display_name'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(), lastLoginAt: integer('last_login_at', { mode: 'timestamp' }).notNull(),
}, (table) => [uniqueIndex('idx_users_email').on(table.email)]);

export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(), name: text('name').notNull(), ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [index('idx_workspaces_owner').on(table.ownerUserId)]);

export const memberships = sqliteTable('memberships', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  userId: text('user_id').notNull().references(() => users.id), role: text('role', { enum: ['owner', 'admin', 'member', 'viewer'] }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [uniqueIndex('idx_memberships_workspace_user').on(table.workspaceId, table.userId), index('idx_memberships_user').on(table.userId)]);

export const contacts = sqliteTable('contacts', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  createdByUserId: text('created_by_user_id').notNull().references(() => users.id), company: text('company'), name: text('name').notNull(),
  title: text('title'), department: text('department'), email: text('email'), phone: text('phone'), address: text('address'), website: text('website'),
  companyProfile: text('company_profile'), meetingNote: text('meeting_note'), generationContext: text('generation_context'),
  status: text('status', { enum: ['ready', 'needs_review', 'sent', 'archived'] }).notNull(), confidence: integer('confidence'), imageKey: text('image_key'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(), deletedAt: integer('deleted_at', { mode: 'timestamp' }),
}, (table) => [index('idx_contacts_workspace_created').on(table.workspaceId, table.createdAt), index('idx_contacts_workspace_status').on(table.workspaceId, table.status), index('idx_contacts_workspace_email').on(table.workspaceId, table.email)]);

export const mailEvents = sqliteTable('mail_events', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  contactId: text('contact_id').notNull().references(() => contacts.id), actorUserId: text('actor_user_id').notNull().references(() => users.id),
  status: text('status', { enum: ['pending', 'sent', 'failed', 'cancelled'] }).notNull(), providerMessageId: text('provider_message_id'),
  subject: text('subject'), createdAt: integer('created_at', { mode: 'timestamp' }).notNull(), sentAt: integer('sent_at', { mode: 'timestamp' }),
}, (table) => [index('idx_mail_events_workspace_created').on(table.workspaceId, table.createdAt)]);

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(), workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  actorUserId: text('actor_user_id').notNull().references(() => users.id), action: text('action').notNull(), targetType: text('target_type').notNull(),
  targetId: text('target_id'), metadata: text('metadata'), createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
}, (table) => [index('idx_audit_logs_workspace_created').on(table.workspaceId, table.createdAt)]);
