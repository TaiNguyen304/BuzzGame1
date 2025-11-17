// server.js
const express = require("express");
const cors = require("cors");
const app = express();
const http = require("http").createServer(app);

app.use(cors({ origin: "*" }));

const io = require("socket.io")(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let rooms = {};   
// roomCode -> { hostId, answers:[], buzz:[], statusAnswer, statusBuzz, answerStartTime, buzzStartTime, timers }

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // ========================= TẠO PHÒNG =========================
    socket.on("host-create-room", (roomCode) => {
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                hostId: socket.id,
                answers: [],
                buzz: [],
                statusAnswer: "locked",
                statusBuzz: "locked",
                answerStartTime: 0,
                buzzStartTime: 0,
                answerDuration: 0,
                buzzDuration: 0,
                answerTimer: null,
                buzzTimer: null
            };
        }
        socket.join(roomCode);
        socket.emit("room-created", roomCode);
        console.log("Room created:", roomCode);
    });

    // ========================= USER JOIN =========================
    socket.on("user-join-room", ({ roomCode, name }) => {
        if (!rooms[roomCode]) {
            socket.emit("join-failed", "Phòng không tồn tại.");
            return;
        }
        socket.join(roomCode);
        socket.emit("join-success", { roomCode });
        console.log(`${name} joined room ${roomCode}`);
    });

    // ========================= ĐÁP ÁN =========================
    socket.on("host-toggle-answer", ({ roomCode, state, duration = 0 }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;

        // Xóa timer cũ
        if (room.answerTimer) {
            clearTimeout(room.answerTimer);
            room.answerTimer = null;
        }

        if (state === "open") {
            const now = Date.now();
            room.statusAnswer = "open";
            room.answerStartTime = duration > 0 ? now : 0;
            room.answerDuration = duration;

            io.to(roomCode).emit("answer-status-changed", {
                state: "open",
                duration,
                startTime: duration > 0 ? now : null
            });

            if (duration > 0) {
                room.answerTimer = setTimeout(() => {
                    room.statusAnswer = "locked";
                    room.answerStartTime = 0;
                    io.to(roomCode).emit("answer-status-changed", { state: "locked" });
                }, duration * 1000);
            }
        } else {
            room.statusAnswer = "locked";
            room.answerStartTime = 0;
            room.answerDuration = 0;

            io.to(roomCode).emit("answer-status-changed", { state: "locked" });
        }
    });

    // ========================= CHUÔNG =========================
    socket.on("host-toggle-buzz", ({ roomCode, state, duration = 0 }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;

        if (room.buzzTimer) {
            clearTimeout(room.buzzTimer);
            room.buzzTimer = null;
        }

        if (state === "open") {
            const now = Date.now();
            room.statusBuzz = "open";
            room.buzzStartTime = duration > 0 ? now : 0;
            room.buzzDuration = duration;
            room.buzz = []; // reset danh sách buzz

            io.to(roomCode).emit("buzz-status-changed", {
                state: "open",
                duration,
                startTime: duration > 0 ? now : null
            });

            if (duration > 0) {
                room.buzzTimer = setTimeout(() => {
                    room.statusBuzz = "locked";
                    room.buzzStartTime = 0;
                    io.to(roomCode).emit("buzz-status-changed", { state: "locked" });
                }, duration * 1000);
            }

        } else {
            room.statusBuzz = "locked";
            room.buzzStartTime = 0;
            room.buzzDuration = 0;
            io.to(roomCode).emit("buzz-status-changed", { state: "locked" });
        }
    });

    // ========================= USER GỬI ĐÁP ÁN =========================
    socket.on("user-send-answer", ({ roomCode, name, answer }) => {
        const room = rooms[roomCode];
        if (!room || room.statusAnswer !== "open") return;

        const ts = Date.now();
        const record = { name, answer, ts };

        const index = room.answers.findIndex(x => x.name === name);
        if (index >= 0) room.answers[index] = record;
        else room.answers.push(record);

        io.to(room.hostId).emit("host-new-answer", record);
    });

    // ========================= USER BẤM CHUÔNG =========================
    socket.on("user-buzz", ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room || room.statusBuzz !== "open") return;

        if (room.buzz.find(b => b.name === name)) return;

        const ts = Date.now();
        room.buzz.push({ name, ts });

        io.to(room.hostId).emit("host-new-buzz", { name, ts });
    });

    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));
