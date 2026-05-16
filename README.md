# Smart CCTV - Hệ thống Quản lý Camera Giám sát

Phần mềm quản lý camera CCTV chuyên nghiệp, chạy trên Ubuntu Server, quản lý qua giao diện web responsive.

## 🌟 Tính năng

- **📹 Quản lý nhiều camera** - Thêm/sửa/xóa camera RTSP
- **🔴 Xem trực tiếp** - WebRTC (độ trễ thấp) + HLS fallback
- **⏺ Quay phim** - Ghi hình liên tục hoặc theo lịch, stream copy (CPU ≈ 0%)
- **👤 Nhận dạng người** - Phát hiện người qua snapshot analysis
- **😊 Nhận dạng khuôn mặt** - Đăng ký và nhận diện khuôn mặt
- **⏪ Xem lại chuyên nghiệp** - Timeline 24h, tua nhanh, tìm kiếm theo sự kiện
- **📱 Responsive** - Hoạt động trên desktop và mobile
- **⚡ Nhẹ** - Tối ưu cho server giới hạn tài nguyên

## 🏗 Kiến trúc

| Component | Technology | Vai trò |
|-----------|-----------|---------|
| Streaming | go2rtc | RTSP → WebRTC/HLS proxy |
| Backend | Node.js + Express | REST API + WebSocket |
| Recording | FFmpeg (-c copy) | Stream copy, CPU ≈ 0% |
| Database | SQLite | Metadata, events, settings |
| Frontend | React + Vite | SPA responsive |
| Deploy | Docker Compose | Container orchestration |

## 🚀 Cài đặt

### Yêu cầu
- Ubuntu Server 20.04+
- Docker & Docker Compose
- 2+ CPU cores, 2+ GB RAM

### Bước 1: Clone & Configure

```bash
git clone <repo-url> smart_cctv
cd smart_cctv
cp .env.example .env
# Chỉnh sửa .env theo nhu cầu
```

### Bước 2: Chạy

```bash
docker compose up -d
```

### Bước 3: Truy cập

- **Web UI**: http://your-server-ip
- **API**: http://your-server-ip:3001
- **go2rtc**: http://your-server-ip:1984

## 📡 Thêm Camera

1. Mở Web UI → Dashboard → "Thêm Camera"
2. Nhập tên và RTSP URL:
   ```
   rtsp://admin:password@192.168.1.100:554/stream1
   ```
3. Bật Recording hoặc Detection theo nhu cầu

## 🛠 Development

```bash
# Backend
cd server && npm install && npm run dev

# Frontend
cd web && npm install && npm run dev
```

## 📊 Resource Usage (4 cameras)

| Operation | CPU | RAM |
|-----------|-----|-----|
| Streaming (go2rtc) | ~3% | ~50MB |
| Recording (FFmpeg) | ~3% | ~40MB |
| Detection | ~15% | ~200MB |
| API Server | ~2% | ~80MB |
| **Total** | **~23%** | **~370MB** |

## 📄 License

MIT
