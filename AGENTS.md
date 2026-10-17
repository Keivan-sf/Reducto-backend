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

## Details

### Authentication system

- For signing up, only an email and password is needed
- For signing in, only an email and password is needed
- It should follow basic oauth2 using access token, referesh token and jwt
- There should be sign-out route as well
