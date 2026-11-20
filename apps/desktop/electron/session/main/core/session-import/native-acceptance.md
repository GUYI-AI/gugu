# Native Codex import acceptance

`codex-task-lineage.native.db.test.ts` is an opt-in, real-engine acceptance suite. Default CI reports these cases as skipped and cannot establish that imported tasks continue successfully.

Under the current operations grant, set `GUGU_NATIVE_IMPORT_ROOT` to a new isolated `/Users/mac1/chatgpt-import-3216/native-*` directory and `GUGU_NATIVE_IMPORT_CLI` to the reviewed Codex executable. Use the official single-worker resource guard, actual gate and foreground lease. The guarded runner supplies unique HOME, GUGU_HOME, GUGU_USER_DATA_DIR and CODEX_HOME values.

The suite imports synthetic paginated history through the production scanner, history planner and append helper. Two positive cases keep the ancestor in `sessions` or `archived_sessions`. A real `thread/resume` and turn must send the ancestor marker to a loopback Responses server and complete. The missing-ancestor case must be rejected by the importer and by native resume with the specific lineage error, with no model request. A configuration failure cannot satisfy that negative control.

The fixture keeps the built-in `openai` provider and sets the supported top-level `openai_base_url`; it never overrides a reserved provider ID. API keys are public synthetic fixtures. No upstream model service, real model account or user source is involved.

Keep failed attempts and exact input hashes. Verify owned child PIDs have exited after each run. Real user-source desktop import and continuation remain a separate acceptance step; neither a successful `thread/read` nor these synthetic cases replace it.
