
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
const PROXIMITY_RADIUS = 25;
const MAX_LOCATION_AGE_MS = 30000;
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
    role: room.status === "active" && p.role === "hunter"
      ? "hunter"
      : "player",
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

function distanceInMetres(a, b) {
  const earthRadius = 6371000;
  const toRadians = degrees => degrees * Math.PI / 180;

  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);

  const value =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) *
    Math.sin(dLng / 2) ** 2;

  return earthRadius * 2 * Math.atan2(
    Math.sqrt(value),
    Math.sqrt(1 - value)
  );
}

function updateSeekerProximity(room) {
  if (room.status !== "active") return;

  const now = Date.now();

  const hunters = [...room.players.values()].filter(p =>
    p.role === "hunter" &&
    !p.caught &&
    p.location &&
    now - p.location.updatedAt <= MAX_LOCATION_AGE_MS
  );

  const seekers = [...room.players.values()].filter(p =>
    p.role === "seeker" && !p.caught
  );

  for (const seeker of seekers) {
    const isNear = !!seeker.location && hunters.some(hunter =>
      distanceInMetres(seeker.location, hunter.location) <= PROXIMITY_RADIUS
    );

    if (isNear && !seeker.hunterNearby) {
      io.to(seeker.id).emit("hunter-proximity-alert", {
        near: true,
        message: "WARNING! A Hunter is within 25 metres of you!"
      });
    }

    if (!isNear && seeker.hunterNearby) {
      io.to(seeker.id).emit("hunter-proximity-alert", {
        near: false,
        message: "You are outside the Hunter's 25-metre radius."
      });
    }

    seeker.hunterNearby = isNear;
  }
}

// Send fresh locations to all Hunters.
// Seekers never receive this event.
function sendHunterData(room) {
  if (room.status !== "active") return;

  const now = Date.now();

  const hunters = [...room.players.values()]
    .filter(p =>
      p.role === "hunter" &&
      !p.caught &&
      p.location &&
      now - p.location.updatedAt <= MAX_LOCATION_AGE_MS
    )
    .map(p => ({
      id: p.id,
      name: p.name,
      role: "hunter",
      lat: p.location.lat,
      lng: p.location.lng,
      updatedAt: p.location.updatedAt,
      accuracy: p.location.accuracy
    }));

  const targets = [...room.players.values()]
    .filter(p =>
      (p.role === "seeker" || p.role === "spy") &&
      !p.caught &&
      p.location &&
      now - p.location.updatedAt <= MAX_LOCATION_AGE_MS
    )
    .map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      lat: p.location.lat,
      lng: p.location.lng,
      updatedAt: p.location.updatedAt,
      accuracy: p.location.accuracy
    }));

  const intel = [...room.players.values()]
    .filter(p => p.role === "spy" && !p.caught)
    .map(p => ({
      name: p.name,
      message: "The Spy is secretly helping the Hunter team."
    }));

  for (const p of room.players.values()) {
    if (p.role === "hunter") {
      io.to(p.id).emit("hunter-locations", {
        hunters,
        targets,
        serverTime: now
      });

      io.to(p.id).emit("spy-intel", intel);
    }
  }
}

function assignRoles(room) {
  const all = [...room.players.values()];

  const hunterCount = Math.max(
    1,
    Math.min(5, Number(room.settings.hunterCount) || 1)
  );

  const shuffled = all.slice().sort(() => Math.random() - 0.5);

  shuffled.forEach(p => {
    p.role = "seeker";
    p.caught = false;
    p.location = null;
    p.hunterNearby = false;
  });

  shuffled.slice(0, hunterCount).forEach(p => {
    p.role = "hunter";
  });

  const remainingPlayers = shuffled.slice(hunterCount);

  if (remainingPlayers.length >= 2) {
    remainingPlayers[0].role = "spy";
    remainingPlayers.slice(1).forEach(p => {
      p.role = "seeker";
    });
  } else if (remainingPlayers.length === 1) {
    remainingPlayers[0].role = "seeker";
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

  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }

  if (room.status === "active") {
    updateSeekerProximity(room);
    sendHunterData(room);
  }

  sendRoomState(room);
}

io.on("connection", socket => {

  socket.on("create-room", ({ name, hunterCount } = {}, callback = () => {}) => {
    const playerName = cleanName(name);

    if (!playerName) {
      return callback({ ok: false, error: "Enter your name first." });
    }

    let code = makeCode();
    while (rooms.has(code)) code = makeCode();

    const count = Math.max(1, Math.min(5, Number(hunterCount) || 1));

    const room = {
      code,
      hostId: socket.id,
      status: "lobby",
      settings: { hunterCount: count },
      players: new Map()
    };

    room.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      role: null,
      caught: false,
      location: null,
      hunterNearby: false
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

    if (!playerName) {
      return callback({ ok: false, error: "Enter your name first." });
    }

    if (!room) {
      return callback({ ok: false, error: "Room not found. Check the code." });
    }

    if (room.status !== "lobby") {
      return callback({ ok: false, error: "This game has already started." });
    }

    if (room.players.size >= MAX_PLAYERS) {
      return callback({ ok: false, error: "This room is full." });
    }

    room.players.set(socket.id, {
      id: socket.id,
      name: playerName,
      role: null,
      caught: false,
      location: null,
      hunterNearby: false
    });

    socket.data.roomCode = roomCode;

    callback({ ok: true, code: roomCode });
    sendRoomState(room);
  });

  socket.on("set-hunter-count", ({ count } = {}) => {
    const room = roomFor(socket);

    if (!room || room.status !== "lobby" || room.hostId !== socket.id) return;

    room.settings.hunterCount = Math.max(
      1,
      Math.min(5, Number(count) || 1)
    );

    sendRoomState(room);
  });

  socket.on("start-game", () => {
    const room = roomFor(socket);

    if (!room || room.hostId !== socket.id || room.status !== "lobby") return;

    const required = room.settings.hunterCount + 1;

    if (room.players.size < required) {
      socket.emit(
        "game-error",
        `You need at least ${required} players for ${room.settings.hunterCount} Hunter(s).`
      );
      return;
    }

    assignRoles(room);
    room.status = "active";

    sendRoomState(room);
    sendHunterData(room);
    updateSeekerProximity(room);
  });

  // Receive GPS updates from every player.
  socket.on("location-update", ({ lat, lng, accuracy } = {}) => {
    const room = roomFor(socket);
    const player = playerFor(room, socket.id);

    if (!room || room.status !== "active" || !player || player.caught) return;

    const latitude = Number(lat);
    const longitude = Number(lng);
    const gpsAccuracy = Number(accuracy);

    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    ) return;

    player.location = {
      lat: latitude,
      lng: longitude,
      accuracy: Number.isFinite(gpsAccuracy) ? gpsAccuracy : null,
      updatedAt: Date.now()
    };

    // Immediately send the latest positions to every Hunter.
    sendHunterData(room);
    updateSeekerProximity(room);
  });

  socket.on("mark-caught", ({ targetId } = {}) => {
    const room = roomFor(socket);
    const hunter = playerFor(room, socket.id);
    const target = playerFor(room, targetId);

    if (
      !room ||
      room.status !== "active" ||
      !hunter ||
      hunter.role !== "hunter" ||
      !target ||
      (target.role !== "seeker" && target.role !== "spy") ||
      target.caught
    ) return;

    target.caught = true;
    target.location = null;
    target.hunterNearby = false;

    const remaining = [...room.players.values()].filter(p =>
      (p.role === "seeker" || p.role === "spy") && !p.caught
    ).length;

    if (remaining === 0) room.status = "finished";

    updateSeekerProximity(room);
    sendRoomState(room);
    sendHunterData(room);

    io.to(room.code).emit("game-message", `${target.name} was caught.`);
  });

  socket.on("end-game", () => {
    const room = roomFor(socket);

    if (!room || room.hostId !== socket.id) return;

    room.status = "finished";

    for (const p of room.players.values()) {
      p.location = null;
      p.hunterNearby = false;

      io.to(p.id).emit("hunter-proximity-alert", {
        near: false,
        message: ""
      });
    }

    sendRoomState(room);
    sendHunterData(room);
  });

  socket.on("disconnect", () => removePlayer(socket));
});

// Periodically refresh Hunter maps and expire stale GPS positions.
setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (room.status !== "active") continue;

    for (const player of room.players.values()) {
      if (
        player.location &&
        now - player.location.updatedAt > MAX_LOCATION_AGE_MS
      ) {
        player.location = null;
      }
    }

    sendHunterData(room);
    updateSeekerProximity(room);
  }
}, 3000);

server.listen(PORT, () => {
  console.log(`Game server listening on ${PORT}`);
});
