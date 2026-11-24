import React, { useState, useEffect, useMemo } from 'react';
import { getFaces, addFace, updateFace, deleteFace, getMediaUrl } from '../utils/api';
import { Users, Plus, Trash2, Clock, Search, Edit3, ScanFace, User } from 'lucide-react';
import { format } from 'date-fns';
import { ImageZoomModal, LazyEventImage } from './Events';
import { TechInput, TechFileDropzone, useTechDialog } from '../components/TechUI';

export default function FaceLibrary() {
  const { confirmDialog, showToast } = useTechDialog();
  const [faces, setFaces] = useState([]);
  const [search, setSearch] = useState('');
  const [modalFace, setModalFace] = useState(null);
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
    const ok = await confirmDialog({
      title: 'XÓA HỒ SƠ KHUÔN MẶT',
      message: `Hồ sơ nhận diện và vector 512-D của "${name}" sẽ bị xóa khỏi CSDL. Bạn có chắc chắn?`,
      confirmText: 'Xóa hồ sơ',
      cancelText: 'Hủy',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteFace(id);
      showToast(`Đã xóa hồ sơ khuôn mặt "${name}"`, 'success');
      fetchFaces();
    } catch (err) {
      showToast('Không thể xóa khuôn mặt', 'error');
    }
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
            <span className="text-sm font-bold">CSDL Nhận Diện Khuôn Mặt (512-D)</span>
            <span className="vms-osd-badge ai">{faces.length} hồ sơ</span>
          </div>

          <div className="vms-divider" />

          <div className="tech-input-shell vms-face-search-input">
            <span className="tech-input-icon-left">
              <Search size={13} />
            </span>
            <input
              type="text"
              className="tech-input-control has-left-icon"
              style={{ height: 32, fontSize: '0.78rem' }}
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
              : 'Chưa đăng ký khuôn mặt nào. Thêm ảnh chân dung để hệ thống trích xuất Vector 512-D tự động.'}
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
  const { showToast } = useTechDialog();
  const [name, setName] = useState(initialFace?.name || '');
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(
    initialFace?.photo_path ? getMediaUrl(`snapshots/${initialFace.photo_path}`) : null
  );
  const [saving, setSaving] = useState(false);

  const handleFile = (f) => {
    if (f) {
      setFile(f);
      setPreview(URL.createObjectURL(f));
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      showToast('Vui lòng nhập họ và tên nhân sự', 'warning');
      return;
    }
    setSaving(true);
    const formData = new FormData();
    formData.append('name', name.trim());
    if (file) formData.append('photo', file);
    try {
      if (mode === 'edit' && initialFace) {
        await updateFace(initialFace.id, formData);
        showToast('Đã cập nhật hồ sơ & Vector 512-D thành công!', 'success');
      } else {
        await addFace(formData);
        showToast('Đã đăng ký khuôn mặt & trích xuất Vector 512-D!', 'success');
      }
      onSaved();
      onClose();
    } catch (err) {
      showToast('Lỗi: ' + (err.response?.data?.error || err.message), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tech-modal-backdrop" onClick={onClose}>
      <div
        className="tech-confirm-modal"
        style={{ maxWidth: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tech-corner tl" />
        <div className="tech-corner tr" />
        <div className="tech-corner bl" />
        <div className="tech-corner br" />

        <div className="tech-confirm-header">
          <div
            className="tech-confirm-icon"
            style={{ color: 'var(--face)', background: 'rgba(168, 85, 247, 0.15)' }}
          >
            <ScanFace size={20} />
          </div>
          <div className="flex-1">
            <div className="tech-confirm-tag text-mono">BIOMETRIC ENROLLMENT</div>
            <h3 className="tech-confirm-title">
              {mode === 'edit' ? 'Cập Nhật Hồ Sơ Khuôn Mặt' : 'Đăng Ký Khuôn Mặt Mới'}
            </h3>
          </div>
          <button type="button" className="btn-icon" onClick={onClose}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="tech-confirm-body">
            <TechInput
              label="Họ và Tên Nhân Sự *"
              icon={User}
              placeholder="Nhập tên nhân sự / thành viên"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />

            <TechFileDropzone
              label="Ảnh Chân Dung Rõ Mặt (Tự động trích xuất Vector 512-D)"
              accept="image/jpeg,image/png,image/webp"
              onFileSelect={handleFile}
              previewUrl={preview}
            />
          </div>

          <div className="tech-confirm-footer">
            <button type="button" className="tech-btn tech-btn-ghost" onClick={onClose}>
              Hủy bỏ
            </button>
            <button type="submit" className="tech-btn tech-btn-primary" disabled={saving}>
              {saving ? 'Đang trích xuất AI...' : mode === 'edit' ? 'Cập nhật hồ sơ' : 'Đăng ký ngay'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
