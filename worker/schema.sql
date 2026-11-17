CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT
);
CREATE TABLE IF NOT EXISTS plays (
  user_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  day TEXT NOT NULL,
  channel_id TEXT,
  guild_id TEXT,
  guesses INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  points INTEGER NOT NULL DEFAULT 0,
  bonus INTEGER,
  PRIMARY KEY (user_id, mode, day)
);
CREATE INDEX IF NOT EXISTS plays_channel ON plays (channel_id, mode, day);
CREATE INDEX IF NOT EXISTS plays_guild ON plays (guild_id, mode, day);
CREATE TABLE IF NOT EXISTS cards (
  channel_id TEXT NOT NULL,
  day TEXT NOT NULL,
  message_id TEXT NOT NULL,
  via TEXT NOT NULL,
  token TEXT,
  app_id TEXT,
  created_at INTEGER NOT NULL,
  people TEXT
);
CREATE INDEX IF NOT EXISTS cards_channel ON cards (channel_id, created_at);
CREATE TABLE IF NOT EXISTS recaps (
  channel_id TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (channel_id, day)
);
CREATE TABLE IF NOT EXISTS ratings (
  scope_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  elo REAL NOT NULL,
  games INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope_id, user_id)
);
CREATE TABLE IF NOT EXISTS elo_log (
  user_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  day TEXT NOT NULL,
  delta REAL NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, scope_id, mode, day)
);
