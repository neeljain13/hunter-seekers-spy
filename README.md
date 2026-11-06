# Hunter / Seekers / Spy — MVP starter

A responsive browser app that can be opened on Android, iPhone, tablets, and desktop browsers.

## Game rules in this starter
- One Hunter is assigned randomly.
- One Spy is assigned randomly and secretly aligned with the Hunter.
- Everyone else is a Seeker.
- Only the Hunter receives live coordinates from players with GPS sharing enabled.
- The Spy's identity is hidden from the public roster and shown only to the Spy and server; the Hunter sees a private Spy check-in message.
- Hunter can mark a player caught after a real-world tag, using the group's agreed rules.
- 3–60 players per room. Room data is in memory and disappears when the server restarts.

## Run locally
1. Install Node.js 18 or newer.
2. In this folder run `npm install`
3. Run `npm start`
4. Open `http://localhost:3000`

For multiple phones on the same Wi-Fi, use your computer's LAN IP address. Browser GPS generally requires HTTPS on phones; `localhost` is an exception.

## Put it online
Deploy this folder to a Node.js host that supports WebSockets (for example, a service configured to run `npm start`). Add a domain and HTTPS certificate. Then share the HTTPS URL with players. Keep the service running for the whole game.

## Important before public use
This is an MVP starter, not a hardened production service. Add persistent storage, authenticated host controls, room expiry, rate limits, server-side game timers, anti-spoofing checks, abuse reporting, and security review before public deployment. Use GPS only with each player's explicit consent. Tell players who can see their location, set a clear play boundary, avoid roads/private property, and stop location sharing when the round ends. The app does not provide emergency services or verify physical tagging.
