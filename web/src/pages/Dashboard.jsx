import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { getCameras, addCamera, startRecording, stopRecording } from '../utils/api';
import { useApp } from '../App';
import {
  Camera, Plus, Grid3X3, Grid2X2, Square,
  Video, VideoOff, Eye, AlertTriangle, HardDrive
} from 'lucide-react';
import VideoPlayer from '../components/VideoPlayer';

export default function Dashboard() {
  const [cameras, setCameras] = useState([]);
  const [gridSize, setGridSize] = useState(4);
  const [showAddModal, setShowAddModal] = useState(false);
  const [loading, setLoading] = useState(true);
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
    if (!ws) return;
    const unsub1 = ws.on('camera_added', fetchCameras);
    const unsub2 = ws.on('camera_updated', fetchCameras);
    const unsub3 = ws.on('camera_removed', fetchCameras);
    return () => { unsub1(); unsub2(); unsub3(); };
  }, [ws, fetchCameras]);

  const gridClass = `camera-grid grid-${gridSize}`;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Stats Row */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-icon cyan"><Camera size={20} /></div>
          <div>
            <div className="stat-value">{cameras.length}</div>
            <div className="stat-label">Camera</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon green"><Video size={20} /></div>
          <div>
            <div className="stat-value">{cameras.filter(c => c.record_enabled).length}</div>
            <div className="stat-label">Đang ghi</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon red"><AlertTriangle size={20} /></div>
          <div>
            <div className="stat-value">{cameras.reduce((s, c) => s + (c.events_today || 0), 0)}</div>
            <div className="stat-label">Sự kiện hôm nay</div>
          </div>
        </div>
        <div className="stat-card">
          <div className="stat-icon cyan"><Eye size={20} /></div>
          <div>
            <div className="stat-value">{cameras.filter(c => c.detection_enabled).length}</div>
            <div className="stat-label">Đang giám sát</div>
          </div>
        </div>
      </div>

      {/* Toolbar */}
      <div className="toolbar">
        <div className="toolbar-group">
          <button className="btn btn-primary" onClick={() => setShowAddModal(true)} id="add-camera-btn">
            <Plus size={16} /> Thêm Camera
          </button>
        </div>
        <div className="toolbar-group">
          {[1, 4, 9, 16].map(size => (
            <button
              key={size}
              className={`btn-icon ${gridSize === size ? 'active' : ''}`}
              style={gridSize === size ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
              onClick={() => setGridSize(size)}
              title={`${size} camera`}
            >
              {size === 1 && <Square size={16} />}
              {size === 4 && <Grid2X2 size={16} />}
              {size === 9 && <Grid3X3 size={16} />}
              {size === 16 && <Grid3X3 size={16} />}
            </button>
          ))}
        </div>
      </div>

      {/* Camera Grid */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {cameras.length === 0 && !loading ? (
          <div className="empty-state">
            <Camera size={48} />
            <p>Chưa có camera nào. Bấm "Thêm Camera" để bắt đầu.</p>
          </div>
        ) : (
          <div className={gridClass} style={{ height: '100%' }}>
            {cameras.slice(0, gridSize).map(camera => (
              <div
                key={camera.id}
                className="camera-cell"
                onClick={() => navigate(`/camera/${camera.id}`)}
                id={`camera-cell-${camera.id}`}
                /* Ép ô chứa cho phép co giãn theo luồng video */
                style={{ overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' }}
              >
                {/* Thêm thuộc tính style hoặc class để ép fit cho video bên dưới */}
                <div className="video-wrapper-fix" style={{ width: '100%', height: '100%', display: 'flex' }}>
                  <VideoPlayer
                    streamId={camera.stream_id}
                    streams={camera.streams}
                    autoPlay
                    muted
                    compact
                  />
                </div>
      
                <div className="camera-badge">
                  {camera.record_enabled ? (
                    <span className="badge badge-rec">● REC</span>
                  ) : null}
                  {camera.enabled ? (
                    <span className="badge badge-live">LIVE</span>
                  ) : null}
                </div>
                <div className="camera-overlay">
                  <span className="camera-name">{camera.name}</span>
                  <div className="camera-status">
                    <div className={`status-dot ${camera.enabled ? '' : 'offline'} ${camera.record_enabled ? 'recording' : ''}`} />
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
    <div className="modal-overlay" onClick={onClose}>
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
              <input className="form-input" placeholder="rtsp://admin:password@192.168.1.100:554/stream1"
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
