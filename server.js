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
// roomCode -> { hostId, users: [{id, name}], answers:[], buzz:[], statusAnswer, statusBuzz, answerStartTime, buzzStartTime, timers }

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // ========================= TẠO PHÒNG =========================
    socket.on("host-create-room", (roomCode) => {
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                hostId: socket.id,
                users: [], // Đã thêm: Danh sách người dùng
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
        const room = rooms[roomCode];
        if (!room) {
            socket.emit("join-failed", "Phòng không tồn tại.");
            return;
        }

        // VALIDATE: Kiểm tra tên người dùng bị trùng (CÓ phân biệt chữ hoa/thường)
        if (room.users.some(user => user.name === name)) {
            socket.emit("join-failed", `Tên "${name}" đã được sử dụng trong phòng này. Vui lòng chọn tên khác.`);
            return;
        }

        // ADD USER and proceed with join
        room.users.push({ id: socket.id, name });
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
            
            // SỬA LỖI: Luôn đặt startTime là now, kể cả khi duration = 0
            room.answerStartTime = now;
            room.answerDuration = duration;

            io.to(roomCode).emit("answer-status-changed", {
                state: "open",
                duration,
                startTime: now
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
            
            // SỬA LỖI: Luôn đặt startTime là now, kể cả khi duration = 0
            room.buzzStartTime = now;
            room.buzzDuration = duration;
            room.buzz = []; // reset danh sách buzz

            io.to(roomCode).emit("buzz-status-changed", {
                state: "open",
                duration,
                startTime: now
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
        // Xóa người dùng khỏi danh sách users của phòng
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const initialCount = room.users.length;
            room.users = room.users.filter(user => user.id !== socket.id);
            if (room.users.length < initialCount) {
                console.log(`User ${socket.id} left room ${roomCode}`);
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));