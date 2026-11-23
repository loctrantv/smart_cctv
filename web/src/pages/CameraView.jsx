import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  getCamera,
  getCameras,
  updateCamera,
  startRecording,
  stopRecording,
  getEvents,
  getMediaUrl,
} from '../utils/api';
import VideoPlayer from '../components/VideoPlayer';
import {
  ArrowLeft,
  Video,
  VideoOff,
  Eye,
  EyeOff,
  Settings,
  PlayCircle,
  Columns,
  Rows,
  ArrowUpSquare,
  ArrowDownSquare,
  AlertTriangle,
  Check,
  Trash2,
  GitCommit,
  Square,
} from 'lucide-react';

export default function CameraView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [camera, setCamera] = useState(null);
  const [allCameras, setAllCameras] = useState([]);
  const [cameraEvents, setCameraEvents] = useState([]);
  const [loading, setLoading] = useState(true);

  const [lensMode, setLensMode] = useState('split');
  const [showZoneConfig, setShowZoneConfig] = useState(false);
  const [drawMode, setDrawMode] = useState('zone'); // 'zone' | 'tripwire'
  const [zones, setZones] = useState([]);
  const [tripwires, setTripwires] = useState([]);
  const [activeZone, setActiveZone] = useState(null);
  const [activeLine, setActiveLine] = useState(null);
  const [aspectRatio, setAspectRatio] = useState(8 / 9);

  const stageRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState(null);

  const fetchCameraData = useCallback(async () => {
    try {
      const [data, list, evts] = await Promise.all([
        getCamera(id),
        getCameras(),
        getEvents({ camera_id: id, limit: 12 }),
      ]);
      setCamera(data);
      setAllCameras(list || []);
      setCameraEvents(evts?.events || []);

      if (data.detection_zone) {
        if (data.detection_zone.startsWith('[')) {
          try {
            setZones(JSON.parse(data.detection_zone));
          } catch {
            setZones([]);
          }
        } else {
          const parts = data.detection_zone.split(',').map(Number);
          if (parts.length === 4) {
            setZones([{ x: parts[0], y: parts[1], w: parts[2], h: parts[3], loitering_seconds: 0 }]);
          } else {
            setZones([]);
          }
        }
      } else {
        setZones([]);
      }

      if (data.tripwire_config && data.tripwire_config.startsWith('[')) {
        try {
          setTripwires(JSON.parse(data.tripwire_config));
        } catch {
          setTripwires([]);
        }
      } else {
        setTripwires([]);
      }
    } catch {
      navigate('/');
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => {
    fetchCameraData();
  }, [fetchCameraData]);

  const getCoordinates = (e, rect) => {
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height)),
    };
  };

  const handleStart = (e) => {
    if (!showZoneConfig || !stageRef.current) return;
    const rect = stageRef.current.getBoundingClientRect();
    const pos = getCoordinates(e, rect);
    setIsDrawing(true);
    setStartPos(pos);

    if (drawMode === 'zone') {
      setActiveZone({ x: pos.x, y: pos.y, w: 0.01, h: 0.01, loitering_seconds: 0 });
    } else {
      setActiveLine({
        id: `tw_${Date.now()}`,
        name: `Rào ảo #${tripwires.length + 1}`,
        x1: pos.x,
        y1: pos.y,
        x2: pos.x,
        y2: pos.y,
        direction: 'both',
      });
    }
  };

  const handleMove = (e) => {
    if (!isDrawing || !startPos || !stageRef.current) return;
    if (e.cancelable) e.preventDefault();

    const rect = stageRef.current.getBoundingClientRect();
    const pos = getCoordinates(e, rect);

    if (drawMode === 'zone') {
      const x = Math.min(startPos.x, pos.x);
      const y = Math.min(startPos.y, pos.y);
      const w = Math.max(0.01, Math.abs(startPos.x - pos.x));
      const h = Math.max(0.01, Math.abs(startPos.y - pos.y));
      setActiveZone({ x, y, w, h, loitering_seconds: 0 });
    } else if (activeLine) {
      setActiveLine({ ...activeLine, x2: pos.x, y2: pos.y });
    }
  };

  const handleEnd = () => {
    if (isDrawing) {
      if (drawMode === 'zone' && activeZone && activeZone.w > 0.02 && activeZone.h > 0.02) {
        setZones((prev) => [...prev, activeZone]);
      } else if (drawMode === 'tripwire' && activeLine) {
        const dist = Math.hypot(activeLine.x2 - activeLine.x1, activeLine.y2 - activeLine.y1);
        if (dist > 0.03) {
          setTripwires((prev) => [...prev, activeLine]);
        }
      }
    }
    setIsDrawing(false);
    setStartPos(null);
    setActiveZone(null);
    setActiveLine(null);
  };

  const handleSaveZoneAndTripwires = async () => {
    try {
      await updateCamera(camera.id, {
        detection_zone: JSON.stringify(zones),
        tripwire_config: JSON.stringify(tripwires),
      });
      setShowZoneConfig(false);
      const updated = await getCamera(id);
      setCamera(updated);
    } catch (err) {
      alert('Không thể lưu cấu hình AI: ' + (err.response?.data?.error || err.message));
    }
  };

  const addPresetLensZone = (whichLens) => {
    if (whichLens === 'top') {
      setZones((prev) => [
        ...prev,
        { x: 0.02, y: 0.02, w: 0.96, h: 0.46, loitering_seconds: 0 },
      ]);
    } else if (whichLens === 'bottom') {
      setZones((prev) => [
        ...prev,
        { x: 0.02, y: 0.52, w: 0.96, h: 0.46, loitering_seconds: 0 },
      ]);
    }
  };

  const toggleRecording = async () => {
    if (camera.record_enabled) {
      await stopRecording(camera.id);
    } else {
      await startRecording(camera.id);
    }
    const updated = await getCamera(id);
    setCamera(updated);
  };

  const toggleDetection = async () => {
    await updateCamera(camera.id, { detection_enabled: camera.detection_enabled ? 0 : 1 });
    const updated = await getCamera(id);
    setCamera(updated);
  };

  if (loading || !camera) {
    return (
      <div className="empty-state">
        <p>Đang tải trạm điều khiển camera...</p>
      </div>
    );
  }

  return (
    <div className="vms-workstation">
      {/* Top Workstation Toolbar */}
      <div className="vms-control-strip">
        <div className="vms-strip-left">
          <button
            type="button"
            className="vms-strip-btn"
            onClick={() => navigate('/')}
            title="Quay lại bảng Live Matrix"
          >
            <ArrowLeft size={15} />
            <span>Matrix</span>
          </button>

          <div className="vms-divider" />

          <div className="flex items-center gap-2">
            <span className={`status-pulse-dot ${camera.enabled ? 'online' : 'offline'}`} />
            <strong className="text-sm">{camera.name}</strong>
            {camera.location && (
              <span className="text-xs text-muted">({camera.location})</span>
            )}
          </div>

          {allCameras.length > 1 && (
            <select
              className="vms-channel-select"
              value={camera.id}
              onChange={(e) => navigate(`/camera/${e.target.value}`)}
            >
              {allCameras.map((c) => (
                <option key={c.id} value={c.id}>
                  Chuyển kênh: {c.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* Dual-Lens View Selector & Action Buttons */}
        <div className="vms-strip-right">
          {!showZoneConfig && (
            <div className="vms-btn-group">
              <button
                type="button"
                className={`vms-strip-btn ${lensMode === 'split' ? 'active' : ''}`}
                onClick={() => setLensMode('split')}
              >
                <Columns size={13} /> <span>Tách Ngang 2 Mắt</span>
              </button>
              <button
                type="button"
                className={`vms-strip-btn ${lensMode === 'stacked' ? 'active' : ''}`}
                onClick={() => setLensMode('stacked')}
              >
                <Rows size={13} /> <span>Kép Dọc (8:9)</span>
              </button>
              <button
                type="button"
                className={`vms-strip-btn ${lensMode === 'top' ? 'active' : ''}`}
                onClick={() => setLensMode('top')}
              >
                <ArrowUpSquare size={13} /> <span>Mắt 1 (Trên)</span>
              </button>
              <button
                type="button"
                className={`vms-strip-btn ${lensMode === 'bottom' ? 'active' : ''}`}
                onClick={() => setLensMode('bottom')}
              >
                <ArrowDownSquare size={13} /> <span>Mắt 2 (Dưới)</span>
              </button>
            </div>
          )}

          <button
            type="button"
            className={`btn btn-sm ${camera.record_enabled ? 'btn-danger' : 'btn-secondary'}`}
            onClick={toggleRecording}
            id="toggle-recording"
          >
            {camera.record_enabled ? (
              <>
                <VideoOff size={14} /> Dừng ghi
              </>
            ) : (
              <>
                <Video size={14} /> Ghi hình
              </>
            )}
          </button>

          <button
            type="button"
            className={`btn btn-sm ${camera.detection_enabled ? 'btn-primary' : 'btn-secondary'}`}
            onClick={toggleDetection}
            id="toggle-detection"
          >
            {camera.detection_enabled ? (
              <>
                <EyeOff size={14} /> Tắt AI
              </>
            ) : (
              <>
                <Eye size={14} /> Bật AI
              </>
            )}
          </button>

          <button
            type="button"
            className={`btn btn-sm ${showZoneConfig ? 'btn-danger' : 'btn-secondary'}`}
            onClick={() => setShowZoneConfig(!showZoneConfig)}
            id="toggle-zone-config"
          >
            <Settings size={14} />{' '}
            {showZoneConfig ? 'Đóng Vẽ Vùng / Rào Ảo' : 'Vùng Cấm & Hàng Rào Ảo'}
          </button>

          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => navigate('/playback')}
          >
            <PlayCircle size={14} /> Xem lại
          </button>
        </div>
      </div>

      {/* Two-Column Workstation Content */}
      <div className="vms-workstation-body">
        <div className="vms-workstation-stage">
          <div
            ref={stageRef}
            className={`vms-stage-frame ${
              showZoneConfig ? 'zone-drawing-locked' : `mode-${lensMode}`
            }`}
            style={
              showZoneConfig || lensMode === 'stacked'
                ? { aspectRatio: `${aspectRatio}` }
                : undefined
            }
          >
            <VideoPlayer
              streamId={camera.stream_id}
              streams={camera.streams}
              cameraName={camera.name}
              autoPlay
              muted={false}
              lensMode={lensMode}
              onLensModeChange={setLensMode}
              lockStacked={showZoneConfig}
              onAspectRatioChange={setAspectRatio}
            />

            {/* Interactive Zone & Virtual Tripwire Drawing Overlay */}
            {showZoneConfig && (
              <>
                <div className="vms-zone-lens-boundary">
                  <span className="lens-guide-top">▲ MẮT 1 (KHUNG TRÊN: 0% – 50%)</span>
                  <span className="lens-guide-bottom">▼ MẮT 2 (KHUNG DƯỚI: 50% – 100%)</span>
                </div>

                <div
                  className="vms-zone-draw-surface"
                  onMouseDown={handleStart}
                  onMouseMove={handleMove}
                  onMouseUp={handleEnd}
                  onMouseLeave={handleEnd}
                  onTouchStart={handleStart}
                  onTouchMove={handleMove}
                  onTouchEnd={handleEnd}
                />

                {/* SVG Overlay for Virtual Tripwire Lines (ByteTrack Line Crossing) */}
                <svg
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    zIndex: 17,
                    pointerEvents: 'none',
                  }}
                >
                  {tripwires.map((tw) => (
                    <g key={tw.id}>
                      <line
                        x1={`${tw.x1 * 100}%`}
                        y1={`${tw.y1 * 100}%`}
                        x2={`${tw.x2 * 100}%`}
                        y2={`${tw.y2 * 100}%`}
                        stroke="#00ff88"
                        strokeWidth="3"
                        strokeDasharray="6 4"
                      />
                      <circle cx={`${tw.x1 * 100}%`} cy={`${tw.y1 * 100}%`} r="5" fill="#00d4ff" />
                      <circle cx={`${tw.x2 * 100}%`} cy={`${tw.y2 * 100}%`} r="5" fill="#ff3b30" />
                    </g>
                  ))}
                  {isDrawing && activeLine && (
                    <line
                      x1={`${activeLine.x1 * 100}%`}
                      y1={`${activeLine.y1 * 100}%`}
                      x2={`${activeLine.x2 * 100}%`}
                      y2={`${activeLine.y2 * 100}%`}
                      stroke="#00d4ff"
                      strokeWidth="3"
                    />
                  )}
                </svg>

                {zones.map((z, idx) => (
                  <div
                    key={idx}
                    className="vms-zone-box"
                    style={{
                      left: `${z.x * 100}%`,
                      top: `${z.y * 100}%`,
                      width: `${z.w * 100}%`,
                      height: `${z.h * 100}%`,
                    }}
                  >
                    <button
                      type="button"
                      className="vms-zone-remove-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setZones((prev) => prev.filter((_, i) => i !== idx));
                      }}
                    >
                      ✕
                    </button>
                    <span className="vms-zone-label">
                      Vùng #{idx + 1} ({z.y + z.h / 2 < 0.5 ? 'Mắt 1' : 'Mắt 2'})
                      {z.loitering_seconds > 0 ? ` · Lảng vảng ${z.loitering_seconds}s` : ''}
                    </span>
                  </div>
                ))}

                {isDrawing && activeZone && (
                  <div
                    className="vms-zone-box drawing"
                    style={{
                      left: `${activeZone.x * 100}%`,
                      top: `${activeZone.y * 100}%`,
                      width: `${activeZone.w * 100}%`,
                      height: `${activeZone.h * 100}%`,
                    }}
                  />
                )}
              </>
            )}
          </div>
        </div>

        {/* Right Side Inspector Panel */}
        <aside className="vms-workstation-sidebar custom-scrollbar">
          {showZoneConfig ? (
            <div className="card mb-3" style={{ borderColor: 'var(--accent)' }}>
              <div className="card-header">
                <span className="font-bold text-sm" style={{ color: 'var(--accent)' }}>
                  Cấu Hình Vùng Cấm & Hàng Rào Ảo AI
                </span>
              </div>
              <div className="card-body" style={{ padding: 14 }}>
                {/* Tool Selector: Zone vs Tripwire */}
                <div className="vms-btn-group w-full mb-3">
                  <button
                    type="button"
                    className={`vms-strip-btn flex-1 ${drawMode === 'zone' ? 'active' : ''}`}
                    onClick={() => setDrawMode('zone')}
                  >
                    <Square size={13} /> <span>Vẽ Vùng Quét / Lảng Vảng</span>
                  </button>
                  <button
                    type="button"
                    className={`vms-strip-btn flex-1 ${drawMode === 'tripwire' ? 'active' : ''}`}
                    onClick={() => setDrawMode('tripwire')}
                  >
                    <GitCommit size={13} /> <span>Vẽ Hàng Rào Ảo (Line)</span>
                  </button>
                </div>

                {drawMode === 'zone' ? (
                  <>
                    <p className="text-xs text-muted mb-3">
                      Kéo chuột trên Mắt 1 hoặc Mắt 2 để khoanh vùng quét. Có thể đặt thời gian{' '}
                      <strong>Lảng vảng (giây)</strong>: nếu đối tượng đứng trong vùng quá số giây
                      này sẽ báo động Xâm nhập.
                    </p>
                    <div className="flex gap-2 mb-3">
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm flex-1"
                        onClick={() => addPresetLensZone('top')}
                      >
                        + Chọn trọn Mắt 1
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm flex-1"
                        onClick={() => addPresetLensZone('bottom')}
                      >
                        + Chọn trọn Mắt 2
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="text-xs text-muted mb-3">
                    Kéo chuột để kẻ một vạch <strong>Hàng rào ảo (Điểm A xanh → Điểm B đỏ)</strong>.
                    Thuật toán ByteTrack sẽ báo động khi Người hoặc Xe vượt qua vạch này.
                  </p>
                )}

                {/* Zones List with Loitering Timer Input */}
                <div className="text-xs font-bold mb-2 flex justify-between">
                  <span>Vùng quét & Xâm nhập ({zones.length})</span>
                  {zones.length > 0 && (
                    <button
                      type="button"
                      className="text-xs"
                      style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer' }}
                      onClick={() => setZones([])}
                    >
                      Xóa hết vùng
                    </button>
                  )}
                </div>
                <div className="flex flex-col gap-2 mb-3">
                  {zones.map((z, idx) => (
                    <div
                      key={idx}
                      className="flex items-center justify-between gap-2 p-2"
                      style={{
                        background: 'var(--bg-input)',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                      }}
                    >
                      <span className="text-xs font-bold">
                        Vùng #{idx + 1} ({z.y + z.h / 2 < 0.5 ? 'Mắt 1' : 'Mắt 2'})
                      </span>
                      <div className="flex items-center gap-1">
                        <span className="text-xs text-muted">Lảng vảng (s):</span>
                        <input
                          type="number"
                          min="0"
                          max="600"
                          className="form-input"
                          style={{ width: 58, padding: '2px 6px', fontSize: '0.75rem' }}
                          value={z.loitering_seconds || 0}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10) || 0;
                            setZones((prev) =>
                              prev.map((item, i) =>
                                i === idx ? { ...item, loitering_seconds: val } : item
                              )
                            );
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>

                {/* Tripwire Lines List with Direction Selector */}
                <div className="text-xs font-bold mb-2 flex justify-between">
                  <span>Hàng rào ảo ByteTrack ({tripwires.length})</span>
                  {tripwires.length > 0 && (
                    <button
                      type="button"
                      className="text-xs"
                      style={{ color: 'var(--danger)', background: 'none', border: 'none', cursor: 'pointer' }}
                      onClick={() => setTripwires([])}
                    >
                      Xóa hết rào
                    </button>
                  )}
                </div>
                <div className="flex flex-col gap-2">
                  {tripwires.map((tw, idx) => (
                    <div
                      key={tw.id}
                      className="flex items-center justify-between gap-2 p-2"
                      style={{
                        background: 'var(--bg-input)',
                        borderRadius: 6,
                        border: '1px solid var(--border)',
                      }}
                    >
                      <span className="text-xs font-bold" style={{ color: 'var(--success)' }}>
                        {tw.name}
                      </span>
                      <select
                        className="filter-select"
                        style={{ minWidth: 95, padding: '2px 6px', fontSize: '0.72rem' }}
                        value={tw.direction}
                        onChange={(e) => {
                          const dir = e.target.value;
                          setTripwires((prev) =>
                            prev.map((item, i) => (i === idx ? { ...item, direction: dir } : item))
                          );
                        }}
                      >
                        <option value="both">Cả 2 chiều</option>
                        <option value="a_to_b">Chiều A → B</option>
                        <option value="b_to_a">Chiều B → A</option>
                      </select>
                      <button
                        type="button"
                        className="btn-icon"
                        style={{ width: 22, height: 22, color: 'var(--danger)' }}
                        onClick={() =>
                          setTripwires((prev) => prev.filter((_, i) => i !== idx))
                        }
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="mt-4 flex justify-end gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => setShowZoneConfig(false)}
                  >
                    Hủy
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={handleSaveZoneAndTripwires}
                    id="save-zone-btn"
                  >
                    <Check size={14} /> Lưu cấu hình AI
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {/* Technical Channel Details Card */}
          <div className="card mb-3">
            <div className="card-header">
              <span className="font-bold text-sm">Thông Số Kênh & AI</span>
            </div>
            <div className="card-body" style={{ padding: 14 }}>
              <div className="vms-kv-list">
                <div className="vms-kv-row">
                  <span className="text-xs text-muted">Mã luồng</span>
                  <span className="text-xs text-mono">{camera.stream_id}</span>
                </div>
                <div className="vms-kv-row">
                  <span className="text-xs text-muted">Cấu trúc khung</span>
                  <span className="text-xs text-mono">Dual-Lens (2×16:9 / 8:9)</span>
                </div>
                <div className="vms-kv-row">
                  <span className="text-xs text-muted">Vùng cấm / Hàng rào ảo</span>
                  <span className="text-xs font-bold">
                    {zones.length} vùng · {tripwires.length} rào ảo
                  </span>
                </div>
                <div className="vms-kv-row">
                  <span className="text-xs text-muted">Sự kiện 24h</span>
                  <span className="text-xs font-bold">{camera.events_today || 0}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Recent Events of This Camera */}
          <div className="card">
            <div className="card-header">
              <span className="font-bold text-sm flex items-center gap-2">
                <AlertTriangle size={14} style={{ color: 'var(--warning)' }} />
                Sự Kiện Gần Đây Của Kênh
              </span>
            </div>
            <div className="card-body" style={{ padding: 10 }}>
              {cameraEvents.length === 0 ? (
                <p className="text-xs text-muted text-center p-4">
                  Chưa có sự kiện nào trên kênh này
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  {cameraEvents.map((evt) => (
                    <div key={evt.id} className="vms-drawer-item">
                      <div className="vms-drawer-thumb">
                        {evt.snapshot_path ? (
                          <img
                            src={getMediaUrl(`snapshots/${evt.snapshot_path}`)}
                            alt="snapshot"
                            loading="lazy"
                          />
                        ) : (
                          <div className="video-placeholder">
                            <AlertTriangle size={14} />
                          </div>
                        )}
                      </div>
                      <div className="vms-drawer-meta">
                        <span className={`event-type ${evt.type}`}>{evt.type}</span>
                        <div className="text-xs font-bold truncate mt-0.5">{evt.label}</div>
                        <div className="text-xs text-mono text-muted">
                          {evt.timestamp
                            ? new Date(
                                evt.timestamp.includes('Z')
                                  ? evt.timestamp
                                  : evt.timestamp.replace(' ', 'T') + 'Z'
                              ).toLocaleString('vi-VN', { hour12: false })
                            : ''}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
