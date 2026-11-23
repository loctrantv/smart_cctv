import React, { useState } from 'react';
import { login } from '../utils/api';
import { TechInput } from '../components/TechUI';
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
      <div className="login-card vms-login-console" style={{ position: 'relative' }}>
        <div className="tech-corner tl" />
        <div className="tech-corner tr" />
        <div className="tech-corner bl" />
        <div className="tech-corner br" />

        <div className="login-header">
          <div className="login-logo-icon">
            <Shield size={24} />
          </div>
          <div className="flex items-center justify-center gap-2 mb-1">
            <span className="vms-osd-badge ai">
              <Radio size={10} /> RUST AI NVR 2.0
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
          <TechInput
            label="Tài khoản vận hành"
            icon={User}
            type="text"
            placeholder="Nhập tên tài khoản"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={loading}
            autoFocus
          />

          <TechInput
            label="Mật khẩu bảo mật"
            icon={Lock}
            type={showPassword ? 'text' : 'password'}
            placeholder="Nhập mật khẩu"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={loading}
            rightElement={
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                style={{
                  background: 'none',
                  border: 'none',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            }
          />

          <button
            type="submit"
            className="tech-btn tech-btn-primary w-full mt-3"
            style={{ height: 40 }}
            disabled={loading}
          >
            {loading ? 'Đang xác thực phiên...' : 'Truy cập Hệ thống'}
          </button>
        </form>
      </div>
    </div>
  );
}
