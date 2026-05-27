import axios from 'axios';

const API_HOST = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? 'https://camera.tranhtuongtravinh.com' : '');
const API_BASE = `${API_HOST}/api`;

const api = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
});

// Request interceptor to automatically attach Authorization header
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('smart_cctv_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
}, (error) => {
  return Promise.reject(error);
});

// Response interceptor to clear auth on 401 Unauthorized responses
api.interceptors.response.use((response) => {
  return response;
}, (error) => {
  if (error.response && error.response.status === 401) {
    // Only clear token if we are not actively on /login page
    if (!error.config.url.includes('/auth/login')) {
      localStorage.removeItem('smart_cctv_token');
      localStorage.removeItem('smart_cctv_user');
      window.location.reload(); // Re-trigger App level verification which will mount the Login page
    }
  }
  return Promise.reject(error);
});

// Authentication
export const login = (username, password) => api.post('/auth/login', { username, password }).then(r => r.data);
export const verifyToken = () => api.get('/auth/verify').then(r => r.data);

// Helper to construct authenticated URLs for videos and images
export const getMediaUrl = (path) => {
  const token = localStorage.getItem('smart_cctv_token');
  return `${API_HOST}/media/${path}?token=${token}`;
};

// Cameras
export const getCameras = () => api.get('/cameras').then(r => r.data);
export const getCamera = (id) => api.get(`/cameras/${id}`).then(r => r.data);
export const addCamera = (data) => api.post('/cameras', data).then(r => r.data);
export const updateCamera = (id, data) => api.put(`/cameras/${id}`, data).then(r => r.data);
export const deleteCamera = (id) => api.delete(`/cameras/${id}`).then(r => r.data);
export const startRecording = (id) => api.post(`/cameras/${id}/record/start`).then(r => r.data);
export const stopRecording = (id) => api.post(`/cameras/${id}/record/stop`).then(r => r.data);

// Recordings
export const getRecordings = (params) => api.get('/recordings', { params }).then(r => r.data);
export const getTimeline = (cameraId, date) => api.get(`/recordings/timeline/${cameraId}`, { params: { date } }).then(r => r.data);
export const getRecordingDates = (cameraId) => api.get(`/recordings/dates/${cameraId}`).then(r => r.data);
export const deleteRecording = (id) => api.delete(`/recordings/${id}`).then(r => r.data);
export const getRecordingStreamUrl = (id) => {
  const token = localStorage.getItem('smart_cctv_token');
  return `${API_BASE}/recordings/${id}/stream?token=${token}`;
};

// Events
export const getEvents = (params) => api.get('/events', { params }).then(r => r.data);
export const getEventStats = (params) => api.get('/events/stats', { params }).then(r => r.data);
export const deleteEvent = (id) => api.delete(`/events/${id}`).then(r => r.data);
export const deleteEvents = (ids) => api.delete('/events', { data: { ids } }).then(r => r.data);

// Faces
export const getFaces = () => api.get('/faces').then(r => r.data);
export const addFace = (formData) => api.post('/faces', formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data);
export const deleteFace = (id) => api.delete(`/faces/${id}`).then(r => r.data);

// System
export const getSystemInfo = () => api.get('/system/info').then(r => r.data);
export const getSettings = () => api.get('/system/settings').then(r => r.data);
export const updateSettings = (data) => api.put('/system/settings', data).then(r => r.data);

export default api;
