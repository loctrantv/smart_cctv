import React, { useState, useEffect } from 'react';
import {
  getSystemInfo,
  getSettings,
  updateSettings,
  getCameras,
  updateCamera,
  deleteCamera,
  changePassword,
  getAiModels,
  downloadAiModel,
} from '../utils/api';
import { useApp } from '../App';
import {
  HardDrive,
  Cpu,
  Save,
  RefreshCw,
  Camera,
  Volume2,
  Activity,
  Trash2,
  Shield,
  Lock,
  Edit3,
  Check,
  X,
} from 'lucide-react';

export default function SettingsPage() {
  const [sysInfo, setSysInfo] = useState(null);
  const [settings, setSettings] = useState({});
  const [cameras, setCameras] = useState([]);
  const [aiModels, setAiModels] = useState([]);
  const [downloadingModel, setDownloadingModel] = useState({});
  const [activeTab, setActiveTab] = useState('general');
  const [saving, setSaving] = useState(false);
  const [toastMsg, setToastMsg] = useState('');

  // Inline Camera Edit State
  const [editingCamId, setEditingCamId] = useState(null);
  const [camForm, setCamForm] = useState({ name: '', location: '', rtsp_url: '' });
  const [camSaving, setCamSaving] = useState(false);

  // Password change state
  const { user, onAuthUpdate, refreshGlobalStats } = useApp();
  const [pwdForm, setPwdForm] = useState({
    newUsername: user?.username || 'admin',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [pwdSaving, setPwdSaving] = useState(false);
  const [pwdMsg, setPwdMsg] = useState({ type: '', text: '' });

  const loadAll = () => {
    getSystemInfo().then(setSysInfo).catch(() => {});
    getSettings().then(setSettings).catch(() => {});
    getCameras().then(setCameras).catch(() => {});
    getAiModels().then(setAiModels).catch(() => {});
  };

  const handleDownloadModel = async (modelId) => {
    setDownloadingModel((prev) => ({ ...prev, [modelId]: true }));
    try {
      const res = await downloadAiModel(modelId);
      showToast(res.message || 'Đã tải và kích hoạt model AI!');
      const updated = await getAiModels();
      setAiModels(updated);
    } catch (err) {
      alert('Lỗi tải model AI: ' + (err.response?.data?.error || err.message));
    } finally {
      setDownloadingModel((prev) => ({ ...prev, [modelId]: false }));
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const showToast = (msg) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 3500);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings(settings);
      showToast('Đã lưu và áp dụng cài đặt thành công (Hot-Reload)!');
    } catch (err) {
      alert('Lỗi: ' + (err.response?.data?.error || err.message));
    } finally {
      setSaving(false);
    }
  };

  const startEditCamera = (cam) => {
    setEditingCamId(cam.id);
    setCamForm({
      name: cam.name || '',
      location: cam.location || '',
      rtsp_url: '', // Keep empty unless operator wants to overwrite RTSP URL
    });
  };

  const handleSaveCameraEdit = async (camId) => {
    setCamSaving(true);
    try {
      const payload = {
        name: camForm.name,
        location: camForm.location,
      };
      if (camForm.rtsp_url && camForm.rtsp_url.trim()) {
        payload.rtsp_url = camForm.rtsp_url.trim();
      }
      await updateCamera(camId, payload);
      setEditingCamId(null);
      const updatedList = await getCameras();
      setCameras(updatedList);
      if (refreshGlobalStats) refreshGlobalStats();
      showToast('Đã cập nhật thông tin kênh camera!');
    } catch (err) {
      alert('Không thể cập nhật camera: ' + (err.response?.data?.error || err.message));
    } finally {
      setCamSaving(false);
    }
  };

  const handleDeleteCamera = async (id) => {
    if (!confirm('Xóa kênh camera này? Tất cả bản ghi và sự kiện liên quan sẽ bị xóa.')) return;
    try {
      await deleteCamera(id);
      setCameras(cameras.filter((c) => c.id !== id));
      if (refreshGlobalStats) refreshGlobalStats();
      showToast('Đã xóa kênh camera');
    } catch (err) {
      alert('Lỗi khi xóa camera: ' + (err.response?.data?.error || err.message));
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    setPwdMsg({ type: '', text: '' });

    if (!pwdForm.currentPassword || !pwdForm.newPassword) {
      setPwdMsg({ type: 'error', text: 'Vui lòng nhập đầy đủ mật khẩu hiện tại và mật khẩu mới' });
      return;
    }
    if (pwdForm.newPassword.length < 8) {
      setPwdMsg({ type: 'error', text: 'Mật khẩu mới phải có ít nhất 8 ký tự' });
      return;
    }
    if (pwdForm.newPassword !== pwdForm.confirmPassword) {
      setPwdMsg({ type: 'error', text: 'Mật khẩu xác nhận không khớp' });
      return;
    }

    setPwdSaving(true);
    try {
      const res = await changePassword({
        currentPassword: pwdForm.currentPassword,
        newPassword: pwdForm.newPassword,
        newUsername: pwdForm.newUsername,
      });
      if (res.token && res.user && onAuthUpdate) {
        onAuthUpdate(res.token, res.user);
      }
      setPwdForm((prev) => ({
        ...prev,
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      }));
      setPwdMsg({
        type: 'success',
        text: 'Đã cập nhật mật khẩu thành công! Các phiên đăng nhập cũ đã bị thu hồi.',
      });
    } catch (err) {
      setPwdMsg({
        type: 'error',
        text: err.response?.data?.error || 'Không thể đổi mật khẩu',
      });
    } finally {
      setPwdSaving(false);
    }
  };

  const formatBytes = (bytes) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const TABS = [
    { id: 'general', label: 'Kênh Camera' },
    { id: 'storage', label: 'Lưu trữ NVR' },
    { id: 'detection', label: 'Phát hiện AI' },
    { id: 'sound', label: 'Âm thanh đêm' },
    { id: 'security', label: 'Bảo mật' },
    { id: 'system', label: 'Phần cứng' },
  ];

  const hasSaveButton = ['storage', 'detection', 'sound'].includes(activeTab);

  const maxQuotaBytes = (parseInt(settings['storage.max_gb'] || '100', 10) || 100) * 1024 * 1024 * 1024;
  const usedStorageBytes = sysInfo?.app?.totalStorageUsed || 0;
  const usedQuotaPct = Math.min(100, Math.round((usedStorageBytes / maxQuotaBytes) * 100));

  return (
    <div style={{ maxWidth: 880, margin: '0 auto' }}>
      {toastMsg && (
        <div className="vms-toast-banner">
          <Check size={15} />
          <span>{toastMsg}</span>
        </div>
      )}

      <div className="tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── General: Camera Channel Management with Inline Editing ── */}
      {activeTab === 'general' && (
        <div className="card">
          <div className="card-header">
            <span className="font-bold flex items-center gap-2">
              <Camera size={16} style={{ color: 'var(--accent)' }} /> Danh Sách Kênh Camera ({cameras.length})
            </span>
          </div>
          <div className="card-body" style={{ padding: 14 }}>
            {cameras.length === 0 ? (
              <p className="text-muted text-center p-4">Chưa có camera nào được cấu hình</p>
            ) : (
              <div className="flex flex-col gap-3">
                {cameras.map((cam, idx) => {
                  const isEditing = editingCamId === cam.id;
                  return (
                    <div
                      key={cam.id}
                      className="card"
                      style={{ background: 'var(--bg-secondary)' }}
                    >
                      <div className="card-body" style={{ padding: '12px 16px' }}>
                        {isEditing ? (
                          <div className="flex flex-col gap-3">
                            <div
                              style={{
                                display: 'grid',
                                gridTemplateColumns: '1fr 1fr',
                                gap: 10,
                              }}
                            >
                              <div>
                                <label className="form-label">Tên kênh camera</label>
                                <input
                                  className="form-input"
                                  value={camForm.name}
                                  onChange={(e) =>
                                    setCamForm({ ...camForm, name: e.target.value })
                                  }
                                />
                              </div>
                              <div>
                                <label className="form-label">Vị trí lắp đặt</label>
                                <input
                                  className="form-input"
                                  value={camForm.location}
                                  onChange={(e) =>
                                    setCamForm({ ...camForm, location: e.target.value })
                                  }
                                />
                              </div>
                            </div>
                            <div>
                              <label className="form-label">
                                RTSP URL mới (Để trống nếu giữ nguyên: {cam.rtsp_url})
                              </label>
                              <input
                                className="form-input text-mono text-xs"
                                placeholder="rtsp://admin:password@192.168.1.100:554/stream1"
                                value={camForm.rtsp_url}
                                onChange={(e) =>
                                  setCamForm({ ...camForm, rtsp_url: e.target.value })
                                }
                              />
                            </div>
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => setEditingCamId(null)}
                              >
                                <X size={13} /> Hủy
                              </button>
                              <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                disabled={camSaving}
                                onClick={() => handleSaveCameraEdit(cam.id)}
                              >
                                <Check size={13} /> {camSaving ? 'Đang lưu...' : 'Lưu thay đổi'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="vms-ch-tag text-mono">
                                  CH{String(idx + 1).padStart(2, '0')}
                                </span>
                                <span className="font-bold text-sm">{cam.name}</span>
                                {cam.location && (
                                  <span className="text-xs text-muted">· {cam.location}</span>
                                )}
                              </div>
                              <div className="text-xs text-muted text-mono mt-1 truncate">
                                {cam.rtsp_url}
                              </div>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                              <div className={`status-dot ${cam.enabled ? '' : 'offline'}`} />
                              <span className="text-xs mr-1">
                                {cam.enabled ? 'Online' : 'Offline'}
                              </span>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                style={{ height: 30, padding: '0 10px' }}
                                onClick={() => startEditCamera(cam)}
                              >
                                <Edit3 size={13} /> Sửa
                              </button>
                              <button
                                type="button"
                                className="btn btn-danger btn-sm"
                                style={{ height: 30, padding: '0 10px' }}
                                onClick={() => handleDeleteCamera(cam.id)}
                                title="Xóa camera"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Storage ── */}
      {activeTab === 'storage' && (
        <div className="card">
          <div className="card-header">
            <span className="font-bold flex items-center gap-2">
              <HardDrive size={16} style={{ color: 'var(--accent)' }} /> Quản Lý Lưu Trữ NVR
            </span>
          </div>
          <div className="card-body" style={{ padding: 16 }}>
            {sysInfo && (
              <div className="vms-meter-box mb-4">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold">Dung lượng bản ghi NVR đã dùng</span>
                  <span className="text-xs text-mono">
                    {formatBytes(usedStorageBytes)} / {settings['storage.max_gb'] || '100'} GB ({usedQuotaPct}%)
                  </span>
                </div>
                <div className="vms-meter-rail">
                  <div
                    className="vms-meter-fill"
                    style={{
                      width: `${usedQuotaPct}%`,
                      background:
                        usedQuotaPct > 85
                          ? 'var(--danger)'
                          : usedQuotaPct > 65
                          ? 'var(--warning)'
                          : 'var(--accent)',
                    }}
                  />
                </div>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Hạn mức dung lượng lưu trữ tối đa (GB)</label>
              <input
                className="form-input"
                type="number"
                value={settings['storage.max_gb'] || '100'}
                onChange={(e) => setSettings({ ...settings, 'storage.max_gb': e.target.value })}
              />
            </div>
            <div className="form-group mt-3">
              <label className="form-label">Thời gian tự động xoay vòng xóa file cũ (ngày)</label>
              <input
                className="form-input"
                type="number"
                value={settings['storage.retention_days'] || '30'}
                onChange={(e) =>
                  setSettings({ ...settings, 'storage.retention_days': e.target.value })
                }
              />
            </div>
            <div className="form-group mt-3">
              <label className="form-label">Thời lượng cắt file mỗi đoạn ghi liên tục (phút)</label>
              <input
                className="form-input"
                type="number"
                value={settings['recording.segment_minutes'] || '15'}
                onChange={(e) =>
                  setSettings({ ...settings, 'recording.segment_minutes': e.target.value })
                }
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Motion & Multi-Tier ONNX AI Detection ── */}
      {activeTab === 'detection' && (
        <div className="flex flex-col gap-3">
          {/* ONNX AI Models Manager Card */}
          <div className="card">
            <div className="card-header">
              <span className="font-bold flex items-center gap-2">
                <Cpu size={16} style={{ color: 'var(--accent)' }} /> Quản Lý 5 Mô-Đun AI ONNX (Rust Engine)
              </span>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => getAiModels().then(setAiModels)}
              >
                <RefreshCw size={12} /> Kiểm tra
              </button>
            </div>
            <div className="card-body" style={{ padding: 14 }}>
              <p className="text-xs text-muted mb-3">
                Tải và kích hoạt nóng (Hot-load) các mô hình mạng nơ-ron ONNX trực tiếp vào bộ nhớ
                Rust mà không cần khởi động lại máy chủ:
              </p>
              <div className="flex flex-col gap-2">
                {aiModels.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between gap-3 p-3"
                    style={{
                      background: 'var(--bg-secondary)',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                    }}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-sm">{m.name}</span>
                        <span className="text-xs text-mono text-muted">({m.size_mb} MB)</span>
                        {m.installed ? (
                          <span className="vms-osd-badge ai">ĐÃ KÍCH HOẠT</span>
                        ) : (
                          <span className="vms-osd-badge rec">CHƯA TẢI</span>
                        )}
                      </div>
                      <div className="text-xs text-muted mt-1">{m.description}</div>
                    </div>
                    <button
                      type="button"
                      className={`btn btn-sm ${m.installed ? 'btn-secondary' : 'btn-primary'}`}
                      disabled={downloadingModel[m.id]}
                      onClick={() => handleDownloadModel(m.id)}
                    >
                      {downloadingModel[m.id]
                        ? 'Đang tải...'
                        : m.installed
                        ? 'Cập nhật lại'
                        : 'Tải & Kích hoạt'}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="font-bold flex items-center gap-2">
                <Activity size={16} style={{ color: 'var(--success)' }} /> Thông Số Quét & Ghi Hình Sự Kiện
              </span>
            </div>
            <div className="card-body" style={{ padding: 16 }}>
              <div className="form-group">
                <label className="form-label">Chu kỳ quét khung hình (ms)</label>
                <input
                  className="form-input"
                  type="number"
                  value={settings['detection.interval_ms'] || '2500'}
                  onChange={(e) =>
                    setSettings({ ...settings, 'detection.interval_ms': e.target.value })
                  }
                />
              </div>

              <div className="form-group mt-3">
                <label className="form-label">Ngưỡng tin cậy AI (0.0 – 1.0)</label>
                <input
                  className="form-input"
                  type="number"
                  step="0.05"
                  min="0.1"
                  max="1"
                  value={settings['detection.confidence_threshold'] || '0.45'}
                  onChange={(e) =>
                    setSettings({ ...settings, 'detection.confidence_threshold': e.target.value })
                  }
                />
              </div>

              <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid var(--border)' }} />

              <div className="form-group">
                <label className="form-label">Tự động ghi hình sự kiện khi phát hiện</label>
                <select
                  className="form-input"
                  value={settings['recording.on_motion_enabled'] || '0'}
                  onChange={(e) =>
                    setSettings({ ...settings, 'recording.on_motion_enabled': e.target.value })
                  }
                >
                  <option value="0">Tắt (Chỉ chụp ảnh Snapshot sự kiện)</option>
                  <option value="1">Bật (Tự động quay video MP4 khi phát hiện)</option>
                </select>
              </div>

              <div className="form-group mt-3">
                <label className="form-label">Thời lượng đoạn video sự kiện (giây)</label>
                <input
                  className="form-input"
                  type="number"
                  min="5"
                  max="300"
                  value={settings['recording.on_motion_duration'] || '30'}
                  onChange={(e) =>
                    setSettings({ ...settings, 'recording.on_motion_duration': e.target.value })
                  }
                />
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Night Sound Detection ── */}
      {activeTab === 'sound' && (
        <div className="card">
          <div className="card-header">
            <span className="font-bold flex items-center gap-2">
              <Volume2 size={16} style={{ color: '#f59e0b' }} />
              Phát Hiện Âm Thanh Bất Thường Ban Đêm
            </span>
          </div>
          <div className="card-body" style={{ padding: 16 }}>
            <div className="form-group">
              <label className="form-label">Trạng thái kích hoạt</label>
              <select
                className="form-input"
                value={settings['sound.detection_enabled'] || '0'}
                onChange={(e) =>
                  setSettings({ ...settings, 'sound.detection_enabled': e.target.value })
                }
              >
                <option value="0">Tắt</option>
                <option value="1">Bật — Giám sát cường độ âm thanh RMS trong khung giờ đêm</option>
              </select>
            </div>

            <hr style={{ margin: '18px 0', border: 'none', borderTop: '1px solid var(--border)' }} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">Giờ bắt đầu trực đêm (0–23h)</label>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  max="23"
                  value={settings['sound.night_start'] ?? '22'}
                  onChange={(e) =>
                    setSettings({ ...settings, 'sound.night_start': e.target.value })
                  }
                />
              </div>
              <div className="form-group">
                <label className="form-label">Giờ kết thúc trực đêm (0–23h)</label>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  max="23"
                  value={settings['sound.night_end'] ?? '6'}
                  onChange={(e) => setSettings({ ...settings, 'sound.night_end': e.target.value })}
                />
              </div>
            </div>

            <div className="form-group mt-3">
              <label className="form-label">Ngưỡng kích hoạt âm lượng (dBFS)</label>
              <input
                className="form-input"
                type="number"
                min="-60"
                max="0"
                step="1"
                value={settings['sound.threshold_db'] ?? '-20'}
                onChange={(e) => setSettings({ ...settings, 'sound.threshold_db': e.target.value })}
              />
              <div className="text-xs text-muted mt-1">
                -30 dBFS ≈ nói chuyện · -20 dBFS ≈ tiếng động lớn · -10 dBFS ≈ tiếng va đập mạnh / la hét
              </div>
            </div>

            <div className="form-group mt-3">
              <label className="form-label">Tự động quay video khi có âm thanh lạ</label>
              <select
                className="form-input"
                value={settings['sound.recording_enabled'] || '1'}
                onChange={(e) =>
                  setSettings({ ...settings, 'sound.recording_enabled': e.target.value })
                }
              >
                <option value="0">Tắt — Chỉ ghi nhận sự kiện cảnh báo</option>
                <option value="1">Bật — Tự động ghi hình kênh phát sinh tiếng động</option>
              </select>
            </div>

            <div className="form-group mt-3">
              <label className="form-label">Thời lượng quay (giây)</label>
              <input
                className="form-input"
                type="number"
                min="5"
                max="300"
                value={settings['sound.recording_duration'] || '30'}
                onChange={(e) =>
                  setSettings({ ...settings, 'sound.recording_duration': e.target.value })
                }
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Security / Password Management ── */}
      {activeTab === 'security' && (
        <div className="card">
          <div className="card-header">
            <span className="font-bold flex items-center gap-2">
              <Shield size={16} style={{ color: 'var(--accent)' }} /> Bảo Mật Tài Khoản Quản Trị
            </span>
          </div>
          <div className="card-body" style={{ padding: 16 }}>
            {pwdMsg.text && (
              <div
                style={{
                  padding: '10px 14px',
                  borderRadius: 8,
                  marginBottom: 16,
                  fontSize: '0.85rem',
                  background:
                    pwdMsg.type === 'error'
                      ? 'rgba(239, 68, 68, 0.15)'
                      : 'rgba(16, 185, 129, 0.15)',
                  color: pwdMsg.type === 'error' ? 'var(--danger)' : 'var(--success)',
                  border: `1px solid ${
                    pwdMsg.type === 'error'
                      ? 'rgba(239, 68, 68, 0.3)'
                      : 'rgba(16, 185, 129, 0.3)'
                  }`,
                }}
              >
                {pwdMsg.text}
              </div>
            )}

            <form onSubmit={handlePasswordChange}>
              <div className="form-group">
                <label className="form-label">Tên đăng nhập quản trị</label>
                <input
                  className="form-input"
                  type="text"
                  value={pwdForm.newUsername}
                  onChange={(e) => setPwdForm({ ...pwdForm, newUsername: e.target.value })}
                />
              </div>

              <div className="form-group mt-3">
                <label className="form-label">Mật khẩu hiện tại *</label>
                <input
                  className="form-input"
                  type="password"
                  placeholder="Nhập mật khẩu hiện tại"
                  value={pwdForm.currentPassword}
                  onChange={(e) => setPwdForm({ ...pwdForm, currentPassword: e.target.value })}
                />
              </div>

              <div className="form-group mt-3">
                <label className="form-label">Mật khẩu mới * (Tối thiểu 8 ký tự, băm scrypt)</label>
                <input
                  className="form-input"
                  type="password"
                  placeholder="Nhập mật khẩu mới"
                  value={pwdForm.newPassword}
                  onChange={(e) => setPwdForm({ ...pwdForm, newPassword: e.target.value })}
                />
              </div>

              <div className="form-group mt-3">
                <label className="form-label">Xác nhận mật khẩu mới *</label>
                <input
                  className="form-input"
                  type="password"
                  placeholder="Nhập lại mật khẩu mới"
                  value={pwdForm.confirmPassword}
                  onChange={(e) => setPwdForm({ ...pwdForm, confirmPassword: e.target.value })}
                />
              </div>

              <div className="mt-4 flex justify-end">
                <button type="submit" className="btn btn-primary" disabled={pwdSaving}>
                  <Lock size={15} /> {pwdSaving ? 'Đang cập nhật...' : 'Cập nhật thông tin bảo mật'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── System Hardware Telemetry ── */}
      {activeTab === 'system' && sysInfo && (
        <div className="card">
          <div className="card-header">
            <span className="font-bold flex items-center gap-2">
              <Cpu size={16} style={{ color: 'var(--accent)' }} /> Giám Sát Tài Nguyên Máy Chủ NVR
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => getSystemInfo().then(setSysInfo)}
            >
              <RefreshCw size={12} /> Làm mới
            </button>
          </div>
          <div className="card-body" style={{ padding: 16 }}>
            {/* Memory & Disk Progress Gauges */}
            <div className="vms-meter-box mb-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold">Bộ nhớ RAM hệ thống</span>
                <span className="text-xs text-mono">
                  {formatBytes(sysInfo.system.usedMemory)} / {formatBytes(sysInfo.system.totalMemory)} (
                  {sysInfo.system.memoryPercent}%)
                </span>
              </div>
              <div className="vms-meter-rail">
                <div
                  className="vms-meter-fill"
                  style={{
                    width: `${sysInfo.system.memoryPercent}%`,
                    background:
                      sysInfo.system.memoryPercent > 85 ? 'var(--danger)' : 'var(--accent)',
                  }}
                />
              </div>
            </div>

            {sysInfo.disk && sysInfo.disk.total > 0 && (
              <div className="vms-meter-box mb-4">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold">Ổ cứng chứa bản ghi (Disk Partition)</span>
                  <span className="text-xs text-mono">
                    Đã dùng {formatBytes(sysInfo.disk.used)} / Tổng {formatBytes(sysInfo.disk.total)} (Còn trống{' '}
                    {formatBytes(sysInfo.disk.free)})
                  </span>
                </div>
                <div className="vms-meter-rail">
                  <div
                    className="vms-meter-fill"
                    style={{
                      width: `${Math.round((sysInfo.disk.used / sysInfo.disk.total) * 100)}%`,
                      background: 'var(--success)',
                    }}
                  />
                </div>
              </div>
            )}

            <div className="vms-kv-list">
              <div className="vms-kv-row">
                <span className="text-xs text-muted">Tên máy chủ (Hostname)</span>
                <span className="text-xs text-mono font-bold">{sysInfo.system.hostname}</span>
              </div>
              <div className="vms-kv-row">
                <span className="text-xs text-muted">Hệ điều hành</span>
                <span className="text-xs text-mono">
                  {sysInfo.system.platform} ({sysInfo.system.arch})
                </span>
              </div>
              <div className="vms-kv-row">
                <span className="text-xs text-muted">Vi xử lý (CPU)</span>
                <span className="text-xs text-mono">
                  {sysInfo.system.cpuCount} Cores — {sysInfo.system.cpuModel}
                </span>
              </div>
              <div className="vms-kv-row">
                <span className="text-xs text-muted">Thời gian hoạt động OS (Uptime)</span>
                <span className="text-xs text-mono">
                  {Math.floor(sysInfo.system.uptime / 3600)}h{' '}
                  {Math.floor((sysInfo.system.uptime % 3600) / 60)}m
                </span>
              </div>
              <div className="vms-kv-row">
                <span className="text-xs text-muted">Thời gian hoạt động dịch vụ VMS</span>
                <span className="text-xs text-mono">
                  {Math.floor(sysInfo.app.uptime / 3600)}h{' '}
                  {Math.floor((sysInfo.app.uptime % 3600) / 60)}m
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Save Button ── */}
      {hasSaveButton && (
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={saving}
            id="save-settings"
          >
            <Save size={15} /> {saving ? 'Đang áp dụng...' : 'Lưu & Áp dụng ngay'}
          </button>
        </div>
      )}
    </div>
  );
}
