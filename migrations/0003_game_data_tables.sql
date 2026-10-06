-- Game-data tables for Adventurer's Ledger: SRD 5.2.1 (2024, "5.5e") reference data,
-- equipment, classes, spells, origins, monsters, rules, the treasure generator's config,
-- and new columns on Item. Designed in Zr0AM/dnd-app docs/db/schema-plan.md.
--
-- Creates tables only; the SRD rows are in seed/srd/*.sql (see the README). Existing Item
-- rows are not changed: the eight new Item columns are nullable and start NULL.
--
-- Conventions (matching the existing Item table):
--   * Tables are PascalCase and singular; columns are camelCase, prefixed with
--     the owning entity (spellName, monsterAc); foreign keys reuse the target's
--     key name (rarityID, classID).
--   * Content tables carry <entity>Slug (unique, URL-safe), sourceID and
--     sourcePage (SRD page, for the reader), and active (1 listed, 0 retired).
--   * Money is integer copper (costCp); dice are (count, sides) integer pairs.
--   * Booleans are INTEGER 0/1 with a CHECK.
-- D1 enforces foreign keys, so tables are created parent-first.

------------------------------------------------------------------------------
-- 1. Reference / lookup tables
------------------------------------------------------------------------------

CREATE TABLE Source (
  sourceID          INTEGER PRIMARY KEY,
  sourceName        TEXT NOT NULL UNIQUE,      -- 'System Reference Document 5.2.1'
  sourceAbbrev      TEXT NOT NULL UNIQUE,      -- 'SRD 5.2.1', 'DDB', 'Homebrew'
  sourceLicense     TEXT,                      -- 'CC-BY-4.0'
  sourceLicenseUrl  TEXT,
  sourceAttribution TEXT,                      -- statement the footer/legal page must show
  sourceUrl         TEXT
);

CREATE TABLE Ability (
  abilityID   INTEGER PRIMARY KEY,
  abilityCode TEXT NOT NULL UNIQUE,            -- 'STR'
  abilityName TEXT NOT NULL UNIQUE,            -- 'Strength'
  sortOrder   INTEGER NOT NULL
);

CREATE TABLE Skill (
  skillID          INTEGER PRIMARY KEY,
  skillName        TEXT NOT NULL UNIQUE,
  skillSlug        TEXT NOT NULL UNIQUE,
  abilityID        INTEGER NOT NULL REFERENCES Ability(abilityID),
  skillDescription TEXT
);

CREATE TABLE DamageType (
  damageTypeID          INTEGER PRIMARY KEY,
  damageTypeName        TEXT NOT NULL UNIQUE,  -- 'Acid' … 'Thunder'
  damageTypeDescription TEXT
);

CREATE TABLE Condition (
  conditionID          INTEGER PRIMARY KEY,
  conditionName        TEXT NOT NULL UNIQUE,   -- 'Blinded' … 'Unconscious', 'Exhaustion'
  conditionSlug        TEXT NOT NULL UNIQUE,
  conditionDescription TEXT NOT NULL,
  sourceID             INTEGER NOT NULL REFERENCES Source(sourceID),
  sourcePage           INTEGER
);

CREATE TABLE CreatureSize (
  sizeID       INTEGER PRIMARY KEY,
  sizeName     TEXT NOT NULL UNIQUE,           -- 'Tiny' … 'Gargantuan'
  sizeSpaceFt  REAL NOT NULL,                  -- 2.5, 5, 5, 10, 15, 20
  sizeHitDie   INTEGER NOT NULL,               -- d4 … d20, used to check monster HP
  sortOrder    INTEGER NOT NULL
);

CREATE TABLE CreatureType (
  creatureTypeID   INTEGER PRIMARY KEY,
  creatureTypeName TEXT NOT NULL UNIQUE        -- 'Aberration' … 'Undead'
);

CREATE TABLE Alignment (
  alignmentID     INTEGER PRIMARY KEY,
  alignmentName   TEXT NOT NULL UNIQUE,        -- 'Lawful Good' … 'Unaligned'
  alignmentAbbrev TEXT NOT NULL UNIQUE         -- 'LG' … 'U'
);

CREATE TABLE Language (
  languageID     INTEGER PRIMARY KEY,
  languageName   TEXT NOT NULL UNIQUE,
  languageKind   TEXT NOT NULL CHECK (languageKind IN ('standard', 'rare', 'secret')),
  languageOrigin TEXT,
  sourceID       INTEGER NOT NULL REFERENCES Source(sourceID)
);

-- Replaces DENOMS in src/app/core/coins/coins.ts.
CREATE TABLE Denomination (
  denomKey   TEXT PRIMARY KEY,                 -- 'pp' | 'gp' | 'ep' | 'sp' | 'cp'
  denomName  TEXT NOT NULL UNIQUE,             -- 'platinum'
  denomLabel TEXT NOT NULL,                    -- 'Platinum'
  valueCp    INTEGER NOT NULL CHECK (valueCp > 0),
  sortOrder  INTEGER NOT NULL,                 -- largest first; the splitter relies on it
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- Replaces the free-text Item.itemRarity and raritySlug(); carries the SRD's
-- "Magic Item Rarities and Values" and "Crafting Time and Cost" tables.
CREATE TABLE Rarity (
  rarityID       INTEGER PRIMARY KEY,
  rarityName     TEXT NOT NULL UNIQUE,         -- 'Very Rare'
  raritySlug     TEXT NOT NULL UNIQUE,         -- 'very-rare' (CSS modifier)
  sortOrder      INTEGER NOT NULL,
  valueGp        INTEGER,                      -- NULL for Artifact (priceless)
  craftDays      INTEGER,
  craftCostGp    INTEGER
);

-- Magic item categories: Armor, Potion, Ring, Rod, Scroll, Staff, Wand,
-- Weapon, Wondrous Item. Replaces the free-text Item.itemType.
CREATE TABLE ItemCategory (
  categoryID          INTEGER PRIMARY KEY,
  categoryName        TEXT NOT NULL UNIQUE,
  categorySlug        TEXT NOT NULL UNIQUE,
  categoryDescription TEXT
);

CREATE TABLE MagicSchool (
  schoolID   INTEGER PRIMARY KEY,
  schoolName TEXT NOT NULL UNIQUE              -- 'Abjuration' … 'Transmutation'
);

-- CR → XP and proficiency bonus. crValue is numeric so ranges sort and compare
-- (0.125, 0.25, 0.5, 1 … 30); crLabel is the display form ('1/8').
CREATE TABLE ChallengeRating (
  crValue           REAL PRIMARY KEY,
  crLabel           TEXT NOT NULL UNIQUE,
  xp                INTEGER NOT NULL,
  proficiencyBonus  INTEGER NOT NULL
);

-- Character advancement: XP thresholds and proficiency bonus per level.
CREATE TABLE CharacterLevel (
  level            INTEGER PRIMARY KEY CHECK (level BETWEEN 1 AND 20),
  xpRequired       INTEGER NOT NULL,
  proficiencyBonus INTEGER NOT NULL
);

------------------------------------------------------------------------------
-- 2. Equipment (mundane goods)
------------------------------------------------------------------------------

CREATE TABLE Equipment (
  equipmentID          INTEGER PRIMARY KEY,
  equipmentName        TEXT NOT NULL,
  equipmentSlug        TEXT NOT NULL UNIQUE,
  equipmentKind        TEXT NOT NULL CHECK (equipmentKind IN (
                         'weapon', 'armor', 'tool', 'gear', 'ammunition', 'focus',
                         'pack', 'container', 'mount', 'tack', 'vehicle')),
  costCp               INTEGER,                -- NULL when the SRD lists no price
  weightLb             REAL,
  equipmentDescription TEXT,
  sourceID             INTEGER NOT NULL REFERENCES Source(sourceID),
  sourcePage           INTEGER,
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE WeaponProperty (
  weaponPropertyID          INTEGER PRIMARY KEY,
  weaponPropertyName        TEXT NOT NULL UNIQUE,  -- 'Finesse', 'Versatile' …
  weaponPropertyDescription TEXT NOT NULL
);

CREATE TABLE WeaponMastery (
  masteryID          INTEGER PRIMARY KEY,
  masteryName        TEXT NOT NULL UNIQUE,         -- 'Cleave', 'Graze', 'Nick' …
  masteryDescription TEXT NOT NULL
);

CREATE TABLE Weapon (
  equipmentID           INTEGER PRIMARY KEY REFERENCES Equipment(equipmentID) ON DELETE CASCADE,
  weaponCategory        TEXT NOT NULL CHECK (weaponCategory IN ('simple', 'martial')),
  weaponRange           TEXT NOT NULL CHECK (weaponRange IN ('melee', 'ranged')),
  damageDiceCount       INTEGER,               -- NULL with damageFlat (Blowgun: 1)
  damageDiceSides       INTEGER,
  damageFlat            INTEGER,
  damageTypeID          INTEGER NOT NULL REFERENCES DamageType(damageTypeID),
  versatileDiceCount    INTEGER,
  versatileDiceSides    INTEGER,
  rangeNormalFt         INTEGER,
  rangeLongFt           INTEGER,
  ammunitionID          INTEGER REFERENCES Equipment(equipmentID),
  masteryID             INTEGER NOT NULL REFERENCES WeaponMastery(masteryID)
);

CREATE TABLE WeaponPropertyLink (
  equipmentID      INTEGER NOT NULL REFERENCES Weapon(equipmentID) ON DELETE CASCADE,
  weaponPropertyID INTEGER NOT NULL REFERENCES WeaponProperty(weaponPropertyID),
  PRIMARY KEY (equipmentID, weaponPropertyID)
);

CREATE TABLE Armor (
  equipmentID           INTEGER PRIMARY KEY REFERENCES Equipment(equipmentID) ON DELETE CASCADE,
  armorCategory         TEXT NOT NULL CHECK (armorCategory IN ('light', 'medium', 'heavy', 'shield')),
  armorBaseAc           INTEGER NOT NULL,      -- shields: the bonus (+2)
  armorAddsDex          INTEGER NOT NULL CHECK (armorAddsDex IN (0, 1)),
  armorDexCap           INTEGER,               -- NULL = uncapped; medium armor = 2
  armorStrengthReq      INTEGER,
  armorStealthDisadv    INTEGER NOT NULL CHECK (armorStealthDisadv IN (0, 1)),
  armorDonMinutes       REAL NOT NULL,         -- shield: an Action, stored as 0
  armorDoffMinutes      REAL NOT NULL
);

CREATE TABLE Tool (
  equipmentID   INTEGER PRIMARY KEY REFERENCES Equipment(equipmentID) ON DELETE CASCADE,
  toolCategory  TEXT NOT NULL CHECK (toolCategory IN ('artisan', 'gaming', 'musical', 'other')),
  abilityID     INTEGER NOT NULL REFERENCES Ability(abilityID),
  toolUtilize   TEXT,                          -- "Utilize" actions and DCs
  toolCraft     TEXT                           -- what it can craft
);

-- Contents of packs (Explorer's Pack …) and kits.
CREATE TABLE EquipmentContent (
  containerID INTEGER NOT NULL REFERENCES Equipment(equipmentID) ON DELETE CASCADE,
  contentID   INTEGER NOT NULL REFERENCES Equipment(equipmentID),
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  PRIMARY KEY (containerID, contentID)
);

CREATE TABLE Mount (
  equipmentID         INTEGER PRIMARY KEY REFERENCES Equipment(equipmentID) ON DELETE CASCADE,
  mountSpeedFt        INTEGER,
  mountCarryCapacityLb INTEGER
);

CREATE TABLE Vehicle (
  equipmentID           INTEGER PRIMARY KEY REFERENCES Equipment(equipmentID) ON DELETE CASCADE,
  vehicleKind           TEXT NOT NULL CHECK (vehicleKind IN ('land', 'water', 'air')),
  vehicleSpeedMph       REAL,
  vehicleCrew           INTEGER,
  vehiclePassengers     INTEGER,
  vehicleCargoTons      REAL,
  vehicleAc             INTEGER,
  vehicleHp             INTEGER,
  vehicleDamageThreshold INTEGER
);

-- Lifestyle expenses, food/drink/lodging, hirelings, spellcasting services.
CREATE TABLE Service (
  serviceID          INTEGER PRIMARY KEY,
  serviceName        TEXT NOT NULL,
  serviceCategory    TEXT NOT NULL CHECK (serviceCategory IN (
                       'lifestyle', 'food', 'drink', 'lodging', 'hireling', 'spellcasting', 'travel')),
  costCp             INTEGER,
  serviceUnit        TEXT,                     -- 'per day', 'per mile', 'per mug'
  serviceDescription TEXT,
  sourceID           INTEGER NOT NULL REFERENCES Source(sourceID),
  sourcePage         INTEGER,
  UNIQUE (serviceCategory, serviceName)
);

-- The d100 Trinkets table.
CREATE TABLE Trinket (
  trinketRoll INTEGER PRIMARY KEY CHECK (trinketRoll BETWEEN 1 AND 100),
  trinketText TEXT NOT NULL,
  sourceID    INTEGER NOT NULL REFERENCES Source(sourceID)
);

------------------------------------------------------------------------------
-- 3. Classes (spells reference classes, so classes come first)
------------------------------------------------------------------------------

CREATE TABLE Class (
  classID              INTEGER PRIMARY KEY,
  className            TEXT NOT NULL UNIQUE,
  classSlug            TEXT NOT NULL UNIQUE,
  classHitDieSides     INTEGER NOT NULL,       -- 12 for Barbarian
  classPrimaryMode     TEXT NOT NULL DEFAULT 'all' CHECK (classPrimaryMode IN ('all', 'any')),
  classSkillChoices    INTEGER NOT NULL,       -- "Choose 2"
  classCasterType      TEXT NOT NULL CHECK (classCasterType IN ('none', 'full', 'half', 'pact')),
  spellcastingAbilityID INTEGER REFERENCES Ability(abilityID),
  classDescription     TEXT,
  classStartingEquipmentText TEXT,             -- "(A) Greataxe, 4 Handaxes … or (B) 75 GP"
  sourceID             INTEGER NOT NULL REFERENCES Source(sourceID),
  sourcePage           INTEGER,
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- Primary abilities (multiclass prerequisite is a 13 in all/any of them).
CREATE TABLE ClassPrimaryAbility (
  classID   INTEGER NOT NULL REFERENCES Class(classID) ON DELETE CASCADE,
  abilityID INTEGER NOT NULL REFERENCES Ability(abilityID),
  PRIMARY KEY (classID, abilityID)
);

CREATE TABLE ClassSavingThrow (
  classID   INTEGER NOT NULL REFERENCES Class(classID) ON DELETE CASCADE,
  abilityID INTEGER NOT NULL REFERENCES Ability(abilityID),
  PRIMARY KEY (classID, abilityID)
);

CREATE TABLE ClassSkillOption (
  classID INTEGER NOT NULL REFERENCES Class(classID) ON DELETE CASCADE,
  skillID INTEGER NOT NULL REFERENCES Skill(skillID),
  PRIMARY KEY (classID, skillID)
);

-- Weapon proficiencies, armor training and tools. Either a category
-- ('Martial weapons', 'Light armor') or a specific item via equipmentID.
CREATE TABLE ClassProficiency (
  classProficiencyID INTEGER PRIMARY KEY,
  classID            INTEGER NOT NULL REFERENCES Class(classID) ON DELETE CASCADE,
  proficiencyKind    TEXT NOT NULL CHECK (proficiencyKind IN ('weapon', 'armor', 'tool')),
  proficiencyText    TEXT NOT NULL,
  equipmentID        INTEGER REFERENCES Equipment(equipmentID),
  grantedOnMulticlass INTEGER NOT NULL DEFAULT 0 CHECK (grantedOnMulticlass IN (0, 1))
);

-- "Choose A or B": each row is one line of one option.
CREATE TABLE ClassStartingEquipment (
  classStartingEquipmentID INTEGER PRIMARY KEY,
  classID                  INTEGER NOT NULL REFERENCES Class(classID) ON DELETE CASCADE,
  optionLabel              TEXT NOT NULL,      -- 'A', 'B'
  equipmentID              INTEGER REFERENCES Equipment(equipmentID),
  quantity                 INTEGER NOT NULL DEFAULT 1,
  goldGp                   INTEGER,            -- the "and 15 GP" / "75 GP" lines
  CHECK ((equipmentID IS NULL) <> (goldGp IS NULL))
);

-- The class-specific columns of each class's Features table (Rages, Rage
-- Damage, Sneak Attack, Focus Points, Cantrips, Prepared Spells, Pact slots …),
-- one row per class, level and column so new columns need no schema change.
CREATE TABLE ClassLevelValue (
  classID     INTEGER NOT NULL REFERENCES Class(classID) ON DELETE CASCADE,
  level       INTEGER NOT NULL REFERENCES CharacterLevel(level),
  columnKey   TEXT NOT NULL,                   -- 'rageDamage'
  columnLabel TEXT NOT NULL,                   -- 'Rage Damage'
  columnValue TEXT NOT NULL,                   -- '+2', '1d6', '4'
  sortOrder   INTEGER NOT NULL,
  PRIMARY KEY (classID, level, columnKey)
);

-- Spell slots per class level. Stored per class (not per caster type) because
-- the 2024 half casters have their own tables from level 1.
CREATE TABLE ClassSpellSlot (
  classID    INTEGER NOT NULL REFERENCES Class(classID) ON DELETE CASCADE,
  level      INTEGER NOT NULL REFERENCES CharacterLevel(level),
  spellLevel INTEGER NOT NULL CHECK (spellLevel BETWEEN 1 AND 9),
  slots      INTEGER NOT NULL CHECK (slots > 0),
  PRIMARY KEY (classID, level, spellLevel)
);

CREATE TABLE Subclass (
  subclassID          INTEGER PRIMARY KEY,
  classID             INTEGER NOT NULL REFERENCES Class(classID) ON DELETE CASCADE,
  subclassName        TEXT NOT NULL UNIQUE,    -- 'Path of the Berserker'
  subclassSlug        TEXT NOT NULL UNIQUE,
  subclassDescription TEXT,
  sourceID            INTEGER NOT NULL REFERENCES Source(sourceID),
  sourcePage          INTEGER,
  active              INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- Class and subclass features ("Level 2: Danger Sense").
CREATE TABLE ClassFeature (
  featureID          INTEGER PRIMARY KEY,
  featureSlug        TEXT NOT NULL UNIQUE,
  classID            INTEGER NOT NULL REFERENCES Class(classID) ON DELETE CASCADE,
  subclassID         INTEGER REFERENCES Subclass(subclassID) ON DELETE CASCADE,
  level              INTEGER NOT NULL REFERENCES CharacterLevel(level),
  featureName        TEXT NOT NULL,
  featureDescription TEXT NOT NULL,
  sortOrder          INTEGER NOT NULL,
  sourcePage         INTEGER
);

-- Pick lists a feature offers: Metamagic Options, Eldritch Invocations …
CREATE TABLE FeatureOption (
  featureOptionID          INTEGER PRIMARY KEY,
  featureID                INTEGER NOT NULL REFERENCES ClassFeature(featureID) ON DELETE CASCADE,
  featureOptionName        TEXT NOT NULL,
  featureOptionPrereq      TEXT,               -- 'Level 5+ Warlock'
  featureOptionMinLevel    INTEGER,
  featureOptionCost        TEXT,               -- '2 Sorcery Points'
  featureOptionRepeatable  INTEGER NOT NULL DEFAULT 0 CHECK (featureOptionRepeatable IN (0, 1)),
  featureOptionDescription TEXT NOT NULL,
  UNIQUE (featureID, featureOptionName)
);

------------------------------------------------------------------------------
-- 4. Spells
------------------------------------------------------------------------------

CREATE TABLE Spell (
  spellID              INTEGER PRIMARY KEY,
  spellName            TEXT NOT NULL UNIQUE,
  spellSlug            TEXT NOT NULL UNIQUE,
  spellLevel           INTEGER NOT NULL CHECK (spellLevel BETWEEN 0 AND 9),  -- 0 = cantrip
  schoolID             INTEGER NOT NULL REFERENCES MagicSchool(schoolID),
  spellCastingTime     TEXT NOT NULL,          -- 'Action', 'Bonus Action', '1 minute'
  spellIsRitual        INTEGER NOT NULL CHECK (spellIsRitual IN (0, 1)),
  spellRange           TEXT NOT NULL,          -- '30 feet', 'Self (15-foot Cone)'
  spellVerbal          INTEGER NOT NULL CHECK (spellVerbal IN (0, 1)),
  spellSomatic         INTEGER NOT NULL CHECK (spellSomatic IN (0, 1)),
  spellMaterial        TEXT,                   -- NULL = no M component
  spellMaterialCostGp  INTEGER,
  spellMaterialConsumed INTEGER NOT NULL DEFAULT 0 CHECK (spellMaterialConsumed IN (0, 1)),
  spellDuration        TEXT NOT NULL,
  spellConcentration   INTEGER NOT NULL CHECK (spellConcentration IN (0, 1)),
  spellDescription     TEXT NOT NULL,
  spellHigherLevel     TEXT,                   -- "Using a Higher-Level Spell Slot" / "Cantrip Upgrade"
  sourceID             INTEGER NOT NULL REFERENCES Source(sourceID),
  sourcePage           INTEGER,
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE SpellClass (
  spellID INTEGER NOT NULL REFERENCES Spell(spellID) ON DELETE CASCADE,
  classID INTEGER NOT NULL REFERENCES Class(classID) ON DELETE CASCADE,
  PRIMARY KEY (spellID, classID)
);

------------------------------------------------------------------------------
-- 5. Origins: species, backgrounds, feats
------------------------------------------------------------------------------

CREATE TABLE Feat (
  featID          INTEGER PRIMARY KEY,
  featName        TEXT NOT NULL UNIQUE,
  featSlug        TEXT NOT NULL UNIQUE,
  featCategory    TEXT NOT NULL CHECK (featCategory IN ('origin', 'general', 'fighting_style', 'epic_boon')),
  featPrereq      TEXT,                        -- 'Level 4+, Strength or Dexterity 13+'
  featMinLevel    INTEGER,
  featRepeatable  INTEGER NOT NULL DEFAULT 0 CHECK (featRepeatable IN (0, 1)),
  featDescription TEXT NOT NULL,
  sourceID        INTEGER NOT NULL REFERENCES Source(sourceID),
  sourcePage      INTEGER,
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE Species (
  speciesID          INTEGER PRIMARY KEY,
  speciesName        TEXT NOT NULL UNIQUE,
  speciesSlug        TEXT NOT NULL UNIQUE,
  creatureTypeID     INTEGER NOT NULL REFERENCES CreatureType(creatureTypeID),
  speciesSizeNote    TEXT,                     -- 'about 5–7 feet tall'
  speciesSpeedFt     INTEGER NOT NULL,
  speciesDescription TEXT,
  sourceID           INTEGER NOT NULL REFERENCES Source(sourceID),
  sourcePage         INTEGER,
  active             INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

-- Sizes a species may choose (Human, Tiefling: Small or Medium).
CREATE TABLE SpeciesSize (
  speciesID INTEGER NOT NULL REFERENCES Species(speciesID) ON DELETE CASCADE,
  sizeID    INTEGER NOT NULL REFERENCES CreatureSize(sizeID),
  PRIMARY KEY (speciesID, sizeID)
);

CREATE TABLE SpeciesTrait (
  speciesTraitID          INTEGER PRIMARY KEY,
  speciesID               INTEGER NOT NULL REFERENCES Species(speciesID) ON DELETE CASCADE,
  speciesTraitName        TEXT NOT NULL,
  speciesTraitMinLevel    INTEGER NOT NULL DEFAULT 1,  -- Draconic Flight: 5
  speciesTraitDescription TEXT NOT NULL,
  sortOrder               INTEGER NOT NULL,
  UNIQUE (speciesID, speciesTraitName)
);

-- Choices a species offers: Draconic Ancestors, Elven Lineages, Gnomish
-- Lineages, Giant Ancestry, Fiendish Legacies.
CREATE TABLE SpeciesOption (
  speciesOptionID          INTEGER PRIMARY KEY,
  speciesOptionSlug        TEXT NOT NULL UNIQUE,
  speciesID                INTEGER NOT NULL REFERENCES Species(speciesID) ON DELETE CASCADE,
  speciesOptionGroup       TEXT NOT NULL,      -- 'Draconic Ancestor'
  speciesOptionName        TEXT NOT NULL,      -- 'Red'
  damageTypeID             INTEGER REFERENCES DamageType(damageTypeID),
  speciesOptionDescription TEXT,              -- the option's traits, as text
  speciesOptionDetails     TEXT CHECK (speciesOptionDetails IS NULL OR json_valid(speciesOptionDetails)),
  UNIQUE (speciesID, speciesOptionGroup, speciesOptionName)
);

CREATE TABLE Background (
  backgroundID          INTEGER PRIMARY KEY,
  backgroundName        TEXT NOT NULL UNIQUE,
  backgroundSlug        TEXT NOT NULL UNIQUE,
  featID                INTEGER NOT NULL REFERENCES Feat(featID),   -- origin feat
  backgroundFeatNote    TEXT,                  -- 'Cleric' for Magic Initiate (Cleric)
  backgroundToolText    TEXT,                  -- 'Choose one kind of Gaming Set'
  toolEquipmentID       INTEGER REFERENCES Equipment(equipmentID),
  backgroundDescription TEXT,
  backgroundEquipmentText TEXT,                -- "(A) … or (B) 50 GP"
  sourceID              INTEGER NOT NULL REFERENCES Source(sourceID),
  sourcePage            INTEGER,
  active                INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE TABLE BackgroundAbility (
  backgroundID INTEGER NOT NULL REFERENCES Background(backgroundID) ON DELETE CASCADE,
  abilityID    INTEGER NOT NULL REFERENCES Ability(abilityID),
  PRIMARY KEY (backgroundID, abilityID)
);

CREATE TABLE BackgroundSkill (
  backgroundID INTEGER NOT NULL REFERENCES Background(backgroundID) ON DELETE CASCADE,
  skillID      INTEGER NOT NULL REFERENCES Skill(skillID),
  PRIMARY KEY (backgroundID, skillID)
);

CREATE TABLE BackgroundEquipment (
  backgroundEquipmentID INTEGER PRIMARY KEY,
  backgroundID          INTEGER NOT NULL REFERENCES Background(backgroundID) ON DELETE CASCADE,
  optionLabel           TEXT NOT NULL,         -- 'A', 'B'
  equipmentID           INTEGER REFERENCES Equipment(equipmentID),
  quantity              INTEGER NOT NULL DEFAULT 1,
  goldGp                INTEGER,
  CHECK ((equipmentID IS NULL) <> (goldGp IS NULL))
);

------------------------------------------------------------------------------
-- 6. Magic items (extends the existing Item table)
------------------------------------------------------------------------------

-- Item already exists in D1 (itemID, itemName, itemRarity, itemCost, itemType,
-- itemRestrictions, itemAttunement, itemSource, itemUrl, itemVisualDesc,
-- itemShopkeeperDesc, active, itemDescription, itemDescriptionSource).
-- Phase 1 adds nullable foreign keys beside the text columns; the text columns
-- are dropped only after the app and API read the new ones.
ALTER TABLE Item ADD COLUMN itemSlug TEXT;
ALTER TABLE Item ADD COLUMN rarityID INTEGER REFERENCES Rarity(rarityID);
ALTER TABLE Item ADD COLUMN categoryID INTEGER REFERENCES ItemCategory(categoryID);
ALTER TABLE Item ADD COLUMN sourceID INTEGER REFERENCES Source(sourceID);
ALTER TABLE Item ADD COLUMN sourcePage INTEGER;
ALTER TABLE Item ADD COLUMN itemRequiresAttunement INTEGER CHECK (itemRequiresAttunement IN (0, 1));
ALTER TABLE Item ADD COLUMN itemHeader TEXT;  -- SRD line: 'Wondrous Item, Rare (Requires Attunement)'
ALTER TABLE Item ADD COLUMN itemBaseRequirement TEXT;  -- 'Any Medium or Heavy, Except Hide Armor'
CREATE UNIQUE INDEX ItemSlugIdx ON Item(itemSlug);

-- "Rarity Varies" items: Weapon +1/+2/+3, Potion of Healing tiers, Spell
-- Scroll by spell level, Potion of Giant Strength by giant.
CREATE TABLE ItemVariant (
  itemVariantID   INTEGER PRIMARY KEY,
  itemID          INTEGER NOT NULL REFERENCES Item(itemID) ON DELETE CASCADE,
  variantName     TEXT NOT NULL,               -- '+2', 'Greater', 'Level 3', 'Frost Giant'
  rarityID        INTEGER NOT NULL REFERENCES Rarity(rarityID),
  variantCost     INTEGER,                     -- gp, same unit as Item.itemCost
  variantDetails  TEXT CHECK (variantDetails IS NULL OR json_valid(variantDetails)),  -- {"str":23} / {"hp":"8d4+8"}
  sortOrder       INTEGER NOT NULL,
  UNIQUE (itemID, variantName)
);

-- "Requires Attunement by a Cleric or Paladin / a Spellcaster / a Dwarf …".
-- One row per acceptable kind of creature; any row satisfies the requirement.
CREATE TABLE ItemAttunementReq (
  itemAttunementReqID INTEGER PRIMARY KEY,
  itemID              INTEGER NOT NULL REFERENCES Item(itemID) ON DELETE CASCADE,
  classID             INTEGER REFERENCES Class(classID),
  speciesID           INTEGER REFERENCES Species(speciesID),
  requiresSpellcaster INTEGER NOT NULL DEFAULT 0 CHECK (requiresSpellcaster IN (0, 1)),
  reqNote             TEXT                     -- 'a creature attuned to a Belt of Dwarvenkind'
);

-- Items that cast spells (wands, staffs, Cube of Force, Spell Scroll variants).
CREATE TABLE ItemSpell (
  itemID      INTEGER NOT NULL REFERENCES Item(itemID) ON DELETE CASCADE,
  spellID     INTEGER NOT NULL REFERENCES Spell(spellID),
  chargeCost  INTEGER,
  saveDc      INTEGER,
  castAtLevel INTEGER,
  PRIMARY KEY (itemID, spellID)
);

------------------------------------------------------------------------------
-- 7. Monsters
------------------------------------------------------------------------------

CREATE TABLE Monster (
  monsterID            INTEGER PRIMARY KEY,
  monsterName          TEXT NOT NULL UNIQUE,
  monsterSlug          TEXT NOT NULL UNIQUE,
  monsterGroup         TEXT,                   -- section heading: 'Awakened Plants', 'Animals'
  creatureTypeID       INTEGER NOT NULL REFERENCES CreatureType(creatureTypeID),
  monsterTypeTags      TEXT,                   -- '(Wizard)', '(Devil)'
  monsterAlignment     TEXT NOT NULL,          -- display text: 'Neutral', 'Typically Chaotic Evil'
  alignmentID          INTEGER REFERENCES Alignment(alignmentID),
  monsterAc            INTEGER NOT NULL,
  monsterAcNote        TEXT,
  monsterHpAvg         INTEGER NOT NULL,
  monsterHpDiceCount   INTEGER,
  monsterHpDiceSides   INTEGER,
  monsterHpBonus       INTEGER,
  monsterInitBonus     INTEGER,                -- NULL until sourced (5e-srd-api omits it)
  monsterStr           INTEGER NOT NULL,
  monsterDex           INTEGER NOT NULL,
  monsterCon           INTEGER NOT NULL,
  monsterInt           INTEGER NOT NULL,
  monsterWis           INTEGER NOT NULL,
  monsterCha           INTEGER NOT NULL,
  monsterPassivePerception INTEGER NOT NULL,
  monsterLanguages     TEXT,                   -- the Languages line as printed
  monsterTelepathyFt   INTEGER,
  crValue              REAL NOT NULL REFERENCES ChallengeRating(crValue),
  monsterXpInLair      INTEGER,                -- 'XP 5,900, or 7,200 in lair'
  monsterLegendaryUses INTEGER,               -- 'Legendary Action Uses: 3 (4 in Lair)'
  monsterLegendaryUsesLair INTEGER,
  monsterDescription   TEXT,
  sourceID             INTEGER NOT NULL REFERENCES Source(sourceID),
  sourcePage           INTEGER,
  active               INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);

CREATE INDEX MonsterCrIdx ON Monster(crValue);
CREATE INDEX MonsterTypeIdx ON Monster(creatureTypeID);

CREATE TABLE MonsterSize (
  monsterID INTEGER NOT NULL REFERENCES Monster(monsterID) ON DELETE CASCADE,
  sizeID    INTEGER NOT NULL REFERENCES CreatureSize(sizeID),
  PRIMARY KEY (monsterID, sizeID)
);

CREATE TABLE MonsterSpeed (
  monsterID    INTEGER NOT NULL REFERENCES Monster(monsterID) ON DELETE CASCADE,
  speedMode    TEXT NOT NULL CHECK (speedMode IN ('walk', 'burrow', 'climb', 'fly', 'swim')),
  speedFt      INTEGER NOT NULL,
  speedHover   INTEGER NOT NULL DEFAULT 0 CHECK (speedHover IN (0, 1)),
  PRIMARY KEY (monsterID, speedMode)
);

-- Saving throws that differ from the ability modifier (proficient saves).
CREATE TABLE MonsterSave (
  monsterID INTEGER NOT NULL REFERENCES Monster(monsterID) ON DELETE CASCADE,
  abilityID INTEGER NOT NULL REFERENCES Ability(abilityID),
  saveBonus INTEGER NOT NULL,
  PRIMARY KEY (monsterID, abilityID)
);

CREATE TABLE MonsterSkill (
  monsterID  INTEGER NOT NULL REFERENCES Monster(monsterID) ON DELETE CASCADE,
  skillID    INTEGER NOT NULL REFERENCES Skill(skillID),
  skillBonus INTEGER NOT NULL,
  PRIMARY KEY (monsterID, skillID)
);

CREATE TABLE MonsterSense (
  monsterID    INTEGER NOT NULL REFERENCES Monster(monsterID) ON DELETE CASCADE,
  senseKind    TEXT NOT NULL CHECK (senseKind IN ('blindsight', 'darkvision', 'tremorsense', 'truesight')),
  senseRangeFt INTEGER NOT NULL,
  senseNote    TEXT,                           -- '(blind beyond this radius)'
  PRIMARY KEY (monsterID, senseKind)
);

-- Resistances, Vulnerabilities and Immunities (damage types and conditions).
CREATE TABLE MonsterDefense (
  monsterDefenseID INTEGER PRIMARY KEY,
  monsterID        INTEGER NOT NULL REFERENCES Monster(monsterID) ON DELETE CASCADE,
  defenseKind      TEXT NOT NULL CHECK (defenseKind IN ('resistance', 'vulnerability', 'immunity')),
  damageTypeID     INTEGER REFERENCES DamageType(damageTypeID),
  conditionID      INTEGER REFERENCES Condition(conditionID),
  defenseNote      TEXT,                       -- qualifier, or the whole entry when it names no type
  CHECK (damageTypeID IS NULL OR conditionID IS NULL),
  CHECK (damageTypeID IS NOT NULL OR conditionID IS NOT NULL OR defenseNote IS NOT NULL)
);

-- Languages named on the Languages line, for filtering. The line itself (with
-- "understands … but can't speak", "plus two other languages") is Monster.monsterLanguages.
CREATE TABLE MonsterLanguage (
  monsterLanguageID INTEGER PRIMARY KEY,
  monsterID         INTEGER NOT NULL REFERENCES Monster(monsterID) ON DELETE CASCADE,
  languageID        INTEGER NOT NULL REFERENCES Language(languageID),
  languageNote      TEXT,                      -- dialect: 'Aquan, Terran'
  UNIQUE (monsterID, languageID)
);

-- "Gear Light Crossbow, Shortsword, Javelins (6)". gearText is kept for
-- entries that match no Equipment row (e.g. 'Wand').
CREATE TABLE MonsterGear (
  monsterGearID INTEGER PRIMARY KEY,
  monsterID     INTEGER NOT NULL REFERENCES Monster(monsterID) ON DELETE CASCADE,
  equipmentID   INTEGER REFERENCES Equipment(equipmentID),
  gearText      TEXT NOT NULL,
  quantity      INTEGER NOT NULL DEFAULT 1
);

-- Every entry under Traits, Actions, Bonus Actions, Reactions, Legendary Actions.
CREATE TABLE MonsterAction (
  monsterActionID   INTEGER PRIMARY KEY,
  monsterID         INTEGER NOT NULL REFERENCES Monster(monsterID) ON DELETE CASCADE,
  actionSection     TEXT NOT NULL CHECK (actionSection IN (
                      'trait', 'action', 'bonus_action', 'reaction', 'legendary_action')),
  actionName        TEXT NOT NULL,             -- 'Shortsword', 'Fire Breath'
  actionUsage       TEXT,                      -- '(Recharge 5–6)', '(3/Day)'
  actionRechargeMin INTEGER,                   -- 5 for Recharge 5–6
  actionUsesPerDay  INTEGER,
  attackKind        TEXT CHECK (attackKind IN ('melee', 'ranged', 'melee_or_ranged')),
  attackBonus       INTEGER,
  attackReachFt     INTEGER,
  attackRangeFt     INTEGER,
  attackRangeLongFt INTEGER,
  saveAbilityID     INTEGER REFERENCES Ability(abilityID),
  saveDc            INTEGER,
  actionDescription TEXT NOT NULL,             -- full text, always kept
  sortOrder         INTEGER NOT NULL,
  UNIQUE (monsterID, actionSection, sortOrder)   -- also how seeds address a row
);

-- Structured damage for attacks: "7 (1d6 + 4) Piercing plus 17 (5d6) Poison".
CREATE TABLE MonsterActionDamage (
  monsterActionID INTEGER NOT NULL REFERENCES MonsterAction(monsterActionID) ON DELETE CASCADE,
  damageIndex     INTEGER NOT NULL,            -- 0 primary, 1 "plus …"
  damageAvg       INTEGER NOT NULL,
  damageDiceCount INTEGER,
  damageDiceSides INTEGER,
  damageBonus     INTEGER,
  damageTypeID    INTEGER NOT NULL REFERENCES DamageType(damageTypeID),
  PRIMARY KEY (monsterActionID, damageIndex)
);

-- Spells inside a Spellcasting action: "At Will: …", "1/Day Each: …".
CREATE TABLE MonsterSpell (
  monsterActionID INTEGER NOT NULL REFERENCES MonsterAction(monsterActionID) ON DELETE CASCADE,
  spellID         INTEGER NOT NULL REFERENCES Spell(spellID),
  spellFrequency  TEXT NOT NULL,               -- 'at_will', '1/day', '2/day'
  castAtLevel     INTEGER,
  PRIMARY KEY (monsterActionID, spellID)
);

------------------------------------------------------------------------------
-- 8. Rules reference and Gameplay Toolbox
------------------------------------------------------------------------------

-- Rules Glossary terms, actions, hazards, curses and contagions, environmental
-- effects, fear and mental stress, traps. Structured extras go in ruleDetails.
CREATE TABLE RuleEntry (
  ruleID          INTEGER PRIMARY KEY,
  ruleTerm        TEXT NOT NULL,
  ruleSlug        TEXT NOT NULL UNIQUE,
  ruleCategory    TEXT NOT NULL CHECK (ruleCategory IN (
                    'glossary', 'action', 'area_of_effect', 'hazard', 'curse', 'contagion',
                    'environment', 'mental_stress', 'trap', 'other')),
  ruleTags        TEXT,                        -- '[Action]', '[Condition]', '[Hazard]'
  ruleDescription TEXT NOT NULL,
  ruleDetails     TEXT CHECK (ruleDetails IS NULL OR json_valid(ruleDetails)),  -- trap trigger/duration/countermeasures
  sourceID        INTEGER NOT NULL REFERENCES Source(sourceID),
  sourcePage      INTEGER,
  UNIQUE (ruleCategory, ruleTerm)
);

CREATE TABLE Poison (
  poisonID          INTEGER PRIMARY KEY,
  poisonName        TEXT NOT NULL UNIQUE,
  poisonType        TEXT NOT NULL CHECK (poisonType IN ('contact', 'ingested', 'inhaled', 'injury')),
  costCp            INTEGER,
  poisonDescription TEXT NOT NULL,
  sourceID          INTEGER NOT NULL REFERENCES Source(sourceID),
  sourcePage        INTEGER
);

CREATE TABLE TravelPace (
  paceName        TEXT PRIMARY KEY,            -- 'Fast', 'Normal', 'Slow'
  paceFtPerMinute INTEGER NOT NULL,
  paceMilesPerHour REAL NOT NULL,
  paceMilesPerDay INTEGER NOT NULL,
  paceEffect      TEXT
);

-- "XP Budget per Character" from Combat Encounters.
CREATE TABLE EncounterXpBudget (
  level    INTEGER PRIMARY KEY REFERENCES CharacterLevel(level),
  xpLow    INTEGER NOT NULL,
  xpModerate INTEGER NOT NULL,
  xpHigh   INTEGER NOT NULL
);

------------------------------------------------------------------------------
-- 9. Treasure generator (replaces src/app/treasure-generator/hoard-tables.ts)
------------------------------------------------------------------------------

-- Magic item tables A–I and the rarity each is sampled by (MAGIC_TABLE_RARITY).
CREATE TABLE MagicItemTable (
  magicTableID   TEXT PRIMARY KEY CHECK (length(magicTableID) = 1),
  rarityID       INTEGER NOT NULL REFERENCES Rarity(rarityID),
  magicTableNote TEXT
);

-- Optional finer control later: weighted d100 rows per table.
CREATE TABLE MagicItemTableEntry (
  magicTableID TEXT NOT NULL REFERENCES MagicItemTable(magicTableID) ON DELETE CASCADE,
  rollUpTo     INTEGER NOT NULL CHECK (rollUpTo BETWEEN 1 AND 100),
  itemID       INTEGER NOT NULL REFERENCES Item(itemID),
  itemVariantID INTEGER REFERENCES ItemVariant(itemVariantID),
  PRIMARY KEY (magicTableID, rollUpTo)
);

CREATE TABLE TreasureBand (
  bandID    TEXT PRIMARY KEY,                  -- 'cr0-4'
  minCr     REAL NOT NULL UNIQUE,
  bandLabel TEXT NOT NULL,                     -- 'CR 0–4'
  bandBlurb TEXT,
  sortOrder INTEGER NOT NULL
);

CREATE TABLE TreasureBandCoin (
  bandID        TEXT NOT NULL REFERENCES TreasureBand(bandID) ON DELETE CASCADE,
  denomKey      TEXT NOT NULL REFERENCES Denomination(denomKey),
  diceCount     INTEGER NOT NULL,
  diceSides     INTEGER NOT NULL,
  multiplier    INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bandID, denomKey)
);

CREATE TABLE TreasureHoardRow (
  hoardRowID       INTEGER PRIMARY KEY,
  bandID           TEXT NOT NULL REFERENCES TreasureBand(bandID) ON DELETE CASCADE,
  rollUpTo         INTEGER NOT NULL CHECK (rollUpTo BETWEEN 1 AND 100),
  valuableKind     TEXT CHECK (valuableKind IN ('gem', 'art')),
  valuableDiceCount INTEGER,
  valuableDiceSides INTEGER,
  valuableValueGp  INTEGER,
  UNIQUE (bandID, rollUpTo),
  CHECK ((valuableKind IS NULL) = (valuableValueGp IS NULL))
);

CREATE TABLE TreasureHoardMagicRoll (
  hoardRowID   INTEGER NOT NULL REFERENCES TreasureHoardRow(hoardRowID) ON DELETE CASCADE,
  magicTableID TEXT NOT NULL REFERENCES MagicItemTable(magicTableID),
  diceCount    INTEGER NOT NULL,
  diceSides    INTEGER NOT NULL,
  PRIMARY KEY (hoardRowID, magicTableID)
);

-- Gem and art object names by value (GEM_NAMES, ART_NAMES).
CREATE TABLE Valuable (
  valuableID   INTEGER PRIMARY KEY,
  valuableKind TEXT NOT NULL CHECK (valuableKind IN ('gem', 'art')),
  valueGp      INTEGER NOT NULL,
  valuableName TEXT NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  UNIQUE (valuableKind, valueGp, valuableName)
);

------------------------------------------------------------------------------
-- 10. Read views for the dnd-db-rest Worker (one GET per screen, no joins client-side)
------------------------------------------------------------------------------

CREATE VIEW SpellListView AS
SELECT s.spellID, s.spellName, s.spellSlug, s.spellLevel, ms.schoolName,
       s.spellCastingTime, s.spellIsRitual, s.spellRange, s.spellConcentration,
       s.spellDuration, s.active,
       (SELECT group_concat(c.className, ', ')
          FROM SpellClass sc JOIN Class c ON c.classID = sc.classID
         WHERE sc.spellID = s.spellID) AS spellClasses
  FROM Spell s JOIN MagicSchool ms ON ms.schoolID = s.schoolID;

CREATE VIEW MonsterListView AS
SELECT m.monsterID, m.monsterName, m.monsterSlug, ct.creatureTypeName,
       cr.crLabel, m.crValue, cr.xp, m.monsterAc, m.monsterHpAvg, m.active,
       (SELECT group_concat(z.sizeName, ' or ')
          FROM MonsterSize ms JOIN CreatureSize z ON z.sizeID = ms.sizeID
         WHERE ms.monsterID = m.monsterID) AS monsterSizes
  FROM Monster m
  JOIN CreatureType ct ON ct.creatureTypeID = m.creatureTypeID
  JOIN ChallengeRating cr ON cr.crValue = m.crValue;

CREATE VIEW EquipmentListView AS
SELECT e.equipmentID, e.equipmentName, e.equipmentSlug, e.equipmentKind,
       e.costCp, e.weightLb, e.active,
       w.weaponCategory, w.weaponRange, w.damageDiceCount, w.damageDiceSides,
       dt.damageTypeName, wm.masteryName,
       a.armorCategory, a.armorBaseAc, a.armorDexCap
  FROM Equipment e
  LEFT JOIN Weapon w ON w.equipmentID = e.equipmentID
  LEFT JOIN DamageType dt ON dt.damageTypeID = w.damageTypeID
  LEFT JOIN WeaponMastery wm ON wm.masteryID = w.masteryID
  LEFT JOIN Armor a ON a.equipmentID = e.equipmentID;
