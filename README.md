# FFmpeg Render Worker

Node.js service that merges video scenes, narration audio, background music, and subtitles into a final video using FFmpeg.

## Deploy to Railway

1. Push to GitHub
2. Create a new project on [railway.app](https://railway.app)
3. Connect the repo → Railway auto-detects the Dockerfile
4. Add environment variable: `PUBLIC_URL` = your Railway service URL
5. Deploy!

## API

### `GET /health`
Health check.

### `POST /render`
Accepts a render manifest and returns the final video URL.

### `POST /cleanup`
Removes old temp files.

### `GET /output/:filename`
Serves rendered video files.
