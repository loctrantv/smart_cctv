const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const http = require('http');

const { initDatabase } = require('./db/schema');
const camerasRouter = require('./routes/cameras');
const recordingsRouter = require('./routes/recordings');
const eventsRouter = require('./routes/events');
const facesRouter = require('./routes/faces');
const systemRouter = require('./routes/system');
const RecordingManager = require('./services/recording-manager');
const StorageManager = require('./services/storage-manager');
const DetectionWorker = require('./services/detection-worker');
const Go2RTCClient = require('./services/go2rtc-client');

// ============================================
// Configuration
// ============================================
const PORT = process.env.PORT || 3001;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'smart_cctv.db');
const RECORDINGS_PATH = process.env.RECORDINGS_PATH || path.join(__dirname, '..', 'data', 'recordings');
const SNAPSHOTS_PATH = process.env.SNAPSHOTS_PATH || path.join(__dirname, '..', 'data', 'snapshots');
const GO2RTC_URL = process.env.GO2RTC_URL || 'http://camera2.tranhtuongtravinh.com/go2rtc/';

// Ensure directories exist
[RECORDINGS_PATH, SNAPSHOTS_PATH, path.dirname(DB_PATH)].forEach(dir => {
  fs.mkdirSync(dir, { recursive: true });
});

// ============================================
// Initialize
// ============================================
const db = initDatabase(DB_PATH);
const app = express();
const server = http.createServer(app);

// WebSocket server for real-time events
const wss = new WebSocketServer({ server, path: '/ws' });

const wsClients = new Set();
wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log(`[WS] Client connected. Total: ${wsClients.size}`);

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${wsClients.size}`);
  });

  // Send initial status
  ws.send(JSON.stringify({ type: 'connected', timestamp: Date.now() }));
});

function broadcast(event) {
  const data = JSON.stringify(event);
  wsClients.forEach(ws => {
    if (ws.readyState === 1) ws.send(data);
  });
}

// ============================================
// Services
// ============================================
const go2rtcClient = new Go2RTCClient(GO2RTC_URL);
const recordingManager = new RecordingManager(db, RECORDINGS_PATH, broadcast);
const storageManager = new StorageManager(db, RECORDINGS_PATH, SNAPSHOTS_PATH);
const detectionWorker = new DetectionWorker(db, SNAPSHOTS_PATH, go2rtcClient, broadcast);

// ============================================
// Middleware
// ============================================
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve snapshots and recordings statically
app.use('/media/snapshots', express.static(SNAPSHOTS_PATH));
app.use('/media/recordings', express.static(RECORDINGS_PATH));

// Inject dependencies into request
app.use((req, res, next) => {
  req.db = db;
  req.go2rtcClient = go2rtcClient;
  req.recordingManager = recordingManager;
  req.detectionWorker = detectionWorker;
  req.storageManager = storageManager;
  req.broadcast = broadcast;
  req.config = { RECORDINGS_PATH, SNAPSHOTS_PATH, GO2RTC_URL };
  next();
});

// ============================================
// Routes
// ============================================
app.use('/api/cameras', camerasRouter);
app.use('/api/recordings', recordingsRouter);
app.use('/api/events', eventsRouter);
app.use('/api/faces', facesRouter);
app.use('/api/system', systemRouter);

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    cameras: db.prepare('SELECT COUNT(*) as count FROM cameras').get().count,
    recordings: db.prepare('SELECT COUNT(*) as count FROM recordings').get().count,
  });
});

// ============================================
// Startup
// ============================================
server.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║       Smart CCTV API Server         ║
  ║     http://localhost:${PORT}           ║
  ╚══════════════════════════════════════╝
  `);

  // Start recording for cameras with auto-record enabled
  const cameras = db.prepare('SELECT * FROM cameras WHERE enabled = 1').all();
  cameras.forEach(camera => {
    // Register with go2rtc
    go2rtcClient.addStream(camera.stream_id, camera.rtsp_url).catch(err => {
      console.error(`[go2rtc] Failed to register camera ${camera.name}:`, err.message);
    });

    // Start recording if configured
    if (camera.record_enabled) {
      recordingManager.startRecording(camera);
    }

    // Start detection if configured
    if (camera.detection_enabled) {
      detectionWorker.startDetection(camera);
    }
  });

  // Start storage cleanup scheduler
  storageManager.startScheduler();
});

// ============================================
// Graceful Shutdown
// ============================================
function shutdown() {
  console.log('\n[Server] Shutting down gracefully...');
  recordingManager.stopAll();
  detectionWorker.stopAll();
  db.close();
  server.close(() => {
    console.log('[Server] Goodbye!');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
