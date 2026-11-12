-- #2548 固定到左侧栏: a session marked here keeps its own row in the desktop left list even when its agent lives
-- in a group or project. Existing sessions start unmarked; the one-time upgrade (sidebar-pin-upgrade.ts) runs in the
-- app at start, not here: it marks only top-level sessions (the app's own parent rule) and announces each change.
ALTER TABLE `sessions` ADD COLUMN `is_pinned_to_sidebar` integer DEFAULT 0 NOT NULL;
