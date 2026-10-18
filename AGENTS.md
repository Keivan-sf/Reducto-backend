## Project overview

This is a backend for a messaging app. It is kind of a Telegram clone.

- It should support basic private messaging user-to-user, and group messagin, and channels.
- Should support sending media including images,videos,documents and other filetypes. Also it should store their type
- Should also support gifs. and each user can have a gif storage for themselves that they can choose from to send
- Users should be able to edit their profile name and picture too
- Should also support reactions. users should be able to choose from a predifiend set of emojis to react to a message. much like discord and telegram.
- Authentication system

## Tools

- Nodejs and typescript as environment and the language
- Drizzel for database
- Express for route handling
- Socket.io for realtime notifications
- Zod for validation
- Swagger for automatic api documentation
- Use jest for tests

## Guidelines

- Write simple unit tests for each system you implement that can be run easily without messing up the real database or having to be connected to internet
- The project structure should have a src directory which consists of `/db`, `/components`, `/realtime`, `/lib`. for example an auth service and router should reside in `src/components/auth`
- Make sure each router in components is in a separate file than it's service
- You can setup middlewares to make your job easier for zod validation of requests
- Use prettier for formatting
- For an s3 bucket or database make sure there is a simple docker compose setup for testing

## Details

### Authentication system

- For signing up, only an email and password is needed
- For signing in, only an email and password is needed
- It should follow basic oauth2 using access token, referesh token and jwt
- There should be sign-out route as well
- Auth should have middlewares that can be used on other routes to make sure the user is authenticated

### Settings

- Users should be able to change their name and username
- Users should be able to setup or change their avatar.
- Avatar is only accepted if the image aspect ratio is 1:1 and the image is not too large
- Avatar is stored in a different folder on the object storage

### Gif system

- Users can upload gifs or videos to be stored as gifs. but in reality on the backend all of the gifs (and videos that are uploaded to be gifs) are converted and stored as muted mp4s. Use ffmpeg for this.
- There should be a limit of 50mb filesize for gifs
- When a gif is uploaded, it will have it's own id and record on the database and it's mp4 file should be stored on a suitable folder on the object storage
- A user can add gifs to their gif library. Meaning there should be a route where a user may provide a gif id and add that gif id to their library. and another route where user can request and see all the gif id's in their library
- A user can also remove gifs from their gif library
- When a user upload a gif themselves, it should automatically be added to their library after the gif is successfully uploaded and stored

### Chats / conversations

- A user can message another user therefore creating a conversation
- Sending a message should be done using http apis but notifications (new messages etc.) should be sent over web sockets using socket.io.
- A message can have text, and attatchment. A message can at most have one attatchment. an attatchment can be of the following types: 1.image 2.video 3.audio 4.gif 5.music 6.document(basically any other filetype)
- It's obvious that if the message attatchment is a gif, it should just consist of the gif id
- Messages can be forwarded from other users from other chats just like telegram
- Messages can have reactions. Just like discord or telegram. There should be a hard coded defined set of emojis which users can use for reaction

#### Groups
- Groups are type of conversation where multiple people can be in it at the same time
- Users can create groups (and they will be the owner of the group)
- Owners of a group can make other users admin of the group which have the same capablities as the owner except they can't make other users admin and they can't delete the group
- Each group should have a unique invite link that if a user clicks on, they will automatically join the group
