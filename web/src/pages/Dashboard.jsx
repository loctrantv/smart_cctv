import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getCameras,
  addCamera,
  startRecording,
  stopRecording,
  updateCamera,
  getEvents,
  getMediaUrl,
} from '../utils/api';
import { useApp } from '../App';
import {
  Camera,
  Plus,
  Grid3X3,
  Grid2X2,
  Square,
  Columns,
  Rows,
  Video,
  Eye,
  EyeOff,
  AlertTriangle,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  Bell,
  Volume2,
  Activity,
  ArrowUpSquare,
  ArrowDownSquare,
} from 'lucide-react';
import VideoPlayer from '../components/VideoPlayer';

/**
 * Layouts specifically engineered for Dual-Lens (8:9 stacked 2x16:9) CCTV cameras:
 * - '1-split' : 1 Camera in Side-by-Side mode (Left: Top Lens 16:9, Right: Bottom Lens 16:9)
 * - '2-col'   : 2 Cameras side-by-side in 2 vertical 8:9 columns (= 4 x 16:9 views fitting a 16:9 monitor!)
 * - '3-col'   : 3 Cameras side-by-side in 3 vertical 8:9 columns (= 6 x 16:9 views)
 * - '4-col'   : 4 Cameras side-by-side in 4 vertical 8:9 columns (= 8 x 16:9 views)
 * - '2x2'     : Standard 2x2 quad matrix (4 cameras)
 * - '3x3'     : Standard 3x3 matrix (9 cameras)
 */
const MATRIX_LAYOUTS = [
  { id: '1-split', label: '1 Kênh (Tách 2 Mắt)', capacity: 1, defaultLens: 'split' },
  { id: '2-col', label: '2 Cột (4 Khung 16:9)', capacity: 2, defaultLens: 'stacked' },
  { id: '3-col', label: '3 Cột (6 Khung 16:9)', capacity: 3, defaultLens: 'stacked' },
  { id: '4-col', label: '4 Cột (8 Khung 16:9)', capacity: 4, defaultLens: 'stacked' },
  { id: '2x2', label: 'Lưới 2×2 (4 Kênh)', capacity: 4, defaultLens: 'split' },
  { id: '3x3', label: 'Lưới 3×3 (9 Kênh)', capacity: 9, defaultLens: 'stacked' },
];

export default function Dashboard() {
  const [cameras, setCameras] = useState([]);
  const [layoutId, setLayoutId] = useState('2-col');
  const [initialLayoutSet, setInitialLayoutSet] = useState(false);
  const [page, setPage] = useState(0);
  const [autoTour, setAutoTour] = useState(false);
  const [globalLensMode, setGlobalLensMode] = useState('auto'); // 'auto' | 'stacked' | 'split' | 'top' | 'bottom'
  const [cellLensModes, setCellLensModes] = useState({});
  const [showAddModal, setShowAddModal] = useState(false);
  const [showEventDrawer, setShowEventDrawer] = useState(false);
  const [recentEvents, setRecentEvents] = useState([]);
  const [alertMap, setAlertMap] = useState({}); // cameraId -> timestamp of latest motion/sound alert
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState({});

  const { ws, refreshGlobalStats } = useApp();
  const navigate = useNavigate();

  const fetchCameras = useCallback(async () => {
    try {
      const data = await getCameras();
      setCameras(data);
    } catch (err) {
      console.error('Failed to fetch cameras:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRecentEvents = useCallback(async () => {
    try {
      const data = await getEvents({ limit: 15 });
      setRecentEvents(data.events || []);
    } catch {}
  }, []);

  useEffect(() => {
    fetchCameras();
    fetchRecentEvents();
  }, [fetchCameras, fetchRecentEvents]);

  // Automatically pick the optimal layout for Dual-Lens 8:9 cameras on first load
  useEffect(() => {
    if (!loading && !initialLayoutSet) {
      const count = cameras.length;
      if (count <= 1) setLayoutId('1-split');
      else if (count === 2) setLayoutId('2-col');
      else if (count === 3) setLayoutId('3-col');
      else if (count === 4) setLayoutId('4-col');
      else setLayoutId('3x3');
      setInitialLayoutSet(true);
    }
  }, [loading, cameras.length, initialLayoutSet]);

  // Listen to real-time WebSocket events and highlight alerting camera cell
  useEffect(() => {
    if (!ws) return;
    const unsub1 = ws.on('camera_added', fetchCameras);
    const unsub2 = ws.on('camera_updated', fetchCameras);
    const unsub3 = ws.on('camera_removed', fetchCameras);
    const unsub4 = ws.on('detection_event', (payload) => {
      const evt = payload?.event;
      if (evt) {
        setRecentEvents((prev) => [evt, ...prev.slice(0, 19)]);
        setAlertMap((prev) => ({ ...prev, [evt.camera_id]: Date.now() }));
        setTimeout(() => {
          setAlertMap((prev) => {
            const copy = { ...prev };
            if (copy[evt.camera_id] && Date.now() - copy[evt.camera_id] >= 5800) {
              delete copy[evt.camera_id];
            }
            return copy;
          });
        }, 6000);
      }
    });
    return () => {
      unsub1();
      unsub2();
      unsub3();
      unsub4();
    };
  }, [ws, fetchCameras]);

  const currentLayout = useMemo(
    () => MATRIX_LAYOUTS.find((l) => l.id === layoutId) || MATRIX_LAYOUTS[1],
    [layoutId]
  );

  const totalPages = Math.max(1, Math.ceil(cameras.length / currentLayout.capacity));

  useEffect(() => {
    if (page >= totalPages) {
      setPage(0);
    }
  }, [page, totalPages]);

  // Auto-Tour / Patrol cycle timer
  useEffect(() => {
    if (!autoTour || totalPages <= 1) return;
    const timer = setInterval(() => {
      setPage((prev) => (prev + 1) % totalPages);
    }, 12000);
    return () => clearInterval(timer);
  }, [autoTour, totalPages]);

  const visibleCameras = useMemo(() => {
    const start = page * currentLayout.capacity;
    return cameras.slice(start, start + currentLayout.capacity);
  }, [cameras, page, currentLayout]);

  const getEffectiveLensMode = (cameraId) => {
    if (cellLensModes[cameraId]) return cellLensModes[cameraId];
    if (globalLensMode !== 'auto') return globalLensMode;
    return currentLayout.defaultLens;
  };

  const handleGlobalLensChange = (mode) => {
    setGlobalLensMode(mode);
    setCellLensModes({}); // Reset per-cell overrides so all cameras follow the new global choice
  };

  const handleToggleRecord = async (e, camera) => {
    e.stopPropagation();
    const cid = camera.id;
    if (actionLoading[cid]) return;

    setActionLoading((prev) => ({ ...prev, [cid]: true }));
    try {
      if (camera.record_enabled) {
        await stopRecording(cid);
      } else {
        await startRecording(cid);
      }
      await fetchCameras();
      if (refreshGlobalStats) refreshGlobalStats();
    } catch (err) {
      console.error('Lỗi bật/tắt ghi hình:', err);
    } finally {
      setActionLoading((prev) => ({ ...prev, [cid]: false }));
    }
  };

  const handleToggleDetection = async (e, camera) => {
    e.stopPropagation();
    const cid = camera.id;
    if (actionLoading[cid]) return;

    setActionLoading((prev) => ({ ...prev, [cid]: true }));
    try {
      await updateCamera(cid, {
        detection_enabled: !camera.detection_enabled,
      });
      await fetchCameras();
      if (refreshGlobalStats) refreshGlobalStats();
    } catch (err) {
      console.error('Lỗi bật/tắt phát hiện chuyển động:', err);
    } finally {
      setActionLoading((prev) => ({ ...prev, [cid]: false }));
    }
  };

  return (
    <div className="vms-matrix-workspace">
      {/* Compact VMS Operator Control Strip */}
      <div className="vms-control-strip">
        <div className="vms-strip-left">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setShowAddModal(true)}
            id="add-camera-btn"
          >
            <Plus size={14} /> Thêm Kênh
          </button>

          <div className="vms-divider" />

          {/* Matrix Layout Switcher */}
          <div className="vms-btn-group" title="Chọn bố cục màn hình Video Wall">
            {MATRIX_LAYOUTS.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`vms-strip-btn ${layoutId === l.id ? 'active' : ''}`}
                onClick={() => {
                  setLayoutId(l.id);
                  setPage(0);
                }}
              >
                {l.id === '1-split' && <Square size={13} />}
                {l.id === '2-col' && <Columns size={13} />}
                {l.id === '3-col' && <Columns size={13} />}
                {l.id === '4-col' && <Columns size={13} />}
                {l.id === '2x2' && <Grid2X2 size={13} />}
                {l.id === '3x3' && <Grid3X3 size={13} />}
                <span>{l.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Right Controls: Dual-Lens Global Mode + Page Tour + Live Event Drawer Toggle */}
        <div className="vms-strip-right">
          {/* Global Dual-Lens Mode Selector */}
          <div className="vms-btn-group" title="Chế độ hiển thị đồng loạt cho Camera 2 mắt">
            <button
              type="button"
              className={`vms-strip-btn ${globalLensMode === 'auto' ? 'active' : ''}`}
              onClick={() => handleGlobalLensChange('auto')}
              title="Tự động theo bố cục lưới"
            >
              Auto
            </button>
            <button
              type="button"
              className={`vms-strip-btn ${globalLensMode === 'stacked' ? 'active' : ''}`}
              onClick={() => handleGlobalLensChange('stacked')}
              title="Hiển thị tất cả camera dạng Kép Dọc (8:9)"
            >
              <Rows size={13} /> <span>2 Mắt Dọc</span>
            </button>
            <button
              type="button"
              className={`vms-strip-btn ${globalLensMode === 'split' ? 'active' : ''}`}
              onClick={() => handleGlobalLensChange('split')}
              title="Tách ngang Mắt Trên (Trái) & Mắt Dưới (Phải)"
            >
              <Columns size={13} /> <span>Tách Ngang</span>
            </button>
            <button
              type="button"
              className={`vms-strip-btn ${globalLensMode === 'top' ? 'active' : ''}`}
              onClick={() => handleGlobalLensChange('top')}
              title="Chỉ xem Mắt 1 (Trên) cho tất cả camera"
            >
              <ArrowUpSquare size={13} /> <span>Mắt 1</span>
            </button>
            <button
              type="button"
              className={`vms-strip-btn ${globalLensMode === 'bottom' ? 'active' : ''}`}
              onClick={() => handleGlobalLensChange('bottom')}
              title="Chỉ xem Mắt 2 (Dưới) cho tất cả camera"
            >
              <ArrowDownSquare size={13} /> <span>Mắt 2</span>
            </button>
          </div>

          {/* Pagination & Auto-Patrol when cameras > layout capacity */}
          {totalPages > 1 && (
            <div className="vms-pagination-group">
              <button
                type="button"
                className="vms-strip-btn"
                onClick={() => setPage((p) => (p - 1 + totalPages) % totalPages)}
                title="Trang kênh trước"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="vms-page-indicator text-mono">
                {page + 1}/{totalPages}
              </span>
              <button
                type="button"
                className="vms-strip-btn"
                onClick={() => setPage((p) => (p + 1) % totalPages)}
                title="Trang kênh tiếp"
              >
                <ChevronRight size={14} />
              </button>
              <button
                type="button"
                className={`vms-strip-btn ${autoTour ? 'active-tour' : ''}`}
                onClick={() => setAutoTour((prev) => !prev)}
                title="Tự động tuần tra đảo trang sau mỗi 12 giây"
              >
                {autoTour ? <Pause size={13} /> : <Play size={13} />}
                <span>Tuần tra</span>
              </button>
            </div>
          )}

          <button
            type="button"
            className={`vms-strip-btn ${showEventDrawer ? 'active' : ''}`}
            onClick={() => setShowEventDrawer((prev) => !prev)}
            title="Đóng/Mở khay sự kiện cảnh báo trực tiếp"
          >
            <Bell size={14} />
            <span>Cảnh báo</span>
            {recentEvents.length > 0 && (
              <span className="vms-alert-count">{recentEvents.length}</span>
            )}
          </button>
        </div>
      </div>

      {/* Main Video Wall Area + Optional Right Live Event Feed Drawer */}
      <div className="vms-wall-body">
        <div className="vms-wall-stage">
          {cameras.length === 0 && !loading ? (
            <div className="dashboard-empty-state">
              <div className="empty-icon-pulse">
                <Camera size={44} className="text-muted" />
              </div>
              <h3>Hệ thống chưa kết nối kênh Camera nào</h3>
              <p>
                Bấm nút &ldquo;Thêm Kênh&rdquo; ở thanh điều khiển phía trên để kết nối luồng RTSP
                đầu tiên.
              </p>
              <button
                type="button"
                className="btn btn-primary mt-4"
                onClick={() => setShowAddModal(true)}
              >
                <Plus size={16} /> Thêm Kênh Camera
              </button>
            </div>
          ) : (
            <div className={`vms-matrix-grid layout-${layoutId}`}>
              {visibleCameras.map((camera, idx) => {
                const isAlerting = Boolean(alertMap[camera.id]);
                const effectiveLens = getEffectiveLensMode(camera.id);

                return (
                  <div
                    key={camera.id}
                    className={`vms-matrix-cell ${camera.record_enabled ? 'is-recording' : ''} ${
                      isAlerting ? 'is-alerting' : ''
                    }`}
                    onDoubleClick={() => navigate(`/camera/${camera.id}`)}
                    id={`camera-cell-${camera.id}`}
                  >
                    {/* Top-Left OSD Overlay Header (Channel Number, Name, REC status, AI status) */}
                    <div className="vms-cell-osd-top">
                      <span className="vms-ch-tag text-mono">
                        CH{String(page * currentLayout.capacity + idx + 1).padStart(2, '0')}
                      </span>
                      <span className="vms-cam-title truncate">{camera.name}</span>

                      {camera.record_enabled && (
                        <span className="vms-osd-badge rec">
                          <span className="dot-blink" /> REC
                        </span>
                      )}

                      {camera.detection_enabled && (
                        <span className="vms-osd-badge ai">AI</span>
                      )}

                      {isAlerting && (
                        <span className="vms-osd-badge alert">CẢNH BÁO!</span>
                      )}
                    </div>

                    {/* Top-Right Quick Operator Action Buttons (Record, AI, Open Workstation) */}
                    <div className="vms-cell-actions" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className={`vms-cell-action-btn ${
                          camera.record_enabled ? 'active-danger' : ''
                        }`}
                        onClick={(e) => handleToggleRecord(e, camera)}
                        title={camera.record_enabled ? 'Dừng ghi hình' : 'Bắt đầu ghi hình'}
                        disabled={actionLoading[camera.id]}
                      >
                        <Video size={13} />
                      </button>

                      <button
                        type="button"
                        className={`vms-cell-action-btn ${
                          camera.detection_enabled ? 'active-success' : ''
                        }`}
                        onClick={(e) => handleToggleDetection(e, camera)}
                        title={
                          camera.detection_enabled
                            ? 'Tắt giám sát phát hiện'
                            : 'Bật giám sát phát hiện'
                        }
                        disabled={actionLoading[camera.id]}
                      >
                        {camera.detection_enabled ? <Eye size={13} /> : <EyeOff size={13} />}
                      </button>

                      <button
                        type="button"
                        className="vms-cell-action-btn"
                        onClick={() => navigate(`/camera/${camera.id}`)}
                        title="Mở trạm điều khiển chi tiết & vẽ vùng quét AI"
                      >
                        <Maximize2 size={13} />
                      </button>
                    </div>

                    {/* Dual-Lens Smart Video Player */}
                    <VideoPlayer
                      cameraId={camera.id}
                      streamId={camera.stream_id}
                      streams={camera.streams}
                      cameraName={camera.name}
                      autoPlay
                      muted
                      compact={currentLayout.capacity >= 4}
                      lensMode={effectiveLens}
                      onLensModeChange={(nextMode) =>
                        setCellLensModes((prev) => ({ ...prev, [camera.id]: nextMode }))
                      }
                    />
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Collapsible Right Live Event Alert Drawer */}
        {showEventDrawer && (
          <aside className="vms-event-drawer">
            <div className="vms-drawer-header">
              <div className="flex items-center gap-2">
                <AlertTriangle size={15} style={{ color: 'var(--warning)' }} />
                <span className="font-bold text-sm">Sự Kiện Trực Tiếp</span>
              </div>
              <button
                type="button"
                className="vms-strip-btn"
                onClick={() => navigate('/events')}
              >
                Xem tất cả
              </button>
            </div>

            <div className="vms-drawer-list custom-scrollbar">
              {recentEvents.length === 0 ? (
                <div className="empty-state" style={{ padding: '40px 12px' }}>
                  <Activity size={28} />
                  <p className="text-xs">Chưa có cảnh báo mới</p>
                </div>
              ) : (
                recentEvents.map((evt) => (
                  <div
                    key={evt.id}
                    className="vms-drawer-item"
                    onClick={() => navigate(`/camera/${evt.camera_id}`)}
                  >
                    <div className="vms-drawer-thumb">
                      {evt.snapshot_path ? (
                        <img
                          src={getMediaUrl(`snapshots/${evt.snapshot_path}`)}
                          alt="event"
                          loading="lazy"
                        />
                      ) : (
                        <div className="video-placeholder">
                          <Volume2 size={16} style={{ color: 'var(--warning)' }} />
                        </div>
                      )}
                    </div>
                    <div className="vms-drawer-meta">
                      <div className="flex items-center justify-between">
                        <span className={`event-type ${evt.type}`}>
                          {evt.type === 'sound_alert' ? 'Âm thanh lạ' : 'Chuyển động'}
                        </span>
                        <span className="text-xs text-mono text-muted">
                          {evt.timestamp
                            ? new Date(
                                evt.timestamp.includes('Z')
                                  ? evt.timestamp
                                  : evt.timestamp.replace(' ', 'T') + 'Z'
                              ).toLocaleTimeString('vi-VN', { hour12: false })
                            : ''}
                        </span>
                      </div>
                      <div className="text-xs font-bold truncate mt-1">
                        {evt.camera_name || 'Camera'}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </aside>
        )}
      </div>

      {/* Add Camera Modal */}
      {showAddModal && (
        <AddCameraModal onClose={() => setShowAddModal(false)} onAdded={fetchCameras} />
      )}
    </div>
  );
}

function AddCameraModal({ onClose, onAdded }) {
  const [form, setForm] = useState({ name: '', rtsp_url: '', location: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.rtsp_url) {
      setError('Vui lòng điền tên và RTSP URL');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await addCamera(form);
      onAdded();
      onClose();
    } catch (err) {
      setError(err.response?.data?.error || 'Không thể thêm camera');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose} style={{ zIndex: 1000 }}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Thêm Kênh Camera Mới</h3>
          <button type="button" className="btn-icon" onClick={onClose}>
            <span>✕</span>
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && (
              <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: '0.85rem' }}>
                {error}
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Tên Camera *</label>
              <input
                className="form-input"
                placeholder="VD: Camera Sân Trước (2 Mắt)"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">RTSP URL *</label>
              <input
                className="form-input text-sm font-mono"
                placeholder="rtsp://admin:password@192.168.1.100:554/stream1"
                value={form.rtsp_url}
                onChange={(e) => setForm({ ...form, rtsp_url: e.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label">Vị trí lắp đặt</label>
              <input
                className="form-input"
                placeholder="VD: Cổng chính / Sân thượng"
                value={form.location}
                onChange={(e) => setForm({ ...form, location: e.target.value })}
              />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Hủy
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Đang kết nối...' : 'Thêm Camera'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
