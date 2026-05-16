import axios from 'axios';

const API_BASE = '/api';

const api = axios.create({
  baseURL: API_BASE,
  timeout: 10000,
});

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
export const getRecordingStreamUrl = (id) => `${API_BASE}/recordings/${id}/stream`;

// Events
export const getEvents = (params) => api.get('/events', { params }).then(r => r.data);
export const getEventStats = (params) => api.get('/events/stats', { params }).then(r => r.data);
export const deleteEvent = (id) => api.delete(`/events/${id}`).then(r => r.data);

// Faces
export const getFaces = () => api.get('/faces').then(r => r.data);
export const addFace = (formData) => api.post('/faces', formData, { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data);
export const deleteFace = (id) => api.delete(`/faces/${id}`).then(r => r.data);

// System
export const getSystemInfo = () => api.get('/system/info').then(r => r.data);
export const getSettings = () => api.get('/system/settings').then(r => r.data);
export const updateSettings = (data) => api.put('/system/settings', data).then(r => r.data);

export default api;
