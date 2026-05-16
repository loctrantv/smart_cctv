import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { getCamera, updateCamera, startRecording, stopRecording, deleteCamera } from '../utils/api';
import VideoPlayer from '../components/VideoPlayer';
import {
  ArrowLeft, Video, VideoOff, Eye, EyeOff,
  Camera, Trash2, Settings, Download
} from 'lucide-react';

export default function CameraView() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [camera, setCamera] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetch() {
      try {
        const data = await getCamera(id);
        setCamera(data);
      } catch {
        navigate('/');
      } finally {
        setLoading(false);
      }
    }
    fetch();
  }, [id, navigate]);

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

  const handleDelete = async () => {
    if (!confirm('Xóa camera này? Tất cả recordings và events sẽ bị xóa.')) return;
    await deleteCamera(camera.id);
    navigate('/');
  };

  if (loading || !camera) {
    return <div className="empty-state"><p>Đang tải...</p></div>;
  }

  return (
    <div>
      {/* Back + Title */}
      <div className="toolbar">
        <div className="toolbar-group">
          <button className="btn btn-secondary" onClick={() => navigate('/')}>
            <ArrowLeft size={16} /> Quay lại
          </button>
          <h2 style={{ fontSize: '1.1rem', fontWeight: 600 }}>{camera.name}</h2>
          {camera.location && <span className="text-muted text-sm">({camera.location})</span>}
        </div>
        <div className="toolbar-group">
          <button className="btn btn-danger btn-sm" onClick={handleDelete} id="delete-camera">
            <Trash2 size={14} /> Xóa
          </button>
        </div>
      </div>

      {/* Video */}
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <VideoPlayer
          streamId={camera.stream_id}
          streams={camera.streams}
          autoPlay
          muted={false}
        />
      </div>

      {/* Controls */}
      <div style={{ maxWidth: 960, margin: '16px auto' }}>
        <div className="card">
          <div className="card-body">
            <div className="flex gap-3" style={{ flexWrap: 'wrap' }}>
              <button
                className={`btn ${camera.record_enabled ? 'btn-danger' : 'btn-secondary'}`}
                onClick={toggleRecording}
                id="toggle-recording"
              >
                {camera.record_enabled ? <><VideoOff size={16} /> Dừng ghi</> : <><Video size={16} /> Bắt đầu ghi</>}
              </button>

              <button
                className={`btn ${camera.detection_enabled ? 'btn-primary' : 'btn-secondary'}`}
                onClick={toggleDetection}
                id="toggle-detection"
              >
                {camera.detection_enabled ? <><EyeOff size={16} /> Tắt phát hiện</> : <><Eye size={16} /> Bật phát hiện</>}
              </button>

              <button className="btn btn-secondary" onClick={() => navigate('/playback')} id="goto-playback">
                <Download size={16} /> Xem lại
              </button>
            </div>

            {/* Camera Info */}
            <div className="mt-4">
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div>
                  <div className="text-xs text-muted mb-2">Stream ID</div>
                  <div className="text-sm text-mono">{camera.stream_id}</div>
                </div>
                <div>
                  <div className="text-xs text-muted mb-2">RTSP URL</div>
                  <div className="text-sm text-mono truncate">{camera.rtsp_url}</div>
                </div>
                <div>
                  <div className="text-xs text-muted mb-2">Trạng thái</div>
                  <div className="flex items-center gap-2">
                    <div className={`status-dot ${camera.enabled ? '' : 'offline'}`} />
                    <span className="text-sm">{camera.enabled ? 'Online' : 'Offline'}</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs text-muted mb-2">Sự kiện hôm nay</div>
                  <div className="text-sm font-bold">{camera.events_today || 0}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
