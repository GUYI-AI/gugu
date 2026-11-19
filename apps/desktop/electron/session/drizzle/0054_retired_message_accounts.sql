CREATE TABLE im_message_retired_accounts (
  account_id text PRIMARY KEY NOT NULL
);

--> statement-breakpoint
CREATE TRIGGER im_messages_retired_insert
BEFORE INSERT ON im_messages
WHEN EXISTS (SELECT 1 FROM im_message_retired_accounts WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'im_account_retired');
END;

--> statement-breakpoint
CREATE TRIGGER im_messages_retired_update
BEFORE UPDATE ON im_messages
WHEN EXISTS (SELECT 1 FROM im_message_retired_accounts WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'im_account_retired');
END;

--> statement-breakpoint
CREATE TRIGGER im_message_accounts_retired_insert
BEFORE INSERT ON im_message_accounts
WHEN EXISTS (SELECT 1 FROM im_message_retired_accounts WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'im_account_retired');
END;

--> statement-breakpoint
CREATE TRIGGER im_message_accounts_retired_update
BEFORE UPDATE ON im_message_accounts
WHEN EXISTS (SELECT 1 FROM im_message_retired_accounts WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'im_account_retired');
END;

--> statement-breakpoint
CREATE TRIGGER im_message_chats_retired_insert
BEFORE INSERT ON im_message_chats
WHEN EXISTS (SELECT 1 FROM im_message_retired_accounts WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'im_account_retired');
END;

--> statement-breakpoint
CREATE TRIGGER im_message_chats_retired_update
BEFORE UPDATE ON im_message_chats
WHEN EXISTS (SELECT 1 FROM im_message_retired_accounts WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'im_account_retired');
END;

--> statement-breakpoint
CREATE TRIGGER im_message_ranges_retired_insert
BEFORE INSERT ON im_message_ranges
WHEN EXISTS (SELECT 1 FROM im_message_retired_accounts WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'im_account_retired');
END;

--> statement-breakpoint
CREATE TRIGGER im_message_ranges_retired_update
BEFORE UPDATE ON im_message_ranges
WHEN EXISTS (SELECT 1 FROM im_message_retired_accounts WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'im_account_retired');
END;

--> statement-breakpoint
CREATE TRIGGER im_message_tombstones_retired_insert
BEFORE INSERT ON im_message_tombstones
WHEN EXISTS (SELECT 1 FROM im_message_retired_accounts WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'im_account_retired');
END;

--> statement-breakpoint
CREATE TRIGGER im_message_tombstones_retired_update
BEFORE UPDATE ON im_message_tombstones
WHEN EXISTS (SELECT 1 FROM im_message_retired_accounts WHERE account_id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'im_account_retired');
END;
