# Lane 2 read paths: agents, models, connections, automations, team, github

Dev = a62bb6b35. Head = cut2 after the round-3 commits, with rma-head 3fd6dec0f merged in. "S/" = apps/desktop/src/, "R/" = S/session/renderer/.
One path = one source read plus its keeper (a replica and its readers count as one). The following are not read paths:
an action's own read (a check right before a write, a read-back after a write), and a push that patches the same entry.

| data | dev paths (where) | head paths (where) | note |
|---|---|---|---|
| agents offered for new tasks, per machine (`agents.list`) | 2: R/lib/stores/use-agents.ts useAgents rq; R/features/sessions/stores/project-sessions-store.ts rq | 1: agentsMetadata (R/lib/stores/agent-replicas.ts) | |
| library agent list, per machine (`agents.listManagement`) | 1: use-agents useManagementAgents rq through the library host | 1: managementAgents | round 3: `useManagementAgents` returns the Reading, as `useAgents` does (was `{reading, refetch}`). The library host's dead `listManagement` was removed. |
| one library agent, per machine (`agents.getManagement`) | 3: use-agents useManagementAgent; R/features/extensions/panel/market-detail-agent-devices.tsx rq per device; S/mobile/market/phoneMarketTargets.ts rq per device | 2: managementAgent; marketDeviceReading (R/features/extensions/market-device-readings.ts, with closures registered by market-detail-devices.tsx and phoneMarketTargets.ts) | stays 2: the market picker is lane 1's mechanism (see report) |
| one agent's metadata (`agents.get`) | 2: use-agents useAgent rq (this computer); R/features/sessions/start-side-session.ts direct `rpcOn(machine).agents.get` | 1: agentMetadata (machine first, family tag) | round 3: the side chat's fork check uses `agentMetadata.reread`. `useAgent` returns the Reading. |
| agent icons | 1: use-agents rq | 1: agentIcons | |
| harness model catalog, per machine × harness × leg | 1: R/lib/stores/use-harness-model-catalog.ts rq | 1: harnessModelCatalog | the forced probe (`modelCatalog(…, true)`) is an action whose answer is set into the same entry |
| target model catalog | 1: use-target-model-catalog.ts rq | 1: targetModelCatalog | |
| harness model credential | 1: use-harness-model-credential.ts rq | 1: harnessModelCredential | |
| agent installation statuses, per machine | 1: use-agent-installation-statuses.ts rq through the host | 1: agentInstallationStatus | the push (`agentInstallationStatusUpdatedChannel`) patches the entry. The library host's dead `listAgentInstallationStatus` was removed. |
| install source versions | 1: use-agent-installation-statuses.ts rq | 1: installSourceVersions | the library host's dead member was removed |
| agent settings, per machine | 1: R/lib/stores/use-agent-settings.ts rq through the host | 1: agentSettings | `getDefaultSettings` inside reset is an action. The library host's dead `getSettings` was removed. |
| agent config list / sign-in state, per machine | 2: R/lib/stores/use-agent-auth-status.ts live ReplicaState (2 binds); R/lib/acp/auth-login-binding.ts its own live ReplicaState | 2: agentConfigList (R/lib/stores/live/agent-config-list.ts); auth-login-binding.ts own ReplicaState during a login | stays 2: see report |
| CLI install progress | 1: R/features/integrations/CliInstallProgress.tsx setInterval poll | 1: cliInstallProgress (`refreshEvery`) | |
| platform model catalog (cloud) | 1 renderer: S/lib/agentModelReplicas.ts platformModels | 1: platformCatalog | the main process (electron/model-access.ts) reads its own copy, which is outside the renderer. One shared parser since round 1. |
| a session's platform selection | 1: R/features/sessions/session-config/platform-model-catalog.ts rq | 1: sessionPlatformSelection | |
| an agent's model selection | 1: agentModelSelection | 1: agentModelSelection | the read-back after a save in S/components/agentsettings/AgentAiModelPane.tsx and the move checks in R/features/assistant/assistant-move-wire.ts are actions' own reads |
| models a harness offers on a machine (`sessionTimeline.sessionCreateModels`) | 3: agentHarnessModels (agentModelReplicas); R/…/session-config/use-permission-menu.ts rq; S/mobile/agent-watch/CreateSessionPage.tsx effect reads | 2: sessionCreateModels (agent pane, phone create page); permissionMenu (use-permission-menu.ts) | stays 2: see report |
| what a machine offers for a new session (`sessionCreateOptions`) | 1: CreateSessionPage effect read | 1: sessionCreateOptions | |
| custom models | 1: customModels | 1: customModels | |
| agent flood adjustment | 1 | 1: agentFloodAdjustment | agentFloodNotice is a separate datum |
| agent scheduled tasks | 1: agentScheduledTasks | 1: agentScheduledTasks | round 3: the account-bound entry is written the way chat channels and group settings write it |
| chat channels (account) | 1: S/components/settings/channels/useChatChannels.ts module Map + setInterval | 1: chatChannels (S/components/connections/connection-replicas.ts) | one hook, `useChatChannels` in channelAgents.ts (lane 3's, kept by the merge) |
| owner connections snapshot, per route × device | 2: R/features/integrations/integrations-provider.tsx rq `connections:snapshot`; the owner store's own cache | 1: ownerConnections | the store reads and saves through the replica entry (connection-host.ts adapter). connection-library-host and assistant-panel-reads are views over the store. The executePlatformOperation snapshot is an action's read. |
| connection route | 1: routing's own cache | 1: connectionRoute (S/lib/connectionBridge.ts) | routing keeps its last route in the replica (`routeCache`) |
| integrations catalog, per host | 2: integrations-provider rq; R/lib/chat/shared-chat-context.ts direct `rpc.integrations.list` | 1: integrationsCatalog | round 3: the chat-mention icon preload fetches the replica entry. The `rpcOn(null).integrations.list` calls in R/features/assistant/assistant-move-controller.ts are names read while a move runs (an action; lane 3's file). |
| integration connection statuses, per host | 1: integrations-provider rq | 1: integrationStatuses | |
| configured connections, per host | 3: integrations-provider rq; R/features/settings/components/IntegrationDetailSidebar.tsx rq; market device picker (`readDevice` in IntegrationsCard) | 2: configuredConnections; marketDeviceReading through `readDevice` (R/features/settings/components/IntegrationsCard.tsx → market-detail-connector.tsx) | stays 2: the same lane 1 picker as agents. `waitForAssistantControl` (connection-library-host, phoneAssistantAuthorization) is an action's precondition. |
| integration accounts / account checks | 1 + 1: use-integration-accounts.ts rq | 1 + 1: integrationAccounts, integrationAccountChecks | |
| subscription plan / usage / harness connections / connection details / availability | 1 each: subscription-queries.ts | 1 each | the forced usage refresh is an action set into the entry |
| automations on a machine | 1: R/features/automations/use-automations.ts rq | 1: automations | the reads in use-confirm-delete-project.tsx, AssistantCloseHost.tsx and assistant-move-wire.ts are actions' own reads. Round 3: the machine is null or a device id (was 'local'). |
| an automation's next run / latest run / run page / run counts | 1 each: use-automations rq | 1 each: automationNextRun, automationLatestRun, automationRunPage, automationRunCounts | |
| session schedules, per machine | 1: use-session-schedules.ts rq | 1: sessionSchedules | |
| team session (context + profile) | 1: S/features/team/context.tsx rq | 1: teamSession | |
| team directory page | 1: TeamPage rq | 1: teamDirectoryPage | |
| team members page | 2: TeamMembers rq `handoff-members` + rq `manage-members` (the same `api.members`) | 1: teamMembersPage (both readers) | |
| team usage page | 1: TeamUsage rq | 1: teamUsagePage | |
| team top-up quote / order | 1 + 1: TeamTopupDialog rq | 1 + 1: teamTopupQuote, teamTopupOrder | |
| GitHub accounts, per host | 2: R/lib/hooks/useGithubAccounts.ts rq (`listAccounts`); R/lib/providers/github-context-provider.tsx rq (`getAccountState`) | 1: githubAccounts | |
| GitHub repository owners | 1: useGithubRepositoryOwners.ts rq | 1: githubOwners | |

Totals: 39 rows, or 48 data kinds once the grouped rows are split. Dev 61 paths, head 52. 44 kinds have one path at head; 4 still have two (one library agent, configured connections, agent config list, harness models offered).
