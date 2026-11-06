const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false } });
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true }));

// In-memory rooms: restarting the server clears all games and location data.
const rooms = new Map();
const makeCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const cleanName = (s) => String(s || "").trim().slice(0, 20);
const publicPlayers = (room) => [...room.players.values()].map(p => ({
  id: p.id, name: p.name, role: p.role === "hunter" ? "hunter" : "player",
  caught: !!p.caught, connected: !!p.connected
}));

function sendRoomState(code) {
  const room = rooms.get(code);
  if (!room) return;
  const roster = publicPlayers(room);
  for (const p of room.players.values()) {
    io.to(p.id).emit("room-state", {
      code, status: room.status, hostId: room.hostId,
      players: roster, settings: room.settings,
      myRole: p.role, isHost: p.id === room.hostId
    });
  }
}

function assignRoles(room) {
  const players = [...room.players.values()];
  if (players.length < 3) throw new Error("At least 3 players are required.");
  players.forEach(p => { p.role = "seeker"; p.caught = false; p.location = null; });
  const hunter = players[Math.floor(Math.random() * players.length)];
  hunter.role = "hunter";
  const candidates = players.filter(p => p.id !== hunter.id);
  const spy = candidates[Math.floor(Math.random() * candidates.length)];
  spy.role = "spy"; // Spy is secretly aligned with the Hunter.
}

io.on("connection", socket => {
  socket.on("create-room", ({ name }, cb = () => {}) => {
    const playerName = cleanName(name);
    if (!playerName) return cb({ error: "Enter your name." });
    let code;
    do { code = makeCode(); } while (rooms.has(code));
    const room = {
      code, hostId: socket.id, status: "lobby",
      settings: { maxPlayers: 60, durationMinutes: 15 },
      players: new Map()
    };
    room.players.set(socket.id, {
      id: socket.id, name: playerName, role: "host", connected: true,
      caught: false, location: null
    });
    rooms.set(code, room);
    socket.join(code);
    cb({ code });
    sendRoomState(code);
  });

  socket.on("join-room", ({ code, name }, cb = () => {}) => {
    code = String(code || "").trim().toUpperCase();
    const room = rooms.get(code);
    const playerName = cleanName(name);
    if (!playerName) return cb({ error: "Enter your name." });
    if (!room) return cb({ error: "Room not found. Check the code." });
    if (room.status !== "lobby") return cb({ error: "This game has already started." });
    if (room.players.size >= room.settings.maxPlayers) return cb({ error: "This room is full." });
    room.players.set(socket.id, {
      id: socket.id, name: playerName, role: "seeker", connected: true,
      caught: false, location: null
    });
    socket.join(code);
    cb({ code });
    sendRoomState(code);
  });

  socket.on("start-game", ({ code }, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.hostId !== socket.id) return cb({ error: "Only the host can start." });
    if (room.players.size < 3) return cb({ error: "Add at least 3 players before starting." });
    try { assignRoles(room); room.status = "active"; }
    catch (e) { return cb({ error: e.message }); }
    sendRoomState(room.code);
    cb({ ok: true });
  });

  socket.on("location-update", ({ code, lat, lng, accuracy }, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const player = room && room.players.get(socket.id);
    if (!room || room.status !== "active" || !player || player.caught) return cb({ error: "Game is not active." });
    lat = Number(lat); lng = Number(lng); accuracy = Number(accuracy);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return cb({ error: "Invalid location." });
    }
    player.location = { lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : null, updatedAt: Date.now() };

    // Only the Hunter receives live seeker/spy coordinates. Other seekers never receive the map feed.
    const hunter = [...room.players.values()].find(p => p.role === "hunter");
    if (hunter) {
      const targets = [...room.players.values()]
        .filter(p => (p.role === "seeker" || p.role === "spy") && !p.caught && p.location)
        .map(p => ({ id: p.id, name: p.name, role: p.role === "spy" ? "spy" : "seeker", ...p.location }));
      io.to(hunter.id).emit("hunter-locations", targets);
    }

    // Secret Spy can send a private location/intel ping to the Hunter.
    if (player.role === "spy" && hunter) {
      io.to(hunter.id).emit("spy-intel", { message: `${player.name} (your Spy) checked in.`, at: Date.now() });
    }
    cb({ ok: true });
  });

  socket.on("mark-caught", ({ code, targetId }, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const hunter = room && room.players.get(socket.id);
    const target = room && room.players.get(String(targetId));
    if (!room || !hunter || hunter.role !== "hunter" || !target ||
        !["seeker", "spy"].includes(target.role) || target.caught) {
      return cb({ error: "That player cannot be marked caught." });
    }
    target.caught = true;
    target.location = null;
    sendRoomState(room.code);
    cb({ ok: true });
    const remaining = [...room.players.values()].filter(p => ["seeker", "spy"].includes(p.role) && !p.caught);
    if (!remaining.length) {
      room.status = "finished";
      sendRoomState(room.code);
    }
  });

  socket.on("end-game", ({ code }, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.hostId !== socket.id) return cb({ error: "Only the host can end the game." });
    room.status = "finished";
    // Clear stored coordinates when the round ends.
    for (const p of room.players.values()) p.location = null;
    sendRoomState(room.code);
    cb({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = room.players.get(socket.id);
      if (player) {
        player.connected = false;
        // Keep the seat during a round; remove it from a lobby.
        if (room.status === "lobby") room.players.delete(socket.id);
        sendRoomState(room.code);
      }
    }
  });
});

server.listen(PORT, () => console.log(`Hunter vs Seekers running on port ${PORT}`));
