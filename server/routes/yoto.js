import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { db } from '../lib/db.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const YOTO_API_BASE = 'https://api.yotoplay.com';

// Standard headers for Yoto API requests
function getHeaders(token) {
  return {
    'authority': 'api.yotoplay.com',
    'accept': 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9',
    'authorization': `Bearer ${token}`,
    'origin': 'https://my.yotoplay.com',
    'referer': 'https://my.yotoplay.com/',
    'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'content-type': 'application/json'
  };
}

// Get stored Yoto credentials status
router.get('/auth/status', (req, res) => {
  const token = db.prepare("SELECT value FROM settings WHERE key = 'yoto_token'").get();
  const userId = db.prepare("SELECT value FROM settings WHERE key = 'yoto_user_id'").get();

  res.json({
    configured: !!(token?.value && userId?.value),
    hasToken: !!token?.value,
    hasUserId: !!userId?.value
  });
});

// Save Yoto credentials
router.post('/auth', (req, res) => {
  const { token, userId } = req.body;

  if (!token || !userId) {
    return res.status(400).json({ error: 'Both token and userId are required' });
  }

  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  upsert.run('yoto_token', token);
  upsert.run('yoto_user_id', userId);

  res.json({ success: true, message: 'Yoto credentials saved' });
});

// Clear Yoto credentials
router.delete('/auth', (req, res) => {
  db.prepare("DELETE FROM settings WHERE key IN ('yoto_token', 'yoto_user_id')").run();
  res.json({ success: true, message: 'Yoto credentials cleared' });
});

// Get Yoto cards (MYO playlists)
router.get('/cards', async (req, res) => {
  const creds = getCredentials();
  if (!creds) {
    return res.status(401).json({ error: 'Yoto credentials not configured' });
  }

  try {
    const response = await fetch(`${YOTO_API_BASE}/card/mine`, {
      headers: getHeaders(creds.token)
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Yoto API error: ${response.status} - ${text}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Yoto cards error:', error);
    res.status(500).json({ error: 'Failed to fetch Yoto cards', details: error.message });
  }
});

// Get a specific card's content
router.get('/cards/:cardId', async (req, res) => {
  const creds = getCredentials();
  if (!creds) {
    return res.status(401).json({ error: 'Yoto credentials not configured' });
  }

  try {
    const response = await fetch(`${YOTO_API_BASE}/content/${req.params.cardId}`, {
      headers: getHeaders(creds.token)
    });

    if (!response.ok) {
      throw new Error(`Yoto API error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error('Yoto card error:', error);
    res.status(500).json({ error: 'Failed to fetch Yoto card', details: error.message });
  }
});

// Upload a single track to Yoto
router.post('/upload-track', async (req, res) => {
  const { songId } = req.body;
  const creds = getCredentials();

  if (!creds) {
    return res.status(401).json({ error: 'Yoto credentials not configured' });
  }

  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
  if (!song || !song.file_path) {
    return res.status(404).json({ error: 'Song not found or not downloaded' });
  }

  if (!fs.existsSync(song.file_path)) {
    return res.status(404).json({ error: 'Song file not found on disk' });
  }

  try {
    const result = await uploadAudioToYoto(song.file_path, creds.token);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Upload track error:', error);
    res.status(500).json({ error: 'Failed to upload track', details: error.message });
  }
});

// Upload entire playlist to Yoto as a new card (with SSE progress)
router.get('/upload-playlist/:playlistId/stream', async (req, res) => {
  const { playlistId } = req.params;
  const creds = getCredentials();

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    console.log('[Yoto]', data.type, data.message || data.error || data.title || '');
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!creds) {
    sendEvent({ type: 'error', error: 'Yoto credentials not configured' });
    res.end();
    return;
  }

  const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
  if (!playlist) {
    sendEvent({ type: 'error', error: 'Playlist not found' });
    res.end();
    return;
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
    sendEvent({ type: 'error', error: 'Some songs not downloaded', missing: notDownloaded.map(s => s.title) });
    res.end();
    return;
  }

  try {
    const tracks = [];
    const errors = [];

    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      sendEvent({ type: 'upload-start', current: i + 1, total: songs.length, title: song.title });

      try {
        const result = await uploadAudioToYoto(song.file_path, creds.token, (msg) => {
          sendEvent({ type: 'log', message: msg });
        });
        tracks.push({
          title: song.title,
          trackNumber: i + 1,
          key: result.key,
          duration: song.duration,
          format: 'mp3'
        });
        sendEvent({ type: 'upload-complete', current: i + 1, total: songs.length, title: song.title });
      } catch (err) {
        errors.push({ title: song.title, error: err.message });
        sendEvent({ type: 'upload-error', current: i + 1, total: songs.length, title: song.title, error: err.message });
      }
    }

    if (tracks.length === 0) {
      sendEvent({ type: 'error', error: 'All uploads failed', errors });
      res.end();
      return;
    }

    const isUpdate = !!playlist.yoto_card_id;
    sendEvent({ type: 'log', message: isUpdate ? 'Updating Yoto card...' : 'Creating Yoto card...' });

    // Yoto content structure based on blast-hardcheese/Yoto-Music
    const content = {
      title: playlist.name,
      content: {
        activity: 'yoto_Player',
        chapters: tracks.map((t, i) => ({
          key: String(i).padStart(2, '0'),
          title: t.title,
          tracks: [{
            key: '01',
            title: t.title,
            format: 'aac',
            trackUrl: `yoto:#${t.key}`,
            type: 'audio',
            duration: t.duration || 0
          }]
        })),
        config: {
          onlineOnly: false
        },
        version: '1'
      },
      metadata: {
        cover: {
          imageL: 'https://cdn.yoto.io/myo-cover/star_grapefruit.gif'
        }
      },
      userId: creds.userId
    };

    // Include cardId for updates
    if (playlist.yoto_card_id) {
      content.cardId = playlist.yoto_card_id;
    }

    sendEvent({ type: 'log', message: `Sending: ${JSON.stringify(content).substring(0, 300)}...` });

    const persistResponse = await fetch(`${YOTO_API_BASE}/content`, {
      method: 'POST',
      headers: getHeaders(creds.token),
      body: JSON.stringify(content)
    });

    if (!persistResponse.ok) {
      const text = await persistResponse.text();
      sendEvent({ type: 'log', message: `Error response: ${text}` });
      sendEvent({ type: 'error', error: `Failed to create card: ${persistResponse.status} - ${text}` });
      res.end();
      return;
    }

    const cardData = await persistResponse.json();

    // Save the cardId for future updates
    const newCardId = cardData.card?.cardId;
    if (newCardId && newCardId !== playlist.yoto_card_id) {
      db.prepare('UPDATE playlists SET yoto_card_id = ? WHERE id = ?').run(newCardId, playlistId);
      sendEvent({ type: 'log', message: `Saved card ID: ${newCardId}` });
    }

    sendEvent({ type: 'done', success: true, card: cardData, uploadedTracks: tracks.length, errors: errors.length > 0 ? errors : undefined });
    res.end();
  } catch (error) {
    sendEvent({ type: 'error', error: error.message });
    res.end();
  }
});

// Upload entire playlist to Yoto as a new card (non-streaming fallback)
router.post('/upload-playlist/:playlistId', async (req, res) => {
  const { playlistId } = req.params;
  const creds = getCredentials();

  if (!creds) {
    return res.status(401).json({ error: 'Yoto credentials not configured' });
  }

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
      missing: notDownloaded.map(s => s.title)
    });
  }

  try {
    const tracks = [];
    const errors = [];

    // Upload each track
    for (let i = 0; i < songs.length; i++) {
      const song = songs[i];
      try {
        console.log(`Uploading track ${i + 1}/${songs.length}: ${song.title}`);
        const result = await uploadAudioToYoto(song.file_path, creds.token);
        tracks.push({
          title: song.title,
          trackNumber: i + 1,
          key: result.key,
          duration: song.duration,
          format: 'mp3'
        });
      } catch (err) {
        errors.push({ title: song.title, error: err.message });
      }
    }

    if (tracks.length === 0) {
      return res.status(500).json({ error: 'All uploads failed', errors });
    }

    // Yoto content structure based on blast-hardcheese/Yoto-Music
    const content = {
      title: playlist.name,
      content: {
        activity: 'yoto_Player',
        chapters: tracks.map((t, i) => ({
          key: String(i).padStart(2, '0'),
          title: t.title,
          tracks: [{
            key: '01',
            title: t.title,
            format: 'aac',
            trackUrl: `yoto:#${t.key}`,
            type: 'audio',
            duration: t.duration || 0
          }]
        })),
        config: {
          onlineOnly: false
        },
        version: '1'
      },
      metadata: {
        cover: {
          imageL: 'https://cdn.yoto.io/myo-cover/star_grapefruit.gif'
        }
      },
      userId: creds.userId
    };

    // Include cardId for updates
    if (playlist.yoto_card_id) {
      content.cardId = playlist.yoto_card_id;
    }

    // Persist the content to Yoto
    const persistResponse = await fetch(`${YOTO_API_BASE}/content`, {
      method: 'POST',
      headers: getHeaders(creds.token),
      body: JSON.stringify(content)
    });

    if (!persistResponse.ok) {
      const text = await persistResponse.text();
      throw new Error(`Failed to create card: ${persistResponse.status} - ${text}`);
    }

    const cardData = await persistResponse.json();

    // Save the cardId for future updates
    const newCardId = cardData.card?.cardId;
    if (newCardId && newCardId !== playlist.yoto_card_id) {
      db.prepare('UPDATE playlists SET yoto_card_id = ? WHERE id = ?').run(newCardId, playlistId);
    }

    res.json({
      success: true,
      card: cardData,
      uploadedTracks: tracks.length,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    console.error('Upload playlist error:', error);
    res.status(500).json({ error: 'Failed to upload playlist', details: error.message });
  }
});

// Helper: Upload audio file to Yoto's transcoding service
async function uploadAudioToYoto(filePath, token, log = () => {}) {
  const fileBuffer = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
  const filename = path.basename(filePath);

  // Step 1: Get upload URL
  log('Getting upload URL...');
  const uploadUrlResponse = await fetch(
    `${YOTO_API_BASE}/media/transcode/audio/uploadUrl?sha256=${sha256}&filename=${encodeURIComponent(filename)}`,
    { headers: getHeaders(token) }
  );

  if (!uploadUrlResponse.ok) {
    const errorText = await uploadUrlResponse.text();
    throw new Error(`Failed to get upload URL: ${uploadUrlResponse.status} - ${errorText}`);
  }

  const uploadUrlData = await uploadUrlResponse.json();

  const uploadUrl = uploadUrlData.upload?.uploadUrl;
  const uploadId = uploadUrlData.upload?.uploadId;

  if (!uploadId) {
    throw new Error(`No uploadId in response: ${JSON.stringify(uploadUrlData)}`);
  }

  // Step 2: Upload to S3 (skip if uploadUrl is null - file already uploaded)
  if (uploadUrl) {
    log('Uploading to S3...');
    const s3Response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'audio/mpeg'
      },
      body: fileBuffer
    });

    if (!s3Response.ok) {
      throw new Error(`Failed to upload to S3: ${s3Response.status}`);
    }
  } else {
    log('File already uploaded, checking transcoding...');
  }

  // Step 3: Poll for transcoding completion
  log('Waiting for transcoding...');
  let transcoded = null;

  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(r => setTimeout(r, 2000)); // Wait 2 seconds

    // Try the uploadId-based endpoint first (newer API)
    const statusResponse = await fetch(
      `${YOTO_API_BASE}/media/upload/${uploadId}/transcoded?loudnorm=false`,
      { headers: getHeaders(token) }
    );

    if (statusResponse.ok) {
      const statusData = await statusResponse.json();
      const transcodeInfo = statusData.transcode || statusData.transcoded || statusData;
      log(`Status: ${JSON.stringify(transcodeInfo)}`);

      // Check if transcoding is complete
      const isComplete = transcodeInfo.progress?.phase === 'complete' || transcodeInfo.transcodedAt;
      const key = transcodeInfo.transcodedSha256 || transcodeInfo.key;

      if (isComplete && key) {
        transcoded = { key };
        log('Transcoding complete!');
        break;
      }

      // Log progress if available
      if (transcodeInfo.progress) {
        log(`Transcode progress: ${transcodeInfo.progress.phase} ${transcodeInfo.progress.percent || 0}%`);
      }
    } else {
      log(`Status check failed: ${statusResponse.status}`);
    }
    log(`Transcoding... (${attempt + 1}/30)`);
  }

  if (!transcoded?.key) {
    throw new Error('Transcoding timed out or failed');
  }

  return transcoded;
}

function getCredentials() {
  // Check env vars first, then fall back to database
  const envToken = process.env.YOTO_TOKEN;
  const envUserId = process.env.YOTO_USER_ID;

  if (envToken && envUserId) {
    return { token: envToken, userId: envUserId };
  }

  // Fall back to database
  const token = db.prepare("SELECT value FROM settings WHERE key = 'yoto_token'").get();
  const userId = db.prepare("SELECT value FROM settings WHERE key = 'yoto_user_id'").get();

  if (!token?.value || !userId?.value) {
    return null;
  }

  return { token: token.value, userId: userId.value };
}

export default router;
