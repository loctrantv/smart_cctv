import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { getEvents, getEventStats, getCameras, getMediaUrl, deleteEvent, deleteEvents } from '../utils/api';
import { format } from 'date-fns';
import {
  TechSelect,
  TechDatePicker,
  TechCheckbox,
  useTechDialog,
} from '../components/TechUI';
import {
  AlertTriangle,
  User,
  ScanFace,
  Activity,
  Filter,
  Trash2,
  Volume2,
  RefreshCw,
  LayoutGrid,
  List,
  Download,
  ExternalLink,
  Search,
  Image as ImageIcon,
  Camera,
} from 'lucide-react';
import { useApp } from '../App';

const typeIcons = {
  person: User,
  face: ScanFace,
  motion: Activity,
  sound_alert: Volume2,
  vehicle: Activity,
  animal: Activity,
  plate: Activity,
  line_crossing: AlertTriangle,
  intrusion: AlertTriangle,
};
const typeLabels = {
  person: 'Người',
  face: 'Khuôn mặt',
  motion: 'Chuyển động',
  sound_alert: 'Âm thanh AI',
  vehicle: 'Phương tiện',
  animal: 'Động vật',
  plate: 'Biển số xe',
  line_crossing: 'Vượt rào ảo',
  intrusion: 'Xâm nhập vùng cấm',
};

/**
 * IntersectionObserver Lazy Thumbnail so hundreds of event cards never lag the browser
 */
export function LazyEventImage({ src, alt, onClick, aspectRatio = '16/9' }) {
  const boxRef = useRef(null);
  const [inView, setInView] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setErrored(false);
  }, [src]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !src) return;
    if (!('IntersectionObserver' in window)) {
      setInView(true);
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setInView(true);
            obs.disconnect();
          }
        });
      },
      { rootMargin: '160px' }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [src]);

  return (
    <div
      ref={boxRef}
      className="vms-event-img-box"
      style={{ aspectRatio, cursor: src && !errored ? 'zoom-in' : 'default' }}
      onClick={src && !errored ? onClick : undefined}
    >
      {src && inView && !errored && (
        <img
          src={src}
          alt={alt || 'event'}
          loading="lazy"
          decoding="async"
          className={`nvr-lazy-img ${loaded ? 'is-loaded' : ''}`}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      )}
      {(!src || !loaded || errored) && (
        <div className="nvr-lazy-placeholder">
          <ImageIcon size={18} className="opacity-40" />
        </div>
      )}
    </div>
  );
}

export default function Events() {
  const { confirmDialog, showToast } = useTechDialog();
  const [events, setEvents] = useState([]);
  const [stats, setStats] = useState({ byType: [], recentCount: 0 });
  const [cameras, setCameras] = useState([]);
  const [total, setTotal] = useState(0);
  const [viewMode, setViewMode] = useState(
    localStorage.getItem('smart_cctv_events_view') || 'grid'
  ); // 'grid' | 'list'
  const [filters, setFilters] = useState({
    camera_id: '',
    type: '',
    date: '',
    search: '',
    limit: 48,
  });
  const [loading, setLoading] = useState(true);
  const [zoomImage, setZoomImage] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const { ws, refreshGlobalStats } = useApp();
  const navigate = useNavigate();

  const toggleViewMode = (mode) => {
    setViewMode(mode);
    localStorage.setItem('smart_cctv_events_view', mode);
  };

  const parseEventTime = (ts) => {
    if (!ts) return null;
    const iso = ts.includes('Z') || ts.includes('+') ? ts : ts.replace(' ', 'T') + 'Z';
    return new Date(iso);
  };

  const fetchEvents = async () => {
    setLoading(true);
    try {
      const params = { limit: filters.limit };
      if (filters.camera_id) params.camera_id = filters.camera_id;
      if (filters.type) params.type = filters.type;
      if (filters.search && filters.search.trim()) params.search = filters.search.trim();
      if (filters.date) {
        params.start = `${filters.date} 00:00:00`;
        params.end = `${filters.date} 23:59:59`;
      }
      const [data, st] = await Promise.all([
        getEvents(params),
        getEventStats(filters.camera_id ? { camera_id: filters.camera_id } : {}),
      ]);
      setEvents(data.events || []);
      setTotal(data.total || 0);
      setStats(st || { byType: [], recentCount: 0 });
      setSelectedIds(new Set());
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteEvent = async (id) => {
    const ok = await confirmDialog({
      title: 'XÓA SỰ KIỆN AI',
      message: 'Sự kiện này và ảnh Snapshot trên ổ đĩa sẽ bị xóa vĩnh viễn. Bạn có chắc chắn?',
      confirmText: 'Xóa sự kiện',
      cancelText: 'Hủy',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteEvent(id);
      showToast('Đã xóa sự kiện', 'success');
      fetchEvents();
      if (refreshGlobalStats) refreshGlobalStats();
    } catch (err) {
      showToast('Không thể xóa sự kiện: ' + (err.response?.data?.error || err.message), 'error');
    }
  };

  const handleToggleSelect = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allSelected = events.length > 0 && events.every((evt) => selectedIds.has(evt.id));

  const handleToggleSelectAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(events.map((e) => e.id)));
    }
  };

  const handleBulkDelete = async () => {
    const count = selectedIds.size;
    if (count === 0) return;
    const ok = await confirmDialog({
      title: `XÓA HÀNG LOẠT (${count} SỰ KIỆN)`,
      message: `Toàn bộ ${count} sự kiện đã chọn và ảnh chụp liên quan sẽ bị xóa vĩnh viễn khỏi hệ thống.`,
      confirmText: `Xóa ${count} sự kiện`,
      cancelText: 'Hủy',
      danger: true,
    });
    if (!ok) return;

    try {
      await deleteEvents(Array.from(selectedIds));
      showToast(`Đã xóa ${count} sự kiện thành công`, 'success');
      setSelectedIds(new Set());
      fetchEvents();
      if (refreshGlobalStats) refreshGlobalStats();
    } catch (err) {
      showToast(
        'Không thể xóa các sự kiện: ' + (err.response?.data?.error || err.message),
        'error'
      );
    }
  };

  useEffect(() => {
    getCameras().then(setCameras).catch(() => {});
  }, []);

  useEffect(() => {
    fetchEvents();
  }, [filters]);

  useEffect(() => {
    if (!ws) return;
    return ws.on('detection_event', () => fetchEvents());
  }, [ws]);

  const getCountByType = (t) => {
    const found = (stats.byType || []).find((x) => x.type === t);
    return found ? found.count : 0;
  };

  return (
    <div className="vms-events-page">
      {/* Top Event Telemetry Summary Strip */}
      <div className="vms-event-summary-row mb-3">
        <div
          className={`vms-event-stat-chip ${filters.type === '' ? 'active' : ''}`}
          onClick={() => setFilters({ ...filters, type: '' })}
        >
          <AlertTriangle size={15} style={{ color: 'var(--accent)' }} />
          <div>
            <div className="text-xs text-muted">Tổng sự kiện</div>
            <div className="text-sm font-bold text-mono">{total}</div>
          </div>
        </div>

        <div
          className={`vms-event-stat-chip ${filters.type === 'motion' ? 'active' : ''}`}
          onClick={() =>
            setFilters({ ...filters, type: filters.type === 'motion' ? '' : 'motion' })
          }
        >
          <Activity size={15} style={{ color: 'var(--motion)' }} />
          <div>
            <div className="text-xs text-muted">Chuyển động (7 ngày)</div>
            <div className="text-sm font-bold text-mono">{getCountByType('motion')}</div>
          </div>
        </div>

        <div
          className={`vms-event-stat-chip ${filters.type === 'sound_alert' ? 'active' : ''}`}
          onClick={() =>
            setFilters({
              ...filters,
              type: filters.type === 'sound_alert' ? '' : 'sound_alert',
            })
          }
        >
          <Volume2 size={15} style={{ color: '#f59e0b' }} />
          <div>
            <div className="text-xs text-muted">Âm thanh lạ (7 ngày)</div>
            <div className="text-sm font-bold text-mono">{getCountByType('sound_alert')}</div>
          </div>
        </div>

        <div className="vms-event-stat-chip">
          <RefreshCw size={15} style={{ color: 'var(--success)' }} />
          <div>
            <div className="text-xs text-muted">Trong 1 giờ qua</div>
            <div className="text-sm font-bold text-mono">{stats.recentCount || 0}</div>
          </div>
        </div>
      </div>

      {/* VMS Filter & Bulk Action Strip */}
      <div className="vms-control-strip mb-3" style={{ borderRadius: 'var(--radius-md)' }}>
        <div className="vms-strip-left">
          <TechSelect
            icon={Camera}
            value={filters.camera_id}
            onChange={(val) => setFilters({ ...filters, camera_id: val })}
            options={[
              { value: '', label: 'Tất cả kênh camera' },
              ...cameras.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />

          <TechSelect
            icon={Filter}
            value={filters.type}
            onChange={(val) => setFilters({ ...filters, type: val })}
            options={[
              { value: '', label: 'Tất cả loại cảnh báo AI' },
              { value: 'motion', label: 'Chuyển động' },
              { value: 'person', label: 'Người (YOLOv8)' },
              { value: 'face', label: 'Khuôn mặt (ArcFace 512-D)' },
              { value: 'plate', label: 'Biển số xe (ALPR VN)' },
              { value: 'vehicle', label: 'Phương tiện (Xe máy / Ô tô)' },
              { value: 'animal', label: 'Động vật (Chó / Mèo)' },
              { value: 'line_crossing', label: 'Vượt hàng rào ảo (ByteTrack)' },
              { value: 'intrusion', label: 'Xâm nhập / Lảng vảng' },
              { value: 'sound_alert', label: 'Âm thanh AI (YAMNet)' },
            ]}
          />

          <div className="tech-input-shell" style={{ minWidth: 185, height: 32 }}>
            <span className="tech-input-icon-left">
              <Search size={13} />
            </span>
            <input
              type="text"
              className="tech-input-control has-left-icon"
              style={{ height: 32, fontSize: '0.78rem' }}
              placeholder="Tìm biển số / tên / nhãn..."
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            />
          </div>

          <TechDatePicker
            value={filters.date}
            onChange={(val) => setFilters({ ...filters, date: val })}
            placeholder="Tất cả ngày"
            allowClear
          />

          <button
            type="button"
            className={`btn-icon ${loading ? 'loading' : ''}`}
            onClick={fetchEvents}
            title="Làm mới danh sách"
            disabled={loading}
          >
            <RefreshCw size={15} />
          </button>
        </div>

        <div className="vms-strip-right">
          {events.length > 0 && (
            <TechCheckbox
              checked={allSelected}
              onChange={handleToggleSelectAll}
              label={`Chọn tất cả (${events.length})`}
            />
          )}

          {selectedIds.size > 0 && (
            <button
              type="button"
              onClick={handleBulkDelete}
              className="btn btn-danger btn-sm"
            >
              <Trash2 size={13} />
              <span>Xóa ({selectedIds.size})</span>
            </button>
          )}

          <div className="vms-divider" />

          <div className="vms-btn-group">
            <button
              type="button"
              className={`vms-strip-btn ${viewMode === 'grid' ? 'active' : ''}`}
              onClick={() => toggleViewMode('grid')}
              title="Chế độ Lưới ảnh (Gallery Grid)"
            >
              <LayoutGrid size={13} /> <span>Lưới ảnh</span>
            </button>
            <button
              type="button"
              className={`vms-strip-btn ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => toggleViewMode('list')}
              title="Chế độ Danh sách chi tiết"
            >
              <List size={13} /> <span>Danh sách</span>
            </button>
          </div>
        </div>
      </div>

      {/* Events Display: Grid or List */}
      {events.length === 0 && !loading ? (
        <div className="empty-state card">
          <AlertTriangle size={44} />
          <p>Không có sự kiện nào khớp với bộ lọc hiện tại</p>
        </div>
      ) : viewMode === 'grid' ? (
        <div className="vms-events-gallery-grid">
          {events.map((evt) => {
            const Icon = typeIcons[evt.type] || Activity;
            const dt = parseEventTime(evt.timestamp);
            const imgUrl = evt.snapshot_path ? getMediaUrl(`snapshots/${evt.snapshot_path}`) : null;
            const isSelected = selectedIds.has(evt.id);

            return (
              <div
                key={evt.id}
                className={`card vms-event-grid-card ${isSelected ? 'is-selected' : ''}`}
                id={`event-${evt.id}`}
              >
                <div className="vms-event-grid-thumb-wrap">
                  <div className="vms-event-checkbox-overlay">
                    <TechCheckbox
                      checked={isSelected}
                      onChange={() => handleToggleSelect(evt.id)}
                    />
                  </div>

                  <span className={`vms-event-badge-overlay ${evt.type}`}>
                    <Icon size={11} />
                    {typeLabels[evt.type] || evt.type}
                  </span>

                  {imgUrl ? (
                    <LazyEventImage
                      src={imgUrl}
                      alt={evt.type}
                      aspectRatio="16/10"
                      onClick={() =>
                        setZoomImage({
                          src: imgUrl,
                          title: `${typeLabels[evt.type] || evt.type} — ${evt.camera_name} (${
                            dt ? format(dt, 'HH:mm:ss dd/MM/yyyy') : ''
                          })`,
                        })
                      }
                    />
                  ) : (
                    <div
                      className="vms-event-img-box"
                      style={{
                        aspectRatio: '16/10',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background:
                          'linear-gradient(135deg, rgba(245,158,11,0.16), rgba(245,158,11,0.04))',
                      }}
                    >
                      <Icon size={28} style={{ color: '#f59e0b' }} />
                    </div>
                  )}
                </div>

                <div className="vms-event-grid-footer">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-bold truncate">{evt.camera_name}</div>
                    <div className="text-xs text-mono text-muted mt-0.5">
                      {dt ? format(dt, 'HH:mm:ss dd/MM/yyyy') : ''}
                    </div>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="btn-icon"
                      style={{ width: 26, height: 26 }}
                      onClick={() => navigate(`/camera/${evt.camera_id}`)}
                      title="Mở camera này"
                    >
                      <ExternalLink size={12} />
                    </button>
                    <button
                      type="button"
                      className="btn-icon"
                      style={{ width: 26, height: 26, color: 'var(--danger)' }}
                      onClick={() => handleDeleteEvent(evt.id)}
                      title="Xóa sự kiện"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {events.map((evt) => {
            const Icon = typeIcons[evt.type] || Activity;
            const dt = parseEventTime(evt.timestamp);
            const imgUrl = evt.snapshot_path ? getMediaUrl(`snapshots/${evt.snapshot_path}`) : null;

            return (
              <div
                key={evt.id}
                className="event-card"
                id={`event-${evt.id}`}
                style={{ display: 'flex', alignItems: 'center', gap: '12px' }}
              >
                <div className="pl-1 flex items-center shrink-0">
                  <TechCheckbox
                    checked={selectedIds.has(evt.id)}
                    onChange={() => handleToggleSelect(evt.id)}
                  />
                </div>
                <div className="event-thumbnail">
                  {imgUrl ? (
                    <LazyEventImage
                      src={imgUrl}
                      alt="snapshot"
                      aspectRatio="16/9"
                      onClick={() =>
                        setZoomImage({
                          src: imgUrl,
                          title: `${typeLabels[evt.type] || evt.type} - ${evt.camera_name} (${
                            dt ? format(dt, 'HH:mm:ss dd/MM/yyyy') : ''
                          })`,
                        })
                      }
                    />
                  ) : (
                    <div
                      className="video-placeholder"
                      style={{
                        height: '100%',
                        background:
                          evt.type === 'sound_alert'
                            ? 'linear-gradient(135deg, rgba(245,158,11,0.15), rgba(245,158,11,0.05))'
                            : undefined,
                      }}
                    >
                      <Icon size={20} style={evt.type === 'sound_alert' ? { color: '#f59e0b' } : {}} />
                    </div>
                  )}
                </div>
                <div className="event-info">
                  <span className={`event-type ${evt.type}`}>
                    {typeLabels[evt.type] || evt.type}
                  </span>
                  {evt.face_name && (
                    <span
                      style={{
                        marginLeft: 8,
                        color: 'var(--face)',
                        fontWeight: 600,
                        fontSize: '0.8rem',
                      }}
                    >
                      {evt.face_name}
                    </span>
                  )}
                  <div className="event-time mt-1">
                    {evt.camera_name} · {dt ? format(dt, 'HH:mm:ss dd/MM/yyyy') : ''}
                  </div>
                  {evt.confidence > 0 && (
                    <div className="text-xs text-muted mt-0.5">
                      Độ tin cậy: {(evt.confidence * 100).toFixed(0)}%
                    </div>
                  )}
                </div>
                <div
                  className="event-actions"
                  style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}
                >
                  <button
                    type="button"
                    onClick={() => navigate(`/camera/${evt.camera_id}`)}
                    className="btn-icon"
                    title="Xem trực tiếp kênh này"
                  >
                    <ExternalLink size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteEvent(evt.id)}
                    className="btn-icon"
                    style={{ color: 'var(--danger)' }}
                    title="Xóa sự kiện"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {total > events.length && (
        <div style={{ textAlign: 'center', marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setFilters({ ...filters, limit: filters.limit + 48 })}
          >
            Tải thêm sự kiện ({total - events.length} còn lại)
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
        background: 'rgba(0, 0, 0, 0.88)',
        backdropFilter: 'blur(10px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'zoom-out',
      }}
    >
      <div
        style={{
          position: 'relative',
          maxWidth: '92%',
          maxHeight: '92%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          cursor: 'default',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            position: 'absolute',
            top: -44,
            right: 0,
            display: 'flex',
            gap: 8,
          }}
        >
          <a
            href={src}
            download={`event_snapshot_${Date.now()}.jpg`}
            className="btn btn-secondary btn-sm"
            style={{ background: 'rgba(20, 22, 34, 0.85)', color: '#fff' }}
          >
            <Download size={14} /> Tải ảnh
          </a>
          <button
            type="button"
            onClick={onClose}
            className="btn-icon"
            style={{
              color: '#fff',
              background: 'rgba(255, 255, 255, 0.15)',
              borderRadius: '50%',
              width: 32,
              height: 32,
              border: 'none',
            }}
          >
            ✕
          </button>
        </div>

        <img
          src={src}
          alt={title || 'Zoomed'}
          style={{
            maxWidth: '100%',
            maxHeight: '82vh',
            borderRadius: '10px',
            boxShadow: '0 20px 50px rgba(0,0,0,0.6)',
            border: '1px solid rgba(255, 255, 255, 0.14)',
            objectFit: 'contain',
          }}
        />
        {title && (
          <div
            style={{
              marginTop: 12,
              color: '#fff',
              fontWeight: 600,
              fontSize: '0.85rem',
              textAlign: 'center',
              background: 'rgba(0,0,0,0.6)',
              padding: '6px 16px',
              borderRadius: '20px',
              border: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            {title}
          </div>
        )}
      </div>
    </div>
  );
}
