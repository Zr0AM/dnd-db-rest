-- Make a NULL Item.itemID impossible at the database level.
--
-- itemID is declared `int identity ... primary key`, which in SQLite is NOT a rowid alias
-- (only `INTEGER PRIMARY KEY` is), so SQLite allows NULL in it and a row with a NULL
-- itemID can never be addressed by /rest/Item/{id} again. The API already refuses such
-- writes; these triggers enforce the same rule for every other writer
-- (`wrangler d1 execute`, scripts, future code).
--
-- Idempotent (IF NOT EXISTS). Existing rows are not touched or checked; before applying
-- to a database that may already contain orphans, check:
--   SELECT COUNT(*) FROM Item WHERE itemID IS NULL;

CREATE TRIGGER IF NOT EXISTS Item_itemID_not_null_on_insert
BEFORE INSERT ON Item
WHEN NEW.itemID IS NULL
BEGIN
    SELECT RAISE(ABORT, 'itemID must not be NULL');
END;

CREATE TRIGGER IF NOT EXISTS Item_itemID_not_null_on_update
BEFORE UPDATE OF itemID ON Item
WHEN NEW.itemID IS NULL
BEGIN
    SELECT RAISE(ABORT, 'itemID must not be NULL');
END;
