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
