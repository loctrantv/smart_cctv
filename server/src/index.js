// 1. Load environment variables from .env before loading other modules
const { initEnv } = require('./utils/env');
initEnv();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');
const http = require('http');
const url = require('url');

const { initDatabase } = require('./db/schema');
const authRouter = require('./routes/auth');
const camerasRouter = require('./routes/cameras');
const recordingsRouter = require('./routes/recordings');
const eventsRouter = require('./routes/events');
const facesRouter = require('./routes/faces');
const systemRouter = require('./routes/system');
const RecordingManager = require('./services/recording-manager');
const StorageManager = require('./services/storage-manager');
const DetectionWorker = require('./services/detection-worker');
const Go2RTCClient = require('./services/go2rtc-client');
const authMiddleware = require('./middleware/auth');
const { verifyToken, parseCookies } = require('./utils/auth');

// ============================================
// Configuration (Native Host + go2rtc Docker)
// ============================================
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const PORT = parseInt(process.env.PORT || '3001', 10);
const HOST = process.env.HOST || '0.0.0.0';

function resolveDataPath(envVal, defaultRelative) {
  if (!envVal) return path.join(PROJECT_ROOT, defaultRelative);
  // If old Docker path /app/data/... is left in .env, rewrite to local project data dir
  if (envVal.startsWith('/app/data')) {
    return path.join(PROJECT_ROOT, 'data', envVal.slice('/app/data'.length));
  }
  return path.isAbsolute(envVal) ? envVal : path.resolve(PROJECT_ROOT, envVal);
}

const DB_PATH = resolveDataPath(process.env.DB_PATH, 'data/smart_cctv.db');
const RECORDINGS_PATH = resolveDataPath(process.env.RECORDINGS_PATH, 'data/recordings');
const SNAPSHOTS_PATH = resolveDataPath(process.env.SNAPSHOTS_PATH, 'data/snapshots');
const GO2RTC_URL = process.env.GO2RTC_URL || 'http://127.0.0.1:1984';
const GO2RTC_RTSP_URL = process.env.GO2RTC_RTSP_URL || 'rtsp://127.0.0.1:8554';
const WEB_DIST_PATH = path.join(PROJECT_ROOT, 'web', 'dist');

// Ensure data directories exist
[RECORDINGS_PATH, SNAPSHOTS_PATH, path.dirname(DB_PATH)].forEach((dir) => {
  fs.mkdirSync(dir, { recursive: true });
});

// Check FFmpeg availability on host
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 3000 });
} catch {
  console.warn(
    '[WARNING] FFmpeg was not found in system PATH! Recording and motion/sound detection require FFmpeg installed on the host.'
  );
}

// ============================================
// Initialize Database & HTTP/WS Server
// ============================================
const db = initDatabase(DB_PATH);
const app = express();
app.disable('x-powered-by');
const server = http.createServer(app);

// WebSocket server for real-time events
const wss = new WebSocketServer({ server, path: '/ws' });
const wsClients = new Set();

wss.on('connection', (ws, req) => {
  try {
    const parameters = url.parse(req.url, true).query;
    const cookies = parseCookies(req.headers.cookie);
    const token = parameters.token || cookies.smart_cctv_session;
    const decoded = verifyToken(token);

    if (!decoded) {
      ws.close(4001, 'Unauthorized');
      return;
    }

    const user = db
      .prepare('SELECT id, username, token_version FROM users WHERE username = ?')
      .get(decoded.username);
    if (!user || (decoded.v !== undefined && decoded.v !== user.token_version)) {
      ws.close(4001, 'Session Expired');
      return;
    }
  } catch {
    ws.close(4002, 'Auth Error');
    return;
  }

  wsClients.add(ws);
  console.log(`[WS] Client connected. Total: ${wsClients.size}`);

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${wsClients.size}`);
  });

  ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
});

function broadcast(event) {
  const data = JSON.stringify(event);
  wsClients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(data);
  });
}

// ============================================
// Initialize Core Services
// ============================================
const go2rtcClient = new Go2RTCClient(GO2RTC_URL);
const recordingManager = new RecordingManager(db, RECORDINGS_PATH, broadcast, GO2RTC_RTSP_URL);
const storageManager = new StorageManager(db, RECORDINGS_PATH, SNAPSHOTS_PATH);
const detectionWorker = new DetectionWorker(
  db,
  SNAPSHOTS_PATH,
  go2rtcClient,
  broadcast,
  GO2RTC_RTSP_URL,
  recordingManager
);

// ============================================
// Security Headers & CORS Middleware
// ============================================
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  next();
});

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow same-origin requests (no Origin header) or configured ALLOWED_ORIGINS
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      if (process.env.NODE_ENV !== 'production') {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Inject dependencies into request before routes & static media handlers
app.use((req, res, next) => {
  req.db = db;
  req.go2rtcClient = go2rtcClient;
  req.recordingManager = recordingManager;
  req.detectionWorker = detectionWorker;
  req.storageManager = storageManager;
  req.broadcast = broadcast;
  req.config = { RECORDINGS_PATH, SNAPSHOTS_PATH, GO2RTC_URL, GO2RTC_RTSP_URL };
  next();
});

// Serve snapshots and recordings statically (protected by authMiddleware + nosniff)
app.use(
  '/media/snapshots',
  authMiddleware,
  express.static(SNAPSHOTS_PATH, {
    dotfiles: 'deny',
    setHeaders: (res) => {
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  })
);
app.use(
  '/media/recordings',
  authMiddleware,
  express.static(RECORDINGS_PATH, {
    dotfiles: 'deny',
    setHeaders: (res) => {
      res.setHeader('Content-Security-Policy', "default-src 'none'; media-src 'self'");
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  })
);

// ============================================
// API Routes
// ============================================
app.use('/api/auth', authRouter);
app.use('/api/cameras', authMiddleware, camerasRouter);
app.use('/api/recordings', authMiddleware, recordingsRouter);
app.use('/api/events', authMiddleware, eventsRouter);
app.use('/api/faces', authMiddleware, facesRouter);
app.use('/api/system', authMiddleware, systemRouter);

// Public Health Check (minimal info, no sensitive counts)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
  });
});

// ============================================
// Serve Built Frontend SPA (web/dist) in Unified Mode
// ============================================
if (fs.existsSync(WEB_DIST_PATH)) {
  app.use(express.static(WEB_DIST_PATH));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/') || req.path.startsWith('/media/') || req.path.startsWith('/ws')) {
      return next();
    }
    res.sendFile(path.join(WEB_DIST_PATH, 'index.html'));
  });
}

// ============================================
// Startup
// ============================================
server.listen(PORT, HOST, () => {
  console.log(`
  ╔══════════════════════════════════════════════════╗
  ║       Smart CCTV Unified Server (Native)         ║
  ║     http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}                       ║
  ╚══════════════════════════════════════════════════╝
  `);

  // Recover any orphaned recordings from previous abrupt shutdown
  recordingManager.recoverOrphanedRecordings();

  const cameras = db.prepare('SELECT * FROM cameras WHERE enabled = 1').all();
  const soundRow = db
    .prepare("SELECT value FROM settings WHERE key = 'sound.detection_enabled'")
    .get();
  const soundDetectionEnabled = soundRow ? soundRow.value === '1' : false;

  cameras.forEach((camera) => {
    go2rtcClient.addStream(camera.stream_id, camera.rtsp_url).catch((err) => {
      console.error(`[go2rtc] Failed to register camera ${camera.name}:`, err.message);
    });

    if (camera.record_enabled) {
      recordingManager.startRecording(camera);
    }

    if (camera.detection_enabled) {
      detectionWorker.startDetection(camera);
    }

    if (soundDetectionEnabled && camera.detection_enabled) {
      detectionWorker.startSoundDetection(camera);
    }
  });

  storageManager.startScheduler();
});

// ============================================
// Graceful Shutdown
// ============================================
function shutdown() {
  console.log('\n[Server] Shutting down gracefully...');
  recordingManager.stopAll();
  detectionWorker.stopAll();
  try {
    db.close();
  } catch {}
  server.close(() => {
    console.log('[Server] Goodbye!');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
