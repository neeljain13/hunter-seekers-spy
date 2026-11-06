# Hunter vs Seekers vs Spy — Updated project

## Included
- `server.js` — Express + Socket.IO multiplayer server
- `index.html` — mobile-friendly game and Leaflet map UI
- `package.json` — dependencies and Render start command
- `manifest.json`, `sw.js` — basic install metadata
- `.gitignore`

## Deploy on Render (free web service)
1. Upload these files to the **root** of your GitHub repository, replacing the old files.
2. In Render, connect the repository as a **Web Service**.
3. Build command: `npm install`
4. Start command: `npm start`
5. Select the free instance type if available, then deploy.
6. Open the HTTPS `onrender.com` URL on your phone.

## Game rules implemented
- Host chooses 1–5 Hunters before starting.
- Starting requires Hunters + at least one opponent. A two-player game has 1 Hunter and 1 Seeker; with at least two non-Hunters, one is secretly assigned as the Spy.
- Spy identity is hidden from Seekers and non-Hunter players.
- Hunter team receives Hunter teammate positions and all active Seeker/Spy GPS positions.
- Any Hunter can mark a Seeker or Spy caught.
- GPS is opt-in on each device and requires HTTPS.
- Up to 60 players per room.

## Map layers
- Normal: OpenStreetMap.
- Satellite: Esri World Imagery.
- Use the Normal / Satellite buttons to switch. Keep provider attribution visible.
- These are third-party map services. Their availability, rate limits and usage terms may change. This project does not use Google's proprietary map tiles or Google Maps API.

## Important limitations
- This is a prototype, not a security-audited production game.
- Rooms and player data are held in server memory. They are lost when the server restarts or sleeps.
- Render free services may sleep when idle and can take time to wake.
- All players must keep the game open and grant location permission for live GPS updates.
- The server relays GPS to Hunters only, but players should still share location only with people they trust.
- No chat/voice communication feature is included.
