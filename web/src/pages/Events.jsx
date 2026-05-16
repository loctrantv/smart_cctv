import React, { useState, useEffect } from 'react';
import { getEvents, getCameras } from '../utils/api';
import { format } from 'date-fns';
import { AlertTriangle, User, ScanFace, Activity, Filter } from 'lucide-react';
import { useApp } from '../App';

const typeIcons = { person: User, face: ScanFace, motion: Activity };
const typeLabels = { person: 'Người', face: 'Khuôn mặt', motion: 'Chuyển động' };

export default function Events() {
  const [events, setEvents] = useState([]);
  const [cameras, setCameras] = useState([]);
  const [total, setTotal] = useState(0);
  const [filters, setFilters] = useState({ camera_id: '', type: '', limit: 50 });
  const [loading, setLoading] = useState(true);
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
                    <img src={`/media/snapshots/${evt.snapshot_path}`} alt="snapshot" loading="lazy" />
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
    </div>
  );
}
