import React, { useState, createContext, useContext, useEffect, useCallback } from 'react';
import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { useWebSocket } from './hooks/useWebSocket';
import { logout as apiLogout, getCameras } from './utils/api';
import {
  LayoutGrid,
  PlayCircle,
  AlertTriangle,
  Users,
  Settings,
  Menu,
  X,
  Wifi,
  WifiOff,
  Shield,
  LogOut,
  Sun,
  Moon,
  ChevronLeft,
  ChevronRight,
  Maximize,
  Minimize,
  Camera,
  Video,
  Eye,
} from 'lucide-react';

import Dashboard from './pages/Dashboard';
import CameraView from './pages/CameraView';
import Playback from './pages/Playback';
import Events from './pages/Events';
import FaceLibrary from './pages/FaceLibrary';
import SettingsPage from './pages/Settings';
import Login from './pages/Login';

// Context
export const AppContext = createContext();
export const useApp = () => useContext(AppContext);

export default function App() {
  const [token, setToken] = useState(localStorage.getItem('smart_cctv_token') || '');
  const [user, setUser] = useState(() => {
    try {
      const u = localStorage.getItem('smart_cctv_user');
      return u ? JSON.parse(u) : null;
    } catch {
      return null;
    }
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    localStorage.getItem('smart_cctv_sidebar_collapsed') === '1'
  );
  const [tvMode, setTvMode] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('smart_cctv_theme') || 'dark');
  const [clock, setClock] = useState(() => new Date());
  const [globalStats, setGlobalStats] = useState({
    totalCameras: 0,
    recordingCount: 0,
    detectingCount: 0,
    eventsToday: 0,
  });

  const ws = useWebSocket(token);
  const location = useLocation();

  // Live 1-second digital clock for VMS Control Room Header
  useEffect(() => {
    const timer = setInterval(() => setClock(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('smart_cctv_theme', theme);
  }, [theme]);

  const toggleSidebarCollapse = () => {
    setSidebarCollapsed((prev) => {
      const next = !prev;
      localStorage.setItem('smart_cctv_sidebar_collapsed', next ? '1' : '0');
      return next;
    });
  };

  const refreshGlobalStats = useCallback(async () => {
    if (!token) return;
    try {
      const cams = await getCameras();
      setGlobalStats({
        totalCameras: cams.length,
        recordingCount: cams.filter((c) => c.record_enabled).length,
        detectingCount: cams.filter((c) => c.detection_enabled).length,
        eventsToday: cams.reduce((sum, c) => sum + (c.events_today || 0), 0),
      });
    } catch {}
  }, [token]);

  useEffect(() => {
    refreshGlobalStats();
  }, [refreshGlobalStats, location.pathname]);

  useEffect(() => {
    if (!ws) return;
    const u1 = ws.on('camera_added', refreshGlobalStats);
    const u2 = ws.on('camera_updated', refreshGlobalStats);
    const u3 = ws.on('camera_removed', refreshGlobalStats);
    const u4 = ws.on('detection_event', refreshGlobalStats);
    const u5 = ws.on('recording_started', refreshGlobalStats);
    const u6 = ws.on('recording_completed', refreshGlobalStats);
    return () => {
      u1();
      u2();
      u3();
      u4();
      u5();
      u6();
    };
  }, [ws, refreshGlobalStats]);

  // Browser Fullscreen + TV Wall Mode sync
  const toggleTvMode = () => {
    if (!tvMode) {
      setTvMode(true);
      if (document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
    } else {
      setTvMode(false);
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    }
  };

  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && tvMode) {
        setTvMode(false);
      }
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, [tvMode]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const handleLoginSuccess = (newToken, newUser) => {
    localStorage.setItem('smart_cctv_token', newToken);
    localStorage.setItem('smart_cctv_user', JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
  };

  const handleLogout = async () => {
    if (confirm('Đăng xuất khỏi hệ thống giám sát?')) {
      try {
        await apiLogout();
      } catch {}
      localStorage.removeItem('smart_cctv_token');
      localStorage.removeItem('smart_cctv_user');
      setToken('');
      setUser(null);
    }
  };

  if (!token) {
    return <Login onLoginSuccess={handleLoginSuccess} />;
  }

  const navItems = [
    { path: '/', icon: LayoutGrid, label: 'Live Matrix' },
    { path: '/playback', icon: PlayCircle, label: 'Xem lại NVR' },
    { path: '/events', icon: AlertTriangle, label: 'Sự kiện AI' },
    { path: '/faces', icon: Users, label: 'Khuôn mặt' },
    { path: '/settings', icon: Settings, label: 'Cài đặt' },
  ];

  const pageTitle = navItems.find((n) => n.path === location.pathname)?.label || 'Trạm Giám Sát Kênh';

  return (
    <AppContext.Provider
      value={{
        ws,
        theme,
        toggleTheme,
        user,
        onAuthUpdate: handleLoginSuccess,
        globalStats,
        refreshGlobalStats,
        tvMode,
        toggleTvMode,
      }}
    >
      <div className={`app-layout ${tvMode ? 'tv-wall-mode' : ''}`}>
        {/* Mobile backdrop */}
        {sidebarOpen && (
          <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Collapsible VMS Navigation Sidebar */}
        {!tvMode && (
          <aside
            className={`sidebar ${sidebarOpen ? 'open' : ''} ${
              sidebarCollapsed ? 'collapsed' : ''
            }`}
          >
            <div className="sidebar-logo">
              <div className="logo-icon" title="Smart CCTV VMS">
                <Shield size={18} />
              </div>
              {!sidebarCollapsed && (
                <div className="logo-text-block">
                  <h1>SMART VMS</h1>
                  <span className="logo-sub">DUAL-LENS NVR</span>
                </div>
              )}
              <button
                type="button"
                className="sidebar-collapse-btn"
                onClick={toggleSidebarCollapse}
                title={sidebarCollapsed ? 'Mở rộng thanh điều hướng' : 'Thu gọn thanh điều hướng'}
              >
                {sidebarCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
              </button>
            </div>

            <nav className="sidebar-nav">
              {!sidebarCollapsed && <div className="sidebar-section">TRUNG TÂM ĐIỀU KHIỂN</div>}
              {navItems.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  title={item.label}
                  className={({ isActive }) => (isActive ? 'active' : '')}
                  onClick={() => setSidebarOpen(false)}
                >
                  <item.icon className="nav-icon" size={18} />
                  {!sidebarCollapsed && <span>{item.label}</span>}
                </NavLink>
              ))}

              <button
                type="button"
                onClick={handleLogout}
                title="Đăng xuất"
                className="sidebar-logout-btn"
              >
                <LogOut className="nav-icon" size={18} />
                {!sidebarCollapsed && <span>Đăng xuất</span>}
              </button>
            </nav>

            <div className="sidebar-footer">
              <div className="flex items-center gap-2" title={ws.connected ? 'WebSocket Online' : 'WebSocket Offline'}>
                {ws.connected ? (
                  <>
                    <Wifi size={13} style={{ color: 'var(--success)', flexShrink: 0 }} />
                    {!sidebarCollapsed && <span className="text-mono">WS ONLINE</span>}
                  </>
                ) : (
                  <>
                    <WifiOff size={13} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                    {!sidebarCollapsed && <span className="text-mono">MẤT KẾT NỐI</span>}
                  </>
                )}
              </div>
            </div>
          </aside>
        )}

        {/* Main VMS Workspace */}
        <div className="main-content">
          {!tvMode && (
            <header className="header vms-topbar">
              <div className="header-left">
                <button
                  className="header-btn menu-toggle"
                  onClick={() => setSidebarOpen(!sidebarOpen)}
                  id="menu-toggle"
                >
                  {sidebarOpen ? <X size={18} /> : <Menu size={18} />}
                </button>
                <h2 className="header-title">{pageTitle}</h2>
              </div>

              {/* Compact Control Room Telemetry Pills */}
              <div className="vms-telemetry-strip">
                <div className="vms-stat-pill" title="Tổng số camera kết nối">
                  <Camera size={13} style={{ color: 'var(--accent)' }} />
                  <span className="pill-label">KÊNH:</span>
                  <strong className="pill-val">{globalStats.totalCameras}</strong>
                </div>

                <div
                  className={`vms-stat-pill ${globalStats.recordingCount > 0 ? 'is-rec' : ''}`}
                  title="Số kênh đang ghi hình"
                >
                  <Video size={13} style={{ color: 'var(--danger)' }} />
                  <span className="pill-label">REC:</span>
                  <strong className="pill-val">{globalStats.recordingCount}</strong>
                </div>

                <div className="vms-stat-pill" title="Số kênh đang bật giám sát AI">
                  <Eye size={13} style={{ color: 'var(--success)' }} />
                  <span className="pill-label">AI:</span>
                  <strong className="pill-val">{globalStats.detectingCount}</strong>
                </div>

                <div className="vms-stat-pill" title="Tổng sự kiện phát hiện trong 24h qua">
                  <AlertTriangle size={13} style={{ color: 'var(--warning)' }} />
                  <span className="pill-label">24H:</span>
                  <strong className="pill-val">{globalStats.eventsToday}</strong>
                </div>
              </div>

              <div className="header-right">
                <div className="vms-digital-clock text-mono">
                  <span className="clock-time">{clock.toLocaleTimeString('vi-VN', { hour12: false })}</span>
                  <span className="clock-date">{clock.toLocaleDateString('vi-VN')}</span>
                </div>

                <button
                  type="button"
                  onClick={toggleTvMode}
                  className="header-btn"
                  title="Chế độ TV Wall (Toàn màn hình không viền)"
                >
                  <Maximize size={16} />
                </button>

                <button
                  type="button"
                  onClick={toggleTheme}
                  className="header-btn"
                  title="Chuyển giao diện Sáng / Tối"
                >
                  {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
                </button>
              </div>
            </header>
          )}

          {/* Floating exit button when in TV Wall Fullscreen mode */}
          {tvMode && (
            <button
              type="button"
              className="vms-exit-tv-btn"
              onClick={toggleTvMode}
              title="Thoát chế độ TV Wall (ESC)"
            >
              <Minimize size={14} /> Thoát TV Wall
            </button>
          )}

          <div
            className={`page-content ${
              location.pathname === '/' || location.pathname.startsWith('/camera/')
                ? 'vms-edge-page'
                : ''
            }`}
          >
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/camera/:id" element={<CameraView />} />
              <Route path="/playback" element={<Playback />} />
              <Route path="/events" element={<Events />} />
              <Route path="/faces" element={<FaceLibrary />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          </div>
        </div>
      </div>
    </AppContext.Provider>
  );
}
