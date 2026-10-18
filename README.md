# Reducto backend

Install dependencies with `pnpm install`. Install `ffmpeg` on the API server and
make it available on `PATH`; GIF/video uploads use its H.264 encoder.

Configure the local `.env` using `.env.example`, then run:

```sh
docker compose up -d
pnpm run db:migrate
pnpm run dev
```

Authenticated `POST /api/gifs` accepts a multipart `gif` field containing a GIF or
video, up to 50 MB. FFmpeg converts every upload into an H.264 MP4 without audio
before saving it under `gifs/` in object storage. The database file size refers
to the converted MP4. Uploads are automatically added to the user's library.
Existing stored files are not converted retroactively.

Run offline tests with `pnpm test`, typecheck with `pnpm run typecheck`, and format
code with `pnpm run format`.
