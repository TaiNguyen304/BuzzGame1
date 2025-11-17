// server.js
const express = require("express");
const cors = require("cors");
const app = express();
const http = require("http").createServer(app);

// CORS cho GitHub Pages
app.use(cors({
    origin: "*"
}));

const io = require("socket.io")(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

let rooms = {};   // roomCode -> { hostId, answers:[], buzz:[], statusAnswer, statusBuzz }

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // Host tạo phòng
    socket.on("host-create-room", (roomCode) => {
        rooms[roomCode] = {
            hostId: socket.id,
            answers: [],
            buzz: [],
            statusAnswer: "locked",
            statusBuzz: "locked",
            answerStartTime: 0,
            buzzStartTime: 0
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
    });

    // HOST mở đáp án / đóng đáp án
    socket.on("host-toggle-answer", ({ roomCode, state, duration }) => {
        if (!rooms[roomCode]) return;

        rooms[roomCode].statusAnswer = state;
        rooms[roomCode].answerStartTime = Date.now();

        io.to(roomCode).emit("answer-status-changed", {
            state,
            duration,
            startTime: rooms[roomCode].answerStartTime
        });
    });

    // HOST mở chuông / đóng chuông
    socket.on("host-toggle-buzz", ({ roomCode, state, duration }) => {
        if (!rooms[roomCode]) return;

        rooms[roomCode].statusBuzz = state;
        rooms[roomCode].buzzStartTime = Date.now();

        io.to(roomCode).emit("buzz-status-changed", {
            state,
            duration,
            startTime: rooms[roomCode].buzzStartTime
        });
    });

    // User gửi đáp án
    socket.on("user-send-answer", ({ roomCode, name, answer }) => {
        if (!rooms[roomCode]) return;

        const ts = Date.now();
        rooms[roomCode].answers.push({ name, answer, ts });

        io.to(rooms[roomCode].hostId).emit("host-new-answer", {
            name,
            answer,
            ts
        });
    });

    // User bấm chuông
    socket.on("user-buzz", ({ roomCode, name }) => {
        if (!rooms[roomCode]) return;

        const ts = Date.now();
        rooms[roomCode].buzz.push({ name, ts });

        io.to(rooms[roomCode].hostId).emit("host-new-buzz", {
            name,
            ts
        });
    });

    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log("Server running on port", PORT);
});
