import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { db } from '../lib/db.js';
import { YotoClient, DEFAULT_CLIENT_ID } from 'yoto-nodejs-client';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const YOTO_API_BASE = 'https://api.yotoplay.com';

// Store active device code sessions (in-memory, keyed by device_code)
const deviceCodeSessions = new Map();

// Cached YotoClient instance
let yotoClient = null;

// Initialize YotoClient from stored credentials
function getYotoClient() {
  if (yotoClient) return yotoClient;

  const creds = getStoredCredentials();
  if (!creds) return null;

  try {
    yotoClient = new YotoClient({
      clientId: DEFAULT_CLIENT_ID,
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      onTokenRefresh: (tokens) => {
        // Persist refreshed tokens to database
        console.log('[Yoto] Token refreshed, saving to database');
        saveCredentials({
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token || creds.refreshToken,
          userId: creds.userId
        });
      },
      onRefreshStart: () => console.log('[Yoto] Refreshing token...'),
      onRefreshError: (err) => console.warn('[Yoto] Token refresh error:', err.message),
      onInvalid: (err) => {
        console.error('[Yoto] Token invalid, clearing credentials:', err.message);
        clearCredentials();
        yotoClient = null;
      }
    });
    return yotoClient;
  } catch (err) {
    console.error('[Yoto] Failed to create client:', err.message);
    return null;
  }
}

// Get stored credentials from database
function getStoredCredentials() {
  const accessToken = db.prepare("SELECT value FROM settings WHERE key = 'yoto_access_token'").get();
  const refreshToken = db.prepare("SELECT value FROM settings WHERE key = 'yoto_refresh_token'").get();
  const userId = db.prepare("SELECT value FROM settings WHERE key = 'yoto_user_id'").get();

  if (!accessToken?.value || !refreshToken?.value) {
    return null;
  }

  return {
    accessToken: accessToken.value,
    refreshToken: refreshToken.value,
    userId: userId?.value
  };
}

// Save credentials to database
function saveCredentials({ accessToken, refreshToken, userId }) {
  const upsert = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  upsert.run('yoto_access_token', accessToken);
  upsert.run('yoto_refresh_token', refreshToken);
  if (userId) {
    upsert.run('yoto_user_id', userId);
  }

  // Reset cached client so it picks up new tokens
  yotoClient = null;
}

// Clear credentials from database
function clearCredentials() {
  db.prepare("DELETE FROM settings WHERE key LIKE 'yoto_%'").run();
  yotoClient = null;
}

// Standard headers for direct API calls (fallback)
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

// ============================================================================
// Auth Routes
// ============================================================================

// Get auth status
router.get('/auth/status', (req, res) => {
  const creds = getStoredCredentials();
  res.json({
    configured: !!creds,
    hasToken: !!creds?.accessToken,
    hasRefreshToken: !!creds?.refreshToken
  });
});

// Start device flow login
router.post('/auth/device-code', async (req, res) => {
  try {
    const deviceAuth = await YotoClient.requestDeviceCode({
      clientId: DEFAULT_CLIENT_ID
    });

    // Store session for polling
    deviceCodeSessions.set(deviceAuth.device_code, {
      createdAt: Date.now(),
      expiresIn: deviceAuth.expires_in,
      interval: deviceAuth.interval * 1000
    });

    res.json({
      deviceCode: deviceAuth.device_code,
      userCode: deviceAuth.user_code,
      verificationUri: deviceAuth.verification_uri,
      verificationUriComplete: deviceAuth.verification_uri_complete,
      expiresIn: deviceAuth.expires_in,
      interval: deviceAuth.interval
    });
  } catch (err) {
    console.error('[Yoto] Device code request failed:', err);
    res.status(500).json({ error: 'Failed to start login', details: err.message });
  }
});

// Poll for device authorization
router.post('/auth/poll', async (req, res) => {
  const { deviceCode } = req.body;

  if (!deviceCode) {
    return res.status(400).json({ error: 'deviceCode is required' });
  }

  const session = deviceCodeSessions.get(deviceCode);
  if (!session) {
    return res.status(400).json({ error: 'Invalid or expired device code session' });
  }

  try {
    const result = await YotoClient.pollForDeviceToken({
      deviceCode,
      clientId: DEFAULT_CLIENT_ID,
      currentInterval: session.interval
    });

    if (result.status === 'success') {
      // Extract user ID from the access token (JWT)
      let userId = null;
      try {
        const payload = JSON.parse(Buffer.from(result.tokens.access_token.split('.')[1], 'base64').toString());
        userId = payload.sub;
      } catch (e) {
        console.warn('[Yoto] Could not extract user ID from token');
      }

      // Save credentials
      saveCredentials({
        accessToken: result.tokens.access_token,
        refreshToken: result.tokens.refresh_token,
        userId
      });

      // Clean up session
      deviceCodeSessions.delete(deviceCode);

      res.json({ status: 'success', message: 'Login successful' });
    } else if (result.status === 'pending') {
      res.json({ status: 'pending' });
    } else if (result.status === 'slow_down') {
      session.interval = result.interval;
      res.json({ status: 'pending', interval: result.interval / 1000 });
    }
  } catch (err) {
    console.error('[Yoto] Poll failed:', err);
    deviceCodeSessions.delete(deviceCode);
    res.status(400).json({
      error: 'Authorization failed',
      details: err.jsonBody?.error_description || err.message
    });
  }
});

// Logout
router.delete('/auth', (req, res) => {
  clearCredentials();
  res.json({ success: true, message: 'Logged out' });
});

// ============================================================================
// Yoto API Routes
// ============================================================================

// Get Yoto cards (MYO playlists)
router.get('/cards', async (req, res) => {
  const client = getYotoClient();
  if (!client) {
    return res.status(401).json({ error: 'Yoto not connected. Please login first.' });
  }

  try {
    const data = await client.getUserMyoContent();
    res.json(data);
  } catch (error) {
    console.error('Yoto cards error:', error);
    res.status(500).json({ error: 'Failed to fetch Yoto cards', details: error.message });
  }
});

// Get a specific card's content
router.get('/cards/:cardId', async (req, res) => {
  const client = getYotoClient();
  if (!client) {
    return res.status(401).json({ error: 'Yoto not connected. Please login first.' });
  }

  try {
    const data = await client.getContent({ cardId: req.params.cardId });
    res.json(data);
  } catch (error) {
    console.error('Yoto card error:', error);
    res.status(500).json({ error: 'Failed to fetch Yoto card', details: error.message });
  }
});

// Upload a single track to Yoto
router.post('/upload-track', async (req, res) => {
  const { songId } = req.body;
  const creds = getStoredCredentials();

  if (!creds) {
    return res.status(401).json({ error: 'Yoto not connected. Please login first.' });
  }

  const song = db.prepare('SELECT * FROM songs WHERE id = ?').get(songId);
  if (!song || !song.file_path) {
    return res.status(404).json({ error: 'Song not found or not downloaded' });
  }

  if (!fs.existsSync(song.file_path)) {
    return res.status(404).json({ error: 'Song file not found on disk' });
  }

  try {
    const result = await uploadAudioToYoto(song.file_path, creds.accessToken);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Upload track error:', error);
    res.status(500).json({ error: 'Failed to upload track', details: error.message });
  }
});

// Upload entire playlist to Yoto as a new card (with SSE progress)
router.get('/upload-playlist/:playlistId/stream', async (req, res) => {
  const { playlistId } = req.params;
  const creds = getStoredCredentials();

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const sendEvent = (data) => {
    console.log('[Yoto]', data.type, data.message || data.error || data.title || '');
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!creds) {
    sendEvent({ type: 'error', error: 'Yoto not connected. Please login first.' });
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
        const result = await uploadAudioToYoto(song.file_path, creds.accessToken, (msg) => {
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
      headers: getHeaders(creds.accessToken),
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
  const creds = getStoredCredentials();

  if (!creds) {
    return res.status(401).json({ error: 'Yoto not connected. Please login first.' });
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
        const result = await uploadAudioToYoto(song.file_path, creds.accessToken);
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
      headers: getHeaders(creds.accessToken),
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

export default router;
