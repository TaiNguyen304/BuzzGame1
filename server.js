// server.js
const express = require("express");
const cors = require("cors");
const app = express();
const http = require("http").createServer(app);

// CORS cho GitHub Pages + Render
app.use(cors({
    origin: "*"
}));

const io = require("socket.io")(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let rooms = {};   // roomCode -> { hostId, answers:[], buzz:[], statusAnswer, statusBuzz, answerStartTime, buzzStartTime }

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // Host tạo phòng
    socket.on("host-create-room", (roomCode) => {
        if (rooms[roomCode]) {
            // Phòng đã tồn tại → không cho tạo lại
            socket.emit("room-created", roomCode); // vẫn cho host vào nếu cùng mã
            socket.join(roomCode);
            return;
        }

        rooms[roomCode] = {
            hostId: socket.id,
            answers: [],
            buzz: [],
            statusAnswer: "locked",
            statusBuzz: "locked",
            answerStartTime: 0,
            buzzStartTime: 0,
            answerDuration: 0,
            buzzDuration: 0
        };

        socket.join(roomCode);
        console.log("Room created:", roomCode);
        socket.emit("room-created", roomCode);
    });

    // User join phòng
    socket.on("user-join-room", ({ roomCode, name }) => {
        if (!rooms[roomCode]) {
            socket.emit("join-failed", "Phòng không tồn tại.");
            return;
        }

        socket.join(roomCode);
        socket.emit("join-success", { roomCode });
        console.log(`${name} joined room ${roomCode}`);
    });

    // HOST mở/khóa đáp án
    socket.on("host-toggle-answer", ({ roomCode, state, duration = 0 }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;

        if (state === "open") {
            const now = Date.now(); // ← Thời điểm CHUẨN do server quyết định
            room.statusAnswer = "open";
            room.answerDuration = duration;
            room.answerStartTime = duration > 0 ? now : 0;

            io.to(roomCode).emit("answer-status-changed", {
                state: "open",
                duration: duration,
                startTime: duration > 0 ? now : null   // chỉ gửi khi có giới hạn
            });
        } else {
            // locked
            room.statusAnswer = "locked";
            room.answerStartTime = 0;
            room.answerDuration = 0;

            io.to(roomCode).emit("answer-status-changed", {
                state: "locked"
            });
        }
    });

    // HOST mở/khóa chuông
    socket.on("host-toggle-buzz", ({ roomCode, state, duration = 0 }) => {
        const room = rooms[roomCode];
        if (!room || room.hostId !== socket.id) return;

        if (state === "open") {
            const now = Date.now(); // ← Server quyết định thời gian chính xác
            room.statusBuzz = "open";
            room.buzzDuration = duration;
            room.buzzStartTime = duration > 0 ? now : 0;

            io.to(roomCode).emit("buzz-status-changed", {
                state: "open",
                duration: duration,
                startTime: duration > 0 ? now : null
            });
        } else {
            // locked
            room.statusBuzz = "locked";
            room.buzzStartTime = 0;
            room.buzzDuration = 0;

            io.to(roomCode).emit("buzz-status-changed", {
                state: "locked"
            });
        }
    });

    // User gửi đáp án
    socket.on("user-send-answer", ({ roomCode, name, answer }) => {
        const room = rooms[roomCode];
        if (!room || room.statusAnswer !== "open") return;

        const ts = Date.now();
        const playerAnswer = { name, answer, ts };

        // Ghi đè nếu người chơi gửi lại
        const existing = room.answers.findIndex(a => a.name === name);
        if (existing !== -1) {
            room.answers[existing] = playerAnswer;
        } else {
            room.answers.push(playerAnswer);
        }

        // Chỉ gửi cho host
        io.to(room.hostId).emit("host-new-answer", playerAnswer);
    });

    // User bấm chuông
    socket.on("user-buzz", ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room || room.statusBuzz !== "open") return;

        const ts = Date.now();

        // Kiểm tra đã bấm chuông chưa (tránh spam)
        if (room.buzz.some(b => b.name === name)) return;

        room.buzz.push({ name, ts });

        // Gửi cho host
        io.to(room.hostId).emit("host-new-buzz", { name, ts });

        // (Tùy chọn) thông báo cho tất cả contestant biết ai đã buzz đầu tiên
        // io.to(roomCode).emit("someone-buzzed", { name });
    });

    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);
        // Có thể thêm dọn phòng nếu host thoát, nhưng tạm để vậy
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});