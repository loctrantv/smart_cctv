import React, { useState, useEffect, useMemo } from 'react';
import { getFaces, addFace, updateFace, deleteFace, getMediaUrl } from '../utils/api';
import { Users, Plus, Trash2, Clock, Search, Edit3, ScanFace } from 'lucide-react';
import { format } from 'date-fns';
import { ImageZoomModal, LazyEventImage } from './Events';

export default function FaceLibrary() {
  const [faces, setFaces] = useState([]);
  const [search, setSearch] = useState('');
  const [modalFace, setModalFace] = useState(null); // null | { mode: 'add' } | { mode: 'edit', face }
  const [loading, setLoading] = useState(true);
  const [zoomImage, setZoomImage] = useState(null);

  const fetchFaces = async () => {
    try {
      const data = await getFaces();
      setFaces(data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFaces();
  }, []);

  const handleDelete = async (id, name) => {
    if (!confirm(`Xóa hồ sơ khuôn mặt "${name}"?`)) return;
    await deleteFace(id);
    fetchFaces();
  };

  const filteredFaces = useMemo(() => {
    if (!search.trim()) return faces;
    const q = search.toLowerCase();
    return faces.filter((f) => (f.name || '').toLowerCase().includes(q));
  }, [faces, search]);

  return (
    <div>
      {/* VMS Face Database Control Bar */}
      <div className="vms-control-strip mb-3" style={{ borderRadius: 'var(--radius-md)' }}>
        <div className="vms-strip-left">
          <div className="flex items-center gap-2">
            <ScanFace size={17} style={{ color: 'var(--face)' }} />
            <span className="text-sm font-bold">CSDL Nhận Diện Khuôn Mặt</span>
            <span className="vms-osd-badge ai">{faces.length} hồ sơ</span>
          </div>

          <div className="vms-divider" />

          <div style={{ position: 'relative', minWidth: 220 }}>
            <Search
              size={14}
              style={{
                position: 'absolute',
                left: 10,
                top: '50%',
                transform: 'translateY(-50%)',
                color: 'var(--text-muted)',
              }}
            />
            <input
              type="text"
              className="filter-select"
              style={{ paddingLeft: 30, paddingRight: 10 }}
              placeholder="Tìm theo tên nhân sự..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>

        <div className="vms-strip-right">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setModalFace({ mode: 'add' })}
            id="add-face-btn"
          >
            <Plus size={14} /> Đăng ký khuôn mặt
          </button>
        </div>
      </div>

      {filteredFaces.length === 0 && !loading ? (
        <div className="empty-state card">
          <Users size={48} />
          <p>
            {search
              ? 'Không tìm thấy hồ sơ khuôn mặt phù hợp.'
              : 'Chưa đăng ký khuôn mặt nào. Thêm ảnh chân dung để hệ thống nhận diện tự động.'}
          </p>
        </div>
      ) : (
        <div className="vms-face-grid">
          {filteredFaces.map((face) => {
            const imgUrl = face.photo_path ? getMediaUrl(`snapshots/${face.photo_path}`) : null;
            return (
              <div key={face.id} className="card vms-face-card" id={`face-${face.id}`}>
                <div className="vms-face-avatar-wrap">
                  {imgUrl ? (
                    <LazyEventImage
                      src={imgUrl}
                      alt={face.name}
                      aspectRatio="1/1"
                      onClick={() =>
                        setZoomImage({
                          src: imgUrl,
                          title: `Hồ sơ khuôn mặt: ${face.name}`,
                        })
                      }
                    />
                  ) : (
                    <div
                      style={{
                        aspectRatio: '1/1',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        background: 'var(--bg-secondary)',
                      }}
                    >
                      <Users size={40} style={{ color: 'var(--text-muted)' }} />
                    </div>
                  )}
                  <span className="vms-face-count-tag text-mono">
                    {face.event_count || 0} lần khớp
                  </span>
                </div>

                <div className="card-body" style={{ padding: 12 }}>
                  <div className="font-bold text-sm truncate">{face.name}</div>
                  <div className="text-xs text-muted flex items-center gap-1 mt-1">
                    <Clock size={11} />
                    <span>
                      {face.last_seen
                        ? format(new Date(face.last_seen), 'HH:mm dd/MM/yyyy')
                        : 'Chưa ghi nhận'}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 mt-3">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm flex-1"
                      onClick={() => setModalFace({ mode: 'edit', face })}
                    >
                      <Edit3 size={12} /> Sửa
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      onClick={() => handleDelete(face.id, face.name)}
                      title="Xóa hồ sơ"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modalFace && (
        <FaceFormModal
          mode={modalFace.mode}
          initialFace={modalFace.face}
          onClose={() => setModalFace(null)}
          onSaved={fetchFaces}
        />
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

function FaceFormModal({ mode, initialFace, onClose, onSaved }) {
  const [name, setName] = useState(initialFace?.name || '');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(
    initialFace?.photo_path ? getMediaUrl(`snapshots/${initialFace.photo_path}`) : null
  );
  const [saving, setSaving] = useState(false);

  const handleFile = (e) => {
    const f = e.target.files[0];
    if (f) {
      setFile(f);
      setPreview(URL.createObjectURL(f));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    const formData = new FormData();
    formData.append('name', name.trim());
    if (file) formData.append('photo', file);
    try {
      if (mode === 'edit' && initialFace) {
        await updateFace(initialFace.id, formData);
      } else {
        await addFace(formData);
      }
      onSaved();
      onClose();
    } catch (err) {
      alert('Lỗi: ' + (err.response?.data?.error || err.message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">
            {mode === 'edit' ? 'Cập nhật hồ sơ khuôn mặt' : 'Đăng ký khuôn mặt mới'}
          </h3>
          <button type="button" className="btn-icon" onClick={onClose}>
            <span>✕</span>
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {preview && (
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <img
                  src={preview}
                  alt="preview"
                  style={{
                    width: 150,
                    height: 150,
                    borderRadius: 10,
                    objectFit: 'cover',
                    border: '2px solid var(--accent)',
                  }}
                />
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Họ và Tên *</label>
              <input
                className="form-input"
                placeholder="Nhập tên nhân sự / thành viên"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <div className="form-group">
              <label className="form-label">Ảnh chân dung rõ mặt (JPEG, PNG, WebP)</label>
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="form-input"
                onChange={handleFile}
              />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Hủy
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Đang lưu...' : mode === 'edit' ? 'Cập nhật' : 'Đăng ký'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
