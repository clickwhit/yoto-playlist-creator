import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import archiver from 'archiver';
import { db } from '../lib/db.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXPORTS_DIR = path.join(__dirname, '../../exports');
const DOWNLOADS_DIR = path.join(__dirname, '../../downloads');

// Ensure exports directory exists
if (!fs.existsSync(EXPORTS_DIR)) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

// Export playlist to folder
router.post('/:playlistId', async (req, res) => {
  const { playlistId } = req.params;

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
  if (!playlist) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  const songs = db.prepare(`
    SELECT s.*, ps.position
    FROM songs s
    JOIN playlist_songs ps ON s.id = ps.song_id
    WHERE ps.playlist_id = ?
    ORDER BY ps.position
  `).all(playlistId);

  // Check all songs are downloaded
  const notDownloaded = songs.filter(s => !s.file_path || !fs.existsSync(s.file_path));
  if (notDownloaded.length > 0) {
    return res.status(400).json({
      error: 'Some songs not downloaded',
      missing: notDownloaded.map(s => ({ youtube_id: s.youtube_id, title: s.title }))
    });
  }

  // Create sanitized folder name
  const folderName = sanitizeFilename(playlist.name);
  const exportPath = path.join(EXPORTS_DIR, folderName);

  // Remove existing export folder if it exists
  if (fs.existsSync(exportPath)) {
    fs.rmSync(exportPath, { recursive: true });
  }
  fs.mkdirSync(exportPath, { recursive: true });

  // Copy files with numbered prefixes for ordering
  const copied = [];
  for (const song of songs) {
    const trackNum = String(song.position + 1).padStart(2, '0');
    const sanitizedTitle = sanitizeFilename(song.title);
    const ext = path.extname(song.file_path);
    const newFilename = `${trackNum} - ${sanitizedTitle}${ext}`;
    const destPath = path.join(exportPath, newFilename);

    fs.copyFileSync(song.file_path, destPath);
    copied.push({ original: song.title, exported: newFilename });
  }

  res.json({
    success: true,
    playlist: playlist.name,
    exportPath,
    files: copied,
    totalTracks: copied.length
  });
});

// Get list of exported playlists
router.get('/', (req, res) => {
  if (!fs.existsSync(EXPORTS_DIR)) {
    return res.json({ exports: [] });
  }

  const exports = fs.readdirSync(EXPORTS_DIR, { withFileTypes: true })
    .filter(dirent => dirent.isDirectory())
    .map(dirent => {
      const folderPath = path.join(EXPORTS_DIR, dirent.name);
      const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.mp3'));
      const stats = fs.statSync(folderPath);
      return {
        name: dirent.name,
        path: folderPath,
        trackCount: files.length,
        exportedAt: stats.mtime
      };
    });

  res.json({ exports });
});

// Delete an export
router.delete('/:folderName', (req, res) => {
  const folderPath = path.join(EXPORTS_DIR, req.params.folderName);

  if (!fs.existsSync(folderPath)) {
    return res.status(404).json({ error: 'Export not found' });
  }

  fs.rmSync(folderPath, { recursive: true });
  res.status(204).send();
});

// Download playlist as zip
router.get('/download/:playlistId', async (req, res) => {
  const { playlistId } = req.params;

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
  if (!playlist) {
    return res.status(404).json({ error: 'Playlist not found' });
  }

  const songs = db.prepare(`
    SELECT s.*, ps.position
    FROM songs s
    JOIN playlist_songs ps ON s.id = ps.song_id
    WHERE ps.playlist_id = ?
    ORDER BY ps.position
  `).all(playlistId);

  const notDownloaded = songs.filter(s => !s.file_path || !fs.existsSync(s.file_path));
  if (notDownloaded.length > 0) {
    return res.status(400).json({
      error: 'Some songs not downloaded',
      missing: notDownloaded.map(s => s.title)
    });
  }

  const zipFilename = `${sanitizeFilename(playlist.name)}.zip`;
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${zipFilename}"`);

  const archive = archiver('zip', { zlib: { level: 5 } });
  archive.pipe(res);

  for (const song of songs) {
    const trackNum = String(song.position + 1).padStart(2, '0');
    const sanitizedTitle = sanitizeFilename(song.title);
    const ext = path.extname(song.file_path);
    const filename = `${trackNum} - ${sanitizedTitle}${ext}`;
    archive.file(song.file_path, { name: filename });
  }

  await archive.finalize();
});

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '') // Remove illegal chars
    .replace(/\s+/g, ' ') // Normalize spaces
    .trim()
    .substring(0, 100); // Limit length
}

export default router;
