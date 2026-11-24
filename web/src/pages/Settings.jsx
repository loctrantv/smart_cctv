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
  TechInput,
  TechNumberInput,
  TechSwitch,
  useTechDialog,
} from '../components/TechUI';
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
  User,
  Link,
  MapPin,
} from 'lucide-react';

export default function SettingsPage() {
  const { confirmDialog, showToast } = useTechDialog();
  const [sysInfo, setSysInfo] = useState(null);
  const [settings, setSettings] = useState({});
  const [cameras, setCameras] = useState([]);
  const [aiModels, setAiModels] = useState([]);
  const [downloadingModel, setDownloadingModel] = useState({});
  const [activeTab, setActiveTab] = useState('general');
  const [saving, setSaving] = useState(false);

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

  const loadAll = () => {
    getSystemInfo().then(setSysInfo).catch(() => {});
    getSettings().then(setSettings).catch(() => {});
    getCameras().then(setCameras).catch(() => {});
    getAiModels().then(setAiModels).catch(() => {});
  };

  useEffect(() => {
    loadAll();
  }, []);

  const handleDownloadModel = async (modelId) => {
    setDownloadingModel((prev) => ({ ...prev, [modelId]: true }));
    try {
      const res = await downloadAiModel(modelId);
      showToast(res.message || 'Đã tải và kích hoạt model AI!', 'success');
      const updated = await getAiModels();
      setAiModels(updated);
    } catch (err) {
      showToast('Lỗi tải model AI: ' + (err.response?.data?.error || err.message), 'error');
    } finally {
      setDownloadingModel((prev) => ({ ...prev, [modelId]: false }));
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings(settings);
      showToast('Đã lưu và áp dụng cài đặt thành công (Hot-Reload)!', 'success');
    } catch (err) {
      showToast('Lỗi: ' + (err.response?.data?.error || err.message), 'error');
    } finally {
      setSaving(false);
    }
  };

  const startEditCamera = (cam) => {
    setEditingCamId(cam.id);
    setCamForm({
      name: cam.name || '',
      location: cam.location || '',
      rtsp_url: '',
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
      showToast('Đã cập nhật thông tin kênh camera!', 'success');
    } catch (err) {
      showToast(
        'Không thể cập nhật camera: ' + (err.response?.data?.error || err.message),
        'error'
      );
    } finally {
      setCamSaving(false);
    }
  };

  const handleDeleteCamera = async (id, name) => {
    const ok = await confirmDialog({
      title: 'XÓA KÊNH CAMERA',
      message: `Xóa kênh "${name}"? Toàn bộ bản ghi MP4 và lịch sử sự kiện AI của kênh này sẽ bị xóa vĩnh viễn.`,
      confirmText: 'Xóa kênh',
      cancelText: 'Hủy',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteCamera(id);
      setCameras(cameras.filter((c) => c.id !== id));
      if (refreshGlobalStats) refreshGlobalStats();
      showToast(`Đã xóa kênh camera "${name}"`, 'success');
    } catch (err) {
      showToast('Lỗi khi xóa camera: ' + (err.response?.data?.error || err.message), 'error');
    }
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();

    if (!pwdForm.currentPassword || !pwdForm.newPassword) {
      showToast('Vui lòng nhập đầy đủ mật khẩu hiện tại và mật khẩu mới', 'warning');
      return;
    }
    if (pwdForm.newPassword.length < 8) {
      showToast('Mật khẩu mới phải có ít nhất 8 ký tự', 'warning');
      return;
    }
    if (pwdForm.newPassword !== pwdForm.confirmPassword) {
      showToast('Mật khẩu xác nhận không khớp', 'warning');
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
      showToast(
        'Đã cập nhật mật khẩu thành công! Các phiên đăng nhập cũ đã bị thu hồi.',
        'success'
      );
    } catch (err) {
      showToast(err.response?.data?.error || 'Không thể đổi mật khẩu', 'error');
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

  const maxQuotaBytes =
    (parseInt(settings['storage.max_gb'] || '100', 10) || 100) * 1024 * 1024 * 1024;
  const usedStorageBytes = sysInfo?.app?.totalStorageUsed || 0;
  const usedQuotaPct = Math.min(100, Math.round((usedStorageBytes / maxQuotaBytes) * 100));

  return (
    <div style={{ maxWidth: 880, margin: '0 auto' }}>
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

      {/* ── General: Camera Channel Management with TechUI Inline Editing ── */}
      {activeTab === 'general' && (
        <div className="card">
          <div className="card-header">
            <span className="font-bold flex items-center gap-2">
              <Camera size={16} style={{ color: 'var(--accent)' }} /> Danh Sách Kênh Camera (
              {cameras.length})
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
                          <div className="flex flex-col gap-2">
                            <div className="vms-grid-2">
                              <TechInput
                                label="Tên kênh camera"
                                icon={Camera}
                                value={camForm.name}
                                onChange={(e) =>
                                  setCamForm({ ...camForm, name: e.target.value })
                                }
                              />
                              <TechInput
                                label="Vị trí lắp đặt"
                                icon={MapPin}
                                value={camForm.location}
                                onChange={(e) =>
                                  setCamForm({ ...camForm, location: e.target.value })
                                }
                              />
                            </div>
                            <TechInput
                              label={`RTSP URL mới (Để trống nếu giữ nguyên: ${cam.rtsp_url})`}
                              icon={Link}
                              mono
                              placeholder="rtsp://admin:password@192.168.1.100:554/stream1"
                              value={camForm.rtsp_url}
                              onChange={(e) =>
                                setCamForm({ ...camForm, rtsp_url: e.target.value })
                              }
                            />
                            <div className="flex justify-end gap-2">
                              <button
                                type="button"
                                className="tech-btn tech-btn-ghost"
                                onClick={() => setEditingCamId(null)}
                              >
                                <X size={13} /> Hủy
                              </button>
                              <button
                                type="button"
                                className="tech-btn tech-btn-primary"
                                disabled={camSaving}
                                onClick={() => handleSaveCameraEdit(cam.id)}
                              >
                                <Check size={13} /> {camSaving ? 'Đang lưu...' : 'Lưu thay đổi'}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="vms-cam-row-item">
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
                                onClick={() => handleDeleteCamera(cam.id, cam.name)}
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
                    {formatBytes(usedStorageBytes)} / {settings['storage.max_gb'] || '100'} GB (
                    {usedQuotaPct}%)
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
            <div className="vms-grid-3">
              <TechNumberInput
                label="Hạn mức lưu trữ tối đa"
                value={settings['storage.max_gb'] || '100'}
                min={5}
                max={10000}
                step={10}
                unit="GB"
                onChange={(val) => setSettings({ ...settings, 'storage.max_gb': val })}
              />
              <TechNumberInput
                label="Thời gian xoay vòng xóa cũ"
                value={settings['storage.retention_days'] || '30'}
                min={1}
                max={365}
                step={1}
                unit="NGÀY"
                onChange={(val) => setSettings({ ...settings, 'storage.retention_days': val })}
              />
              <TechNumberInput
                label="Thời lượng mỗi đoạn MP4"
                value={settings['recording.segment_minutes'] || '15'}
                min={1}
                max={120}
                step={5}
                unit="PHÚT"
                onChange={(val) =>
                  setSettings({ ...settings, 'recording.segment_minutes': val })
                }
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Motion & Multi-Tier ONNX AI Detection ── */}
      {activeTab === 'detection' && (
        <div className="flex flex-col gap-3">
          <div className="card">
            <div className="card-header">
              <span className="font-bold flex items-center gap-2">
                <Cpu size={16} style={{ color: 'var(--accent)' }} /> Quản Lý 5 Mô-Đun AI ONNX (Rust
                Engine)
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
                    className="vms-model-card-row"
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
                      className={`tech-btn ${
                        m.installed ? 'tech-btn-ghost' : 'tech-btn-primary'
                      }`}
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
                <Activity size={16} style={{ color: 'var(--success)' }} /> Thông Số Quét & Ghi Hình
                Sự Kiện AI
              </span>
            </div>
            <div className="card-body" style={{ padding: 16 }}>
              <div className="vms-grid-2">
                <TechNumberInput
                  label="Chu kỳ quét khung hình"
                  hint="Giá trị nhỏ = phát hiện nhanh hơn (Khuyến nghị: 2000 – 3000 ms)"
                  value={settings['detection.interval_ms'] || '2500'}
                  min={500}
                  max={30000}
                  step={500}
                  unit="ms"
                  onChange={(val) =>
                    setSettings({ ...settings, 'detection.interval_ms': val })
                  }
                />

                <TechNumberInput
                  label="Ngưỡng độ tin cậy AI (Confidence)"
                  hint="Phạm vi từ 0.15 đến 0.95 (Khuyến nghị: 0.30 – 0.45)"
                  value={settings['detection.confidence_threshold'] || '0.35'}
                  min={0.15}
                  max={0.95}
                  step={0.05}
                  onChange={(val) =>
                    setSettings({ ...settings, 'detection.confidence_threshold': val })
                  }
                />
              </div>

              <div className="flex flex-col gap-2 mt-3 mb-3">
                <TechSwitch
                  checked={settings['detection.person_enabled'] !== '0'}
                  onChange={(on) =>
                    setSettings({
                      ...settings,
                      'detection.person_enabled': on ? '1' : '0',
                    })
                  }
                  label="AI Nhận diện Con người & Khuôn mặt (Person / ArcFace)"
                  description="Tự động đóng khung Cyan cho Người và khớp khuôn mặt trong Thư viện Khuôn mặt trên cả 2 mắt camera."
                />

                <TechSwitch
                  checked={settings['detection.animal_enabled'] !== '0'}
                  onChange={(on) =>
                    setSettings({
                      ...settings,
                      'detection.animal_enabled': on ? '1' : '0',
                    })
                  }
                  label="AI Nhận diện Thú cưng & Động vật (Chó / Mèo)"
                  description="Tự động đóng khung Xanh Neon khi phát hiện chó, mèo di chuyển trong vùng quan sát."
                />

                <TechSwitch
                  checked={settings['detection.vehicle_enabled'] !== '0'}
                  onChange={(on) =>
                    setSettings({
                      ...settings,
                      'detection.vehicle_enabled': on ? '1' : '0',
                    })
                  }
                  label="AI Nhận diện Phương tiện & Biển số xe (Xe máy / Ô tô / ALPR)"
                  description="Tự động đóng khung Vàng Amber cho xe máy, ô tô, xe đạp và trích xuất biển số."
                />

                <TechSwitch
                  checked={settings['detection.motion_enabled'] === '1'}
                  onChange={(on) =>
                    setSettings({
                      ...settings,
                      'detection.motion_enabled': on ? '1' : '0',
                    })
                  }
                  label="Bật phát hiện Chuyển động Pixel dự phòng (Motion Detection)"
                  description="Mặc định: TẮT (Khuyến nghị khi đã bật AI YOLOv8n để tránh báo động giả do cây rung/ánh sáng). Khi bật: Báo thêm chuyển động cụm hẹp nếu không có đối tượng AI."
                />

                <TechSwitch
                  checked={settings['recording.on_motion_enabled'] === '1'}
                  onChange={(on) =>
                    setSettings({
                      ...settings,
                      'recording.on_motion_enabled': on ? '1' : '0',
                    })
                  }
                  label="Tự động ghi hình Video MP4 khi phát hiện sự kiện AI"
                  description="Khi tắt: Hệ thống chỉ chụp ảnh Snapshot có vẽ khung Bounding Box. Khi bật: Quay thêm đoạn video MP4."
                />
              </div>

              <TechNumberInput
                label="Thời lượng đoạn video sự kiện"
                value={settings['recording.on_motion_duration'] || '30'}
                min={5}
                max={300}
                step={5}
                unit="GIÂY"
                onChange={(val) =>
                  setSettings({ ...settings, 'recording.on_motion_duration': val })
                }
              />
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
              Phát Hiện Âm Thanh Bất Thường Ban Đêm (YAMNet AI)
            </span>
          </div>
          <div className="card-body" style={{ padding: 16 }}>
            <div className="mb-4">
              <TechSwitch
                checked={settings['sound.detection_enabled'] === '1'}
                onChange={(on) =>
                  setSettings({
                    ...settings,
                    'sound.detection_enabled': on ? '1' : '0',
                  })
                }
                label="Kích hoạt Giám sát & Phân loại Âm thanh Ban đêm"
                description="Lắng nghe và phân biệt Tiếng kính vỡ, Tiếng la hét, Trẻ em khóc, Chó sủa trong khung giờ trực đêm."
              />
            </div>

            <div className="vms-grid-3">
              <TechNumberInput
                label="Giờ bắt đầu trực đêm"
                value={settings['sound.night_start'] ?? '22'}
                min={0}
                max={23}
                step={1}
                unit="GIỜ"
                onChange={(val) => setSettings({ ...settings, 'sound.night_start': val })}
              />
              <TechNumberInput
                label="Giờ kết thúc trực đêm"
                value={settings['sound.night_end'] ?? '6'}
                min={0}
                max={23}
                step={1}
                unit="GIỜ"
                onChange={(val) => setSettings({ ...settings, 'sound.night_end': val })}
              />
              <TechNumberInput
                label="Ngưỡng âm lượng kích hoạt"
                hint="-30: Nhạy · -20: Vừa · -10: Tiếng rất lớn"
                value={settings['sound.threshold_db'] ?? '-20'}
                min={-60}
                max={0}
                step={2}
                unit="dBFS"
                onChange={(val) => setSettings({ ...settings, 'sound.threshold_db': val })}
              />
            </div>

            <div className="mt-4 mb-3">
              <TechSwitch
                checked={settings['sound.recording_enabled'] !== '0'}
                onChange={(on) =>
                  setSettings({
                    ...settings,
                    'sound.recording_enabled': on ? '1' : '0',
                  })
                }
                label="Tự động quay Video khi phát hiện âm thanh lạ"
                description="Tự động kích hoạt ghi hình kênh camera phát sinh âm thanh vượt ngưỡng."
              />
            </div>

            <TechNumberInput
              label="Thời lượng quay video âm thanh"
              value={settings['sound.recording_duration'] || '30'}
              min={5}
              max={300}
              step={5}
              unit="GIÂY"
              onChange={(val) =>
                setSettings({ ...settings, 'sound.recording_duration': val })
              }
            />
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
            <form onSubmit={handlePasswordChange}>
              <TechInput
                label="Tên đăng nhập quản trị"
                icon={User}
                value={pwdForm.newUsername}
                onChange={(e) => setPwdForm({ ...pwdForm, newUsername: e.target.value })}
              />

              <TechInput
                label="Mật khẩu hiện tại *"
                icon={Lock}
                type="password"
                placeholder="Nhập mật khẩu hiện tại"
                value={pwdForm.currentPassword}
                onChange={(e) => setPwdForm({ ...pwdForm, currentPassword: e.target.value })}
              />

              <TechInput
                label="Mật khẩu mới * (Tối thiểu 8 ký tự, băm scrypt)"
                icon={Lock}
                type="password"
                placeholder="Nhập mật khẩu mới"
                value={pwdForm.newPassword}
                onChange={(e) => setPwdForm({ ...pwdForm, newPassword: e.target.value })}
              />

              <TechInput
                label="Xác nhận mật khẩu mới *"
                icon={Lock}
                type="password"
                placeholder="Nhập lại mật khẩu mới"
                value={pwdForm.confirmPassword}
                onChange={(e) => setPwdForm({ ...pwdForm, confirmPassword: e.target.value })}
              />

              <div className="mt-4 flex justify-end">
                <button type="submit" className="tech-btn tech-btn-primary" disabled={pwdSaving}>
                  <Lock size={15} />{' '}
                  {pwdSaving ? 'Đang cập nhật...' : 'Cập nhật thông tin bảo mật'}
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
            <div className="vms-meter-box mb-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold">Bộ nhớ RAM hệ thống</span>
                <span className="text-xs text-mono">
                  {formatBytes(sysInfo.system.usedMemory)} /{' '}
                  {formatBytes(sysInfo.system.totalMemory)} ({sysInfo.system.memoryPercent}%)
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
                    Đã dùng {formatBytes(sysInfo.disk.used)} / Tổng{' '}
                    {formatBytes(sysInfo.disk.total)} (Còn trống {formatBytes(sysInfo.disk.free)})
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
                <span className="text-xs text-muted">Core Engine</span>
                <span className="text-xs text-mono font-bold" style={{ color: 'var(--accent)' }}>
                  {sysInfo.system.engine || 'Rust Native AI NVR v2.0'}
                </span>
              </div>
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
            className="tech-btn tech-btn-primary"
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
