import React, { useState, useEffect } from 'react';
import { getEvents, getCameras, getMediaUrl, deleteEvent, deleteEvents } from '../utils/api';
import { format } from 'date-fns';
import { AlertTriangle, User, ScanFace, Activity, Filter, Trash2, Volume2, ChevronDown, RefreshCw } from 'lucide-react';
import { useApp } from '../App';

const typeIcons  = { person: User, face: ScanFace, motion: Activity, sound_alert: Volume2 };
const typeLabels = { person: 'Người', face: 'Khuôn mặt', motion: 'Chuyển động', sound_alert: 'Âm thanh lạ' };

export default function Events() {
  const [events, setEvents] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ camera_id: '', type: '', limit: 50 });
  const [loading, setLoading] = useState(true);
  const [zoomImage, setZoomImage] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
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
      setSelectedIds(new Set()); // Reset selections on filter change / refresh
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

  const handleToggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const allSelected = events.length > 0 && events.every(evt => selectedIds.has(evt.id));

  const handleToggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(prev => {
        const next = new Set(prev);
        events.forEach(evt => next.delete(evt.id));
        return next;
      });
    } else {
      setSelectedIds(prev => {
        const next = new Set(prev);
        events.forEach(evt => next.add(evt.id));
        return next;
      });
    }
  };

  const handleBulkDelete = async () => {
    const count = selectedIds.size;
    if (count === 0) return;

    if (!confirm(`Bạn có chắc chắn muốn xóa ${count} sự kiện đã chọn? Ảnh chụp của các sự kiện này sẽ bị xóa vĩnh viễn.`)) {
      return;
    }

    try {
      await deleteEvents(Array.from(selectedIds));
      setSelectedIds(new Set());
      fetchEvents();
    } catch (err) {
      alert('Không thể xóa các sự kiện: ' + (err.response?.data?.error || err.message));
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
      {/* Filters & Actions Control Bar */}
      <div className="filter-bar">
        <div className="filter-group">
          <div className="flex items-center gap-2 text-muted mr-2">
            <Filter size={18} />
            <span className="text-xs font-semibold uppercase tracking-wider hidden lg:inline">Bộ lọc</span>
          </div>
          
          <div className="filter-select-wrapper">
            <select 
              className="filter-select"
              value={filters.camera_id} 
              onChange={e => setFilters({ ...filters, camera_id: e.target.value })}
            >
              <option value="">Tất cả camera</option>
              {cameras.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <ChevronDown className="filter-chevron" />
          </div>

          <div className="filter-select-wrapper">
            <select 
              className="filter-select"
              value={filters.type} 
              onChange={e => setFilters({ ...filters, type: e.target.value })}
            >
              <option value="">Tất cả loại</option>
              <option value="person">Người</option>
              <option value="face">Khuôn mặt</option>
              <option value="motion">Chuyển động</option>
              <option value="sound_alert">Âm thanh lạ</option>
            </select>
            <ChevronDown className="filter-chevron" />
          </div>

          <button 
            className={`refresh-btn ${loading ? 'loading' : ''}`}
            onClick={fetchEvents}
            title="Làm mới"
            disabled={loading}
          >
            <RefreshCw size={18} />
          </button>
        </div>

        <div className="bulk-actions">
          {events.length > 0 && (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input 
                type="checkbox" 
                checked={allSelected} 
                onChange={handleToggleSelectAll}
                className="w-4 h-4 rounded border-border bg-input transition-all cursor-pointer"
              />
              <span className="text-sm font-medium">Toàn bộ ({events.length})</span>
            </label>
          )}

          {selectedIds.size > 0 && (
            <button 
              onClick={handleBulkDelete}
              className="btn btn-danger btn-sm px-4"
            >
              <Trash2 size={14} />
              <span>Xóa {selectedIds.size}</span>
            </button>
          )}
          <div className="ml-auto hidden md:flex items-center gap-2 text-muted text-xs">
            <span>{total} sự kiện</span>
          </div>
        </div>
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
              <div key={evt.id} className="event-card" id={`event-${evt.id}`} style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div className="pl-1 md:pl-2 flex items-center shrink-0">
                  <input 
                    type="checkbox" 
                    checked={selectedIds.has(evt.id)}
                    onChange={() => handleToggleSelect(evt.id)}
                    style={{ width: '18px', height: '18px', cursor: 'pointer' }}
                  />
                </div>
                <div className="event-thumbnail">
                  {evt.snapshot_path ? (
                    <img 
                      src={getMediaUrl(`snapshots/${evt.snapshot_path}`)} 
                      alt="snapshot" 
                      loading="lazy"
                      decoding="async"
                      style={{ cursor: 'zoom-in', background: '#07080d' }}
                      onClick={() => setZoomImage({
                        src: getMediaUrl(`snapshots/${evt.snapshot_path}`),
                        title: `${typeLabels[evt.type] || evt.type} - ${evt.camera_name} (${evt.timestamp ? format(new Date(evt.timestamp), 'HH:mm:ss dd/MM/yyyy') : ''})`
                      })}
                    />
                  ) : (
                    <div className="video-placeholder" style={{
                      height: '100%',
                      background: evt.type === 'sound_alert'
                        ? 'linear-gradient(135deg, rgba(245,158,11,0.15), rgba(245,158,11,0.05))'
                        : undefined,
                    }}>
                      <Icon size={20} style={evt.type === 'sound_alert' ? { color: '#f59e0b' } : {}} />
                    </div>
                  )}
                </div>
                <div className="event-info">
                  <span className={`event-type ${evt.type}`}
                    style={evt.type === 'sound_alert' ? {
                      background: 'rgba(245, 158, 11, 0.15)',
                      color: '#f59e0b',
                      border: '1px solid rgba(245, 158, 11, 0.3)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    } : {}}
                  >
                    {evt.type === 'sound_alert' && <Volume2 size={12} />}
                    {typeLabels[evt.type] || evt.type}
                  </span>
                  {evt.face_name && (
                    <span style={{ marginLeft: 8, color: 'var(--face)', fontWeight: 600, fontSize: '0.8rem' }}>
                      {evt.face_name}
                    </span>
                  )}
                  <div className="event-time mt-1 md:mt-2">
                    {evt.camera_name} · {evt.timestamp ? format(new Date(evt.timestamp), 'HH:mm:ss dd/MM/yyyy') : ''}
                  </div>
                  {evt.confidence > 0 && (
                    <div className="text-xs text-muted mt-0.5 md:mt-1">
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
