import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../lib/db.js';

const router = Router();

// Get all playlists
router.get('/', (req, res) => {
  const playlists = db.prepare(`
    SELECT p.*, COUNT(ps.id) as song_count
    FROM playlists p
    LEFT JOIN playlist_songs ps ON p.id = ps.playlist_id
    GROUP BY p.id
    ORDER BY p.updated_at DESC
  `).all();

  res.json(playlists);
});

// Get single playlist with songs
router.get('/:id', (req, res) => {
  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);

  if (!playlist) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  const songs = db.prepare(`
    SELECT s.*, ps.position, ps.id as playlist_song_id
    FROM songs s
    JOIN playlist_songs ps ON s.id = ps.song_id
    WHERE ps.playlist_id = ?
    ORDER BY ps.position ASC
  `).all(req.params.id);

  res.json({ ...playlist, songs });
});

// Create playlist
router.post('/', (req, res) => {
  const { name, description, color } = req.body;
  const id = uuidv4();

  db.prepare(`
    INSERT INTO playlists (id, name, description, color)
    VALUES (?, ?, ?, ?)
  `).run(id, name, description || '', color || '#a8d5ba');

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
  res.status(201).json(playlist);
});

// Update playlist
router.put('/:id', (req, res) => {
  const { name, description, color } = req.body;

  db.prepare(`
    UPDATE playlists
    SET name = COALESCE(?, name),
        description = COALESCE(?, description),
        color = COALESCE(?, color),
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(name, description, color, req.params.id);

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(req.params.id);

  if (!playlist) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  res.json(playlist);
});

// Delete playlist
router.delete('/:id', (req, res) => {
  const result = db.prepare('DELETE FROM playlists WHERE id = ?').run(req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  res.status(204).send();
});

// Add song to playlist
router.post('/:id/songs', (req, res) => {
  const { youtube_id, title, artist, duration, thumbnail } = req.body;
  const playlistId = req.params.id;

  // Check playlist exists
  const playlist = db.prepare('SELECT id FROM playlists WHERE id = ?').get(playlistId);
  if (!playlist) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  // Get or create song in cache
  let song = db.prepare('SELECT * FROM songs WHERE youtube_id = ?').get(youtube_id);

  if (!song) {
    const songId = uuidv4();
    db.prepare(`
      INSERT INTO songs (id, youtube_id, title, artist, duration, thumbnail)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(songId, youtube_id, title, artist || '', duration || 0, thumbnail || '');
    song = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
  }

  // Check if already in playlist
  const existing = db.prepare(`
    SELECT id FROM playlist_songs WHERE playlist_id = ? AND song_id = ?
  `).get(playlistId, song.id);

  if (existing) {
    return res.status(400).json({ error: 'Song already in playlist' });
  }

  // Get max position
  const maxPos = db.prepare(`
    SELECT COALESCE(MAX(position), -1) as max_pos FROM playlist_songs WHERE playlist_id = ?
  `).get(playlistId);

  // Add to playlist
  const psId = uuidv4();
  db.prepare(`
    INSERT INTO playlist_songs (id, playlist_id, song_id, position)
    VALUES (?, ?, ?, ?)
  `).run(psId, playlistId, song.id, maxPos.max_pos + 1);

  // Update playlist timestamp
  db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);

  res.status(201).json({ ...song, position: maxPos.max_pos + 1, playlist_song_id: psId });
});

// Remove song from playlist
router.delete('/:id/songs/:songId', (req, res) => {
  const { id: playlistId, songId } = req.params;

  const result = db.prepare(`
    DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?
  `).run(playlistId, songId);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Song not found in playlist' });
  }

  // Reorder remaining songs
  const songs = db.prepare(`
    SELECT id FROM playlist_songs WHERE playlist_id = ? ORDER BY position
  `).all(playlistId);

  const updateStmt = db.prepare('UPDATE playlist_songs SET position = ? WHERE id = ?');
  songs.forEach((s, index) => {
    updateStmt.run(index, s.id);
  });

  db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);

  res.status(204).send();
});

// Reorder songs in playlist
router.put('/:id/reorder', (req, res) => {
  const { songIds } = req.body; // Array of song IDs in new order
  const playlistId = req.params.id;

  const updateStmt = db.prepare(`
    UPDATE playlist_songs SET position = ? WHERE playlist_id = ? AND song_id = ?
  `);

  const transaction = db.transaction(() => {
    songIds.forEach((songId, index) => {
      updateStmt.run(index, playlistId, songId);
    });
  });

  transaction();

  db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);

  res.json({ success: true });
});

export default router;
