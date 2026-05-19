import React, { useState, useEffect, useRef } from 'react';
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
  const [showZoneConfig, setShowZoneConfig] = useState(false);
  const [zones, setZones] = useState([]);
  const [activeZone, setActiveZone] = useState(null);
  const [aspectRatio, setAspectRatio] = useState(16 / 9);

  const containerRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [startPos, setStartPos] = useState(null);

  const getCoordinates = (e, rect) => {
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
    };
  };

  const handleStart = (e) => {
    if (!showZoneConfig || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const pos = getCoordinates(e, rect);
    setIsDrawing(true);
    setStartPos(pos);
    setActiveZone({ x: pos.x, y: pos.y, w: 0.01, h: 0.01 });
  };

  const handleMove = (e) => {
    if (!isDrawing || !startPos || !containerRef.current) return;
    if (e.cancelable) e.preventDefault(); // prevent touch drag scroll
    
    const rect = containerRef.current.getBoundingClientRect();
    const pos = getCoordinates(e, rect);
    
    const x = Math.min(startPos.x, pos.x);
    const y = Math.min(startPos.y, pos.y);
    const w = Math.max(0.01, Math.abs(startPos.x - pos.x));
    const h = Math.max(0.01, Math.abs(startPos.y - pos.y));
    
    setActiveZone({ x, y, w, h });
  };

  const handleEnd = () => {
    if (isDrawing && activeZone && activeZone.w > 0.01 && activeZone.h > 0.01) {
      setZones(prev => [...prev, activeZone]);
    }
    setIsDrawing(false);
    setStartPos(null);
    setActiveZone(null);
  };

  useEffect(() => {
    async function fetch() {
      try {
        const data = await getCamera(id);
        setCamera(data);
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
              setZones([{ x: parts[0], y: parts[1], w: parts[2], h: parts[3] }]);
            } else {
              setZones([]);
            }
          }
        } else {
          setZones([]);
        }
      } catch {
        navigate('/');
      } finally {
        setLoading(false);
      }
    }
    fetch();
  }, [id, navigate]);

  const handleSaveZone = async () => {
    try {
      const zoneString = JSON.stringify(zones);
      await updateCamera(camera.id, { detection_zone: zoneString });
      alert('Đã cập nhật các vùng quét phát hiện chuyển động cho camera!');
      setShowZoneConfig(false);
      const updated = await getCamera(id);
      setCamera(updated);
    } catch (err) {
      alert('Không thể lưu cấu hình vùng quét: ' + err.message);
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
      <div 
        ref={containerRef} 
        style={{ 
          width: '100%',
          maxWidth: 560,
          margin: '0 auto', 
          position: 'relative', 
          overflow: 'hidden', 
          userSelect: 'none',
          aspectRatio: aspectRatio,
          background: '#000',
          borderRadius: 'var(--radius-md, 8px)'
        }}
      >
        <VideoPlayer
          streamId={camera.stream_id}
          streams={camera.streams}
          autoPlay
          muted={false}
          onAspectRatioChange={setAspectRatio}
        />
        
        {/* Transparent Interactive Drawing Overlay */}
        {showZoneConfig && (
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              zIndex: 15,
              cursor: 'crosshair',
              pointerEvents: 'auto',
              userSelect: 'none',
              WebkitUserSelect: 'none'
            }}
            onMouseDown={handleStart}
            onMouseMove={handleMove}
            onMouseUp={handleEnd}
            onMouseLeave={handleEnd}
            onTouchStart={handleStart}
            onTouchMove={handleMove}
            onTouchEnd={handleEnd}
          />
        )}
        
        {/* All Active Detection Zones Overlays */}
        {showZoneConfig && (zones.length > 0) && zones.map((z, idx) => (
          <div 
            key={idx} 
            style={{
              position: 'absolute',
              left: `${z.x * 100}%`,
              top: `${z.y * 100}%`,
              width: `${z.w * 100}%`,
              height: `${z.h * 100}%`,
              border: '2px dashed var(--danger, #ef4444)',
              background: 'rgba(239, 68, 68, 0.15)',
              boxShadow: '0 0 8px rgba(239, 68, 68, 0.4)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 10,
              borderRadius: '4px'
            }}
          >
            {showZoneConfig && (
              <button
                style={{
                  position: 'absolute',
                  top: -8,
                  right: -8,
                  width: 18,
                  height: 18,
                  borderRadius: '50%',
                  background: '#ef4444',
                  color: '#fff',
                  border: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '10px',
                  fontWeight: 'bold',
                  cursor: 'pointer',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
                  zIndex: 20,
                  pointerEvents: 'auto'
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  setZones(prev => prev.filter((_, i) => i !== idx));
                }}
              >
                ✕
              </button>
            )}
            <span style={{
              position: 'absolute',
              bottom: 2,
              left: 4,
              color: '#fff',
              fontSize: '0.65rem',
              background: 'rgba(0,0,0,0.6)',
              padding: '2px 4px',
              borderRadius: '2px',
              textShadow: '0 1px 2px rgba(0,0,0,0.8)'
            }}>
              Vùng #{idx + 1} ({Math.round(z.w * 100)}%x{Math.round(z.h * 100)}%)
            </span>
          </div>
        ))}

        {/* Temporary active drawing zone preview */}
        {isDrawing && activeZone && (
          <div 
            style={{
              position: 'absolute',
              left: `${activeZone.x * 100}%`,
              top: `${activeZone.y * 100}%`,
              width: `${activeZone.w * 100}%`,
              height: `${activeZone.h * 100}%`,
              border: '3px solid #ff4d4d',
              background: 'rgba(255, 77, 77, 0.25)',
              boxShadow: '0 0 10px rgba(255,77,77,0.5)',
              borderRadius: '4px',
              zIndex: 14
            }}
          />
        )}
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

              <button
                className={`btn ${showZoneConfig ? 'btn-danger' : 'btn-secondary'}`}
                onClick={() => setShowZoneConfig(!showZoneConfig)}
                id="toggle-zone-config"
              >
                <Settings size={16} /> {showZoneConfig ? 'Đóng cấu hình' : 'Cấu hình vùng quét'}
              </button>

              <button className="btn btn-secondary" onClick={() => navigate('/playback')} id="goto-playback">
                <Download size={16} /> Xem lại
              </button>
            </div>

            {/* Zone Config Control Panel */}
            {showZoneConfig && (
              <div className="card mt-3 animate-fadeIn" style={{ border: '1px solid rgba(239, 68, 68, 0.3)', background: 'rgba(0, 0, 0, 0.2)' }}>
                <style>{`
                  @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(-10px); }
                    to { opacity: 1; transform: translateY(0); }
                  }
                  .animate-fadeIn {
                    animation: fadeIn 0.25s ease-out;
                  }
                `}</style>
                <div className="card-header flex items-center justify-between" style={{ background: 'rgba(239, 68, 68, 0.05)', padding: '10px 16px' }}>
                  <span className="font-bold flex items-center gap-2" style={{ color: 'var(--danger, #ef4444)' }}>
                    <Settings size={16} /> Cấu hình các vùng phát hiện chuyển động
                  </span>
                  <button className="btn btn-secondary btn-sm" style={{ padding: '4px 8px', fontSize: '0.75rem' }} onClick={() => setZones([])}>
                    Xóa tất cả các vùng
                  </button>
                </div>
                <div className="card-body" style={{ padding: '16px' }}>
                  <p className="text-xs text-muted mb-4">
                    Nhấp chuột và kéo thả (hoặc chạm vuốt trên màn hình điện thoại) <strong>trực tiếp lên màn hình video camera ở trên</strong> để tự do vẽ các vùng quét. Bạn có thể vẽ nhiều vùng tùy ý. Nhấp dấu ✕ ở góc trên mỗi vùng để xóa vùng đó.
                  </p>
                  
                  <div className="text-sm font-bold mb-2 flex justify-between items-center">
                    <span>Danh sách vùng quét đã vẽ ({zones.length})</span>
                  </div>

                  {zones.length === 0 ? (
                    <div className="text-xs text-muted p-3 text-center" style={{ background: 'rgba(255,255,255,0.02)', borderRadius: '4px', border: '1px dashed rgba(255,255,255,0.1)' }}>
                      Chưa vẽ vùng quét nào. Camera sẽ mặc định phát hiện chuyển động trên toàn màn hình.
                    </div>
                  ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 10 }}>
                      {zones.map((z, idx) => (
                        <div key={idx} className="flex justify-between items-center p-2" style={{ background: 'rgba(255,255,255,0.05)', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)' }}>
                          <span className="text-xs font-bold" style={{ color: 'var(--danger, #ef4444)' }}>Vùng #{idx + 1}</span>
                          <span className="text-xs text-mono text-muted">{Math.round(z.w*100)}% x {Math.round(z.h*100)}%</span>
                          <button 
                            style={{ background: 'none', border: 'none', color: '#ff4d4d', cursor: 'pointer', padding: '0 4px', fontSize: '12px' }}
                            onClick={() => setZones(prev => prev.filter((_, i) => i !== idx))}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="mt-4 flex justify-end gap-2">
                    <button className="btn btn-secondary btn-sm" onClick={() => setShowZoneConfig(false)}>
                      Hủy bỏ
                    </button>
                    <button className="btn btn-primary btn-sm" onClick={handleSaveZone} id="save-zone-btn">
                      Lưu cấu hình
                    </button>
                  </div>
                </div>
              </div>
            )}

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
