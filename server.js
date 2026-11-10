
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

/* -------------------- WEBSITE ROUTES -------------------- */

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    message: "Hunter vs Seekers server is running"
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.get("/manifest.json", (_req, res) => {
  res.sendFile(path.join(__dirname, "manifest.json"));
});

app.get("/sw.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "sw.js"));
});

/* -------------------- HELPER FUNCTIONS -------------------- */

function makeCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/[<>]/g, "")
    .slice(0, 22);
}

function roomFor(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function playerFor(room, socketId) {
  return room ? room.players.get(socketId) : null;
}

function publicPlayers(room) {
  return [...room.players.values()].map(player => ({
    id: player.id,
    name: player.name,

    // Never reveal the Spy to other players.
    role:
      room.status === "active" && player.role === "hunter"
        ? "hunter"
        : "player",

    caught: !!player.caught,
    isHost: player.id === room.hostId
  }));
}

function sendRoomState(room) {
  const players = publicPlayers(room);

  for (const player of room.players.values()) {
    io.to(player.id).emit("room-state", {
      code: room.code,
      players,
      status: room.status,
      settings: room.settings,

      myRole:
        room.status === "active"
          ? player.role
          : null,

      isHost: player.id === room.hostId
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
    Math.cos(lat1) *
    Math.cos(lat2) *
    Math.sin(dLng / 2) ** 2;

  return earthRadius * 2 * Math.atan2(
    Math.sqrt(value),
    Math.sqrt(1 - value)
  );
}

/* -------------------- PROXIMITY ALERT -------------------- */

function updateSeekerProximity(room) {
  if (room.status !== "active") return;

  const now = Date.now();

  const hunters = [...room.players.values()].filter(player =>
    player.role === "hunter" &&
    !player.caught &&
    player.location &&
    now - player.location.updatedAt <= MAX_LOCATION_AGE_MS
  );

  const seekers = [...room.players.values()].filter(player =>
    player.role === "seeker" &&
    !player.caught
  );

  for (const seeker of seekers) {
    const isNear =
      !!seeker.location &&
      hunters.some(hunter =>
        distanceInMetres(
          seeker.location,
          hunter.location
        ) <= PROXIMITY_RADIUS
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

/* -------------------- HUNTER LOCATION DATA -------------------- */

// Only Hunters receive this information.
// Seekers never receive other players' GPS coordinates.

function sendHunterData(room) {
  if (room.status !== "active") return;

  const now = Date.now();

  const hunters = [...room.players.values()]
    .filter(player =>
      player.role === "hunter" &&
      !player.caught &&
      player.location &&
      now - player.location.updatedAt <= MAX_LOCATION_AGE_MS
    )
    .map(player => ({
      id: player.id,
      name: player.name,
      role: "hunter",
      lat: player.location.lat,
      lng: player.location.lng,
      updatedAt: player.location.updatedAt,
      accuracy: player.location.accuracy
    }));

  const targets = [...room.players.values()]
    .filter(player =>
      (player.role === "seeker" || player.role === "spy") &&
      !player.caught &&
      player.location &&
      now - player.location.updatedAt <= MAX_LOCATION_AGE_MS
    )
    .map(player => ({
      id: player.id,
      name: player.name,
      role: player.role,
      lat: player.location.lat,
      lng: player.location.lng,
      updatedAt: player.location.updatedAt,
      accuracy: player.location.accuracy
    }));

  const intel = [...room.players.values()]
    .filter(player =>
      player.role === "spy" &&
      !player.caught
    )
    .map(player => ({
      name: player.name,
      message: "The Spy is secretly helping the Hunter team."
    }));

  for (const player of room.players.values()) {
    if (player.role === "hunter") {
      io.to(player.id).emit("hunter-locations", {
        hunters,
        targets,
        serverTime: now
      });

      io.to(player.id).emit("spy-intel", intel);
    }
  }
}

/* -------------------- ROLE ASSIGNMENT -------------------- */

function assignRoles(room) {
  const allPlayers = [...room.players.values()];

  const hunterCount = Math.max(
    1,
    Math.min(
      5,
      Number(room.settings.hunterCount) || 1
    )
  );

  const shuffled = allPlayers
    .slice()
    .sort(() => Math.random() - 0.5);

  shuffled.forEach(player => {
    player.role = "seeker";
    player.caught = false;
    player.location = null;
    player.hunterNearby = false;
  });

  // Assign Hunters.
  shuffled
    .slice(0, hunterCount)
    .forEach(player => {
      player.role = "hunter";
    });

  const remainingPlayers = shuffled.slice(hunterCount);

  // Assign one Spy only when at least two non-Hunters exist.
  if (remainingPlayers.length >= 2) {
    remainingPlayers[0].role = "spy";

    remainingPlayers
      .slice(1)
      .forEach(player => {
        player.role = "seeker";
      });
  }
}

/* -------------------- REMOVE PLAYER -------------------- */

function removePlayer(socket) {
  const room = roomFor(socket);

  if (!room) return;

  room.players.delete(socket.id);

  socket.data.roomCode = null;
  socket.leave(room.code);

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }

  // Transfer host if the host leaves.
  if (room.hostId === socket.id) {
    room.hostId = room.players.keys().next().value;
  }

  if (room.status === "active") {
    updateSeekerProximity(room);
    sendHunterData(room);
  }

  sendRoomState(room);
}

/* -------------------- SOCKET CONNECTION -------------------- */

io.on("connection", socket => {

  console.log("Player connected:", socket.id);

  /* ---------------- CREATE ROOM ---------------- */

  socket.on(
    "create-room",
    ({ name, hunterCount } = {}, callback = () => {}) => {

      try {
        const playerName = cleanName(name);

        if (!playerName) {
          return callback({
            ok: false,
            error: "Enter your name first."
          });
        }

        // Do not allow one socket to create multiple rooms.
        if (roomFor(socket)) {
          return callback({
            ok: false,
            error: "You are already in a room. Leave it first."
          });
        }

        let code = makeCode();

        while (rooms.has(code)) {
          code = makeCode();
        }

        const count = Math.max(
          1,
          Math.min(5, Number(hunterCount) || 1)
        );

        const room = {
          code,
          hostId: socket.id,
          status: "lobby",

          settings: {
            hunterCount: count
          },

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

        // Join the Socket.IO room.
        socket.join(code);

        console.log(
          "Room created:",
          code,
          "by",
          playerName
        );

        callback({
          ok: true,
          code
        });

        sendRoomState(room);

      } catch (error) {
        console.error("Create room error:", error);

        callback({
          ok: false,
          error: "Unable to create room. Please try again."
        });
      }
    }
  );

  /* ---------------- JOIN ROOM ---------------- */

  socket.on(
    "join-room",
    ({ name, code } = {}, callback = () => {}) => {

      try {
        const playerName = cleanName(name);

        const roomCode = String(code || "")
          .trim()
          .toUpperCase();

        const room = rooms.get(roomCode);

        if (!playerName) {
          return callback({
            ok: false,
            error: "Enter your name first."
          });
        }

        if (roomFor(socket)) {
          return callback({
            ok: false,
            error: "You are already in a room. Leave it first."
          });
        }

        if (!room) {
          return callback({
            ok: false,
            error: "Room not found. Check the code."
          });
        }

        if (room.status !== "lobby") {
          return callback({
            ok: false,
            error: "This game has already started."
          });
        }

        if (room.players.size >= MAX_PLAYERS) {
          return callback({
            ok: false,
            error: "This room is full."
          });
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

        // Join the Socket.IO room.
        socket.join(roomCode);

        console.log(
          playerName,
          "joined room:",
          roomCode
        );

        callback({
          ok: true,
          code: roomCode
        });

        sendRoomState(room);

      } catch (error) {
        console.error("Join room error:", error);

        callback({
          ok: false,
          error: "Unable to join room. Please try again."
        });
      }
    }
  );

  /* ---------------- CHANGE HUNTER COUNT ---------------- */

  socket.on("set-hunter-count", ({ count } = {}) => {
    const room = roomFor(socket);

    if (
      !room ||
      room.status !== "lobby" ||
      room.hostId !== socket.id
    ) return;

    room.settings.hunterCount = Math.max(
      1,
      Math.min(5, Number(count) || 1)
    );

    sendRoomState(room);
  });

  /* ---------------- START GAME ---------------- */

  socket.on("start-game", () => {
    const room = roomFor(socket);

    if (
      !room ||
      room.hostId !== socket.id ||
      room.status !== "lobby"
    ) return;

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

    console.log("Game started:", room.code);

    sendRoomState(room);
    sendHunterData(room);
    updateSeekerProximity(room);
  });

  /* ---------------- GPS LOCATION UPDATE ---------------- */

  socket.on(
    "location-update",
    ({ lat, lng, accuracy } = {}) => {

      const room = roomFor(socket);
      const player = playerFor(room, socket.id);

      if (
        !room ||
        room.status !== "active" ||
        !player ||
        player.caught
      ) return;

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

        accuracy: Number.isFinite(gpsAccuracy)
          ? gpsAccuracy
          : null,

        updatedAt: Date.now()
      };

      // Immediately update all Hunters.
      sendHunterData(room);

      // Check whether a Hunter is within 25 metres.
      updateSeekerProximity(room);
    }
  );

  /* ---------------- MARK PLAYER CAUGHT ---------------- */

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

    const remaining = [...room.players.values()]
      .filter(player =>
        (player.role === "seeker" || player.role === "spy") &&
        !player.caught
      ).length;

    if (remaining === 0) {
      room.status = "finished";
    }

    updateSeekerProximity(room);
    sendRoomState(room);
    sendHunterData(room);

    io.to(room.code).emit(
      "game-message",
      `${target.name} was caught.`
    );

    console.log(
      target.name,
      "was caught in room",
      room.code
    );
  });

  /* ---------------- END GAME ---------------- */

  socket.on("end-game", () => {

    const room = roomFor(socket);

    if (
      !room ||
      room.hostId !== socket.id
    ) return;

    room.status = "finished";

    for (const player of room.players.values()) {
      player.location = null;
      player.hunterNearby = false;

      io.to(player.id).emit(
        "hunter-proximity-alert",
        { near: false }
      );
    }

    sendRoomState(room);
    sendHunterData(room);

    console.log("Game ended:", room.code);
  });

  /* ---------------- DISCONNECT ---------------- */

  socket.on("disconnect", reason => {

    console.log(
      "Player disconnected:",
      socket.id,
      reason
    );

    removePlayer(socket);
  });

});

/* -------------------- GPS CLEANUP -------------------- */

// Remove old GPS locations and refresh Hunter maps every 3 seconds.

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

/* -------------------- SERVER START -------------------- */

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Game server running on port ${PORT}`);
});
