import React, { useState, useEffect } from 'react';
import { getEvents, getCameras, getMediaUrl, deleteEvent } from '../utils/api';
import { format } from 'date-fns';
import { AlertTriangle, User, ScanFace, Activity, Filter, Trash2 } from 'lucide-react';
import { useApp } from '../App';

const typeIcons = { person: User, face: ScanFace, motion: Activity };
const typeLabels = { person: 'Người', face: 'Khuôn mặt', motion: 'Chuyển động' };

export default function Events() {
  const [events, setEvents] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ camera_id: '', type: '', limit: 50 });
  const [loading, setLoading] = useState(true);
  const [zoomImage, setZoomImage] = useState(null);
  const { ws } = useApp();

  const fetchEvents = async () => {
    setLoading(true);
    try {
      const params = {};
      if (filters.camera_id) params.camera_id = filters.camera_id;
      if (filters.type) params.type = filters.type;
      params.limit = filters.limit;
      const data = await getEvents(params);
      setEvents(data.events);
      setTotal(data.total);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteEvent = async (id) => {
    if (!confirm('Bạn có chắc chắn muốn xóa sự kiện này? Ảnh chụp của sự kiện trên ổ đĩa sẽ bị xóa vĩnh viễn.')) return;
    try {
      await deleteEvent(id);
      fetchEvents();
    } catch (err) {
      alert('Không thể xóa sự kiện: ' + (err.response?.data?.error || err.message));
    }
  };

  useEffect(() => { getCameras().then(setCameras); }, []);
  useEffect(() => { fetchEvents(); }, [filters]);

  useEffect(() => {
    if (!ws) return;
    return ws.on('detection_event', () => fetchEvents());
  }, [ws]);

  return (
    <div>
      {/* Filters */}
      <div className="toolbar">
        <div className="toolbar-group">
          <Filter size={16} className="text-muted" />
          <select className="form-select" style={{ width: 160 }}
            value={filters.camera_id} onChange={e => setFilters({ ...filters, camera_id: e.target.value })}>
            <option value="">Tất cả camera</option>
            {cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select className="form-select" style={{ width: 140 }}
            value={filters.type} onChange={e => setFilters({ ...filters, type: e.target.value })}>
            <option value="">Tất cả loại</option>
            <option value="person">Người</option>
            <option value="face">Khuôn mặt</option>
            <option value="motion">Chuyển động</option>
          </select>
        </div>
        <span className="text-xs text-muted">{total} sự kiện</span>
      </div>

      {/* Events List */}
      {events.length === 0 && !loading ? (
        <div className="empty-state">
          <AlertTriangle size={48} />
          <p>Chưa có sự kiện nào</p>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {events.map(evt => {
            const Icon = typeIcons[evt.type] || Activity;
            return (
              <div key={evt.id} className="event-card" id={`event-${evt.id}`}>
                <div className="event-thumbnail">
                  {evt.snapshot_path ? (
                    <img 
                      src={getMediaUrl(`snapshots/${evt.snapshot_path}`)} 
                      alt="snapshot" 
                      loading="lazy" 
                      style={{ cursor: 'zoom-in' }}
                      onClick={() => setZoomImage({
                        src: getMediaUrl(`snapshots/${evt.snapshot_path}`),
                        title: `${typeLabels[evt.type] || evt.type} - ${evt.camera_name} (${evt.timestamp ? format(new Date(evt.timestamp), 'HH:mm:ss dd/MM/yyyy') : ''})`
                      })}
                    />
                  ) : (
                    <div className="video-placeholder" style={{ height: '100%' }}>
                      <Icon size={20} />
                    </div>
                  )}
                </div>
                <div className="event-info">
                  <span className={`event-type ${evt.type}`}>
                    {typeLabels[evt.type] || evt.type}
                  </span>
                  {evt.face_name && (
                    <span style={{ marginLeft: 8, color: 'var(--face)', fontWeight: 600, fontSize: '0.8rem' }}>
                      {evt.face_name}
                    </span>
                  )}
                  <div className="event-time mt-2">
                    {evt.camera_name} · {evt.timestamp ? format(new Date(evt.timestamp), 'HH:mm:ss dd/MM/yyyy') : ''}
                  </div>
                  {evt.confidence > 0 && (
                    <div className="text-xs text-muted mt-2">
                      Độ tin cậy: {(evt.confidence * 100).toFixed(0)}%
                    </div>
                  )}
                </div>
                <div className="event-actions" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', paddingRight: 8 }}>
                  <button
                    onClick={() => handleDeleteEvent(evt.id)}
                    className="btn-icon"
                    style={{
                      color: 'var(--danger)',
                      opacity: 0.8,
                      border: 'none',
                      background: 'none',
                      cursor: 'pointer',
                      padding: 8,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderRadius: '50%',
                    }}
                    title="Xóa sự kiện"
                    onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
                    onMouseLeave={(e) => e.currentTarget.style.opacity = 0.8}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {total > events.length && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button className="btn btn-secondary" onClick={() => setFilters({ ...filters, limit: filters.limit + 50 })}>
            Tải thêm
          </button>
        </div>
      )}
      {zoomImage && (
        <ImageZoomModal 
          src={zoomImage.src} 
          title={zoomImage.title} 
          onClose={() => setZoomImage(null)} 
        />
      )}
    </div>
  );
}

export function ImageZoomModal({ src, title, onClose }) {
  return (
    <div 
      className="modal-overlay" 
      onClick={onClose}
      style={{
        zIndex: 9999,
        background: 'rgba(0, 0, 0, 0.85)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'zoom-out',
        animation: 'modalFadeIn 0.2s ease-out'
      }}
    >
      <style>{`
        @keyframes modalFadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes modalScaleUp {
          from { transform: scale(0.9); opacity: 0; }
          to { transform: scale(1); opacity: 1; }
        }
      `}</style>
      <div 
        style={{
          position: 'relative',
          maxWidth: '90%',
          maxHeight: '90%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          cursor: 'default',
        }}
        onClick={e => e.stopPropagation()}
      >
        <button 
          onClick={onClose}
          className="btn-icon" 
          style={{
            position: 'absolute',
            top: -45,
            right: 0,
            color: '#fff',
            fontSize: '1.25rem',
            background: 'rgba(255, 255, 255, 0.1)',
            backdropFilter: 'blur(5px)',
            borderRadius: '50%',
            width: 32,
            height: 32,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            border: 'none',
            cursor: 'pointer',
            transition: 'background 0.2s'
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.2)'}
          onMouseLeave={e => e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'}
        >
          ✕
        </button>
        <img 
          src={src} 
          alt={title || "Zoomed"} 
          style={{
            maxWidth: '100%',
            maxHeight: '80vh',
            borderRadius: '12px',
            boxShadow: '0 20px 50px rgba(0,0,0,0.5)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            objectFit: 'contain',
            animation: 'modalScaleUp 0.2s cubic-bezier(0.34, 1.56, 0.64, 1)'
          }} 
        />
        {title && (
          <div 
            style={{
              marginTop: 16,
              color: '#fff',
              fontWeight: 600,
              fontSize: '0.9rem',
              textAlign: 'center',
              textShadow: '0 2px 4px rgba(0,0,0,0.5)',
              background: 'rgba(0,0,0,0.4)',
              padding: '6px 16px',
              borderRadius: '20px',
              border: '1px solid rgba(255,255,255,0.05)',
              backdropFilter: 'blur(5px)'
            }}
          >
            {title}
          </div>
        )}
      </div>
    </div>
  );
}
