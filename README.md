# Smart CCTV

> Hệ thống quản lý camera giám sát mã nguồn mở, chạy hoàn toàn **on-premise**, giao diện web responsive, tối ưu cho server tài nguyên thấp.

---

## Tính năng

| Tính năng | Mô tả |
|---|---|
| **Xem trực tiếp** | WebRTC độ trễ thấp, HLS fallback tự động |
| **Ghi hình** | Liên tục hoặc theo lịch, stream copy — CPU ≈ 0% |
| **Phát hiện chuyển động** | Snapshot analysis, tự động quay video khi có chuyển động |
| **Phát hiện âm thanh** | Lắng nghe âm thanh bất thường trong khung giờ ban đêm (tùy chỉnh), tự động quay video |
| **Nhận dạng khuôn mặt** | Đăng ký khuôn mặt, nhận diện thời gian thực |
| **Xem lại** | Timeline 24h, tua nhanh, tìm kiếm theo sự kiện |
| **Sự kiện** | Lịch sử toàn bộ sự kiện, lọc theo loại / camera, xóa hàng loạt |
| **Quản lý lưu trữ** | Tự động xóa file cũ theo dung lượng và số ngày lưu |
| **Realtime** | WebSocket broadcast — UI cập nhật ngay khi có sự kiện |
| **Responsive** | Hoạt động tốt trên desktop và mobile |

---

## Kiến trúc

```
Browser
  └─ React SPA (Vite)
       ├─ WebRTC / HLS ──► go2rtc (RTSP proxy)
       │                        └─ Camera RTSP streams
       └─ REST API / WS ──► Node.js + Express
                                 ├─ SQLite (metadata, events, settings)
                                 ├─ FFmpeg (recording, detection snapshots)
                                 └─ go2rtc API (stream management)
```

| Layer | Công nghệ | Vai trò |
|---|---|---|
| Streaming proxy | go2rtc | RTSP → WebRTC / HLS |
| Backend | Node.js + Express | REST API, WebSocket, business logic |
| Recording / Detection | FFmpeg | Stream copy, snapshot, audio RMS |
| Database | SQLite (better-sqlite3) | Cameras, recordings, events, settings |
| Frontend | React 18 + Vite | SPA, realtime dashboard |
| Deploy | Docker Compose | Container orchestration |

---

## Yêu cầu hệ thống

- **OS**: Ubuntu Server 20.04+ (hoặc bất kỳ Linux/Windows có Docker)
- **Docker**: 20.10+ & Docker Compose v2
- **Tài nguyên tối thiểu**: 2 CPU cores, 2 GB RAM
- **FFmpeg**: đã cài trong Docker image (hoặc cài local khi dev)

---

## Cài đặt nhanh (Docker)

### 1. Clone & cấu hình

```bash
git clone <repo-url> smart_cctv
cd smart_cctv
cp .env.example .env
```

Chỉnh sửa `.env`:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your_secure_password
JWT_SECRET=your_random_secret_key

GO2RTC_URL=http://localhost:1984
GO2RTC_RTSP_URL=rtsp://localhost:8554

TZ=Asia/Ho_Chi_Minh
```

### 2. Khởi động

```bash
docker compose up -d
```

### 3. Truy cập

| Dịch vụ | URL |
|---|---|
| Web UI | `http://<server-ip>` |
| API Server | `http://<server-ip>:3001` |
| go2rtc Dashboard | `http://<server-ip>:1984` |

Đăng nhập với tài khoản đã cấu hình trong `.env`.

---

## Thêm Camera

1. Mở Web UI → Dashboard → **"Thêm Camera"**
2. Nhập tên, RTSP URL, và các tùy chọn:

```
rtsp://admin:password@192.168.1.100:554/stream1
```

3. Bật **Ghi hình** hoặc **Phát hiện** theo nhu cầu

---

## Cấu hình tính năng

### Phát hiện Chuyển động

Vào **Settings → Phát hiện**:
- Khoảng cách quét (ms) — nhỏ hơn = nhanh hơn nhưng tốn CPU
- Ngưỡng tin cậy (0–1)
- Tự động quay video khi phát hiện + thời lượng

### Phát hiện Âm thanh Ban đêm

Vào **Settings → Âm thanh**:

| Cài đặt | Mô tả |
|---|---|
| Bật phát hiện | Bật/tắt toàn bộ tính năng |
| Khung giờ ban đêm | Giờ bắt đầu và kết thúc (hỗ trợ qua nửa đêm) |
| Ngưỡng âm lượng (dBFS) | -30 ≈ nói bình thường · -20 ≈ nói to · -10 ≈ la hét |
| Tự động quay video | Bật/tắt ghi hình khi phát hiện âm thanh lạ |
| Thời lượng quay | 5–300 giây |

> Sau khi lưu cài đặt, **restart server** để áp dụng: `docker compose restart api`

---

## Phát triển (Development)

### Backend

```bash
cd server
npm install
npm run dev        # nodemon với hot-reload
```

### Frontend

```bash
cd web
npm install
npm run dev        # Vite dev server tại http://localhost:5173
```

### Cấu trúc thư mục

```
smart_cctv/
├── server/
│   └── src/
│       ├── db/             # Schema SQLite
│       ├── middleware/     # Auth middleware
│       ├── routes/         # REST API routes
│       ├── services/       # DetectionWorker, RecordingManager, StorageManager
│       └── utils/
├── web/
│   └── src/
│       ├── components/     # VideoPlayer
│       ├── hooks/          # useWebSocket
│       ├── pages/          # Dashboard, CameraView, Events, Playback, Settings...
│       └── utils/          # API client
├── data/                   # Recordings, snapshots, database (auto-created)
├── docker-compose.yml
├── go2rtc.yaml
└── .env
```

---

## API Overview

| Method | Endpoint | Mô tả |
|---|---|---|
| `POST` | `/api/auth/login` | Đăng nhập, trả về JWT |
| `GET` | `/api/cameras` | Danh sách camera |
| `POST` | `/api/cameras` | Thêm camera |
| `PUT` | `/api/cameras/:id` | Cập nhật camera |
| `DELETE` | `/api/cameras/:id` | Xóa camera |
| `GET` | `/api/recordings` | Danh sách bản ghi |
| `GET` | `/api/events` | Danh sách sự kiện (filter: type, camera, time) |
| `DELETE` | `/api/events` | Xóa hàng loạt sự kiện |
| `GET` | `/api/system/settings` | Đọc cài đặt hệ thống |
| `PUT` | `/api/system/settings` | Cập nhật cài đặt |
| `GET` | `/api/health` | Health check |

**WebSocket**: `ws://<server>/ws?token=<jwt>` — nhận realtime events (`detection_event`, `recording_started`, `recording_completed`)

---

## Tài nguyên hệ thống (ước tính, 4 camera)

| Thành phần | CPU | RAM |
|---|---|---|
| go2rtc (streaming) | ~3% | ~50 MB |
| FFmpeg (recording) | ~3% | ~40 MB |
| Detection (snapshot) | ~15% | ~200 MB |
| Sound detection (audio) | ~2% | ~20 MB |
| API Server | ~2% | ~80 MB |
| **Tổng** | **~25%** | **~390 MB** |

---

## Loại sự kiện

| Type | Mô tả | Badge |
|---|---|---|
| `motion` | Phát hiện chuyển động qua snapshot | Xanh lá |
| `person` | Phát hiện người | Xanh dương |
| `face` | Nhận diện khuôn mặt | Tím |
| `sound_alert` | Âm thanh bất thường ban đêm | Cam |

---

## License

MIT © 2026
