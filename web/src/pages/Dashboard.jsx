import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getCameras, addCamera, startRecording, stopRecording, updateCamera } from '../utils/api';
import { useApp } from '../App';
import {
  Camera, Plus, Grid3X3, Grid2X2, Square, Columns,
  Video, VideoOff, Eye, EyeOff, AlertTriangle, Maximize2,
  Bell, BellOff, Shield, ShieldOff, MoreHorizontal
} from 'lucide-react';
import VideoPlayer from '../components/VideoPlayer';

export default function Dashboard() {
  const [cameras, setCameras] = useState([]);
  const [gridSize, setGridSize] = useState(4);
  const [initialGridSet, setInitialGridSet] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState({});
  const [cameraAspects, setCameraAspects] = useState({});
  const { ws } = useApp();
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

  useEffect(() => {
    fetchCameras();
  }, [fetchCameras]);

  useEffect(() => {
    if (!loading && !initialGridSet) {
      const count = cameras.length;
      let size = 1;
      if (count > 1) size = 2;
      if (count > 2) size = 4;
      if (count > 4) size = 9;
      setGridSize(size);
      setInitialGridSet(true);
    }
  }, [loading, cameras.length, initialGridSet]);

  useEffect(() => {
    if (!ws) return;
    const unsub1 = ws.on('camera_added', fetchCameras);
    const unsub2 = ws.on('camera_updated', fetchCameras);
    const unsub3 = ws.on('camera_removed', fetchCameras);
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [ws, fetchCameras]);

  const handleToggleRecord = async (e, camera) => {
    e.stopPropagation();
    const cid = camera.id;
    if (actionLoading[cid]) return;

    setActionLoading(prev => ({ ...prev, [cid]: true }));
    try {
      if (camera.record_enabled) {
        await stopRecording(cid);
      } else {
        await startRecording(cid);
      }
      await fetchCameras();
    } catch (err) {
      console.error('Lỗi bật/tắt ghi hình:', err);
    } finally {
      setActionLoading(prev => ({ ...prev, [cid]: false }));
    }
  };

  const handleToggleDetection = async (e, camera) => {
    e.stopPropagation();
    const cid = camera.id;
    if (actionLoading[cid]) return;

    setActionLoading(prev => ({ ...prev, [cid]: true }));
    try {
      await updateCamera(cid, {
        detection_enabled: !camera.detection_enabled
      });
      await fetchCameras();
    } catch (err) {
      console.error('Lỗi bật/tắt phát hiện chuyển động:', err);
    } finally {
      setActionLoading(prev => ({ ...prev, [cid]: false }));
    }
  };

  const gridClass = `camera-grid grid-${gridSize}`;

  return (
    <div className="dashboard-container" style={{ height: '100%', display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Stats Row */}
      <div className="dashboard-stats-row" style={{ flexShrink: 0 }}>
        <div className="dashboard-stat-card">
          <div className="dashboard-stat-icon-wrapper cyan-glow">
            <Camera className="dashboard-stat-icon" size={20} />
          </div>
          <div className="dashboard-stat-text">
            <span className="dashboard-stat-value">{cameras.length}</span>
            <span className="dashboard-stat-label">Tổng Camera</span>
          </div>
        </div>
        
        <div className="dashboard-stat-card">
          <div className={`dashboard-stat-icon-wrapper red-glow ${cameras.some(c => c.record_enabled) ? 'animate-recording-glow' : ''}`}>
            <Video className="dashboard-stat-icon" size={20} />
          </div>
          <div className="dashboard-stat-text">
            <span className="dashboard-stat-value">{cameras.filter(c => c.record_enabled).length}</span>
            <span className="dashboard-stat-label">Đang ghi hình</span>
          </div>
        </div>

        <div className="dashboard-stat-card">
          <div className="dashboard-stat-icon-wrapper orange-glow">
            <AlertTriangle className="dashboard-stat-icon" size={20} />
          </div>
          <div className="dashboard-stat-text">
            <span className="dashboard-stat-value">{cameras.reduce((s, c) => s + (c.events_today || 0), 0)}</span>
            <span className="dashboard-stat-label">Sự kiện hôm nay</span>
          </div>
        </div>

        <div className="dashboard-stat-card">
          <div className="dashboard-stat-icon-wrapper green-glow">
            <Eye className="dashboard-stat-icon" size={20} />
          </div>
          <div className="dashboard-stat-text">
            <span className="dashboard-stat-value">{cameras.filter(c => c.detection_enabled).length}</span>
            <span className="dashboard-stat-label">Đang giám sát</span>
          </div>
        </div>
      </div>

      {/* Modern Responsive Toolbar */}
      <div className="dashboard-toolbar-wrapper" style={{ flexShrink: 0 }}>
        <div className="dashboard-toolbar-left">
          <button className="btn btn-primary shadow-md hover:shadow-lg transition-all" onClick={() => setShowAddModal(true)} id="add-camera-btn">
            <Plus size={16} />
          </button>
        </div>
        <div className="dashboard-toolbar-right">
          <span className="toolbar-label hidden md:inline">Chế độ xem lưới:</span>
          <div className="grid-toggle-group">
            {[1, 2, 4, 9].map(size => (
              <button
                key={size}
                className={`grid-toggle-btn ${gridSize === size ? 'active' : ''}`}
                onClick={() => setGridSize(size)}
                title={`Lưới ${size} ô`}
              >
                {size === 1 && <Square size={15} />}
                {size === 2 && <Columns size={15} />}
                {size === 4 && <Grid2X2 size={15} />}
                {size === 9 && <Grid3X3 size={15} />}
                <span className="grid-toggle-text">{size}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Camera Grid Section */}
      <div className="dashboard-grid-content">
        {cameras.length === 0 && !loading ? (
          <div className="dashboard-empty-state">
            <div className="empty-icon-pulse">
              <Camera size={44} className="text-muted" />
            </div>
            <h3>Hệ thống chưa kết nối camera</h3>
            <p>Vui lòng bấm nút "Thêm Camera" ở phía trên để cấu hình luồng RTSP đầu tiên.</p>
            <button className="btn btn-primary mt-4" onClick={() => setShowAddModal(true)}>
              <Plus size={16} /> Thiết lập ngay
            </button>
          </div>
        ) : (
          <div className={gridClass}>
            {cameras.slice(0, gridSize).map(camera => (
              <div
                key={camera.id}
                className={`dashboard-camera-cell ${camera.record_enabled ? 'is-recording' : ''}`}
                onClick={() => navigate(`/camera/${camera.id}`)}
                id={`camera-cell-${camera.id}`}
                style={{ 
                  aspectRatio: cameraAspects[camera.id] ? `${cameraAspects[camera.id]}` : undefined 
                }}
              >
                {/* Video Player */}
                <div className="dashboard-video-container">
                  <VideoPlayer
                    streamId={camera.stream_id}
                    streams={camera.streams}
                    autoPlay
                    muted
                    compact
                    onAspectRatioChange={(ratio) => setCameraAspects(prev => ({ ...prev, [camera.id]: ratio }))}
                  />
                  
                  {/* Status Indicator Badges */}
                  <div className="dashboard-cell-badges">
                    {camera.record_enabled && (
                      <span className="badge-pill badge-pill-danger recording">
                        <span className="dot-blink" /> REC
                      </span>
                    )}
                  </div>

                  {camera.enabled ? (
                    <span className="badge-pill badge-pill-success live-badge-bottom-right">LIVE</span>
                  ) : (
                    <span className="badge-pill badge-pill-muted live-badge-bottom-right">OFFLINE</span>
                  )}

                  {/* Micro Quick Controls Overlaid on Video Hover */}
                  <div className="dashboard-cell-quick-actions">
                    <button
                      className={`quick-action-btn ${camera.record_enabled ? 'active danger' : ''}`}
                      onClick={(e) => handleToggleRecord(e, camera)}
                      title={camera.record_enabled ? "Dừng ghi hình" : "Bắt đầu ghi hình"}
                      disabled={actionLoading[camera.id]}
                    >
                      <Video size={14} className={camera.record_enabled ? "animate-pulse" : ""} />
                    </button>
                    
                    <button
                      className={`quick-action-btn ${camera.detection_enabled ? 'active success' : ''}`}
                      onClick={(e) => handleToggleDetection(e, camera)}
                      title={camera.detection_enabled ? "Tắt giám sát" : "Bật giám sát phát hiện"}
                      disabled={actionLoading[camera.id]}
                    >
                      {camera.detection_enabled ? <Eye size={14} /> : <EyeOff size={14} />}
                    </button>

                    <button
                      className="quick-action-btn hover-primary"
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/camera/${camera.id}`);
                      }}
                      title="Xem chi tiết camera"
                    >
                      <Maximize2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Camera Overlay Footer */}
                <div className="dashboard-cell-footer">
                  <div className="camera-info">
                    <span className="camera-name">{camera.name}</span>
                    <span className="camera-location text-xs text-muted truncate">
                      {camera.location || 'Chưa định vị trí'}
                    </span>
                  </div>
                  <div className="camera-status-indicator">
                    <span className={`status-pulse-dot ${camera.enabled ? 'online' : 'offline'}`} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Add Camera Modal */}
      {showAddModal && (
        <AddCameraModal
          onClose={() => setShowAddModal(false)}
          onAdded={fetchCameras}
        />
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
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Thêm Camera Mới</h3>
          <button className="btn-icon" onClick={onClose}><span>✕</span></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {error && <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: '0.85rem' }}>{error}</div>}
            <div className="form-group">
              <label className="form-label">Tên Camera *</label>
              <input className="form-input" placeholder="VD: Camera Sân Trước"
                value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">RTSP URL *</label>
              <input className="form-input text-sm font-mono" placeholder="rtsp://admin:password@192.168.1.100:554/stream1"
                value={form.rtsp_url} onChange={e => setForm({ ...form, rtsp_url: e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Vị trí</label>
              <input className="form-input" placeholder="VD: Tầng 1, Cổng chính"
                value={form.location} onChange={e => setForm({ ...form, location: e.target.value })} />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Hủy</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Đang thêm...' : 'Thêm Camera'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

