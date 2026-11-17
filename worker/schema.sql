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
  PRIMARY KEY (user_id, mode, day)
);
CREATE INDEX IF NOT EXISTS plays_channel ON plays (channel_id, mode, day);
CREATE INDEX IF NOT EXISTS plays_guild ON plays (guild_id, mode, day);
