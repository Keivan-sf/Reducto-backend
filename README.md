# Reducto backend

Install dependencies with `pnpm install`. Install `ffmpeg` and `ffprobe` on the API server and
make them available on `PATH`; voice uploads require its `libopus` encoder,
GIF/video uploads use its H.264 encoder, and
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
clients can reserve the displayed aspect ratio. Audio, music, voice messages, and documents
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

## Media durations

Voice, music, and video attachment metadata includes a positive `durationSeconds`,
measured from the bytes stored in object storage. Images, documents, and ordinary
audio have `null` duration. The database check requires a positive duration for
timed attachments and `NULL` for all other types. Migration 0012 converts
existing untimed values to `NULL`. After applying the migrations, run:

```sh
pnpm run db:backfill-media-durations
```

The backfill reads existing timed attachments with a missing duration from object
storage, probes their durations, and validates the database check when all files
succeed. Failed records keep their `0` or `NULL` placeholder and are reported by
ID; fix the missing or corrupt files and rerun the command. It skips completed
rows. The command uses the server's database/S3 configuration and requires
`ffprobe` on PATH.

## Video thumbnails

Every video attachment and GIF (stored as MP4) has a JPEG thumbnail of its first
frame in object storage under `thumbnails/`. Video uploads fail if thumbnail
creation or storage fails, so new video records always have a thumbnail.
Forwarding preserves the thumbnail reference. Thumbnail dimensions match the
video's display dimensions, including rotation; no separate thumbnail width or
height is stored.

Attachment uploads and `GET /api/conversations/:conversationId/attachments/:mediaId/metadata`
return `thumbnailKey` and `thumbnailUrl` alongside the existing metadata. The URL
is presigned for 15 minutes and can be used directly as an image source without
an Authorization header. Fetch metadata again to renew it. Reading metadata
requires conversation membership and does not download the video. Both thumbnail
fields are null for nonvideo attachments. GIF upload, detail, and library responses
also include these fields, using the stored MP4's first frame.

For an existing deployment, stop API instances running the old upload code,
apply `pnpm run db:migrate`, deploy the updated code, and run:

```sh
pnpm run db:backfill-video-thumbnails
```

Migration 0008 adds nullable thumbnail references and database checks that require
a nonempty reference for every new video/GIF. The backfill processes missing
thumbnails in batches and validates the checks against historical records only
when every file succeeds. It preserves original media and records, reports
failures by ID, and exits with a nonzero status on failure. Fix missing/corrupt
source objects or storage errors and rerun it; completed rows are skipped.
Deterministic backfill keys prevent duplicate thumbnail objects after a failed
database update. Metadata may have null thumbnails until backfill completes.

If upgrading from before the dimensions migration, run the thumbnail backfill
first, then `pnpm run db:backfill-media-dimensions`. Thumbnail backfill also fills
missing video dimensions from the generated first frame without replacing existing
dimensions. Both commands use the server's database/S3 configuration and require
FFmpeg/ffprobe on PATH.

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
| POST         | `/api/conversations/:id/attachments`                        | Upload multipart `file`, optionally `kind=music` or `kind=voice`                                                  |
| GET          | `/api/conversations/:id/attachments/:mediaId`               | Download an attachment                                                                            |
| PUT / DELETE | `/api/conversations/:id/messages/:messageId/reactions`      | Add/remove my `{ "emoji": "👍" }` reaction                                                        |

Usernames are case-insensitive: `Alice` and `alice` resolve to the same user.
Username and user ID lookups reuse the same private conversation. Changing a
username does not change existing chats. Unknown usernames return `404`, and
starting a chat with yourself returns `400`.

To fetch the first (oldest) message directly, use authenticated
`GET /api/conversations/:conversationId/messages/first`. It returns
`{ "message": { ... } }`, including the usual message fields and reactions, or
`{ "message": null }` if the conversation is empty. Membership is required;
nonmembers receive `403`. The oldest message is selected by creation time, then
UUID for tied timestamps, using the existing message history index. Reading it
does not change the user's seen position. No migration is required. Use the
returned ID with the context endpoint below to load messages near the beginning.

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

## Seen positions and unread counts

Each conversation membership stores `lastSeenMessageId`. It is `null` until the
user explicitly marks a message as seen. Existing memberships also start with
null; the migration does not infer read history. Reading message history, fetching
metadata, sending a message, or requesting the conversation list does not mark
messages as seen.

`GET /api/conversations` includes these fields on every conversation for the
requesting user:

```json
{
  "id": "<conversation UUID>",
  "type": "private",
  "name": null,
  "createdAt": "2026-10-22T00:00:00.000Z",
  "lastSeenMessageId": null,
  "unreadCount": 12
}
```

Unread counts include every message strictly newer than that user's seen position,
including their own messages. With no seen position, all messages count as unread;
an empty chat has zero unread messages. Ordering matches message history:
`createdAt`, then message UUID for tied timestamps. PostgreSQL timestamp precision
is retained when comparing positions.

Advance the authenticated user's seen position with:

```http
PUT /api/conversations/:conversationId/seen
Authorization: Bearer <accessToken>
Content-Type: application/json

{ "messageId": "<last message displayed to the user>" }
```

The response is `{ "lastSeenMessageId": "...", "unreadCount": 0 }`, with the
actual unread count at the time of the update. The target must exist in this
conversation (`400` otherwise); membership is required (`403` for nonmembers).
The caller's user ID comes from their access token. Repeated or older positions
are ignored and return the current state. Updates from multiple devices are
serialized per member so the saved position cannot move backward.

After a successful advance, other current members receive the Socket.IO event
`conversation.seen` with `{ "userId": "...", "conversationId": "...",
"lastSeenMessageId": "..." }`. The actor, outsiders, and removed members do not
receive it. Unchanged or rejected updates emit no event. Fetch
`GET /api/conversations/:conversationId/members` to recover all current members'
seen positions after reconnecting; member entries now include `lastSeenMessageId`.
Removing a membership removes its seen state; rejoining starts with no seen
position. Deleting a conversation removes its messages and seen state together.

Run `pnpm run db:migrate` before deploying. Migration 0010 adds the nullable
membership field and a foreign key requiring the seen message to belong to the
same conversation. It preserves existing data and requires no backfill.

## Voice messages

Voice messages are a separate attachment type from music and ordinary audio.
Upload a multipart `file` with `kind=voice`:

```sh
curl -X POST "$API_URL/api/conversations/$CONVERSATION_ID/attachments" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -F 'kind=voice' \
  -F 'file=@recording.webm;type=audio/webm'
```

Supported inputs include Ogg, MP3, MP4/M4A audio, WebM audio, WAV, and FLAC.
Audio MIME types, including `audio/ogg;codecs=opus`, and `application/ogg` are
accepted; FFmpeg validates and decodes the actual audio. The first audio stream
is converted to mono, 48 kHz Ogg Opus, using speech encoding and a target bitrate
of 30 kbit/s with variable bitrate enabled. Output size varies with the recording.
Non-audio streams and source metadata are discarded. The upload limit is 50 MB;
empty, corrupt, or undecodable audio is rejected before storage.

The upload response's `attachment` has `type: "voice"`, `contentType: "audio/ogg"`,
an `.ogg` filename, and the converted file size. Width, height, and thumbnail
fields are null. Send the uploaded ID as a normal message attachment:

```json
{ "attachment": { "type": "voice", "mediaId": "<uploaded attachment UUID>" } }
```

Voice attachments support replies, forwarding, message history, and existing
`message.created` notifications. Use the attachment metadata and download endpoints
with conversation membership, as with other files. Downloads contain the converted
Ogg bytes. Music (`kind=music`) and audio uploads without a kind retain their
original files and types; they are not converted to voice messages.

Run `pnpm run db:migrate` before deploying voice support. Migration 0009 adds
`voice` to the media type enum without changing existing attachments or files;
there is no media backfill to run. FFmpeg with `libopus` must be installed on the
API server.

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
To edit a message, send `PATCH /api/conversations/:conversationId/messages/:messageId`
with `{ "text": "Updated text" }`. Only the sender, while still a member of the
conversation, can edit it. Text is trimmed and must contain 1–10,000 characters.
Other fields are rejected. The response is `{ "message": ... }`, including
attachment metadata. Every current member, including the sender, receives
`message.updated` with `{ conversationId, messageId, text }` containing the saved text.

Connections disconnect at token expiry; refresh the token over HTTP and reconnect.
Events are delivered to currently connected participants and are not queued for
offline users; retrieve persisted history through HTTP after reconnecting.

| Event                                       | Payload                                                 |
| ------------------------------------------- | ------------------------------------------------------- |
| `message.created`                           | `{ message }`                                           |
| `message.updated`                           | `{ conversationId, messageId, text }`                     |
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
