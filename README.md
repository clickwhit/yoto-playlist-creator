# Yoto Playlist Builder

![Yoto Playlist Builder Screenshot](screenshot.png)

A web app for building playlists from YouTube and uploading them to Yoto MYO cards.

## Features

- Search YouTube and add songs to playlists
- Download audio from YouTube (via yt-dlp)
- Drag-and-drop reordering
- Upload playlists directly to Yoto as MYO cards
- Dark mode

## Setup

```bash
pnpm install
```

### Yoto Integration (optional)

Click the "Connect Yoto" button in the app to login.

### Requirements

- Node.js 18+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) installed and in PATH

## Run

```bash
pnpm run dev
```

- Client: http://localhost:3000
- Server: http://localhost:3001

## License

MIT
