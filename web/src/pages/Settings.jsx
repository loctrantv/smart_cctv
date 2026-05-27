import React, { useState, useEffect } from 'react';
import { getSystemInfo, getSettings, updateSettings, getCameras, updateCamera } from '../utils/api';
import { Settings as SettingsIcon, HardDrive, Cpu, Save, RefreshCw, Camera, Clock } from 'lucide-react';

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

  return (
    <div style={{ maxWidth: 800, margin: '0 auto' }}>
      <div className="tabs">
        {[
          { id: 'general', label: 'Tổng quát' },
          { id: 'storage', label: 'Lưu trữ' },
          { id: 'detection', label: 'Phát hiện' },
          { id: 'system', label: 'Hệ thống' },
        ].map(tab => (
          <button key={tab.id} className={`tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* General */}
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

      {/* Storage */}
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
            <div className="form-group">
              <label className="form-label">Thời gian lưu trữ (ngày)</label>
              <input className="form-input" type="number" value={settings['storage.retention_days'] || '30'}
                onChange={e => setSettings({ ...settings, 'storage.retention_days': e.target.value })} />
            </div>
            <div className="form-group">
              <label className="form-label">Thời lượng mỗi đoạn ghi (phút)</label>
              <input className="form-input" type="number" value={settings['recording.segment_minutes'] || '15'}
                onChange={e => setSettings({ ...settings, 'recording.segment_minutes': e.target.value })} />
            </div>
          </div>
        </div>
      )}

      {/* Detection */}
      {activeTab === 'detection' && (
        <div className="card">
          <div className="card-header">
            <span className="font-bold flex items-center gap-2"><SettingsIcon size={16} /> Phát hiện & Ghi hình</span>
          </div>
          <div className="card-body">
            <div className="form-group">
              <label className="form-label">Khoảng cách quét (ms)</label>
              <input className="form-input" type="number" value={settings['detection.interval_ms'] || '3000'}
                onChange={e => setSettings({ ...settings, 'detection.interval_ms': e.target.value })} />
              <div className="text-xs text-muted mt-2">Giá trị nhỏ = phát hiện nhanh hơn nhưng tốn CPU hơn</div>
            </div>
            <div className="form-group mt-3">
              <label className="form-label">Ngưỡng tin cậy (0-1)</label>
              <input className="form-input" type="number" step="0.1" min="0" max="1"
                value={settings['detection.confidence_threshold'] || '0.5'}
                onChange={e => setSettings({ ...settings, 'detection.confidence_threshold': e.target.value })} />
            </div>

            <hr style={{ margin: '20px 0', border: 'none', borderTop: '1px solid var(--border)' }} />

            <div className="form-group">
              <label className="form-label">Quay phim khi phát hiện chuyển động</label>
              <select 
                className="form-input" 
                value={settings['recording.on_motion_enabled'] || '0'}
                onChange={e => setSettings({ ...settings, 'recording.on_motion_enabled': e.target.value })}
              >
                <option value="0">Tắt (Chỉ chụp ảnh sự kiện)</option>
                <option value="1">Bật (Tự động quay video khi có chuyển động)</option>
              </select>
            </div>
            
            <div className="form-group mt-3">
              <label className="form-label">Thời lượng quay khi có chuyển động (giây)</label>
              <input 
                className="form-input" 
                type="number" 
                min="5" 
                max="300"
                value={settings['recording.on_motion_duration'] || '30'}
                onChange={e => setSettings({ ...settings, 'recording.on_motion_duration': e.target.value })} 
              />
              <div className="text-xs text-muted mt-2">Thời gian quay video tự động sau mỗi lần phát hiện chuyển động (từ 5 đến 300 giây)</div>
            </div>
          </div>
        </div>
      )}

      {/* System */}
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
              <div><div className="text-xs text-muted">CPU</div><div className="text-sm">{sysInfo.system.cpuCount} cores - {sysInfo.system.cpuModel}</div></div>
              <div><div className="text-xs text-muted">RAM</div><div className="text-sm">{formatBytes(sysInfo.system.usedMemory)} / {formatBytes(sysInfo.system.totalMemory)} ({sysInfo.system.memoryPercent}%)</div></div>
              <div><div className="text-xs text-muted">Uptime Server</div><div className="text-sm">{Math.floor(sysInfo.system.uptime / 3600)}h {Math.floor((sysInfo.system.uptime % 3600) / 60)}m</div></div>
              <div><div className="text-xs text-muted">Uptime App</div><div className="text-sm">{Math.floor(sysInfo.app.uptime / 3600)}h {Math.floor((sysInfo.app.uptime % 3600) / 60)}m</div></div>
            </div>
          </div>
        </div>
      )}

      {/* Save Button */}
      {(activeTab === 'storage' || activeTab === 'detection') && (
        <div style={{ marginTop: 16, textAlign: 'right' }}>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving} id="save-settings">
            <Save size={16} /> {saving ? 'Đang lưu...' : 'Lưu cài đặt'}
          </button>
        </div>
      )}
    </div>
  );
}
