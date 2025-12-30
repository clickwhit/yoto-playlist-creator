import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '../../data/yoto.db');

export const db = new Database(dbPath);

export function initDb() {
  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Playlists table
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT DEFAULT '#a8d5ba',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Songs cache table (downloaded songs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS songs (
      id TEXT PRIMARY KEY,
      youtube_id TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      artist TEXT,
      duration INTEGER,
      thumbnail TEXT,
      file_path TEXT,
      downloaded_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Playlist songs junction table (with ordering)
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlist_songs (
      id TEXT PRIMARY KEY,
      playlist_id TEXT NOT NULL,
      song_id TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (song_id) REFERENCES songs(id) ON DELETE CASCADE,
      UNIQUE(playlist_id, song_id)
    )
  `);

  // Yoto credentials (optional, stored locally)
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Create indexes for performance
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_playlist_songs_playlist ON playlist_songs(playlist_id);
    CREATE INDEX IF NOT EXISTS idx_playlist_songs_position ON playlist_songs(playlist_id, position);
    CREATE INDEX IF NOT EXISTS idx_songs_youtube_id ON songs(youtube_id);
  `);

  // Migration: Add yoto_card_id column if it doesn't exist
  const columns = db.prepare("PRAGMA table_info(playlists)").all();
  if (!columns.find(c => c.name === 'yoto_card_id')) {
    db.exec(`ALTER TABLE playlists ADD COLUMN yoto_card_id TEXT`);
  }

  console.log('📦 Database initialized');
}
