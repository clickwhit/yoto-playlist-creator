import { Router } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { db } from '../lib/db.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOWNLOADS_DIR = path.join(__dirname, '../../downloads');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Get download status for a song
router.get('/status/:youtubeId', (req, res) => {
  const song = db.prepare('SELECT * FROM songs WHERE youtube_id = ?').get(req.params.youtubeId);

  if (!song) {
    return res.json({ downloaded: false });
  }

  const downloaded = song.file_path && fs.existsSync(song.file_path);
  res.json({
    downloaded,
    song: downloaded ? song : null
  });
});

// Download a song
router.post('/:youtubeId', async (req, res) => {
  const { youtubeId } = req.params;

  // Check if already downloaded
  const existingSong = db.prepare('SELECT * FROM songs WHERE youtube_id = ?').get(youtubeId);
  if (existingSong?.file_path && fs.existsSync(existingSong.file_path)) {
    return res.json({ success: true, song: existingSong, cached: true });
  }

  try {
    const result = await downloadAudio(youtubeId);

    // Update song record with file path
    db.prepare(`
      UPDATE songs
      SET file_path = ?, downloaded_at = CURRENT_TIMESTAMP
      WHERE youtube_id = ?
    `).run(result.filePath, youtubeId);

    const song = db.prepare('SELECT * FROM songs WHERE youtube_id = ?').get(youtubeId);
    res.json({ success: true, song, cached: false });
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Download failed', details: error.message });
  }
});

// Download all songs in a playlist (with SSE progress)
router.get('/playlist/:playlistId/stream', async (req, res) => {
  const { playlistId } = req.params;

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const songs = db.prepare(`
    SELECT s.*
    FROM songs s
    JOIN playlist_songs ps ON s.id = ps.song_id
    WHERE ps.playlist_id = ?
    ORDER BY ps.position
  `).all(playlistId);

  const total = songs.length;
  let completed = 0;
  let errors = 0;

  for (const song of songs) {
    sendEvent({
      type: 'progress',
      current: completed + 1,
      total,
      title: song.title,
      youtube_id: song.youtube_id
    });

    // Skip if already downloaded
    if (song.file_path && fs.existsSync(song.file_path)) {
      completed++;
      sendEvent({ type: 'complete', youtube_id: song.youtube_id, cached: true });
      continue;
    }

    try {
      const result = await downloadAudio(song.youtube_id);
      db.prepare(`
        UPDATE songs
        SET file_path = ?, downloaded_at = CURRENT_TIMESTAMP
        WHERE youtube_id = ?
      `).run(result.filePath, song.youtube_id);
      completed++;
      sendEvent({ type: 'complete', youtube_id: song.youtube_id, cached: false });
    } catch (error) {
      errors++;
      sendEvent({ type: 'error', youtube_id: song.youtube_id, error: error.message });
    }
  }

  sendEvent({ type: 'done', completed, errors, total });
  res.end();
});

// Download all songs in a playlist (non-streaming fallback)
router.post('/playlist/:playlistId', async (req, res) => {
  const { playlistId } = req.params;

  const songs = db.prepare(`
    SELECT s.*
    FROM songs s
    JOIN playlist_songs ps ON s.id = ps.song_id
    WHERE ps.playlist_id = ?
    ORDER BY ps.position
  `).all(playlistId);

  const results = [];
  const errors = [];

  for (const song of songs) {
    // Skip if already downloaded
    if (song.file_path && fs.existsSync(song.file_path)) {
      results.push({ youtube_id: song.youtube_id, success: true, cached: true });
      continue;
    }

    try {
      const result = await downloadAudio(song.youtube_id);
      db.prepare(`
        UPDATE songs
        SET file_path = ?, downloaded_at = CURRENT_TIMESTAMP
        WHERE youtube_id = ?
      `).run(result.filePath, song.youtube_id);
      results.push({ youtube_id: song.youtube_id, success: true, cached: false });
    } catch (error) {
      errors.push({ youtube_id: song.youtube_id, error: error.message });
    }
  }

  res.json({ results, errors, total: songs.length });
});

function downloadAudio(youtubeId) {
  return new Promise((resolve, reject) => {
    const outputTemplate = path.join(DOWNLOADS_DIR, `${youtubeId}.%(ext)s`);
    const expectedPath = path.join(DOWNLOADS_DIR, `${youtubeId}.mp3`);

    const args = [
      `https://www.youtube.com/watch?v=${youtubeId}`,
      '-x', // Extract audio
      '--audio-format', 'mp3',
      '--audio-quality', '0', // Best quality
      '-o', outputTemplate,
      '--no-playlist',
      '--no-warnings',
      '--quiet', // Suppress console output
      '--embed-thumbnail',
      '--add-metadata'
      // Note: loudnorm disabled due to ffmpeg compatibility issues
      // Can be re-enabled with: '--postprocessor-args', 'ffmpeg_o:-af loudnorm=I=-16:TP=-1.5:LRA=11'
    ];

    const ytdlp = spawn('yt-dlp', args);
    let stdout = '';
    let stderr = '';

    ytdlp.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
        return;
      }

      // Find the actual output file (might have different extension)
      const files = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.startsWith(youtubeId));
      const mp3File = files.find(f => f.endsWith('.mp3'));

      if (mp3File) {
        resolve({ filePath: path.join(DOWNLOADS_DIR, mp3File) });
      } else if (files.length > 0) {
        // If no mp3, use whatever was downloaded
        resolve({ filePath: path.join(DOWNLOADS_DIR, files[0]) });
      } else {
        reject(new Error('Download completed but file not found'));
      }
    });

    ytdlp.on('error', (error) => {
      reject(new Error(`Failed to start yt-dlp: ${error.message}`));
    });
  });
}

export default router;
