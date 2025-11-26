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

// [ĐIỂM SỬA CHỮA 1]: Hàm broadcastAnswers mới, không sắp xếp trên server và gửi kèm cấu hình sort
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
                // [ĐIỂM SỬA CHỮA 2]: Thêm thuộc tính lưu cấu hình sort
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
        
        // [ĐIỂM SỬA CHỮA 3]: Cập nhật danh sách Contestant trong room
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
        
        // [ĐIỂM SỬA CHỮA 4]: Loại bỏ logic sort cũ, dùng cấu trúc mới
        const answersToSend = room.answers.map(ans => ({
            name: ans.name, 
            answer: ans.answer, 
            time: room.answerStartTime ? (ans.ts - room.answerStartTime) / 1000 : 0
        }));

        socket.emit("viewer-join-success", { 
            roomCode: roomCode, 
            answers: answersToSend, 
            sortOption: room.sortOption || 'time', // Gửi cấu hình sort
            allContestants: room.allContestants || [] // Gửi danh sách thí sinh
        });
    });

    socket.on("manager-join-room", ({ roomCode, name }) => {
// ... (phần này không thay đổi, chỉ thêm logic update allContestants nếu Host.html cần)
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
        
        // [ĐIỂM SỬA CHỮA 5]: Cập nhật danh sách Contestant trong room khi Host lấy danh sách
        room.allContestants = room.users.map(u => u.name); 
        
        const host = room.hostId ? { id: room.hostId, name: "Host" } : null;
        socket.emit("host-all-users", {
            host: host,
            managers: room.managers,
            contestants: room.users
        });
    });
    
    // [ĐIỂM SỬA CHỮA 6]: Thêm handler cho Host đồng bộ cấu hình sắp xếp
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

    // [ĐIỂM SỬA CHỮA 7]: Thêm handler để Result.html yêu cầu cập nhật lại data
    socket.on("viewer-request-update", (roomCode) => {
        broadcastAnswers(roomCode);
    });

// ... (các hàm toggle-answer, reset, toggle-buzz, force-add, user-send-answer, user-buzz không thay đổi logic truyền tải data)
    socket.on("host-reset-answers", (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return; 
        room.answers = []; 
        room.answerStartTime = 0; 
        io.to(roomCode).emit("answers-reset");
        broadcastAnswers(roomCode); // Vẫn gọi broadcastAnswers
    });

    socket.on("user-send-answer", ({ roomCode, name, answer }) => {
// ...
        broadcastAnswers(roomCode); // Vẫn gọi broadcastAnswers
    });
// ...
// ... (logic disconnect không thay đổi)
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});