import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env') });
import express from 'express';
import cors from 'cors';
import { initDb } from './lib/db.js';
import playlistRoutes from './routes/playlists.js';
import searchRoutes from './routes/search.js';
import downloadRoutes from './routes/downloads.js';
import exportRoutes from './routes/export.js';
import yotoRoutes from './routes/yoto.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Initialize database
initDb();

// Routes
app.use('/api/playlists', playlistRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/downloads', downloadRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/yoto', yotoRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Yoto Playlist Builder is running!' });
});

app.listen(PORT, () => {
  console.log(`🎵 Yoto Playlist Builder running on http://localhost:${PORT}`);
});
