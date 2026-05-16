import React, { useState, createContext, useContext } from 'react';
import { Routes, Route, NavLink, useLocation } from 'react-router-dom';
import { useWebSocket } from './hooks/useWebSocket';
import {
  LayoutGrid, Camera, PlayCircle, AlertTriangle,
  Users, Settings, Menu, X, Wifi, WifiOff, Shield
} from 'lucide-react';

import Dashboard from './pages/Dashboard';
import CameraView from './pages/CameraView';
import Playback from './pages/Playback';
import Events from './pages/Events';
import FaceLibrary from './pages/FaceLibrary';
import SettingsPage from './pages/Settings';

// Context
export const AppContext = createContext();
export const useApp = () => useContext(AppContext);

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const ws = useWebSocket();
  const location = useLocation();

  const navItems = [
    { path: '/', icon: LayoutGrid, label: 'Dashboard' },
    { path: '/playback', icon: PlayCircle, label: 'Xem lại' },
    { path: '/events', icon: AlertTriangle, label: 'Sự kiện' },
    { path: '/faces', icon: Users, label: 'Khuôn mặt' },
    { path: '/settings', icon: Settings, label: 'Cài đặt' },
  ];

  const pageTitle = navItems.find(n => n.path === location.pathname)?.label || 'Camera';

  return (
    <AppContext.Provider value={{ ws }}>
      <div className="app-layout">
        {/* Mobile backdrop */}
        {sidebarOpen && (
          <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)} />
        )}

        {/* Sidebar */}
        <aside className={`sidebar ${sidebarOpen ? 'open' : ''}`}>
          <div className="sidebar-logo">
            <div className="logo-icon">
              <Shield size={18} />
            </div>
            <h1>Smart CCTV</h1>
          </div>

          <nav className="sidebar-nav">
            <div className="sidebar-section">Menu</div>
            {navItems.map(item => (
              <NavLink
                key={item.path}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) => isActive ? 'active' : ''}
                onClick={() => setSidebarOpen(false)}
              >
                <item.icon className="nav-icon" size={18} />
                {item.label}
              </NavLink>
            ))}
          </nav>

          <div className="sidebar-footer">
            <div className="flex items-center gap-2">
              {ws.connected ? (
                <><Wifi size={12} style={{ color: 'var(--success)' }} /> <span>Đã kết nối</span></>
              ) : (
                <><WifiOff size={12} style={{ color: 'var(--danger)' }} /> <span>Mất kết nối</span></>
              )}
            </div>
          </div>
        </aside>

        {/* Main content */}
        <div className="main-content">
          <header className="header">
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
            <div className="header-right">
              <div className="flex items-center gap-2 text-xs text-muted text-mono">
                {new Date().toLocaleDateString('vi-VN')} {new Date().toLocaleTimeString('vi-VN')}
              </div>
            </div>
          </header>

          <div className="page-content">
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
