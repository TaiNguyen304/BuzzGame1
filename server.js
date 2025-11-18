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
// roomCode -> { hostId, users: [{id, name, roomCode, role}], managers: [{id, name}], answers:[], buzz:[], statusAnswer, statusBuzz, answerStartTime, buzzStartTime, timers, answerDuration, buzzDuration }

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
             // Trường hợp Host cũ ngắt kết nối, Host mới sẽ được gán lại
             rooms[roomCode].hostId = socket.id;
        }
        socket.join(roomCode);
        
        // SỬA LỖI: Gửi lại dữ liệu đáp án và chuông hiện tại của phòng
        socket.emit("room-created", { 
            roomCode: roomCode, 
            answers: rooms[roomCode].answers, 
            buzzOrder: rooms[roomCode].buzz 
        }); 
        
        console.log("Room created or re-hosted:", roomCode);
    });

    // ========================= USER JOIN =========================
    socket.on("user-join-room", ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit("join-error", "Mã phòng không tồn tại.");

        // Kiểm tra trùng tên (chỉ trong danh sách thí sinh)
        if (room.users.some(u => u.name === name)) {
            return socket.emit("join-error", `Tên "${name}" đã được sử dụng.`);
        }

        // Thêm vào danh sách users
        room.users.push({ id: socket.id, name, roomCode: roomCode, role: 'Contestant' });
        socket.join(roomCode);

        // Gửi trạng thái hiện tại của phòng cho thí sinh
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
        
        // Thông báo cho Host/Manager
        const hostId = room.hostId;
        if (hostId) {
             io.to(hostId).emit("host-new-user", { id: socket.id, name, role: 'Contestant' });
        }
        room.managers.forEach(m => io.to(m.id).emit("host-new-user", { id: socket.id, name, role: 'Contestant' }));
        console.log(`User ${name} joined room ${roomCode}`);
    });

    // ========================= MANAGER JOIN =========================
    socket.on("manager-join-room", ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room) return socket.emit("join-error", "Mã phòng không tồn tại.");

        // Kiểm tra trùng tên (chỉ trong danh sách quản lý)
        if (room.managers.some(m => m.name === name)) {
            return socket.emit("join-error", `Tên "${name}" (Quản lý) đã được sử dụng.`);
        }

        // Thêm vào danh sách managers
        room.managers.push({ id: socket.id, name });
        socket.join(roomCode);

        // SỬA LỖI: Gửi lại dữ liệu đáp án và chuông hiện tại của phòng
        socket.emit("manager-join-success", { 
            roomCode: roomCode, 
            name: name,
            answers: room.answers, 
            buzzOrder: room.buzz 
        });

        // Thông báo cho Host/Manager khác
        const hostId = room.hostId;
        if (hostId) {
             io.to(hostId).emit("host-new-user", { id: socket.id, name, role: 'Manager' });
        }
        room.managers.filter(m => m.id !== socket.id).forEach(m => io.to(m.id).emit("host-new-user", { id: socket.id, name, role: 'Manager' }));
        console.log(`Manager ${name} joined room ${roomCode}`);
    });

    // ========================= LẤY DANH SÁCH USER (cho Host/Manager) =========================
    socket.on("host-get-users", (roomCode) => {
        const room = rooms[roomCode];
        if (!room) return;

        // Tìm Host hiện tại
        const host = room.hostId ? { id: room.hostId, name: "Host" } : null;
        
        // Gửi danh sách cho người yêu cầu
        socket.emit("host-all-users", {
            host: host,
            managers: room.managers,
            contestants: room.users
        });
    });

    // ========================= ĐIỀU KHIỂN ĐÁP ÁN =========================
    socket.on("host-toggle-answer", ({ roomCode, state, duration }) => {
        const room = rooms[roomCode];
        if (!room || (room.hostId !== socket.id && !room.managers.some(m => m.id === socket.id))) return; // Chỉ Host/Manager mới được điều khiển

        // Xóa timer cũ nếu có
        if (room.answerTimer) {
            clearTimeout(room.answerTimer);
            room.answerTimer = null;
        }

        if (state === "open") {
            room.statusAnswer = "open";
            room.answerDuration = duration || 0; // 0 là vĩnh viễn
            room.answerStartTime = Date.now();
            
            io.to(roomCode).emit("answer-status-changed", { 
                state: "open", 
                duration: room.answerDuration,
                startTime: room.answerStartTime // Gửi thời gian gốc từ server
            });

            if (duration > 0) {
                // Thiết lập timer tự động khóa
                room.answerTimer = setTimeout(() => {
                    room.statusAnswer = "locked";
                    room.answerTimer = null;
                    // Broadcast trạng thái khóa
                    io.to(roomCode).emit("answer-status-changed", { state: "locked" });
                }, duration * 1000);
            }
        } else { // state === "locked"
            room.statusAnswer = "locked";
            room.answerTimer = null;
            io.to(roomCode).emit("answer-status-changed", { state: "locked" });
        }
    });

    // ========================= RESET ĐÁP ÁN (NEW) =========================
    socket.on("host-reset-answers", (roomCode) => {
        const room = rooms[roomCode];
        // Chỉ Host/Manager mới được reset
        if (!room || (room.hostId !== socket.id && !room.managers.some(m => m.id === socket.id))) return; 

        room.answers = []; // Xóa dữ liệu đáp án
        
        // Broadcast sự kiện reset đến tất cả Host/Manager trong phòng để đồng bộ
        // Broadcast sự kiện reset đến tất cả các clients (bao gồm cả Contestants, mặc dù họ không cần render)
        io.to(roomCode).emit("answers-reset");
        console.log(`Answers reset by ${socket.id} in room ${roomCode}`);
    });


    // ========================= ĐIỀU KHIỂN CHUÔNG =========================
    socket.on("host-toggle-buzz", ({ roomCode, state, duration }) => {
        const room = rooms[roomCode];
        if (!room || (room.hostId !== socket.id && !room.managers.some(m => m.id === socket.id))) return; // Chỉ Host/Manager mới được điều khiển

        // Xóa timer cũ nếu có
        if (room.buzzTimer) {
            clearTimeout(room.buzzTimer);
            room.buzzTimer = null;
        }

        if (state === "open") {
            room.statusBuzz = "open";
            room.buzzDuration = duration || 0;
            room.buzzStartTime = Date.now();

            io.to(roomCode).emit("buzz-status-changed", { 
                state: "open", 
                duration: room.buzzDuration,
                startTime: room.buzzStartTime // Gửi thời gian gốc từ server
            });

            if (duration > 0) {
                // Thiết lập timer tự động khóa
                room.buzzTimer = setTimeout(() => {
                    room.statusBuzz = "locked";
                    room.buzzTimer = null;
                    // Broadcast trạng thái khóa
                    io.to(roomCode).emit("buzz-status-changed", { state: "locked" });
                }, duration * 1000);
            }

        } else { // state === "locked"
            room.statusBuzz = "locked";
            room.buzzTimer = null;
            io.to(roomCode).emit("buzz-status-changed", { state: "locked" });
        }
    });

    // ========================= RESET CHUÔNG (NEW) =========================
    socket.on("host-reset-buzz", (roomCode) => {
        const room = rooms[roomCode];
        // Chỉ Host/Manager mới được reset
        if (!room || (room.hostId !== socket.id && !room.managers.some(m => m.id === socket.id))) return;

        room.buzz = []; // Xóa dữ liệu chuông
        
        // Broadcast sự kiện reset đến tất cả Host/Manager trong phòng để đồng bộ
        io.to(roomCode).emit("buzz-reset");
        console.log(`Buzz reset by ${socket.id} in room ${roomCode}`);
    });


    // ========================= USER GỬI ĐÁP ÁN =========================
    socket.on("user-send-answer", ({ roomCode, name, answer }) => {
        const room = rooms[roomCode];
        // Cho phép gửi đáp án sau khi khóa, nhưng chỉ cập nhật nếu vẫn trong thời gian mở
        // Nếu muốn chỉ gửi được khi "open" thì thêm: if (room.statusAnswer !== "open") return;
        if (!room) return;
        
        const ts = Date.now();
        const record = { name, answer, ts };

        // Cập nhật/Thêm đáp án mới nhất
        const index = room.answers.findIndex(x => x.name === name);
        if (index >= 0) room.answers[index] = record;
        else room.answers.push(record);

        // Gửi đáp án mới nhất đến Host/Manager
        const hostId = room.hostId;
        if (hostId) {
             io.to(hostId).emit("host-new-answer", record);
        }
        room.managers.forEach(m => io.to(m.id).emit("host-new-answer", record));
    });

    // ========================= USER BẤM CHUÔNG =========================
    socket.on("user-buzz", ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room || room.statusBuzz !== "open") return; // Chỉ cho bấm khi đang mở

        // Kiểm tra xem đã bấm chuông chưa
        if (room.buzz.some(b => b.name === name)) return;

        const ts = Date.now();
        const record = { name, ts };
        room.buzz.push(record);

        // Gửi thông tin bấm chuông mới nhất đến Host/Manager
        const hostId = room.hostId;
        if (hostId) {
             io.to(hostId).emit("host-new-buzz", record);
        }
        room.managers.forEach(m => io.to(m.id).emit("host-new-buzz", record));
    });


    // ========================= DISCONNECT =========================
    socket.on("disconnect", () => {
        console.log("Disconnected:", socket.id);
        
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            
            // 1. Kiểm tra nếu là Host
            if (room.hostId === socket.id) {
                console.log(`Host ${socket.id} left room ${roomCode}`);
                // Không xóa phòng, chỉ xóa hostId để Host mới có thể re-host
                room.hostId = null; 
            }

            // 2. Xóa người dùng (Contestant)
            const initialUserCount = room.users.length;
            const leftUserIndex = room.users.findIndex(user => user.id === socket.id);

            if (leftUserIndex !== -1) {
                const leftUser = room.users[leftUserIndex];
                room.users.splice(leftUserIndex, 1);
                console.log(`Contestant ${leftUser.name} left room ${roomCode}`);
                // Thông báo cho Host/Manager
                if (room.hostId) {
                    io.to(room.hostId).emit("host-user-left", { id: socket.id, role: 'Contestant' });
                }
                room.managers.forEach(m => io.to(m.id).emit("host-user-left", { id: socket.id, role: 'Contestant' }));
                break; 
            }

            // 3. Xóa Quản lý (Manager)
            const leftManagerIndex = room.managers.findIndex(manager => manager.id === socket.id);
            if (leftManagerIndex !== -1) {
                room.managers.splice(leftManagerIndex, 1);
                console.log(`Manager ${socket.id} left room ${roomCode}`);
                // Thông báo cho Host/Manager
                if (room.hostId) {
                    io.to(room.hostId).emit("host-user-left", { id: socket.id, role: 'Manager' });
                }
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