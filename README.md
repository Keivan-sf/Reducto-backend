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

## Conversations and messages

All chat and group HTTP endpoints require `Authorization: Bearer <accessToken>`.
Users can only read, send, react, upload, and download in conversations they belong
to. Group members can read the group's existing history when they join. Removed
members immediately lose access to future requests and notifications.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/conversations` | List my private chats and groups |
| POST | `/api/conversations/private` | Create/reuse a private chat with `{ "userId": "..." }` |
| POST | `/api/conversations/private/:userId/messages` | Send a message and create/reuse the chat |
| GET | `/api/conversations/:id` | Read a conversation |
| GET | `/api/conversations/:id/members` | List participants and roles |
| GET | `/api/conversations/:id/messages?limit=50&before=messageId` | History, newest first; use `nextCursor` for the next page |
| POST | `/api/conversations/:id/messages` | Send text and/or one attachment |
| POST | `/api/conversations/:id/forward` | Forward `{ "messageId": "..." }` from a chat I can access |
| POST | `/api/conversations/:id/attachments` | Upload multipart `file`, optionally `kind=music` |
| GET | `/api/conversations/:id/attachments/:mediaId` | Download an attachment |
| PUT / DELETE | `/api/conversations/:id/messages/:messageId/reactions` | Add/remove my `{ "emoji": "👍" }` reaction |

Message bodies accept `text` (up to 10,000 characters) and a single `attachment`:

```json
{ "text": "Hello!" }
```

```json
{ "attachment": { "type": "gif", "gifId": "<GIF UUID>" } }
```

```json
{ "text": "Photo", "attachment": { "type": "image", "mediaId": "<uploaded attachment UUID>" } }
```

For non-GIF attachments, first upload the file to the destination conversation,
then use the returned attachment `id` and `type`. The server classifies image,
video, audio, and document uploads by their declared MIME type; audio files
uploaded with `kind=music` use the `music` type. The limit is 50 MB per file.
GIFs use the existing `/api/gifs` upload/conversion flow and are referenced only by
GIF ID. Uploaders cannot attach another user's file as their own; use forwarding
to share an existing message. Forwarding checks both conversations and retains
the original sender information. Forwarded file references remain downloadable
in their destination even if the source group is deleted.

Allowed reactions: 👍 👎 ❤️ 😂 😮 😢 🔥 🎉. Each user can add multiple distinct
reactions; adding the same reaction twice is idempotent.

## Groups

| Method | Endpoint | Purpose |
| --- | --- | --- |
| POST | `/api/groups` | Create `{ "name": "My group" }`; creator becomes owner |
| GET / POST | `/api/groups/join/:token` | Join using the returned `inviteLink` (authentication required) |
| GET | `/api/groups/:id/invite` | Owner/admin: retrieve the invite link |
| PATCH | `/api/groups/:id` | Owner/admin: rename with `{ "name": "New name" }` |
| POST | `/api/groups/:id/members` | Owner/admin: add `{ "userId": "..." }` |
| PATCH | `/api/groups/:id/members/:userId` | Owner only: set `{ "role": "admin" }` or `"member"` |
| DELETE | `/api/groups/:id/members/:userId` | Owner/admin: remove a member; owner cannot be removed |
| POST | `/api/groups/:id/leave` | Leave a group; owner must delete it instead |
| DELETE | `/api/groups/:id` | Owner only: delete the group and its message history |

## Realtime notifications

The Socket.IO server shares the API's HTTP port. Connect with an access token:

```ts
const socket = io("http://localhost:3000", { auth: { token: accessToken } });
socket.on("message.created", ({ message }) => renderMessage(message));
```

The server assigns authenticated users to their own notification rooms. Clients
cannot choose rooms or send messages over the socket; sending uses the HTTP API.
Connections disconnect at token expiry; refresh the token over HTTP and reconnect.
Events are delivered to currently connected participants and are not queued for
offline users; retrieve persisted history through HTTP after reconnecting.

| Event | Payload |
| --- | --- |
| `message.created` | `{ message }` |
| `message.reaction_changed` | `{ conversationId, messageId, userId, emoji, removed }` |
| `conversation.updated` | `{ conversationId, name }` |
| `conversation.deleted` | `{ conversationId }` |
| `group.member_joined` / `group.member_left` | `{ conversationId, userId }` |
| `group.role_changed` | `{ conversationId, userId, role }` |

Request schemas and endpoint descriptions are available at `/openapi.json`.
Tests use in-memory repositories and storage plus temporary localhost HTTP/socket
servers; they do not contact PostgreSQL, MinIO, or external services.
