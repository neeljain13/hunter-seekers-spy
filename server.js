const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingInterval: 25000,
  pingTimeout: 60000
});

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 60;
const rooms = new Map();

app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/manifest.json", (_req, res) => res.sendFile(path.join(__dirname, "manifest.json")));
app.get("/sw.js", (_req, res) => res.sendFile(path.join(__dirname, "sw.js")));

function makeCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}
function cleanName(value) {
  return String(value || "").trim().replace(/[<>]/g, "").slice(0, 22);
}
function roomFor(socket) {
  return socket.data.roomCode ? rooms.get(socket.data.roomCode) : null;
}
function playerFor(room, socketId) {
  return room && room.players.get(socketId);
}
function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    role: room.status === "active" && p.role === "hunter" ? "hunter" : "player",
    caught: !!p.caught,
    isHost: p.id === room.hostId
  }));
}
function sendRoomState(room) {
  const players = publicPlayers(room);
  for (const p of room.players.values()) {
    io.to(p.id).emit("room-state", {
      code: room.code,
      players,
      status: room.status,
      settings: room.settings,
      myRole: room.status === "active" ? p.role : null,
      isHost: p.id === room.hostId
    });
  }
}
function assignRoles(room) {
  const all = [...room.players.values()];
  const hunterCount = Math.max(1, Math.min(5, Number(room.settings.hunterCount) || 1));
  const shuffled = all.slice().sort(() => Math.random() - 0.5);
  shuffled.forEach(p => { p.role = "seeker"; p.caught = false; p.location = null; });
  shuffled.slice(0, hunterCount).forEach(p => { p.role = "hunter"; });

  // With only two players and one Hunter, the second player is a Seeker.
  // When there are at least two non-Hunters, assign one of them as the Spy.
  const remainingPlayers = shuffled.slice(hunterCount);
  if (remainingPlayers.length >= 2) {
    remainingPlayers[0].role = "spy";
    remainingPlayers.slice(1).forEach(p => { p.role = "seeker"; });
  } else if (remainingPlayers.length === 1) {
    remainingPlayers[0].role = "seeker";
  }
}
function sendHunterData(room) {
  if (room.status !== "active") return;
  const hunters = [...room.players.values()]
    .filter(p => p.role === "hunter" && !p.caught && p.location)
    .map(p => ({ id: p.id, name: p.name, role: "hunter", lat: p.location.lat, lng: p.location.lng }));
  const targets = [...room.players.values()]
    .filter(p => (p.role === "seeker" || p.role === "spy") && !p.caught && p.location)
    .map(p => ({ id: p.id, name: p.name, role: p.role, lat: p.location.lat, lng: p.location.lng }));
  const intel = [...room.players.values()]
    .filter(p => p.role === "spy" && !p.caught)
    .map(p => ({ name: p.name, message: "The Spy is secretly helping the Hunter team." }));
  for (const p of room.players.values()) {
    if (p.role === "hunter") {
      io.to(p.id).emit("hunter-locations", { hunters, targets });
      io.to(p.id).emit("spy-intel", intel);
    }
  }
}
function removePlayer(socket) {
  const room = roomFor(socket);
  if (!room) return;
  room.players.delete(socket.id);
  socket.data.roomCode = null;
  if (!room.players.size) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === socket.id) room.hostId = room.players.keys().next().value;
  if (room.status === "active") sendHunterData(room);
  sendRoomState(room);
}

io.on("connection", socket => {
  socket.on("create-room", ({ name, hunterCount } = {}, callback = () => {}) => {
    const playerName = cleanName(name);
    if (!playerName) return callback({ ok: false, error: "Enter your name first." });
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();
    const count = Math.max(1, Math.min(5, Number(hunterCount) || 1));
    const room = {
      code, hostId: socket.id, status: "lobby",
      settings: { hunterCount: count },
      players: new Map()
    };
    room.players.set(socket.id, {
      id: socket.id, name: playerName, role: null, caught: false, location: null
    });
    rooms.set(code, room);
    socket.data.roomCode = code;
    callback({ ok: true, code });
    sendRoomState(room);
  });

  socket.on("join-room", ({ name, code } = {}, callback = () => {}) => {
    const playerName = cleanName(name);
    const roomCode = String(code || "").trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!playerName) return callback({ ok: false, error: "Enter your name first." });
    if (!room) return callback({ ok: false, error: "Room not found. Check the code." });
    if (room.status !== "lobby") return callback({ ok: false, error: "This game has already started." });
    if (room.players.size >= MAX_PLAYERS) return callback({ ok: false, error: "This room is full." });
    room.players.set(socket.id, {
      id: socket.id, name: playerName, role: null, caught: false, location: null
    });
    socket.data.roomCode = roomCode;
    callback({ ok: true, code: roomCode });
    sendRoomState(room);
  });

  socket.on("set-hunter-count", ({ count } = {}) => {
    const room = roomFor(socket);
    if (!room || room.status !== "lobby" || room.hostId !== socket.id) return;
    room.settings.hunterCount = Math.max(1, Math.min(5, Number(count) || 1));
    sendRoomState(room);
  });

  socket.on("start-game", () => {
    const room = roomFor(socket);
    if (!room || room.hostId !== socket.id || room.status !== "lobby") return;
    // Minimum is Hunters + one opponent. A Spy is added when there are
    // at least two non-Hunters; a two-player game has one Hunter and one Seeker.
    const required = room.settings.hunterCount + 1;
    if (room.players.size < required) {
      socket.emit("game-error", `You need at least ${required} players for ${room.settings.hunterCount} Hunter(s).`);
      return;
    }
    assignRoles(room);
    room.status = "active";
    sendRoomState(room);
    sendHunterData(room);
  });

  socket.on("location-update", ({ lat, lng } = {}) => {
    const room = roomFor(socket);
    const player = playerFor(room, socket.id);
    if (!room || room.status !== "active" || !player) return;
    const latitude = Number(lat), longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return;
    player.location = { lat: latitude, lng: longitude, updatedAt: Date.now() };
    sendHunterData(room);
  });

  socket.on("mark-caught", ({ targetId } = {}) => {
    const room = roomFor(socket);
    const hunter = playerFor(room, socket.id);
    const target = playerFor(room, targetId);
    if (!room || room.status !== "active" || !hunter || hunter.role !== "hunter" ||
        !target || (target.role !== "seeker" && target.role !== "spy") || target.caught) return;
    target.caught = true;
    target.location = null;
    const remaining = [...room.players.values()].filter(p =>
      (p.role === "seeker" || p.role === "spy") && !p.caught
    ).length;
    if (remaining === 0) room.status = "finished";
    sendRoomState(room);
    sendHunterData(room);
    io.to(room.code).emit("game-message", `${target.name} was caught.`);
  });

  socket.on("end-game", () => {
    const room = roomFor(socket);
    if (!room || room.hostId !== socket.id) return;
    room.status = "finished";
    for (const p of room.players.values()) p.location = null;
    sendRoomState(room);
  });

  socket.on("disconnect", () => removePlayer(socket));
});
server.listen(PORT, () => console.log(`Game server listening on ${PORT}`));
