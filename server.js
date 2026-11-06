const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;
app.use(express.static("public"));
app.get("/", (_req, res) => res.sendFile(__dirname + "/index.html"));
app.get("/health", (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const makeCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();
const cleanName = s => String(s || "").trim().slice(0, 20);
const publicPlayers = room => [...room.players.values()].map(p => ({
  id: p.id, name: p.name,
  role: p.role === "hunter" ? "hunter" : "player",
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
  const hunterCount = Math.max(1, Math.min(5, Number(room.settings.hunterCount) || 1));
  if (players.length < hunterCount + 2) {
    throw new Error(`At least ${hunterCount + 2} players are required for ${hunterCount} Hunter(s) and one Spy.`);
  }
  players.forEach(p => { p.role = "seeker"; p.caught = false; p.location = null; });
  // Randomly choose the Hunter team, then one secret Spy from the remaining players.
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  shuffled.slice(0, hunterCount).forEach(p => { p.role = "hunter"; });
  const spy = shuffled.slice(hunterCount)[Math.floor(Math.random() * (players.length - hunterCount))];
  spy.role = "spy";
}

function sendHunterLocations(room) {
  const hunters = [...room.players.values()].filter(p => p.role === "hunter");
  const targets = [...room.players.values()]
    .filter(p => ["hunter", "seeker", "spy"].includes(p.role) && !p.caught && p.location)
    .map(p => ({ id: p.id, name: p.name, role: p.role, ...p.location }));
  // Only Hunter-team sockets receive this feed. It includes each Hunter's own marker.
  for (const hunter of hunters) io.to(hunter.id).emit("hunter-locations", targets);
}

io.on("connection", socket => {
  socket.on("create-room", ({ name }, cb = () => {}) => {
    const playerName = cleanName(name);
    if (!playerName) return cb({ error: "Enter your name." });
    let code;
    do { code = makeCode(); } while (rooms.has(code));
    const room = {
      code, hostId: socket.id, status: "lobby",
      settings: { maxPlayers: 60, durationMinutes: 15, hunterCount: 1 },
      players: new Map()
    };
    room.players.set(socket.id, { id: socket.id, name: playerName, role: "host", connected: true, caught: false, location: null });
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
    room.players.set(socket.id, { id: socket.id, name: playerName, role: "seeker", connected: true, caught: false, location: null });
    socket.join(code);
    cb({ code });
    sendRoomState(code);
  });

  socket.on("set-hunter-count", ({ code, count }, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.hostId !== socket.id) return cb({ error: "Only the host can change this setting." });
    if (room.status !== "lobby") return cb({ error: "Hunter count can only be changed in the lobby." });
    count = Number(count);
    if (!Number.isInteger(count) || count < 1 || count > 5) return cb({ error: "Choose between 1 and 5 Hunters." });
    room.settings.hunterCount = count;
    sendRoomState(room.code);
    cb({ ok: true });
  });

  socket.on("start-game", ({ code }, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.hostId !== socket.id) return cb({ error: "Only the host can start." });
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
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return cb({ error: "Invalid location." });
    player.location = { lat, lng, accuracy: Number.isFinite(accuracy) ? accuracy : null, updatedAt: Date.now() };
    sendHunterLocations(room);
    if (player.role === "spy") {
      const hunters = [...room.players.values()].filter(p => p.role === "hunter");
      for (const hunter of hunters) io.to(hunter.id).emit("spy-intel", { message: `${player.name} (your Spy) checked in.`, at: Date.now() });
    }
    cb({ ok: true });
  });

  socket.on("mark-caught", ({ code, targetId }, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    const hunter = room && room.players.get(socket.id);
    const target = room && room.players.get(String(targetId));
    if (!room || !hunter || hunter.role !== "hunter" || !target || !["seeker", "spy"].includes(target.role) || target.caught) return cb({ error: "That player cannot be marked caught." });
    target.caught = true;
    target.location = null;
    sendRoomState(room.code);
    sendHunterLocations(room);
    cb({ ok: true });
    const remaining = [...room.players.values()].filter(p => ["seeker", "spy"].includes(p.role) && !p.caught);
    if (!remaining.length) { room.status = "finished"; for (const p of room.players.values()) p.location = null; sendRoomState(room.code); }
  });

  socket.on("end-game", ({ code }, cb = () => {}) => {
    const room = rooms.get(String(code || "").toUpperCase());
    if (!room || room.hostId !== socket.id) return cb({ error: "Only the host can end the game." });
    room.status = "finished";
    for (const p of room.players.values()) p.location = null;
    sendRoomState(room.code);
    cb({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = room.players.get(socket.id);
      if (player) {
        player.connected = false;
        if (room.status === "lobby") room.players.delete(socket.id);
        sendRoomState(room.code);
        if (room.status === "active") sendHunterLocations(room);
      }
    }
  });
});

server.listen(PORT, () => console.log(`Hunter vs Seekers running on port ${PORT}`));
