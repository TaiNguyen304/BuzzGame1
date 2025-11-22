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

function broadcastAnswers(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    
    const results = room.answers.map(ans => ({
        name: ans.name, 
        answer: ans.answer, 
        // Nếu startTime chưa có (trường hợp add khi chưa start), dùng 0 hoặc xử lý logic khác
        time: room.answerStartTime ? (ans.ts - room.answerStartTime) / 1000 : 0
    }));

    results.sort((a, b) => a.time - b.time);
    io.to(roomCode).emit("update-results", results);
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
                buzzTimer: null
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
        
        const results = room.answers.map(ans => ({
            name: ans.name, 
            answer: ans.answer, 
            time: room.answerStartTime ? (ans.ts - room.answerStartTime) / 1000 : 0
        }));
        results.sort((a, b) => a.time - b.time);

        socket.emit("viewer-join-success", { roomCode: roomCode, answers: results });
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
        const host = room.hostId ? { id: room.hostId, name: "Host" } : null;
        socket.emit("host-all-users", {
            host: host,
            managers: room.managers,
            contestants: room.users
        });
    });

    socket.on("host-toggle-answer", ({ roomCode, state, duration }) => {
        const room = rooms[roomCode];
        if (!room) return;
        if (room.answerTimer) { clearTimeout(room.answerTimer); room.answerTimer = null; }

        if (state === "open") {
            room.statusAnswer = "open";
            room.answerDuration = duration || 0; 
            room.answerStartTime = Date.now();
            
            io.to(roomCode).emit("answer-status-changed", { 
                state: "open", 
                duration: room.answerDuration,
                startTime: room.answerStartTime 
            });

            if (duration > 0) {
                room.answerTimer = setTimeout(() => {
                    room.statusAnswer = "locked";
                    room.answerTimer = null;
                    io.to(roomCode).emit("answer-status-changed", { state: "locked" });
                }, duration * 1000);
            }
        } else { 
            room.statusAnswer = "locked";
            room.answerTimer = null;
            io.to(roomCode).emit("answer-status-changed", { state: "locked" });
        }
    });

    socket.on("host-reset-answers", (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return; 
        room.answers = []; 
        room.answerStartTime = 0; 
        io.to(roomCode).emit("answers-reset");
        broadcastAnswers(roomCode);
    });

    socket.on("host-toggle-buzz", ({ roomCode, state, duration }) => {
        const room = rooms[roomCode];
        if (!room) return;
        if (room.buzzTimer) { clearTimeout(room.buzzTimer); room.buzzTimer = null; }

        if (state === "open") {
            room.statusBuzz = "open";
            room.buzzDuration = duration || 0;
            room.buzzStartTime = Date.now();

            io.to(roomCode).emit("buzz-status-changed", { 
                state: "open", 
                duration: room.buzzDuration,
                startTime: room.buzzStartTime 
            });

            if (duration > 0) {
                room.buzzTimer = setTimeout(() => {
                    room.statusBuzz = "locked";
                    room.buzzTimer = null;
                    io.to(roomCode).emit("buzz-status-changed", { state: "locked" });
                }, duration * 1000);
            }

        } else { 
            room.statusBuzz = "locked";
            room.buzzTimer = null;
            io.to(roomCode).emit("buzz-status-changed", { state: "locked" });
        }
    });

    socket.on("host-reset-buzz", (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        room.buzz = []; 
        room.buzzStartTime = 0; 
        io.to(roomCode).emit("buzz-reset");
    });

    // ========================= XỬ LÝ BỔ SUNG THỦ CÔNG (NEW) =========================
    socket.on("host-force-add", ({ roomCode, type, data }) => {
        const room = rooms[roomCode];
        if (!room) return;

        if (type === "answer") {
            data.forEach(item => {
                // Tính toán timestamp giả lập
                // Nếu đang trong phiên (có startTime), ts = startTime + time(s)
                // Nếu không, lấy Now
                const baseTime = room.answerStartTime > 0 ? room.answerStartTime : Date.now();
                const ts = baseTime + (item.time * 1000);
                
                const record = { name: item.name, answer: item.answer, ts: ts };
                
                // Update or Push
                const idx = room.answers.findIndex(x => x.name === item.name);
                if (idx >= 0) room.answers[idx] = record;
                else room.answers.push(record);

                // Gửi update cho Host/Manager
                if (room.hostId) io.to(room.hostId).emit("host-new-answer", record);
                room.managers.forEach(m => io.to(m.id).emit("host-new-answer", record));
            });
            broadcastAnswers(roomCode);
        } 
        else if (type === "buzz") {
            data.forEach(item => {
                const baseTime = room.buzzStartTime > 0 ? room.buzzStartTime : Date.now();
                const ts = baseTime + (item.time * 1000);
                
                const record = { name: item.name, ts: ts };

                // Kiểm tra trùng lặp server-side
                if (!room.buzz.some(b => b.name === item.name)) {
                    room.buzz.push(record);
                    
                    // Gửi update cho Host/Manager
                    if (room.hostId) io.to(room.hostId).emit("host-new-buzz", record);
                    room.managers.forEach(m => io.to(m.id).emit("host-new-buzz", record));

                    // KHÓA MÁY THÍ SINH
                    const userSocket = room.users.find(u => u.name === item.name);
                    if (userSocket) {
                        io.to(userSocket.id).emit("force-lock-buzz");
                    }
                }
            });
        }
    });
    // ===============================================================================

    socket.on("user-send-answer", ({ roomCode, name, answer }) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        const ts = Date.now();
        const record = { name, answer, ts }; 

        const index = room.answers.findIndex(x => x.name === name);
        if (index >= 0) room.answers[index] = record;
        else room.answers.push(record);

        if (room.hostId) io.to(room.hostId).emit("host-new-answer", record);
        room.managers.forEach(m => io.to(m.id).emit("host-new-answer", record));
        broadcastAnswers(roomCode);
    });

    socket.on("user-buzz", ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room || room.statusBuzz !== "open") return; 

        if (room.buzz.some(b => b.name === name)) return;

        const ts = Date.now();
        const record = { name, ts };
        room.buzz.push(record);

        if (room.hostId) io.to(room.hostId).emit("host-new-buzz", record);
        room.managers.forEach(m => io.to(m.id).emit("host-new-buzz", record));
    });

    socket.on("disconnect", () => {
        // Logic disconnect giữ nguyên
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