# Reducto backend

Install dependencies with `pnpm install`. Install `ffmpeg` and `ffprobe` on the API server and
make them available on `PATH`; GIF/video uploads use its H.264 encoder and
video dimensions are read with ffprobe.

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

`POST /api/gifs`, `GET /api/gifs`, and `GET /api/gifs/:gifId` return a
`playbackUrl` alongside each GIF's `id`, `userId`, `objectKey`, `fileSize`, and
`createdAt`. Use it directly as a video player's source. The URL is presigned for
15 minutes and supports normal object-storage video playback; fetch the library
or GIF details again to obtain a fresh URL. Requests for GIF details require a
bearer token, but the returned link plays without an Authorization header.
`S3_ENDPOINT` must be reachable by clients playing the URL. For a message's GIF
attachment, fetch `/api/gifs/:gifId` to resolve its ID into metadata and a playable URL.

## Media dimensions

GIF upload, library, and detail responses include `width` and `height` in pixels.
These describe the stored MP4 after conversion. Image/video attachment uploads
also return these fields. Clients can fetch them before downloading a file with:

```http
GET /api/conversations/:conversationId/attachments/:mediaId/metadata
Authorization: Bearer <accessToken>
```

The response is `{ "attachment": { "id": "...", "type": "image", "width": 640,
"height": 480, ... } }`. It includes the upload's other metadata and requires
conversation membership. It reads only the database. The existing attachment
GET endpoint continues to download the file. For GIF message references, use
`GET /api/gifs/:gifId`. Width and height follow image EXIF/video rotation so
clients can reserve the displayed aspect ratio. Audio, music, and documents
return `null` for both dimensions.

For an existing deployment, stop API instances running the old upload code,
apply `pnpm run db:migrate`, deploy the updated API, and run:

```sh
pnpm run db:backfill-media-dimensions
```

Migration 0007 adds nullable columns without changing files or deleting records.
Its `NOT VALID` checks require positive dimensions for all new GIFs, images, and
videos immediately, while allowing historical rows to await backfill. The command
reads missing dimensions from stored objects in batches, saves each successful
result, and validates both database checks when no failures remain. These checks
then require dimensions for all visual media, equivalent to conditional NOT NULL
constraints; nonvisual attachments keep null dimensions. Historical responses may
contain null dimensions until backfill completes. Missing or corrupt files are
reported by record ID, preserved, and cause a nonzero exit status. Restore those
objects and rerun the command; completed records are skipped. The command requires
the same database/S3 environment variables as the server and ffprobe on PATH.

Run offline tests with `pnpm test`, typecheck with `pnpm run typecheck`, and format
code with `pnpm run format`.

## User profiles

Authenticated lookups return basic details for any user:

- `GET /api/users/:userId`
- `GET /api/users/by-username/:username` (case-insensitive)

```json
{
	"user": {
		"id": "<user UUID>",
		"name": "Display name",
		"username": "some_user",
		"avatarUrl": "<presigned avatar URL>"
	}
}
```

`name` is the display name. `username` and `avatarUrl` are null when unset.
Avatar URLs can be used directly by image clients and expire after 15 minutes;
fetch the profile again to refresh them. `S3_ENDPOINT` must be reachable from the
client using the URL. Responses exclude email addresses, password hashes, and
storage keys. Malformed IDs/usernames return `400`; missing users return `404`.

## Conversations and messages

HTTP and Socket.IO endpoints accept requests from every origin, including
credentialed browser requests. CORS preflights allow all application HTTP methods
and reflect requested headers, including `Authorization` and `Content-Type`.
Authentication and conversation membership checks still apply.

All chat and group HTTP endpoints require `Authorization: Bearer <accessToken>`.
Users can only read, send, react, upload, and download in conversations they belong
to. Group members can read the group's existing history when they join. Removed
members immediately lose access to future requests and notifications.

| Method       | Endpoint                                                    | Purpose                                                                                           |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| GET          | `/api/conversations`                                        | List my private chats and groups                                                                  |
| POST         | `/api/conversations/private`                                | Create/reuse a private chat with `{ "username": "alice" }` or `{ "userId": "..." }` (exactly one) |
| POST         | `/api/conversations/private/:userId/messages`               | Send a message and create/reuse the chat                                                          |
| POST         | `/api/conversations/private/by-username/:username/messages` | Send a message by username and create/reuse the chat                                              |
| GET          | `/api/conversations/:id`                                    | Read a conversation                                                                               |
| GET          | `/api/conversations/:id/members`                            | List participants and roles                                                                       |
| GET          | `/api/conversations/:id/messages?limit=50&before=messageId` | History, newest first; use `nextCursor` for the next page                                         |
| POST         | `/api/conversations/:id/messages`                           | Send text and/or one attachment                                                                   |
| POST         | `/api/conversations/:id/forward`                            | Forward `{ "messageId": "..." }` from a chat I can access                                         |
| POST         | `/api/conversations/:id/attachments`                        | Upload multipart `file`, optionally `kind=music`                                                  |
| GET          | `/api/conversations/:id/attachments/:mediaId`               | Download an attachment                                                                            |
| PUT / DELETE | `/api/conversations/:id/messages/:messageId/reactions`      | Add/remove my `{ "emoji": "👍" }` reaction                                                        |

Usernames are case-insensitive: `Alice` and `alice` resolve to the same user.
Username and user ID lookups reuse the same private conversation. Changing a
username does not change existing chats. Unknown usernames return `404`, and
starting a chat with yourself returns `400`.

To jump to a message with context, use
`GET /api/conversations/:id/messages/:messageId/around?before=50&after=50`.
It returns `{ message, before, after, hasMoreBefore, hasMoreAfter }`. Both counts
default to 50 and accept integers from 0 to 100. The target appears only in
`message`; `before` and `after` contain the closest older/newer messages, each in
chronological order. All returned messages include reactions and reply references.
Ordering uses creation time with message ID as a tiebreaker. Access requires
conversation membership; a missing target or one from another chat returns `404`.

Message bodies accept `text` (up to 10,000 characters), a single `attachment`,
and an optional `replyToMessageId`:

```json
{ "text": "Hello!" }
```

```json
{
	"text": "Replying to your question",
	"replyToMessageId": "<original message UUID>"
}
```

Replies work in private chats and groups, including the send-by-ID and
send-by-username endpoints. The target must exist in the same conversation;
missing or cross-chat targets return `400`. A reply still needs text or an
attachment. Replies can reference other replies. Message responses, history,
and `message.created` notifications include `replyToMessageId` (null for ordinary
messages). Use authenticated `GET /api/conversations/:id/messages/:messageId` to
fetch a reply target outside the current history page. Forwarded messages retain
their origin metadata but do not inherit the source message's reply reference.

```json
{ "attachment": { "type": "gif", "gifId": "<GIF UUID>" } }
```

```json
{
	"text": "Photo",
	"attachment": { "type": "image", "mediaId": "<uploaded attachment UUID>" }
}
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

| Method     | Endpoint                          | Purpose                                                        |
| ---------- | --------------------------------- | -------------------------------------------------------------- |
| POST       | `/api/groups`                     | Create `{ "name": "My group" }`; creator becomes owner         |
| GET / POST | `/api/groups/join/:token`         | Join using the returned `inviteLink` (authentication required) |
| GET        | `/api/groups/:id/invite`          | Owner/admin: retrieve the invite link                          |
| PATCH      | `/api/groups/:id`                 | Owner/admin: rename with `{ "name": "New name" }`              |
| POST       | `/api/groups/:id/members`         | Owner/admin: add `{ "userId": "..." }`                         |
| PATCH      | `/api/groups/:id/members/:userId` | Owner only: set `{ "role": "admin" }` or `"member"`            |
| DELETE     | `/api/groups/:id/members/:userId` | Owner/admin: remove a member; owner cannot be removed          |
| POST       | `/api/groups/:id/leave`           | Leave a group; owner must delete it instead                    |
| DELETE     | `/api/groups/:id`                 | Owner only: delete the group and its message history           |

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

| Event                                       | Payload                                                 |
| ------------------------------------------- | ------------------------------------------------------- |
| `message.created`                           | `{ message }`                                           |
| `message.reaction_changed`                  | `{ conversationId, messageId, userId, emoji, removed }` |
| `conversation.updated`                      | `{ conversationId, name }`                              |
| `conversation.deleted`                      | `{ conversationId }`                                    |
| `group.member_joined` / `group.member_left` | `{ conversationId, userId }`                            |
| `group.role_changed`                        | `{ conversationId, userId, role }`                      |

Profile changes emit `user.profile_updated` with `{ userId, changedFields }`, where
`changedFields` contains `name`, `username`, and/or `avatar`. Only other users who
currently share a private conversation or group with the changed user receive it.
Recipients are deduplicated across shared chats; the changed user, unrelated users,
and former members without another shared chat are excluded. Notifications follow
successful saves, and unchanged name/username updates do not emit an event.
Fetch `/api/users/:userId` on receipt to refresh details and the temporary avatar URL.

Request schemas and endpoint descriptions are available at `/openapi.json`.
Tests use in-memory repositories and storage plus temporary localhost HTTP/socket
servers; they do not contact PostgreSQL, MinIO, or external services.
