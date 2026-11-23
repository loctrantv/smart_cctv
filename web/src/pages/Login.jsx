import React, { useState } from 'react';
import { login } from '../utils/api';
import { Shield, Lock, User, AlertCircle, Eye, EyeOff, Radio } from 'lucide-react';

export default function Login({ onLoginSuccess }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username || !password) {
      setError('Vui lòng nhập tên đăng nhập và mật khẩu.');
      return;
    }

    setError('');
    setLoading(true);

    try {
      const data = await login(username, password);
      localStorage.setItem('smart_cctv_token', data.token);
      localStorage.setItem('smart_cctv_user', JSON.stringify(data.user));
      onLoginSuccess(data.token, data.user);
    } catch (err) {
      setError(
        err.response?.data?.error || 'Không thể kết nối đến máy chủ giám sát. Vui lòng thử lại.'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-wrapper vms-login-bg">
      <div className="login-card vms-login-console">
        <div className="login-header">
          <div className="login-logo-icon">
            <Shield size={24} />
          </div>
          <div className="flex items-center justify-center gap-2 mb-1">
            <span className="vms-osd-badge ai">
              <Radio size={10} /> ON-PREMISE NVR
            </span>
            <span className="vms-osd-badge rec">DUAL-LENS VMS</span>
          </div>
          <h2>SMART CCTV VMS</h2>
          <p>Trung tâm điều khiển & giám sát an ninh</p>
        </div>

        {error && (
          <div className="login-alert">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">Tài khoản vận hành</label>
            <div style={{ position: 'relative' }}>
              <User
                size={16}
                style={{
                  position: 'absolute',
                  left: 12,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--text-secondary)',
                }}
              />
              <input
                type="text"
                className="form-input"
                style={{ paddingLeft: 36 }}
                placeholder="Nhập tên tài khoản"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                disabled={loading}
                autoFocus
              />
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 24 }}>
            <label className="form-label">Mật khẩu bảo mật</label>
            <div style={{ position: 'relative' }}>
              <Lock
                size={16}
                style={{
                  position: 'absolute',
                  left: 12,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: 'var(--text-secondary)',
                }}
              />
              <input
                type={showPassword ? 'text' : 'password'}
                className="form-input"
                style={{ paddingLeft: 36, paddingRight: 36 }}
                placeholder="Nhập mật khẩu"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={loading}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  position: 'absolute',
                  right: 12,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                }}
                disabled={loading}
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
          </div>

          <button type="submit" className="login-btn" disabled={loading}>
            {loading ? 'Đang xác thực phiên...' : 'Truy cập Hệ thống'}
          </button>
        </form>
      </div>
    </div>
  );
}
