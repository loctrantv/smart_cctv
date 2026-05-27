import React, { useState, useEffect } from 'react';
import { getSystemInfo, getSettings, updateSettings, getCameras } from '../utils/api';
import { Settings as SettingsIcon, HardDrive, Cpu, Save, RefreshCw, Camera, Volume2, Activity } from 'lucide-react';

export default function SettingsPage() {
  const [sysInfo, setSysInfo] = useState(null);
  const [settings, setSettings] = useState({});
  const [cameras, setCameras] = useState([]);
  const [activeTab, setActiveTab] = useState('general');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSystemInfo().then(setSysInfo).catch(() => {});
    getSettings().then(setSettings).catch(() => {});
    getCameras().then(setCameras).catch(() => {});
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings(settings);
      alert('Đã lưu cài đặt!');
    } catch (err) {
      alert('Lỗi: ' + err.message);
    } finally {
      setSaving(false);
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
    { id: 'general',   label: 'Tổng quát' },
    { id: 'storage',   label: 'Lưu trữ' },
    { id: 'detection', label: 'Phát hiện' },
    { id: 'sound',     label: 'Âm thanh' },
    { id: 'system',    label: 'Hệ thống' },
  ];

  const hasSaveButton = ['storage', 'detection', 'sound'].includes(activeTab);

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <div className="tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── General ── */}
      {activeTab === 'general' && (
        <div className="card">
          <div className="card-header">
            <span className="font-bold flex items-center gap-2"><Camera size={16} /> Quản lý Camera</span>
          </div>
          <div className="card-body">
            {cameras.length === 0 ? (
              <p className="text-muted">Chưa có camera nào</p>
            ) : (
              <div className="flex flex-col gap-3">
                {cameras.map(cam => (
                  <div key={cam.id} className="card" style={{ background: 'var(--bg-secondary)' }}>
                    <div className="card-body" style={{ padding: '12px 16px' }}>
                      <div className="flex items-center justify-between">
                        <div>
                          <div className="font-bold text-sm">{cam.name}</div>
                          <div className="text-xs text-muted text-mono mt-2">{cam.rtsp_url}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className={`status-dot ${cam.enabled ? '' : 'offline'}`} />
                          <span className="text-xs">{cam.enabled ? 'Online' : 'Offline'}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Storage ── */}
      {activeTab === 'storage' && (
        <div className="card">
          <div className="card-header">
            <span className="font-bold flex items-center gap-2"><HardDrive size={16} /> Lưu trữ</span>
          </div>
          <div className="card-body">
            {sysInfo && (
              <div className="stats-grid mb-4">
                <div className="stat-card">
                  <div className="stat-icon cyan"><HardDrive size={18} /></div>
                  <div>
                    <div className="stat-value text-sm">{formatBytes(sysInfo.app.totalStorageUsed)}</div>
                    <div className="stat-label">Đã sử dụng</div>
                  </div>
                </div>
              </div>
            )}
            <div className="form-group">
              <label className="form-label">Dung lượng tối đa (GB)</label>
              <input className="form-input" type="number" value={settings['storage.max_gb'] || '100'}
                onChange={e => setSettings({ ...settings, 'storage.max_gb': e.target.value })} />
            </div>
            <div className="form-group mt-3">
              <label className="form-label">Thời gian lưu trữ (ngày)</label>
              <input className="form-input" type="number" value={settings['storage.retention_days'] || '30'}
                onChange={e => setSettings({ ...settings, 'storage.retention_days': e.target.value })} />
            </div>
            <div className="form-group mt-3">
              <label className="form-label">Thời lượng mỗi đoạn ghi (phút)</label>
              <input className="form-input" type="number" value={settings['recording.segment_minutes'] || '15'}
                onChange={e => setSettings({ ...settings, 'recording.segment_minutes': e.target.value })} />
            </div>
          </div>
        </div>
      )}

      {/* ── Motion Detection ── */}
      {activeTab === 'detection' && (
        <div className="card">
          <div className="card-header">
            <span className="font-bold flex items-center gap-2"><Activity size={16} /> Phát hiện Chuyển động</span>
          </div>
          <div className="card-body">
            <div className="form-group">
              <label className="form-label">Khoảng cách quét (ms)</label>
              <input className="form-input" type="number" value={settings['detection.interval_ms'] || '3000'}
                onChange={e => setSettings({ ...settings, 'detection.interval_ms': e.target.value })} />
              <div className="text-xs text-muted mt-2">Giá trị nhỏ = phát hiện nhanh hơn nhưng tốn CPU hơn</div>
            </div>

            <div className="form-group mt-3">
              <label className="form-label">Ngưỡng tin cậy (0–1)</label>
              <input className="form-input" type="number" step="0.1" min="0" max="1"
                value={settings['detection.confidence_threshold'] || '0.5'}
                onChange={e => setSettings({ ...settings, 'detection.confidence_threshold': e.target.value })} />
            </div>

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid var(--border)' }} />

            <div className="form-group">
              <label className="form-label">Quay phim khi phát hiện chuyển động</label>
              <select className="form-input"
                value={settings['recording.on_motion_enabled'] || '0'}
                onChange={e => setSettings({ ...settings, 'recording.on_motion_enabled': e.target.value })}
              >
                <option value="0">Tắt (Chỉ chụp ảnh sự kiện)</option>
                <option value="1">Bật (Tự động quay video khi có chuyển động)</option>
              </select>
            </div>

            <div className="form-group mt-3">
              <label className="form-label">Thời lượng quay khi có chuyển động (giây)</label>
              <input className="form-input" type="number" min="5" max="300"
                value={settings['recording.on_motion_duration'] || '30'}
                onChange={e => setSettings({ ...settings, 'recording.on_motion_duration': e.target.value })} />
              <div className="text-xs text-muted mt-2">Thời gian quay video sau mỗi lần phát hiện chuyển động (5–300 giây)</div>
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
              Phát hiện Âm thanh Lạ Ban Đêm
            </span>
          </div>
          <div className="card-body">

            {/* Enable/Disable */}
            <div className="form-group">
              <label className="form-label">Bật phát hiện âm thanh</label>
              <select className="form-input"
                value={settings['sound.detection_enabled'] || '0'}
                onChange={e => setSettings({ ...settings, 'sound.detection_enabled': e.target.value })}
              >
                <option value="0">Tắt</option>
                <option value="1">Bật — lắng nghe âm thanh trong khung giờ đã cấu hình</option>
              </select>
              <div className="text-xs text-muted mt-2">
                Phát hiện tiếng động bất thường (tiếng la hét, va đập...) trong khung giờ ban đêm và tạo sự kiện cảnh báo.
              </div>
            </div>

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid var(--border)' }} />

            {/* Night window */}
            <div className="font-bold text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>Khung giờ ban đêm</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label className="form-label">Bắt đầu (giờ)</label>
                <input className="form-input" type="number" min="0" max="23"
                  value={settings['sound.night_start'] ?? '22'}
                  onChange={e => setSettings({ ...settings, 'sound.night_start': e.target.value })} />
                <div className="text-xs text-muted mt-1">Ví dụ: 22 → 22:00</div>
              </div>
              <div className="form-group">
                <label className="form-label">Kết thúc (giờ)</label>
                <input className="form-input" type="number" min="0" max="23"
                  value={settings['sound.night_end'] ?? '6'}
                  onChange={e => setSettings({ ...settings, 'sound.night_end': e.target.value })} />
                <div className="text-xs text-muted mt-1">Ví dụ: 6 → 06:00</div>
              </div>
            </div>
            <div className="text-xs text-muted mt-1" style={{ padding: '8px 12px', background: 'var(--bg-secondary)', borderRadius: 8, marginTop: 8 }}>
              Hỗ trợ qua nửa đêm — ví dụ: 22:00 → 06:00 sẽ hoạt động đúng.
            </div>

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid var(--border)' }} />

            {/* Threshold */}
            <div className="font-bold text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>Nhạy cảm âm thanh</div>
            <div className="form-group">
              <label className="form-label">Ngưỡng âm lượng (dBFS)</label>
              <input className="form-input" type="number" min="-60" max="0" step="1"
                value={settings['sound.threshold_db'] ?? '-20'}
                onChange={e => setSettings({ ...settings, 'sound.threshold_db': e.target.value })} />
              <div className="text-xs text-muted mt-2">
                Giá trị càng gần 0 → chỉ bắt tiếng rất to.<br />
                Khuyến nghị: <strong>-25 đến -15 dBFS</strong>.<br />
                Ví dụ: -30 dBFS ≈ tiếng nói bình thường · -20 dBFS ≈ tiếng nói to · -10 dBFS ≈ tiếng la hét.
              </div>
            </div>

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid var(--border)' }} />

            {/* Recording */}
            <div className="font-bold text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>Ghi hình khi phát hiện</div>
            <div className="form-group">
              <label className="form-label">Tự động quay video khi phát hiện âm thanh lạ</label>
              <select className="form-input"
                value={settings['sound.recording_enabled'] || '1'}
                onChange={e => setSettings({ ...settings, 'sound.recording_enabled': e.target.value })}
              >
                <option value="0">Tắt — chỉ tạo sự kiện cảnh báo</option>
                <option value="1">Bật — tự động quay video khi phát hiện</option>
              </select>
            </div>

            <div className="form-group mt-3">
              <label className="form-label">Thời lượng quay (giây)</label>
              <input className="form-input" type="number" min="5" max="300"
                value={settings['sound.recording_duration'] || '30'}
                onChange={e => setSettings({ ...settings, 'sound.recording_duration': e.target.value })} />
              <div className="text-xs text-muted mt-2">Thời gian quay video sau khi phát hiện âm thanh lạ (5–300 giây)</div>
            </div>

          </div>
        </div>
      )}

      {/* ── System Info ── */}
      {activeTab === 'system' && sysInfo && (
        <div className="card">
          <div className="card-header">
            <span className="font-bold flex items-center gap-2"><Cpu size={16} /> Thông tin hệ thống</span>
            <button className="btn btn-secondary btn-sm" onClick={() => getSystemInfo().then(setSysInfo)}>
              <RefreshCw size={12} /> Làm mới
            </button>
          </div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div><div className="text-xs text-muted">Hostname</div><div className="text-sm">{sysInfo.system.hostname}</div></div>
              <div><div className="text-xs text-muted">Platform</div><div className="text-sm">{sysInfo.system.platform} ({sysInfo.system.arch})</div></div>
              <div><div className="text-xs text-muted">CPU</div><div className="text-sm">{sysInfo.system.cpuCount} cores — {sysInfo.system.cpuModel}</div></div>
              <div><div className="text-xs text-muted">RAM</div><div className="text-sm">{formatBytes(sysInfo.system.usedMemory)} / {formatBytes(sysInfo.system.totalMemory)} ({sysInfo.system.memoryPercent}%)</div></div>
              <div><div className="text-xs text-muted">Uptime Server</div><div className="text-sm">{Math.floor(sysInfo.system.uptime / 3600)}h {Math.floor((sysInfo.system.uptime % 3600) / 60)}m</div></div>
              <div><div className="text-xs text-muted">Uptime App</div><div className="text-sm">{Math.floor(sysInfo.app.uptime / 3600)}h {Math.floor((sysInfo.app.uptime % 3600) / 60)}m</div></div>
            </div>
          </div>
        </div>
      )}

      {/* ── Save Button ── */}
      {hasSaveButton && (
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving} id="save-settings">
            <Save size={16} /> {saving ? 'Đang lưu...' : 'Lưu cài đặt'}
          </button>
        </div>
      )}
    </div>
  );
}
