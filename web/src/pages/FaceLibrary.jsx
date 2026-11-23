import React, { useState, useEffect } from 'react';
import { getFaces, addFace, deleteFace, getMediaUrl } from '../utils/api';
import { Users, Plus, Trash2, Clock } from 'lucide-react';
import { format } from 'date-fns';
import { ImageZoomModal } from './Events';

export default function FaceLibrary() {
  const [faces, setFaces] = useState([]);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [zoomImage, setZoomImage] = useState(null);

  const fetchFaces = async () => {
    try {
      const data = await getFaces();
      setFaces(data);
    } catch (err) { console.error(err); }
    finally { setLoading(false); }
  };

  useEffect(() => { fetchFaces(); }, []);

  const handleDelete = async (id, name) => {
    if (!confirm(`Xóa khuôn mặt "${name}"?`)) return;
    await deleteFace(id);
    fetchFaces();
  };

  return (
    <div>
      <div className="toolbar">
        <div className="toolbar-group">
          <Users size={18} className="text-muted" />
          <span className="text-sm">{faces.length} khuôn mặt đã đăng ký</span>
        </div>
        <button className="btn btn-primary" onClick={() => setShowAdd(true)} id="add-face-btn">
          <Plus size={16} /> Thêm khuôn mặt
        </button>
      </div>

      {faces.length === 0 && !loading ? (
        <div className="empty-state">
          <Users size={48} />
          <p>Chưa đăng ký khuôn mặt nào. Thêm ảnh khuôn mặt để bắt đầu nhận dạng.</p>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
          {faces.map(face => (
            <div key={face.id} className="card" id={`face-${face.id}`}>
              <div style={{ aspectRatio: '1', background: 'var(--bg-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
                {face.photo_path ? (
                  <img 
                    src={getMediaUrl(`snapshots/${face.photo_path}`)} 
                    alt={face.name}
                    loading="lazy"
                    decoding="async"
                    style={{ width: '100%', height: '100%', objectFit: 'cover', cursor: 'zoom-in' }}
                    onClick={() => setZoomImage({
                      src: getMediaUrl(`snapshots/${face.photo_path}`),
                      title: `Khuôn mặt: ${face.name}`
                    })}
                  />
                ) : (
                  <Users size={40} style={{ color: 'var(--text-muted)' }} />
                )}
              </div>
              <div className="card-body">
                <div className="font-bold">{face.name}</div>
                <div className="text-xs text-muted mt-2">
                  {face.event_count || 0} lần xuất hiện
                </div>
                {face.last_seen && (
                  <div className="text-xs text-muted flex items-center gap-2 mt-2">
                    <Clock size={10} />
                    {format(new Date(face.last_seen), 'HH:mm dd/MM/yyyy')}
                  </div>
                )}
                <button className="btn btn-danger btn-sm w-full mt-2" onClick={() => handleDelete(face.id, face.name)}>
                  <Trash2 size={12} /> Xóa
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && <AddFaceModal onClose={() => setShowAdd(false)} onAdded={fetchFaces} />}
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

function AddFaceModal({ onClose, onAdded }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
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
    if (!name) return;
    setSaving(true);
    const formData = new FormData();
    formData.append('name', name);
    if (file) formData.append('photo', file);
    try {
      await addFace(formData);
      onAdded();
      onClose();
    } catch (err) {
      alert('Lỗi: ' + (err.response?.data?.error || err.message));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">Đăng ký khuôn mặt</h3>
          <button className="btn-icon" onClick={onClose}><span>✕</span></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            {preview && (
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <img src={preview} alt="preview" style={{ maxWidth: 200, maxHeight: 200, borderRadius: 8, objectFit: 'cover' }} />
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Tên *</label>
              <input className="form-input" placeholder="Tên người" value={name} onChange={e => setName(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Ảnh khuôn mặt</label>
              <input type="file" accept="image/*" className="form-input" onChange={handleFile} />
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Hủy</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Đang lưu...' : 'Đăng ký'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
