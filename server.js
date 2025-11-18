// server.js
const express = require("express");
const cors = require("cors");
const app = express();
const http = require("http").createServer(app);

// Cấu hình Middleware
app.use(express.json()); 
app.use(cors({ origin: "*", credentials: true })); 

const io = require("socket.io")(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

let rooms = {};   
// roomCode -> { hostId, users: [{id, name, roomCode, role}], managers: [{id, name}], answers:[], buzz:[], statusAnswer, statusBuzz, answerStartTime, buzzStartTime, answerDuration, buzzDuration, answerTimer, buzzTimer }

// ========================= HTTP Endpoint cho Result.html =========================
// Endpoint này cho phép Result.html lấy dữ liệu đáp án
app.post("/results", (req, res) => {
    const { roomCode } = req.body;
    
    if (!roomCode || !rooms[roomCode]) {
        return res.status(404).json({ error: "Phòng không tồn tại. Vui lòng kiểm tra Room Code." });
    }

    const room = rooms[roomCode];
    
    // Tạo cấu trúc dữ liệu: Tên, Đáp án, Thời gian
    const results = room.answers.map(ans => ({
        name: ans.name, // Tên thí sinh
        answer: ans.answer, // Đáp án
        // Tính thời gian đáp án (tính bằng giây) so với thời điểm bắt đầu vòng trả lời
        time: (ans.time - room.answerStartTime) / 1000 
    }));

    // Sắp xếp theo thời gian (từ nhanh nhất đến chậm nhất)
    results.sort((a, b) => a.time - b.time);

    res.json(results);
});
// =================================================================================

io.on("connection", (socket) => {
    console.log("User connected:", socket.id);

    // ========================= TẠO PHÒNG =========================
    socket.on("host-create-room", (roomCode) => {
        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                hostId: socket.id,
                users: [], // Thí sinh
                managers: [], // Quản lý
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
        console.log(`Host ${socket.id} created/reconnected to room ${roomCode}`);
        socket.emit("host-room-info", { roomCode, role: "Host" });
    });

    // ========================= THAM GIA PHÒNG =========================
    socket.on("join-room", ({ roomCode, name, role }) => {
        const room = rooms[roomCode];
        if (!room) {
            return socket.emit("join-error", "Phòng không tồn tại.");
        }

        const newUser = { id: socket.id, name, roomCode, role };
        
        if (role === "Manager") {
            room.managers.push(newUser);
        } else if (role === "Contestant") {
            room.users.push(newUser);
            if (room.hostId) io.to(room.hostId).emit("host-new-user", newUser);
            room.managers.forEach(m => io.to(m.id).emit("host-new-user", newUser));
        }

        socket.join(roomCode);
        socket.emit("join-success", { roomCode, role, statusAnswer: room.statusAnswer, statusBuzz: room.statusBuzz });
        console.log(`${role} ${name} joined room ${roomCode}`);
    });

    // ========================= BÀI LÀM (Contestant) =========================
    socket.on("submit-answer", ({ roomCode, answer }) => {
        const room = rooms[roomCode];
        if (!room || room.statusAnswer === "locked") return socket.emit("answer-error", "Thời gian trả lời đã kết thúc.");

        const user = room.users.find(u => u.id === socket.id);
        if (!user) return socket.emit("answer-error", "Không tìm thấy thông tin người dùng.");
        
        // LOGIC: Contestant có thể gửi nhiều đáp án, chỉ ghi nhận đáp án cuối cùng
        const existingAnswerIndex = room.answers.findIndex(ans => ans.id === socket.id);
        if (existingAnswerIndex !== -1) {
            // Cập nhật đáp án và thời gian hiện tại (ghi nhận đáp án cuối)
            room.answers[existingAnswerIndex].answer = answer;
            room.answers[existingAnswerIndex].time = Date.now(); 
        } else {
            // Thêm đáp án mới
            room.answers.push({ id: user.id, name: user.name, answer, time: Date.now() });
        }
        
        socket.emit("answer-success", "Đã gửi/cập nhật đáp án thành công.");
        
        if (room.hostId) io.to(room.hostId).emit("host-new-answer", room.answers);
        room.managers.forEach(m => io.to(m.id).emit("host-new-answer", room.answers));
    });

    // ========================= BUZZER (Contestant) =========================
    socket.on("submit-buzz", ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.statusBuzz === "locked") return socket.emit("buzz-error", "Buzzer đã bị khóa.");

        const user = room.users.find(u => u.id === socket.id);
        if (!user) return socket.emit("buzz-error", "Không tìm thấy thông tin người dùng.");

        // LOGIC: Contestant chỉ được bấm buzz 1 lần
        const existingBuzzIndex = room.buzz.findIndex(b => b.id === socket.id);
        if (existingBuzzIndex !== -1) return socket.emit("buzz-error", "Bạn đã bấm buzzer rồi.");
        
        // Thêm buzz
        room.buzz.push({ id: user.id, name: user.name, time: Date.now() });
        
        socket.emit("buzz-success", "Đã bấm buzzer thành công.");
        
        if (room.hostId) io.to(room.hostId).emit("host-new-buzz", room.buzz);
        room.managers.forEach(m => io.to(m.id).emit("host-new-buzz", room.buzz));
    });

    // ========================= CÁC LỆNH CỦA HOST/MANAGER =========================
    socket.on("host-start-answer", ({ roomCode, duration }) => {
        const room = rooms[roomCode];
        if (!room) return;

        room.answers = [];
        room.statusAnswer = "open";
        room.answerStartTime = Date.now();
        
        if (room.answerTimer) clearTimeout(room.answerTimer);

        room.answerTimer = setTimeout(() => {
            room.statusAnswer = "locked";
            room.answerTimer = null;
            io.to(roomCode).emit("answer-status-changed", "locked");
        }, duration * 1000); 

        io.to(roomCode).emit("answer-status-changed", "open", Date.now(), duration);
        io.to(roomCode).emit("host-new-answer", room.answers); 
    });
    
    socket.on("host-lock-answer", (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;
        
        if (room.answerTimer) {
            clearTimeout(room.answerTimer);
            room.answerTimer = null;
        }

        room.statusAnswer = "locked";
        io.to(roomCode).emit("answer-status-changed", "locked");
    });
    
    socket.on("host-show-answers", (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        const sortedAnswers = [...room.answers].sort((a, b) => a.time - b.time);
        io.to(roomCode).emit("answers-revealed", sortedAnswers);
    });

    socket.on("host-clear-answers", (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        room.answers = [];
        if (room.hostId) io.to(room.hostId).emit("host-new-answer", room.answers);
        room.managers.forEach(m => io.to(m.id).emit("host-new-answer", room.answers));
    });

    socket.on("host-get-users", (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        const host = room.hostId ? room.managers.find(m => m.id === room.hostId) || { id: room.hostId, name: "Host (ID: " + room.hostId.substring(0, 4) + "...) " } : null;

        socket.emit("host-all-users", {
            host: host,
            managers: room.managers.filter(m => m.id !== room.hostId),
            contestants: room.users
        });
    });

    // ========================= KHI NGẮT KẾT NỐI =========================
    socket.on("disconnect", () => {
        console.log("User disconnected:", socket.id);

        for (const roomCode in rooms) {
            const room = rooms[roomCode];

            if (room.hostId === socket.id) {
                room.hostId = null; 
                continue;
            }

            const leftUserIndex = room.users.findIndex(user => user.id === socket.id);
            if (leftUserIndex !== -1) {
                room.users.splice(leftUserIndex, 1);
                if (room.hostId) {
                    io.to(room.hostId).emit("host-user-left", { id: socket.id, role: 'Contestant' });
                }
                room.managers.forEach(m => io.to(m.id).emit("host-user-left", { id: socket.id, role: 'Contestant' }));
                break; 
            }

            const leftManagerIndex = room.managers.findIndex(manager => manager.id === socket.id);
            if (leftManagerIndex !== -1) {
                room.managers.splice(leftManagerIndex, 1);
                if (room.hostId) {
                    io.to(room.hostId).emit("host-user-left", { id: socket.id, role: 'Manager' });
                }
                room.managers.forEach(m => io.to(m.id).emit("host-user-left", { id: socket.id, role: 'Manager' }));
                break;
            }
        }
    });
});

const PORT = 3000;
http.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
});