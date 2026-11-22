import { isNotNull, sql } from 'drizzle-orm';
import type { CanonicalPath } from '@gugu/session-shared/canonical-path';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { versionedJsonColumn } from '@main/db/versioned-column';
import {
  automationAgentConfig,
  automationTriggerConfig,
  storedAutomationSessionConfig,
} from '@shared/core/automations/config';
import { sessionConfig } from '@shared/core/sessions/session-config';
import { linkedIssue } from '@shared/core/linked-issue';
import { providerAccountMeta } from '@shared/core/provider-accounts/provider-account-meta';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';
import { workspaceConfig } from '@shared/core/workspaces/workspace-config';
import { workspaceProviderData } from '@shared/core/workspaces/workspace-provider-data';
import type { Hold } from '@gugu/core/local/session-life/types';

/** Durable local IM rows. Their original body is never part of the disposable search schema. */
export const imMessages = sqliteTable('im_messages', {
  rowid: integer('rowid').primaryKey(),
  accountId: text('account_id').notNull(),
  id: text('id').notNull(),
  chatId: text('chat_id').notNull(),
  threadRootId: text('thread_root_id'),
  seq: integer('seq').notNull(),
  senderUserId: text('sender_user_id'),
  createdAt: text('created_at').notNull(),
  contentType: text('content_type').notNull(),
  content: text('content'),
  isWhisper: integer('is_whisper').notNull(),
  toUserIds: text('to_user_ids').notNull(),
  fileItemId: text('file_item_id'),
  rest: text('rest').notNull(),
  /** The account revision that first delivered this message: its notification claim (@@@arrival-claim). */
  claimedRevision: text('claimed_revision'),
}, table => ({
  key: uniqueIndex('im_messages_account_id').on(table.accountId, table.id),
  stream: index('im_messages_stream').on(table.accountId, table.chatId, table.threadRootId, table.seq),
}));

export const imMessageAccounts = sqliteTable('im_message_accounts', {
  accountId: text('account_id').primaryKey().notNull(),
  throughRevision: text('through_revision').notNull(),
});

/** Permission facts for histories, including observer topics absent from the published chat list. */
export const imMessageChats = sqliteTable('im_message_chats', {
  accountId: text('account_id').notNull(),
  chatId: text('chat_id').notNull(),
  sourceChatId: text('source_chat_id'),
  ownMember: integer('own_member'),
  membershipRevoked: integer('membership_revoked').notNull().default(0),
  membershipRevision: text('membership_revision'),
  chatRevision: text('chat_revision'),
  archived: integer('archived').notNull().default(0),
  historyClearedAt: text('history_cleared_at'),
}, table => ({
  key: primaryKey({ columns: [table.accountId, table.chatId] }),
  source: index('im_message_chats_source').on(table.accountId, table.sourceChatId, table.ownMember),
}));

/** Empty message_id is an authoritative conversation departure; other rows are actual message deletions. */
export const imMessageTombstones = sqliteTable('im_message_tombstones', {
  accountId: text('account_id').notNull(),
  chatId: text('chat_id').notNull(),
  messageId: text('message_id').notNull(),
}, table => ({ key: primaryKey({ columns: [table.accountId, table.chatId, table.messageId] }) }));

/** Complete visible sequence intervals; missing ranges always require a network read. */
export const imMessageRanges = sqliteTable('im_message_ranges', {
  accountId: text('account_id').notNull(),
  chatId: text('chat_id').notNull(),
  threadRootId: text('thread_root_id').notNull().default(''),
  fromSeq: integer('from_seq').notNull(),
  toSeq: integer('to_seq').notNull(),
}, table => ({ key: primaryKey({ columns: [table.accountId, table.chatId, table.threadRootId, table.fromSeq] }) }));

export const activityEvents = sqliteTable('activity_events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  eventId: text('event_id').notNull().unique(),
  occurredAt: integer('occurred_at'),
  observedAt: integer('observed_at').notNull(),
  kind: text('kind').notNull(),
  sessionId: text('session_id'),
  /** @@@c1-legacy-project — read only by the previous release after a rollback. */
  projectId: text('project_id'),
  /** The group the event happened in (@@@group-folders); null = none. */
  chatId: text('chat_id'),
  data: text('data').notNull(),
}, table => ({ time: index('activity_events_time').on(table.occurredAt, table.seq),
  session: index('activity_events_session').on(table.sessionId, table.seq),
  project: index('activity_events_project').on(table.projectId, table.seq),
  chat: index('activity_events_chat').on(table.chatId, table.seq) }));

/**
 * The group each session lives in, kept after the session row goes (events like session.deleted are journaled after the
 * row is gone). Filled by a trigger on sessions; sessions never change group (@@@group-folders).
 */
export const activitySessionChats = sqliteTable('activity_session_chats', {
  sessionId: text('session_id').primaryKey(),
  chatId: text('chat_id'),
});

export const activityCoverage = sqliteTable('activity_coverage', {
  id: text('id').primaryKey(),
  startedAt: integer('started_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  endedAt: integer('ended_at'),
});

/** Written by a trigger on `sessions` (migration 0038); the activity journal reads it to place events in projects. */
export const activitySessionProjects = sqliteTable('activity_session_projects', {
  sessionId: text('session_id').primaryKey(),
  projectId: text('project_id').notNull(),
});

/**
 * SSH 远程已下架(#6264):表与引用它的列只为保留旧行而留在库里,产品代码不再读写。
 */
export const sshConnections = sqliteTable(
  'ssh_connections',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull().default(22),
    username: text('username').notNull(),
    authType: text('auth_type').notNull().default('agent'), // 'password' | 'key' | 'agent'
    privateKeyPath: text('private_key_path'), // optional, for key auth
    useAgent: integer('use_agent').notNull().default(0), // boolean, 0=false, 1=true
    metadata: text('metadata'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameIdx: uniqueIndex('idx_ssh_connections_name').on(table.name),
    hostIdx: index('idx_ssh_connections_host').on(table.host),
  })
);

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** In its one spelling on this machine (`@@@canonical-path`): written only as `canonicalPath` made it. */
    path: text('path').notNull().$type<CanonicalPath>(),
    workspaceProvider: text('workspace_provider').notNull().default('local'), // 'local' | 'ssh'
    baseRef: text('base_ref'),
    // gugu #2358: 非 git 项目标记。base_ref 自 0000 起就 nullable + 读路径 `?? 'main'` 兜底
    // （旧版本建的 git 项目 base_ref 也可能为 null），故不能用 base_ref===null 当非 git
    // 标记（会与 legacy null-git 撞车）。显式布尔列消歧:仅本列 true = 非 git,读路径据此把
    // baseRef 还原成 null（见 getProjects），既存行默认 false → 一律按 git 处理,不误伤。
    gitless: integer('gitless', { mode: 'boolean' }).notNull().default(false),
    sshConnectionId: text('ssh_connection_id').references(() => sshConnections.id, {
      onDelete: 'set null',
    }),
    /** The shared workspace representing this project's repository root. Set on first mount. */
    repositoryWorkspaceId: text('repository_workspace_id'),
    /** The root workspace remains available to historical sessions after its folder is detached. */
    rootFolderDetached: integer('root_folder_detached', { mode: 'boolean' }).notNull().default(false),
    /** Project removal hides its directory memberships without discarding them. */
    archivedAt: text('archived_at'),
    /** #609: 'project' = the person created or opened it; 'workspace' = a directory the app keeps for its own needs. */
    kind: text('kind').$type<'project' | 'workspace'>().notNull().default('project'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    pathIdx: uniqueIndex('idx_projects_path').on(table.path),
    sshConnectionIdIdx: index('idx_projects_ssh_connection_id').on(table.sshConnectionId),
  })
);

export const projectRemotes = sqliteTable(
  'project_remotes',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    remoteName: text('remote_name').notNull(),
    remoteUrl: text('remote_url').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.remoteName] }),
  })
);

export const projectSettings = sqliteTable('project_settings', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  baseProjectSettingsJson: text('base_project_settings_json').notNull().default('{}'),
  shareableProjectSettingsJson: text('shareable_project_settings_json').notNull().default('{}'),
  legacyConfigMigratedAt: text('legacy_config_migrated_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const appSettings = sqliteTable(
  'app_settings',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    keyIdx: uniqueIndex('idx_app_settings_key').on(table.key),
  })
);

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    key: text('key'),
    type: text('type').notNull().$type<'local' | 'project-ssh' | 'byoi'>(), // @deprecated — use kind + location
    /** Describes the nature of the workspace: a git worktree, the project root, a folder attached to a project (`path`), or BYOI. */
    kind: text('kind').$type<'worktree' | 'project-root' | 'path' | 'byoi'>(),
    /** Where the workspace runs: on the local machine or over SSH. */
    location: text('location').$type<'local' | 'remote'>(),
    /** FK to ssh_connections; only set when location = 'remote'. */
    sshConnectionId: text('ssh_connection_id').references(() => sshConnections.id, {
      onDelete: 'set null',
    }),
    data: versionedJsonColumn(workspaceProviderData)('data'),
    /** In its one spelling on this machine (`@@@canonical-path`): written only as `canonicalPath` made it. */
    path: text('path').$type<CanonicalPath>(),
    config: versionedJsonColumn(workspaceConfig)('config'),
    branchName: text('branch_name'),
    linesAdded: integer('lines_added'),
    linesDeleted: integer('lines_deleted'),
    /**
     * #7341 这个文件夹挂在哪个项目下(product spec「挂文件夹」)。根目录**不**记在这里 ——
     * 它由 `projects.repositoryWorkspaceId` 指着;null = 没挂在任何项目下。
     */
    /** @@@c1-legacy-project — read only by the previous release after a rollback; C1 never reads or writes it. */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /**
     * The group this folder is bound to on this device (a group is the only container); null = a folder the device
     * keeps without a group (the task home, a cloud computer's working directory, an App's own directory).
     */
    chatId: text('chat_id'),
    /** Order of a group's folders on this device: the first is where a new task starts by default. */
    sort: integer('sort'),
    /** A folder that is not a git repository (base_ref null means "main" for a git folder). */
    gitless: integer('gitless', { mode: 'boolean' }).notNull().default(false),
    baseRef: text('base_ref'),
    /** When the folder was bound to its group (ISO); null when it has none. */
    attachedAt: text('attached_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    keyIdx: uniqueIndex('idx_workspaces_key').on(table.key).where(isNotNull(table.key)),
    projectIdIdx: index('idx_workspaces_project_id').on(table.projectId),
    chatIdx: index('idx_workspaces_chat_id').on(table.chatId, table.sort),
  })
);

/**
 * Settings of a repository-root folder (formerly per project): base, shareable and migration marker, as
 * `project_settings` had them. Keyed by the root folder's workspace id.
 */
export const workspaceSettings = sqliteTable('workspace_settings', {
  workspaceId: text('workspace_id').primaryKey(),
  baseSettingsJson: text('base_settings_json').notNull().default('{}'),
  shareableSettingsJson: text('shareable_settings_json').notNull().default('{}'),
  legacyConfigMigratedAt: text('legacy_config_migrated_at'),
  createdAt: text('created_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at').notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** Git remotes of a repository-root folder (formerly `project_remotes`). */
export const workspaceRemotes = sqliteTable(
  'workspace_remotes',
  {
    workspaceId: text('workspace_id').notNull(),
    remoteName: text('remote_name').notNull(),
    remoteUrl: text('remote_url').notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.workspaceId, table.remoteName] }) })
);

/**
 * Local project ids of earlier releases, kept forever where they were written down outside this database: cloud file
 * versions (`host_project_id`), task cards, `gugu://project/` links, tmux session names, agent-create defaults.
 * Written once by the C1 migration, never after: an id with no row here is gone.
 */
export const legacyProjectAliases = sqliteTable('legacy_project_aliases', {
  projectId: text('project_id').primaryKey(),
  /** The project's repository-root folder; its path is what the project's relative paths are relative to. */
  rootWorkspaceId: text('root_workspace_id'),
  chatId: text('chat_id'),
});

/**
 * This device's own published file versions by chat item (formerly the `files` part of taskpage-project-groups.json):
 * a cache of the database's immutable version records, filled when this device publishes a version or the database
 * answers for one.
 */
export const fileRevisionCache = sqliteTable(
  'file_revision_cache',
  {
    accountId: text('account_id').notNull(),
    itemId: text('item_id').notNull(),
    version: integer('version').notNull(),
    revisionJson: text('revision_json').notNull(),
  },
  (table) => ({ pk: primaryKey({ columns: [table.accountId, table.itemId, table.version] }) })
);

export const pullRequestUsers = sqliteTable('pull_request_users', {
  userId: text('user_id').primaryKey(),
  userName: text('user_name').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  url: text('url'),

  userUpdatedAt: text('user_updated_at'),
  userCreatedAt: text('user_created_at'),
});

export const pullRequests = sqliteTable(
  'pull_requests',
  {
    url: text('url').primaryKey(),
    provider: text('provider').notNull().default('github'),
    repositoryUrl: text('repository_url').notNull(),

    baseRefName: text('base_ref_name').notNull(),
    baseRefOid: text('base_ref_oid').notNull(),

    headRepositoryUrl: text('head_repository_url').notNull(),
    headRefName: text('head_ref_name').notNull(),
    headRefOid: text('head_ref_oid').notNull(),

    identifier: text('identifier'), // #123 for github
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('open'),
    isDraft: integer('is_draft'),

    authorUserId: text('author_user_id').references(() => pullRequestUsers.userId, {
      onDelete: 'set null',
    }),

    additions: integer('additions'),
    deletions: integer('deletions'),
    changedFiles: integer('changed_files'),
    commitCount: integer('commit_count'),

    mergeableStatus: text('mergeable_status'),
    mergeStateStatus: text('merge_state_status'),
    reviewDecision: text('review_decision'),

    pullRequestCreatedAt: text('pull_request_created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    pullRequestUpdatedAt: text('pull_request_updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    urlIdx: uniqueIndex('idx_pull_requests_url').on(table.url),
    repositoryUrlIdx: index('idx_pull_requests_repository_url').on(table.repositoryUrl),
    headRepositoryUrlIdx: index('idx_pull_requests_head_repository_url').on(
      table.headRepositoryUrl
    ),
  })
);

export const pullRequestLabels = sqliteTable(
  'pull_request_labels',
  {
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.url, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pullRequestId, table.name] }),
    nameIdx: index('idx_prl_name').on(table.name),
  })
);

export const pullRequestAssignees = sqliteTable(
  'pull_request_assignees',
  {
    pullRequestUrl: text('pull_request_url')
      .notNull()
      .references(() => pullRequests.url, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => pullRequestUsers.userId, { onDelete: 'cascade' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pullRequestUrl, table.userId] }),
    pullRequestUrlIdx: index('idx_pra_pull_request_url').on(table.pullRequestUrl),
    userIdIdx: index('idx_pra_user_id').on(table.userId),
  })
);

export const pullRequestChecks = sqliteTable(
  'pull_request_checks',
  {
    id: text('id').primaryKey(),
    pullRequestUrl: text('pull_request_url')
      .notNull()
      .references(() => pullRequests.url, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    conclusion: text('conclusion').notNull(),

    detailsUrl: text('details_url'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    workflowName: text('workflow_name'),
    appName: text('app_name'),
    appLogoUrl: text('app_logo_url'),
  },
  (table) => ({
    pullRequestUrlIdx: index('idx_prc_pull_request_url').on(table.pullRequestUrl),
  })
);

export const automations = sqliteTable(
  'automations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    /** @@@c1-legacy-project — read only by the previous release after a rollback. */
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    /** The folder an automation's sessions start in. */
    workspaceId: text('workspace_id'),
    triggerConfig: versionedJsonColumn(automationTriggerConfig)('trigger_config'),
    agentConfig: versionedJsonColumn(automationAgentConfig)('agent_config'),
    sessionConfig: versionedJsonColumn(storedAutomationSessionConfig)('session_config'),
    enabled: integer('enabled').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    /**
     * #7221 非空 = agent 给自己排的:到点把 prompt 送回这条会话,不新开会话。
     * No FK cascade: true deletion uses the automation service's run cleanup/barrier; list load repairs older orphans.
     * Archiving retains this identity and its schedule so Restore can show it again.
     */
    agentSessionId: text('agent_session_id'),
  },
  (table) => ({
    projectIdIdx: index('idx_automations_project_id').on(table.projectId),
    agentSessionIdx: index('idx_automations_agent_session_id').on(table.agentSessionId),
  })
);

export const automationRuns = sqliteTable(
  'automation_runs',
  {
    id: text('id').primaryKey(),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    scheduledAt: integer('scheduled_at'),
    deadlineAt: integer('deadline_at'),
    startedAt: integer('started_at'),
    sessionCreatedAt: integer('session_created_at'),
    launchedAt: integer('launched_at'),
    finishedAt: integer('finished_at'),
    status: text('status').notNull(),
    error: text('error'),
    triggerKind: text('trigger_kind').notNull(),
    triggerConfigSnapshot: text('trigger_config_snapshot').notNull().default('{}'),
    agentConfigSnapshot: text('agent_config_snapshot').notNull().default('{}'),
    sessionConfigSnapshot: text('session_config_snapshot'),
    generatedSessionName: text('generated_session_name'),
  },
  (table) => ({
    automationStartedIdx: index('idx_automation_runs_automation_started').on(
      table.automationId,
      table.startedAt
    ),
    automationScheduledIdx: index('idx_automation_runs_automation_scheduled').on(
      table.automationId,
      table.scheduledAt
    ),
    automationStatusIdx: index('idx_automation_runs_automation_status').on(
      table.automationId,
      table.status
    ),
    statusIdx: index('idx_automation_runs_status').on(table.status),
    statusScheduledIdx: index('idx_automation_runs_status_scheduled').on(
      table.status,
      table.scheduledAt
    ),
  })
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    /**
     * @@@c1-legacy-project — read only by the previous release after a rollback: C1 writes the placeholder project
     * (`LEGACY_PLACEHOLDER_PROJECT_ID`) so that release still boots; dropped next release.
     */
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** The group this session lives in (null: no group, e.g. the task home). Its cwd is `workspaceId`. */
    chatId: text('chat_id'),
    /** Read only by the previous release after a rollback (0043 @@@rollback-title); dropped next release. */
    legacyTitle: text('title').notNull().default(''),
    provider: text('provider'),
    config: versionedJsonColumn(sessionConfig)('config'),
    lifeHold: text('life_hold', { mode: 'json' }).$type<Hold | null>(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    lastInteractedAt: text('last_interacted_at'),
    providerSessionId: text('provider_session_id'),
    agentStatus: text('agent_status'),
    agentStatusSeen: integer('agent_status_seen').default(1),
    /** spec agent-status「附属态」:显示用的细分(running / parked / approval / … / done / plain),可空。 */
    agentStatusDetail: text('agent_status_detail'),
    runtime: text('runtime'),
    // spec session-page: any conversation can be pinned; pinned rows leave their state group
    // and gather in the sidebar's Pinned section.
    isPinned: integer('is_pinned').notNull().default(0),
    // #2548 固定到左侧栏: a top-level session whose agent lives in a group or project also gets its own row
    // in the desktop left list. Independent of isPinned, which only orders a session within its own list.
    isPinnedToSidebar: integer('is_pinned_to_sidebar').notNull().default(0),
    parentSessionId: text('parent_session_id').references(
      (): AnySQLiteColumn => sessions.id,
      { onDelete: 'set null' }
    ),
    /**
     * The extension that started this conversation, when one did.
     *
     * A plain string, ❌ 不设外键:扩展卸载之后这条痕迹必须还在(behavior
     * tab-extensions:「卸载后照跑不误,标记留存并显示为『由已卸载的扩展 X 发起』」)。
     * 外键会把「发起者不在了」变成「发起者是 null」,而那正是用户最需要看见的
     * 那一条信息。
     */
    spawnedByExtensionId: text('spawned_by_extension_id'),
    spawnedBySessionId: text('spawned_by_session_id').references(
      (): AnySQLiteColumn => sessions.id,
      { onDelete: 'set null' }
    ),
    /**
     * spec session-graph:归档的归属键是**这条会话自己**。null = 在会话列表里,时间戳 = 已归档。
     * 会话可不可见只问这一列。
     */
    archivedAt: text('archived_at'),
    /** 这条会话在哪个工作区里干活。多条会话可以共享一个(spawn 出来的子会话就是这样)。 */
    workspaceId: text('workspace_id'),
    /** 新建会话时挑的 issue;首句会提及它,输入框里可以 @ 它。 */
    linkedIssue: versionedJsonColumn(linkedIssue)('linked_issue'),
    /** 有值 = 这条会话是这次自动化运行建出来的(非交互)。运行删了,会话留下、这一格置空。 */
    automationRunId: text('automation_run_id').references(() => automationRuns.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    workspaceIdIdx: index('idx_sessions_workspace_id').on(table.workspaceId),
    chatIdx: index('idx_sessions_chat_id').on(table.chatId),
    parentSessionIdIdx: index('idx_sessions_parent_session_id').on(
      table.parentSessionId
    ),
    spawnedByExtensionIdIdx: index('idx_sessions_spawned_by_extension_id').on(
      table.spawnedByExtensionId
    ),
    spawnedBySessionIdIdx: index('idx_sessions_spawned_by_session_id').on(
      table.spawnedBySessionId
    ),
  })
);

export const terminals = sqliteTable(
  'terminals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    ssh: integer('ssh').notNull().default(0), // boolean, 0=false, 1=true
    name: text('name').notNull(),
    shellId: text('shell_id').$type<TerminalShellId>().notNull().default('system'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    sessionIdIdx: index('idx_terminals_session_id').on(table.sessionId),
  })
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    sender: text('sender').notNull(),
    timestamp: text('timestamp')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    metadata: text('metadata'),
  },
  (table) => ({
    sessionIdIdx: index('idx_messages_session_id').on(table.sessionId),
    timestampIdx: index('idx_messages_timestamp').on(table.timestamp),
  })
);

export const sessionPending = sqliteTable('session_pending', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  sessionId: text('session_id').notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  messageId: text('message_id').notNull().references(() => messages.id, { onDelete: 'cascade' }),
  kind: text('kind', { enum: ['ordinary', 'session-direct', 'inbox-batch'] }).notNull(),
  state: text('state', { enum: ['queued', 'dispatching', 'accepted', 'failed', 'unknown'] }).notNull(),
  attempt: integer('attempt'),
  nativeReceiptId: text('native_receipt_id'),
  /**
   * JSON SerializedError, two meanings by state (one fact per row, never both):
   * - failed: why the row failed (final, reported to its sources);
   * - queued / dispatching: the row lost its channel once before admission (#552) and was put back; a second loss fails it.
   */
  failure: text('failure'),
  enqueuedAt: text('enqueued_at').notNull().default(sql`CURRENT_TIMESTAMP`),
  settledAt: text('settled_at'),
}, table => ({ message: uniqueIndex('idx_session_pending_message').on(table.sessionId, table.messageId),
  queue: index('idx_session_pending_queue').on(table.sessionId, table.state, table.seq) }));

export const sessionPendingSource = sqliteTable('session_pending_source', {
  seq: integer('seq').notNull().references(() => sessionPending.seq, { onDelete: 'cascade' }),
  sessionId: text('session_id').notNull(),
  sourceMessageId: text('source_message_id').notNull(),
}, table => ({ source: uniqueIndex('idx_session_pending_source_identity').on(table.sessionId, table.sourceMessageId) }));

/**
 * #6334 用量页:一条会话「在干活」(working / needs_user)的一段时间一行,时间是 epoch 毫秒。
 * `endedAt` 为 null = 还开着;`lastSeenAt` 是主进程每分钟的心跳,进程被强杀后下次开机按它收口。
 * ❌ 不挂外键:会话删了,它那天跑过的时长仍是那天的事实。写入方见 core/usage/run-interval-recorder.ts。
 */
export const sessionRunIntervals = sqliteTable(
  'session_run_intervals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    provider: text('provider'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (table) => ({
    startedAtIdx: index('idx_session_run_intervals_started_at').on(table.startedAt),
    sessionEndedIdx: index('idx_session_run_intervals_session_ended').on(
      table.sessionId,
      table.endedAt
    ),
  })
);

/**
 * #6334 用量页:各家 CLI 日志文件的解析缓存(路径为键)。size + mtime 没变就不再读;
 * 只长不改的文件从 `data` 里记着的偏移接着读。形状见 core/usage/token-file-cache.ts。
 */
/**
 * #6334 用量页:会话每次启动时用的是咕咕模型('gugu')还是用户自己的账号('byok'),一次启动一行、
 * 与上一行相同则不记。Token 按时刻归到当时那一段(见 core/usage/model-source-recorder.ts)。
 */
export const sessionModelSources = sqliteTable(
  'session_model_sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    source: text('source').notNull(),
    startedAt: integer('started_at').notNull(),
  },
  (table) => ({
    sessionStartedIdx: index('idx_session_model_sources_session_started').on(
      table.sessionId,
      table.startedAt
    ),
  })
);

export const usageTokenFileCache = sqliteTable('usage_token_file_cache', {
  path: text('path').primaryKey(),
  size: integer('size').notNull(),
  mtimeMs: integer('mtime_ms').notNull(),
  provider: text('provider').notNull(),
  providerSessionId: text('provider_session_id').notNull(),
  data: text('data').notNull(),
});

export const editorBuffers = sqliteTable(
  'editor_buffers',
  {
    id: text('id').primaryKey(), // `${projectId}:${workspaceId}:${filePath}`
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    filePath: text('file_path').notNull(),
    content: text('content').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    workspaceFileIdx: index('idx_editor_buffers_workspace_file').on(
      table.workspaceId,
      table.filePath
    ),
  })
);

export const kv = sqliteTable(
  'kv',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    keyIdx: uniqueIndex('idx_kv_key').on(table.key),
  })
);

export const providerAccounts = sqliteTable(
  'provider_accounts',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    credentialRef: text('credential_ref').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    meta: versionedJsonColumn(providerAccountMeta)('meta'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    accountIdx: uniqueIndex('idx_provider_accounts_provider_account').on(
      table.providerId,
      table.accountId
    ),
    defaultIdx: uniqueIndex('idx_provider_accounts_default')
      .on(table.providerId)
      .where(sql`is_default = 1`),
  })
);

export const appSecrets = sqliteTable(
  'app_secrets',
  {
    key: text('key').primaryKey(),
    secret: text('secret').notNull(),
  },
  (table) => ({
    keyIdx: uniqueIndex('idx_app_secrets_key').on(table.key),
  })
);

export type SshConnectionRow = typeof sshConnections.$inferSelect;
export type SshConnectionInsert = typeof sshConnections.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type AutomationRow = typeof automations.$inferSelect;
export type AutomationRunRow = typeof automationRuns.$inferSelect;
export type ProjectSettingsRow = typeof projectSettings.$inferSelect;
export type ProjectSettingsInsert = typeof projectSettings.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type TerminalRow = typeof terminals.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type EditorBufferRow = typeof editorBuffers.$inferSelect;
export type EditorBufferInsert = typeof editorBuffers.$inferInsert;
export type KvRow = typeof kv.$inferSelect;
export type KvInsert = typeof kv.$inferInsert;
export type AppSecretRow = typeof appSecrets.$inferSelect;
export type AppSecretInsert = typeof appSecrets.$inferInsert;
export type ProviderAccountRow = typeof providerAccounts.$inferSelect;
export type ProviderAccountInsert = typeof providerAccounts.$inferInsert;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceInsert = typeof workspaces.$inferInsert;
