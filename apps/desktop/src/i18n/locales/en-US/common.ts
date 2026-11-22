export default {
  "startup": {
    "slogan": "Don't do it yourself. Let AI."
  },
  "staleRead": {
    "failed": "Could not load the latest content. Showing the last loaded version.",
    "retry": "Retry"
  },
  "menu": {
    "search": "Search",
    "noResults": "No results"
  },
  "agentName": {
    "naming": "Generating name…"
  },
  "needsYou": {
    "title": "Needs you",
    "waitingTasks": "Tasks waiting for you",
    "count": "Needs you · {{count}}",
    "loading": "Reading the request…",
    "sourceTask": "From task · {{title}}"
  },
  "actions": {
    "copiedAgentId": "Agent ID copied",
    "copiedGuguNumber": "Gugu ID copied",
    "copiedLink": "Link copied",
    "copy": "Copy",
    "copyFailed": "Could not copy"
  },
  "cloudComputer": {
    "reason": {
      "plan_required": "Your Gugu requires Plus or above.",
      "credits_exhausted": "You are out of credits.",
      "membership_expired": "Your membership has expired, so its cloud resources are paused. Renew, or migrate it to your own computer.",
      "timeout": "Could not connect within two minutes.",
      "network": "Could not reach the Gugu service. Check your network and try again.",
      "signed_out": "You have been signed out. Sign in again, then retry.",
      "gone": "Your Gugu has been closed.",
      "failed": "Your Gugu encountered an error.",
      "server_install_failed": "Could not install the cloud service. Try again.",
      "server_start_failed": "Could not start the cloud service. Try again.",
      "account_offline": "The cloud account could not come online. Try again.",
      "package_update_pending": "An update is waiting for the current task to finish. Try again later.",
      "home_restore_failed": "Could not restore your earlier data. Try again later.",
      "host_unconfirmed": "Could not confirm the cloud machine's status. Try again later.",
      "assistant_create_failed": "Could not create your assistant. Try again.",
      "assistant_busy": "Your assistant is busy. Try again later.",
      "login_expired": "The cloud sign-in has expired and needs to be authorized again.",
      "device_removed": "The cloud device was removed. Confirm to restore it.",
      "provision_incomplete": "Setup did not finish. Try again.",
      "wake_incomplete": "Preparation did not finish. Try again later.",
      "sleep_incomplete": "The operation did not finish. Try again later.",
      "close_incomplete": "Closing did not finish. Try again."
    }
  },
  "connection": {
    "online": "Online",
    "connecting": "Connecting",
    "deviceOffline": "Device offline",
    "lastSeen": "Last online {{time}}",
    "retry": "Reconnect"
  },
  "agentStatus": {
    "running": "Running",
    "parked": "Running in background",
    "needsApproval": "Needs your approval",
    "needsAnswer": "Needs your answer",
    "needsPlanReview": "Needs your plan review",
    "needsAction": "Needs your action",
    "error": "Error",
    "done": "Done",
    "idle": "Idle",
    "online": "Online",
    "offline": "Offline",
    "archived": "Archived",
    "removed": "Removed",
    "pending": "Confirming",
    "starting": "Starting",
    "none": "Status unavailable"
  },
  "agentShare": {
    "guguNumber": "Gugu ID",
    "close": "Close",
    "dialog": "Share {{name}}",
    "generatePoster": "Create contact poster",
    "inviteLink": "Invite link",
    "numberUnassigned": "Not assigned",
    "copied": "Copied",
    "copyRow": "Copy {{label}}",
    "makePublic": "Make public",
    "makingPublic": "Making public…",
    "makePublicHint": "Make it public to get a Gugu ID and invite link.",
    "makePublicFailed": "Could not make the agent public",
    "title": "Share Agent"
  },
  "brand": {
    "documentTitle": "Gugu"
  },
  "dialog": {
    "close": "Close dialog",
    "label": "Dialog"
  },
  "errors": {
    "offline": "Could not connect. Check your network and try again.",
    "operationFailed": "The operation failed. Try again later.",
    "permissionDenied": "You do not have permission to do this."
  },
  "locale": {
    "enUS": "English",
    "label": "Language",
    "system": "System default",
    "zhCN": "简体中文"
  },
  "relativeTime": {
    "daysAgo": "{{count}} days ago",
    "daysAgo_one": "{{count}} day ago",
    "daysAgo_other": "{{count}} days ago",
    "hoursAgo": "{{count}} hours ago",
    "hoursAgo_one": "{{count}} hour ago",
    "hoursAgo_other": "{{count}} hours ago",
    "justNow": "now",
    "minutesAgo": "{{count}} minutes ago",
    "minutesAgo_one": "{{count}} minute ago",
    "minutesAgo_other": "{{count}} minutes ago"
  },
  "notice": {
    "previous": "Previous notice",
    "next": "Next notice",
    "position": "Notice {{index}} of {{total}}",
    "later": "Later",
    "clear": "Clear this notice"
  },
  "toast": {
    "dismiss": "Dismiss"
  },
  "tabs": {
    "pending": "{{label}}, {{count}} pending",
    "pending_one": "{{label}}, {{count}} pending",
    "pending_other": "{{label}}, {{count}} pending"
  }
} as const;
