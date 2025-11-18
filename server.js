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
// roomCode -> { hostId, users: [{id, name}], managers: [{id, name}], answers:[], buzz:[], statusAnswer, statusBuzz, answerStartTime, buzzStartTime, timers }

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
        socket.emit("room-created", roomCode);
        console.log("Room created/re-hosted:", roomCode);
    });

    // Hàm kiểm tra trùng tên (áp dụng cho cả user và manager)
    const isNameTaken = (room, name) => {
        // Kiểm tra trong danh sách thí sinh
        const isContestant = room.users.some(user => user.name === name);
        if (isContestant) return true;
        
        // Kiểm tra trong danh sách quản lý
        const isManager = room.managers.some(manager => manager.name === name);
        if (isManager) return true;

        // Tên host mặc định không cần kiểm tra trùng với user/manager
        if (room.hostId === socket.id && name === "Host") return false; 
        
        return false;
    }


    // ========================= USER JOIN (Thí sinh) =========================
    socket.on("user-join-room", ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room) {
            socket.emit("join-failed", "Phòng không tồn tại.");
            return;
        }

        // VALIDATE: Kiểm tra tên người dùng bị trùng (CÓ phân biệt chữ hoa/thường)
        if (isNameTaken(room, name)) {
            socket.emit("join-failed", `Tên "${name}" đã được sử dụng trong phòng này. Vui lòng chọn tên khác.`);
            return;
        }

        // ADD USER and proceed with join
        room.users.push({ id: socket.id, name });
        socket.join(roomCode);
        socket.emit("join-success", { roomCode });
        console.log(`${name} joined room ${roomCode} as Contestant`);
    });


    // ========================= MANAGER JOIN (Quản lý) =========================
    socket.on("manager-join-room", ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room) {
            socket.emit("join-manager-failed", "Phòng không tồn tại.");
            return;
        }
        
        // Host không cần kiểm tra trùng tên với chính mình
        if (room.hostId === socket.id) {
             socket.emit("join-manager-failed", `Bạn đang là Host của phòng ${roomCode}.`);
             return;
        }

        // VALIDATE: Kiểm tra tên người dùng bị trùng (CÓ phân biệt chữ hoa/thường)
        if (isNameTaken(room, name)) {
            socket.emit("join-manager-failed", `Tên "${name}" đã được sử dụng trong phòng này. Vui lòng chọn tên khác.`);
            return;
        }

        // ADD MANAGER and proceed with join
        room.managers.push({ id: socket.id, name });
        socket.join(roomCode);
        socket.emit("manager-join-success", { roomCode, name });
        console.log(`${name} joined room ${roomCode} as Manager`);
    });

    // ========================= HÀM HỖ TRỢ: KIỂM TRA QUYỀN ĐIỀU KHIỂN =========================
    const canControl = (room, socketId) => {
        // Host luôn có quyền
        if (room.hostId === socketId) return true;
        // Quản lý cũng có quyền
        if (room.managers.some(m => m.id === socketId)) return true;
        return false;
    }

    // ========================= ĐÁP ÁN (Áp dụng cho Host/Manager) =========================
    socket.on("host-toggle-answer", ({ roomCode, state, duration = 0 }) => {
        const room = rooms[roomCode];
        if (!room || !canControl(room, socket.id)) return; // Chỉ Host/Manager mới được điều khiển

        // Xóa timer cũ
        if (room.answerTimer) {
            clearTimeout(room.answerTimer);
            room.answerTimer = null;
        }

        if (state === "open") {
            const now = Date.now();
            room.statusAnswer = "open";
            
            // Luôn đặt startTime là now, kể cả khi duration = 0
            room.answerStartTime = now;
            room.answerDuration = duration;

            io.to(roomCode).emit("answer-status-changed", {
                state: "open",
                duration,
                startTime: now
            });

            if (duration > 0) {
                // Giảm 5 giây timeout để khớp với logic Contestant (remain > 0)
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

    // ========================= CHUÔNG (Áp dụng cho Host/Manager) =========================
    socket.on("host-toggle-buzz", ({ roomCode, state, duration = 0 }) => {
        const room = rooms[roomCode];
        if (!room || !canControl(room, socket.id)) return; // Chỉ Host/Manager mới được điều khiển

        if (room.buzzTimer) {
            clearTimeout(room.buzzTimer);
            room.buzzTimer = null;
        }

        if (state === "open") {
            const now = Date.now();
            room.statusBuzz = "open";
            
            // Luôn đặt startTime là now, kể cả khi duration = 0
            room.buzzStartTime = now;
            room.buzzDuration = duration;
            room.buzz = []; // reset danh sách buzz

            io.to(roomCode).emit("buzz-status-changed", {
                state: "open",
                duration,
                startTime: now
            });

            if (duration > 0) {
                // Giảm 5 giây timeout để khớp với logic Contestant (remain > 0)
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

    // ========================= HOST/MANAGER YÊU CẦU DANH SÁCH USER =========================
    socket.on("host-request-userlist", (roomCode) => {
        const room = rooms[roomCode];
        if (!room || !canControl(room, socket.id)) return;

        // Tìm Host (giả sử Host là người dùng đầu tiên tạo phòng, có ID)
        const hostSocket = io.sockets.sockets.get(room.hostId);
        const host = hostSocket ? { id: room.hostId, name: "Host" } : null; // Tên Host mặc định là "Host"

        // Lấy danh sách Quản lý
        const managers = room.managers;

        // Lấy danh sách Thí sinh
        const contestants = room.users;

        socket.emit("host-receive-userlist", { host, managers, contestants });
    });


    // ========================= USER GỬI ĐÁP ÁN (Thí sinh) =========================
    socket.on("user-send-answer", ({ roomCode, name, answer }) => {
        const room = rooms[roomCode];
        if (!room || room.statusAnswer !== "open") return;

        const ts = Date.now();
        const record = { name, answer, ts };

        const index = room.answers.findIndex(x => x.name === name);
        if (index >= 0) room.answers[index] = record;
        else room.answers.push(record);

        // Gửi đến Host và tất cả Manager
        if (room.hostId) io.to(room.hostId).emit("host-new-answer", record);
        room.managers.forEach(m => io.to(m.id).emit("host-new-answer", record));
    });

    // ========================= USER BẤM CHUÔNG (Thí sinh) =========================
    socket.on("user-buzz", ({ roomCode, name }) => {
        const room = rooms[roomCode];
        if (!room || room.statusBuzz !== "open") return;

        if (room.buzz.find(b => b.name === name)) return;

        const ts = Date.now();
        room.buzz.push({ name, ts });

        // Gửi đến Host và tất cả Manager
        if (room.hostId) io.to(room.hostId).emit("host-new-buzz", { name, ts });
        room.managers.forEach(m => io.to(m.id).emit("host-new-buzz", { name, ts }));
    });

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
            room.users = room.users.filter(user => user.id !== socket.id);
            if (room.users.length < initialUserCount) {
                console.log(`Contestant ${socket.id} left room ${roomCode}`);
                break; 
            }

            // 3. Xóa Quản lý (Manager)
            const initialManagerCount = room.managers.length;
            room.managers = room.managers.filter(manager => manager.id !== socket.id);
            if (room.managers.length < initialManagerCount) {
                console.log(`Manager ${socket.id} left room ${roomCode}`);
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server running on port ${PORT}`));