import { Router } from 'express';
import { spawn } from 'child_process';

const router = Router();

// Search YouTube using yt-dlp
router.get('/', async (req, res) => {
  const { q, limit = 10 } = req.query;

  if (!q) {
    return res.status(400).json({ error: 'Search query required' });
  }

  try {
    const results = await searchYouTube(q, parseInt(limit));
    res.json(results);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({ error: 'Search failed', details: error.message });
  }
});

function searchYouTube(query, limit) {
  return new Promise((resolve, reject) => {
    const args = [
      `ytsearch${limit}:${query}`,
      '--dump-json',
      '--flat-playlist',
      '--no-warnings',
      '--ignore-errors'
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
      if (code !== 0 && !stdout) {
        reject(new Error(stderr || `yt-dlp exited with code ${code}`));
        return;
      }

      try {
        // yt-dlp outputs one JSON object per line
        const results = stdout
          .trim()
          .split('\n')
          .filter(line => line.trim())
          .map(line => {
            const data = JSON.parse(line);
            return {
              youtube_id: data.id,
              title: data.title,
              artist: data.uploader || data.channel || '',
              duration: data.duration || 0,
              thumbnail: getBestThumbnail(data.thumbnails),
              url: data.url || `https://www.youtube.com/watch?v=${data.id}`
            };
          });

        resolve(results);
      } catch (parseError) {
        reject(new Error(`Failed to parse results: ${parseError.message}`));
      }
    });

    ytdlp.on('error', (error) => {
      reject(new Error(`Failed to start yt-dlp: ${error.message}. Is yt-dlp installed?`));
    });
  });
}

function getBestThumbnail(thumbnails) {
  if (!thumbnails || !thumbnails.length) return '';

  // Prefer medium-sized thumbnails for performance
  const preferred = thumbnails.find(t => t.width >= 320 && t.width <= 640);
  if (preferred) return preferred.url;

  // Fall back to last (usually highest quality)
  return thumbnails[thumbnails.length - 1]?.url || '';
}

export default router;
