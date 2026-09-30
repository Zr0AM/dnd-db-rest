-- Baseline: the schema as it already exists in the live `dnd-db` database.
--
-- This is intentionally a no-op on the existing database (IF NOT EXISTS), so it
-- is safe to apply there to record the baseline. On a fresh database (local dev,
-- tests) it creates the table.
--
-- Note: itemID is declared `int ... primary key`, which in SQLite is NOT a rowid
-- alias and does NOT auto-increment. Clients must supply itemID on insert.
CREATE TABLE IF NOT EXISTS Item (
    itemID int identity constraint PK_tblItem primary key,
    itemName nvarchar(150),
    itemRarity nvarchar(20),
    itemCost int,
    itemType nvarchar(20),
    itemRestrictions nvarchar(150),
    itemAttunement nvarchar(20),
    itemSource nvarchar(150),
    itemUrl nvarchar(200),
    itemVisualDesc nvarchar(1000),
    itemShopkeeperDesc nvarchar(1000),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
    itemDescription TEXT,
    itemDescriptionSource TEXT
);
