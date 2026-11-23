# Smart CCTV (Native Node.js + go2rtc Docker)

> Hệ thống quản lý camera giám sát mã nguồn mở, chạy hoàn toàn **on-premise**, giao diện web responsive, tối ưu cho server tài nguyên thấp.
> Kiến trúc **Host Native (PM2)** kết hợp **`go2rtc` chạy trong Docker được cô lập nội bộ (`127.0.0.1`)**.

---

## Tính năng

| Tính năng | Mô tả |
|---|---|
| **Xem trực tiếp** | WebRTC độ trễ thấp, HLS fallback tự động (qua Proxy xác thực của Node.js) |
| **Ghi hình** | Liên tục hoặc theo sự kiện, stream copy (`-c:v copy`) — CPU ≈ 0%, tự phục hồi bản ghi khi mất điện |
| **Phát hiện chuyển động** | Snapshot analysis theo vùng quét tùy chọn (multi-zone), tự động quay video khi có chuyển động |
| **Phát hiện âm thanh** | Lắng nghe âm thanh bất thường trong khung giờ ban đêm (tùy chỉnh), tự động quay video |
| **Nhận dạng khuôn mặt** | Đăng ký khuôn mặt (kiểm tra định dạng ảnh Magic Bytes), nhận diện thời gian thực |
| **Xem lại** | Timeline 24h có minimap zoom, tua nhanh, tìm kiếm theo sự kiện |
| **Sự kiện** | Lịch sử toàn bộ sự kiện, lọc theo loại / camera, xóa hàng loạt |
| **Quản lý lưu trữ** | Tự động xóa file cũ theo dung lượng và số ngày lưu |
| **Bảo mật cao** | Băm mật khẩu `scrypt`, HttpOnly Session Cookie, Rate Limit chống Brute-force, ẩn mật khẩu RTSP, chống SSRF/Command Injection |
| **Hot-reload cài đặt** | Thay đổi cài đặt phát hiện chuyển động / âm thanh áp dụng ngay lập tức không cần restart |

---

## Kiến trúc Bảo mật

```
Browser (Desktop / Mobile)
  ├─ HTTPS / WSS (:3001) ──────► Node.js + Express (Chạy trực tiếp trên Host qua PM2)
  │                                ├─ Phục vụ tĩnh React SPA (web/dist)
  │                                ├─ Xác thực HttpOnly Cookie + JWT + Rate Limit
  │                                ├─ SQLite WAL (users, cameras, recordings, events, settings)
  │                                ├─ FFmpeg Native (recording, detection snapshots, audio RMS)
  │                                └─ Authenticated Proxy (/api/cameras/:id/webrtc, /hls, /snapshot)
  │                                      │
  │                                      ▼ (Chỉ kết nối nội bộ 127.0.0.1:1984 & 127.0.0.1:8554)
  └─ WebRTC Media (:8555) ────► Docker: go2rtc (RTSP proxy)
                                         └─ Camera RTSP streams
```

- **Chỉ `go2rtc` chạy trong Docker**: Cổng API (`1984`) và RTSP (`8554`) của `go2rtc` chỉ mở ở `127.0.0.1` trên máy chủ, ngăn chặn hoàn toàn việc người ngoài truy cập trái phép vào dashboard `go2rtc` hoặc lấy cắp mật khẩu RTSP của camera.
- **Node.js & FFmpeg chạy trực tiếp trên Host (quản lý qua PM2)**: Phục vụ đồng thời cả Frontend (`web/dist`) lẫn Backend API/WebSocket trên cùng một cổng (`3001`).

---

## Yêu cầu hệ thống

- **Node.js**: v20+ (khuyến nghị LTS)
- **FFmpeg**: Cài đặt trực tiếp trên máy chủ và có trong `PATH` (`sudo apt install ffmpeg` trên Ubuntu hoặc `winget install Gyan.FFmpeg` trên Windows)
- **Docker**: Chỉ dùng để chạy container `alexxit/go2rtc`
- **PM2**: `npm install -g pm2`

---

## Cài đặt & Triển khai (PM2 + Docker `go2rtc`)

### 1. Cấu hình biến môi trường

```bash
cp .env.example .env
```

Chỉnh sửa file `.env` ở thư mục gốc:

```env
PORT=3001
NODE_ENV=production

ADMIN_USERNAME=admin
ADMIN_PASSWORD=MatKhauManhCuaBan_2026!
JWT_SECRET=chuoi_ngau_nhien_64_ky_tu_hex_de_ky_token

GO2RTC_URL=http://127.0.0.1:1984
GO2RTC_RTSP_URL=rtsp://127.0.0.1:8554
```

### 2. Khởi chạy `go2rtc` bằng Docker

```bash
docker compose up -d
```

### 3. Cài đặt thư viện & Build giao diện Web

```bash
# Cài đặt & build Frontend (React -> web/dist)
cd web
npm install
npm run build

# Cài đặt Backend
cd ../server
npm install
cd ..
```

### 4. Khởi chạy với PM2

Từ thư mục gốc của dự án (nơi có sẵn file `ecosystem.config.js`):

```bash
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Truy cập hệ thống tại: **`http://<server-ip>:3001`** (hoặc cấu hình Nginx/Cloudflare Tunnel trỏ vào `http://127.0.0.1:3001`).

> [!IMPORTANT]
> Sau khi đăng nhập lần đầu, hãy vào mục **Cài đặt → Bảo mật** trên giao diện Web để đổi mật khẩu quản trị. Mật khẩu sẽ được băm an toàn bằng thuật toán `scrypt` trong cơ sở dữ liệu SQLite.

---

## Phát triển (Development)

```bash
# Terminal 1: Chạy go2rtc trong Docker
docker compose up -d

# Terminal 2: Chạy Backend với hot-reload (cổng 3001)
cd server
npm run dev

# Terminal 3: Chạy Frontend Vite dev server (cổng 5173, tự động proxy /api, /media, /ws sang 3001)
cd web
npm run dev
```

---

## API Overview

| Method | Endpoint | Mô tả |
|---|---|---|
| `POST` | `/api/auth/login` | Đăng nhập (có Rate Limit), cấp HttpOnly Cookie & JWT |
| `POST` | `/api/auth/logout` | Đăng xuất, xóa HttpOnly Cookie |
| `PUT` | `/api/auth/password` | Đổi mật khẩu quản trị & thu hồi toàn bộ phiên cũ |
| `GET` | `/api/cameras` | Danh sách camera (mật khẩu RTSP đã được ẩn `******`) |
| `POST` | `/api/cameras` | Thêm camera (kiểm tra giao thức `rtsp://`, chống SSRF) |
| `PUT` | `/api/cameras/:id` | Cập nhật camera & vùng phát hiện chuyển động |
| `DELETE` | `/api/cameras/:id` | Xóa camera |
| `POST` | `/api/cameras/:id/webrtc` | Proxy bắt tay WebRTC SDP có xác thực tới `go2rtc` |
| `GET` | `/api/cameras/:id/hls/:file` | Proxy phát luồng HLS có xác thực tới `go2rtc` |
| `GET` | `/api/cameras/:id/snapshot` | Proxy chụp ảnh nhanh có xác thực tới `go2rtc` |
| `GET` | `/api/recordings` | Danh sách bản ghi |
| `GET` | `/api/events` | Danh sách sự kiện (filter: type, camera, time) |
| `DELETE` | `/api/events` | Xóa hàng loạt sự kiện |
| `GET` | `/api/system/settings` | Đọc cài đặt hệ thống |
| `PUT` | `/api/system/settings` | Cập nhật & áp dụng ngay cài đặt (Hot-reload) |
| `GET` | `/api/health` | Health check |

---

## License

MIT © 2026
