// server.js
const express = require("express");
const cors = require("cors");
const app = express();
const http = require("http").createServer(app);

app.use(cors({ origin: "*" }));
app.use(express.json()); 

const io = require("socket.io")(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let rooms = {};   

// Hàm broadcastAnswers: Không sắp xếp trên server, chỉ gửi data và cấu hình sort
function broadcastAnswers(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    // Tính toán thời gian trả lời (seconds)
    const answersToSend = room.answers.map(ans => ({
        name: ans.name, 
        answer: ans.answer, 
        // Thời gian tính bằng giây
        time: room.answerStartTime ? (ans.ts - room.answerStartTime) / 1000 : 0 
    }));
    
    // Gửi toàn bộ dữ liệu CÙNG VỚI CẤU HÌNH SORT để Result.html tự sắp xếp
    io.to(roomCode).emit("update-results", {
        answers: answersToSend,
        sortOption: room.sortOption || 'time',
        allContestants: room.allContestants || []
    });
}

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    socket.on("host-create-room", (roomCode) => {
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                hostId: socket.id,
                users: [], 
                managers: [], 
                answers: [],
                buzz: [],
                statusAnswer: "locked",
                statusBuzz: "locked",
                answerStartTime: 0,
                buzzStartTime: 0,
                answerDuration: 0,
                buzzDuration: 0,
                answerTimer: null,
                buzzTimer: null,
                sortOption: "time", 
                allContestants: [], 
            };
        } else {
             rooms[roomCode].hostId = socket.id;
        }
        socket.join(roomCode);
        
        socket.emit("room-created", { 
            roomCode: roomCode, 
            answers: rooms[roomCode].answers, 
            buzzOrder: rooms[roomCode].buzz 
        }); 
    });

    socket.on("user-join-room", ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit("join-error", "Mã phòng không tồn tại.");

        if (room.users.some(u => u.name === name)) {
            return socket.emit("join-error", `Tên "${name}" đã được sử dụng.`);
        }

        room.users.push({ id: socket.id, name, roomCode: roomCode, role: 'Contestant' });
        
        // Cập nhật danh sách Contestant trong room
        room.allContestants = room.users.map(u => u.name); 
        
        socket.join(roomCode);

        socket.emit("join-success", { 
            roomCode: roomCode, 
            name: name,
            statusAnswer: room.statusAnswer, 
            durationAnswer: room.answerDuration,
            startTimeAnswer: room.answerStartTime,
            statusBuzz: room.statusBuzz,
            durationBuzz: room.buzzDuration,
            startTimeBuzz: room.buzzStartTime,
        });
        
        const hostId = room.hostId;
        if (hostId) io.to(hostId).emit("host-new-user", { id: socket.id, name, role: 'Contestant' });
        room.managers.forEach(m => io.to(m.id).emit("host-new-user", { id: socket.id, name, role: 'Contestant' }));
        
        broadcastAnswers(roomCode);
    });
    
    socket.on("viewer-join-room", (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit("join-error", "Mã phòng không tồn tại.");
        socket.join(roomCode);
        
        const answersToSend = room.answers.map(ans => ({
            name: ans.name, 
            answer: ans.answer, 
            time: room.answerStartTime ? (ans.ts - room.answerStartTime) / 1000 : 0
        }));

        socket.emit("viewer-join-success", { 
            roomCode: roomCode, 
            answers: answersToSend, 
            sortOption: room.sortOption || 'time', 
            allContestants: room.allContestants || [] 
        });
    });

    socket.on("manager-join-room", ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit("join-error", "Mã phòng không tồn tại.");

        if (room.managers.some(m => m.name === name)) {
            return socket.emit("join-error", `Tên "${name}" (Quản lý) đã được sử dụng.`);
        }

        room.managers.push({ id: socket.id, name });
        socket.join(roomCode);

        socket.emit("manager-join-success", { 
            roomCode: roomCode, 
            name: name,
            answers: room.answers, 
            buzzOrder: room.buzz 
        });

        const hostId = room.hostId;
        if (hostId) io.to(hostId).emit("host-new-user", { id: socket.id, name, role: 'Manager' });
        room.managers.filter(m => m.id !== socket.id).forEach(m => io.to(m.id).emit("host-new-user", { id: socket.id, name, role: 'Manager' }));
    });

    socket.on("host-get-users", (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        // Cập nhật danh sách Contestant trong room 
        room.allContestants = room.users.map(u => u.name); 
        
        const host = room.hostId ? { id: room.hostId, name: "Host" } : null;
        socket.emit("host-all-users", {
            host: host,
            managers: room.managers,
            contestants: room.users
        });
    });
    
    socket.on("host-sync-sort-config", ({ roomCode, sortOption, allContestants }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        // 1. Cập nhật state của Room
        room.sortOption = sortOption;
        room.allContestants = allContestants;
        
        // 2. Thông báo cho Result.html biết cấu hình sắp xếp đã thay đổi
        io.to(roomCode).emit("update-sort-config", { sortOption, allContestants });
        
        // 3. Force Result.html cập nhật đáp án ngay lập tức (để áp dụng sort mới)
        broadcastAnswers(roomCode); 
    });

    socket.on("viewer-request-update", (roomCode) => {
        broadcastAnswers(roomCode);
    });

    // =======================================================
    // [ĐIỂM SỬA CHỮA QUAN TRỌNG]: KHÔI PHỤC LOGIC MỞ/KHÓA ĐÁP ÁN
    // =======================================================
    socket.on("host-toggle-answer", ({ roomCode, state, duration }) => {
        const room = rooms[roomCode];
        if (!room) return;

        if (room.answerTimer) {
            clearTimeout(room.answerTimer);
            room.answerTimer = null;
        }

        room.statusAnswer = state;
        room.answerDuration = duration || 0;

        if (state === "open") {
            const startTime = Date.now();
            room.answerStartTime = startTime;
            if (duration && duration > 0) {
                room.answerTimer = setTimeout(() => {
                    room.statusAnswer = "locked";
                    room.answerTimer = null;
                    io.to(roomCode).emit("answer-status-changed", { state: "locked" });
                }, duration * 1000);
            }
        } else {
            room.answerStartTime = 0; 
        }

        io.to(roomCode).emit("answer-status-changed", { 
            state: room.statusAnswer, 
            duration: room.answerDuration, 
            startTime: room.answerStartTime 
        });
        
        // Cần gọi broadcastAnswers để Result.html cập nhật trạng thái/thời gian nếu cần
        broadcastAnswers(roomCode); 
    });

    // =======================================================
    // [ĐIỂM SỬA CHỮA QUAN TRỌNG]: KHÔI PHỤC LOGIC MỞ/KHÓA CHUÔNG
    // =======================================================
    socket.on("host-toggle-buzz", ({ roomCode, state, duration }) => {
        const room = rooms[roomCode];
        if (!room) return;

        if (room.buzzTimer) {
            clearTimeout(room.buzzTimer);
            room.buzzTimer = null;
        }

        room.statusBuzz = state;
        room.buzzDuration = duration || 0;
        
        if (state === "open") {
            const startTime = Date.now();
            room.buzzStartTime = startTime;
            if (duration && duration > 0) {
                room.buzzTimer = setTimeout(() => {
                    room.statusBuzz = "locked";
                    room.buzzTimer = null;
                    io.to(roomCode).emit("buzz-status-changed", { state: "locked" });
                }, duration * 1000);
            }
        } else {
            room.buzzStartTime = 0;
        }

        io.to(roomCode).emit("buzz-status-changed", { 
            state: room.statusBuzz, 
            duration: room.buzzDuration, 
            startTime: room.buzzStartTime 
        });
    });

    socket.on("host-reset-answers", (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return; 
        room.answers = []; 
        room.answerStartTime = 0; 
        io.to(roomCode).emit("answers-reset");
        broadcastAnswers(roomCode); 
    });

    socket.on("host-reset-buzz", (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        room.buzz = [];
        room.buzzStartTime = Date.now();
        io.to(roomCode).emit("buzz-reset");
    });
    
    socket.on("host-force-add", ({ roomCode, type, data }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        data.forEach(item => {
            const ts = (room[type === 'answer' ? 'answerStartTime' : 'buzzStartTime'] || Date.now()) + (item.time * 1000);
            if (type === 'answer') {
                const existingIndex = room.answers.findIndex(a => a.name === item.name);
                const newAnswer = { name: item.name, answer: item.answer, ts: ts };
                if (existingIndex !== -1) room.answers[existingIndex] = newAnswer;
                else room.answers.push(newAnswer);
                io.to(room.hostId).emit("host-new-answer", newAnswer);
                room.managers.forEach(m => io.to(m.id).emit("host-new-answer", newAnswer));
            } else {
                room.buzz.push({ name: item.name, ts: ts });
                io.to(room.hostId).emit("host-new-buzz", { name: item.name, ts: ts });
                room.managers.forEach(m => io.to(m.id).emit("host-new-buzz", { name: item.name, ts: ts }));
            }
        });
        broadcastAnswers(roomCode);
    });

    socket.on("user-send-answer", ({ roomCode, name, answer }) => {
        const room = rooms[roomCode];
        if (!room || room.statusAnswer === "locked") return socket.emit("answer-send-error", "Đáp án đang bị khóa!");

        const newAnswer = { name, answer, ts: Date.now() };
        const existingIndex = room.answers.findIndex(a => a.name === name);

        if (existingIndex !== -1) room.answers[existingIndex] = newAnswer;
        else room.answers.push(newAnswer);
        
        io.to(room.hostId).emit("host-new-answer", newAnswer);
        room.managers.forEach(m => io.to(m.id).emit("host-new-answer", newAnswer));
        socket.emit("answer-send-success");
        broadcastAnswers(roomCode);
    });

    socket.on("user-buzz", ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room || room.statusBuzz === "locked") return socket.emit("buzz-error", "Chuông đang bị khóa!");
        if (room.buzz.some(b => b.name === name)) return socket.emit("buzz-error", "Bạn đã bấm chuông!");

        const newBuzz = { name, ts: Date.now() };
        room.buzz.push(newBuzz);

        io.to(room.hostId).emit("host-new-buzz", newBuzz);
        room.managers.forEach(m => io.to(m.id).emit("host-new-buzz", newBuzz));
        
        // Khóa chuông sau khi bấm nếu là giới hạn thời gian (duration > 0)
        if (room.buzzDuration > 0) {
            if (room.buzzTimer) {
                 clearTimeout(room.buzzTimer);
                 room.buzzTimer = null;
            }
            room.statusBuzz = "locked";
            io.to(roomCode).emit("buzz-status-changed", { state: "locked" });
        }
    });

    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            if (room.hostId === socket.id) {
                room.hostId = null; 
            }
            const leftUserIndex = room.users.findIndex(user => user.id === socket.id);
            if (leftUserIndex !== -1) {
                const leftUser = room.users[leftUserIndex];
                room.users.splice(leftUserIndex, 1);
                if (room.hostId) io.to(room.hostId).emit("host-user-left", { id: socket.id, role: 'Contestant' });
                room.managers.forEach(m => io.to(m.id).emit("host-user-left", { id: socket.id, role: 'Contestant' }));
                break; 
            }
            const leftManagerIndex = room.managers.findIndex(manager => manager.id === socket.id);
            if (leftManagerIndex !== -1) {
                room.managers.splice(leftManagerIndex, 1);
                if (room.hostId) io.to(room.hostId).emit("host-user-left", { id: socket.id, role: 'Manager' });
                room.managers.forEach(m => io.to(m.id).emit("host-user-left", { id: socket.id, role: 'Manager' }));
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});