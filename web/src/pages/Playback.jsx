import React, { useState, useEffect, useRef, useCallback } from 'react';
import { getCameras, getTimeline, getRecordingStreamUrl, deleteRecording } from '../utils/api';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Play, Pause, FastForward, SkipBack, SkipForward, Trash2 } from 'lucide-react';

export default function Playback() {
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState(null);
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [timeline, setTimeline] = useState({ recordings: [], events: [] });
  const [currentRecording, setCurrentRecording] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const videoRef = useRef(null);

  useEffect(() => {
    getCameras().then(data => {
      setCameras(data);
      if (data.length > 0) setSelectedCamera(data[0]);
    });
  }, []);

  useEffect(() => {
    if (!selectedCamera) return;
    getTimeline(selectedCamera.id, selectedDate).then(setTimeline).catch(() => setTimeline({ recordings: [], events: [] }));
  }, [selectedCamera, selectedDate]);

  const playRecording = (rec) => {
    setCurrentRecording(rec);
    setPlaying(true);
    setTimeout(() => {
      if (videoRef.current) {
        videoRef.current.src = getRecordingStreamUrl(rec.id);
        videoRef.current.playbackRate = speed;
        videoRef.current.play();
      }
    }, 100);
  };

  const handleDeleteRecording = async (id) => {
    if (!confirm('Bạn có chắc chắn muốn xóa bản ghi này? File video trên ổ đĩa sẽ bị xóa vĩnh viễn.')) return;
    try {
      await deleteRecording(id);
      
      if (currentRecording && currentRecording.id === id) {
        setCurrentRecording(null);
        setPlaying(false);
        if (videoRef.current) {
          videoRef.current.src = '';
        }
      }
      
      if (selectedCamera) {
        getTimeline(selectedCamera.id, selectedDate)
          .then(setTimeline)
          .catch(() => setTimeline({ recordings: [], events: [] }));
      }
    } catch (err) {
      alert('Không thể xóa bản ghi: ' + (err.response?.data?.error || err.message));
    }
  };

  const changeSpeed = () => {
    const speeds = [0.5, 1, 2, 4, 8, 16];
    const idx = speeds.indexOf(speed);
    const next = speeds[(idx + 1) % speeds.length];
    setSpeed(next);
    if (videoRef.current) videoRef.current.playbackRate = next;
  };

  const changeDate = (delta) => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + delta);
    setSelectedDate(format(d, 'yyyy-MM-dd'));
  };

  // Build timeline segments
  const timelineSegments = useCallback(() => {
    const segments = [];
    timeline.recordings.forEach(rec => {
      const start = new Date(rec.start_time);
      const end = rec.end_time ? new Date(rec.end_time) : new Date(start.getTime() + (rec.duration_seconds || 900) * 1000);
      const dayStart = new Date(selectedDate + 'T00:00:00');
      const startPct = Math.max(0, (start - dayStart) / 86400000) * 100;
      const widthPct = Math.max(0.5, ((end - start) / 86400000) * 100);
      segments.push({ type: 'recording', left: startPct, width: widthPct, rec });
    });
    timeline.events.forEach(evt => {
      const time = new Date(evt.timestamp);
      const dayStart = new Date(selectedDate + 'T00:00:00');
      const pct = ((time - dayStart) / 86400000) * 100;
      segments.push({ type: 'event', left: pct, width: 0.3, evt });
    });
    return segments;
  }, [timeline, selectedDate]);

  const handleTimelineClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const clickMinute = pct * 24 * 60;
    // Find closest recording
    const closest = timeline.recordings.find(rec => {
      const start = new Date(rec.start_time);
      const startMin = start.getHours() * 60 + start.getMinutes();
      const endMin = startMin + (rec.duration_seconds || 900) / 60;
      return clickMinute >= startMin && clickMinute <= endMin;
    });
    if (closest) playRecording(closest);
  };

  return (
    <div>
      {/* Controls */}
      <div className="toolbar">
        <div className="toolbar-group">
          <select
            className="form-select"
            style={{ width: 200 }}
            value={selectedCamera?.id || ''}
            onChange={e => setSelectedCamera(cameras.find(c => c.id === e.target.value))}
          >
            {cameras.map(cam => (
              <option key={cam.id} value={cam.id}>{cam.name}</option>
            ))}
          </select>

          <div className="flex items-center gap-2">
            <button className="btn-icon" onClick={() => changeDate(-1)}><ChevronLeft size={16} /></button>
            <input
              type="date"
              className="form-input"
              style={{ width: 160 }}
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
            />
            <button className="btn-icon" onClick={() => changeDate(1)}><ChevronRight size={16} /></button>
          </div>
        </div>
      </div>

      {/* Video Player */}
      <div className="video-player-container mb-4" style={{ maxWidth: 960, margin: '0 auto 16px' }}>
        {currentRecording ? (
          <video
            ref={videoRef}
            controls
            style={{ width: '100%', height: '100%' }}
            onEnded={() => setPlaying(false)}
          />
        ) : (
          <div className="video-placeholder">
            <Play size={32} />
            <p>Chọn một đoạn trên timeline để xem lại</p>
          </div>
        )}
      </div>

      {/* Playback Controls */}
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <div className="card mb-4">
          <div className="card-body">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button className="btn-icon" onClick={() => {
                  if (videoRef.current) videoRef.current.currentTime -= 10;
                }}><SkipBack size={16} /></button>
                <button className="btn btn-primary" onClick={() => {
                  if (videoRef.current) playing ? videoRef.current.pause() : videoRef.current.play();
                  setPlaying(!playing);
                }}>
                  {playing ? <Pause size={16} /> : <Play size={16} />}
                </button>
                <button className="btn-icon" onClick={() => {
                  if (videoRef.current) videoRef.current.currentTime += 10;
                }}><SkipForward size={16} /></button>
              </div>
              <button className="btn btn-secondary btn-sm" onClick={changeSpeed}>
                <FastForward size={14} /> {speed}x
              </button>
            </div>
          </div>
        </div>

        {/* Timeline */}
        <div className="timeline-container">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-bold">Timeline</span>
            <span className="text-xs text-muted">
              {timeline.recordings.length} đoạn ghi · {timeline.events.length} sự kiện
            </span>
          </div>
          <div className="timeline-bar" onClick={handleTimelineClick}>
            {timelineSegments().map((seg, i) => (
              <div
                key={i}
                className={`timeline-segment ${seg.type}`}
                style={{ left: `${seg.left}%`, width: `${seg.width}%` }}
                title={seg.type === 'recording'
                  ? `${seg.rec.start_time} - ${seg.rec.end_time || 'đang ghi'}`
                  : `${seg.evt.type}: ${seg.evt.timestamp}`
                }
              />
            ))}
          </div>
          <div className="timeline-labels">
            {Array.from({ length: 13 }, (_, i) => (
              <span key={i}>{String(i * 2).padStart(2, '0')}:00</span>
            ))}
          </div>
        </div>

        {/* Recording List */}
        <div className="mt-4">
          <h3 className="text-sm font-bold mb-2">Danh sách bản ghi</h3>
          {timeline.recordings.length === 0 ? (
            <div className="empty-state" style={{ padding: 30 }}>
              <p className="text-muted">Không có bản ghi nào trong ngày này</p>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {timeline.recordings.map(rec => (
                <div
                  key={rec.id}
                  className="card"
                  style={{ cursor: 'pointer', borderColor: currentRecording?.id === rec.id ? 'var(--accent)' : undefined }}
                  onClick={() => playRecording(rec)}
                >
                  <div className="card-body" style={{ padding: '10px 14px' }}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Play size={14} style={{ color: 'var(--accent)' }} />
                        <span className="text-mono text-sm">
                          {rec.start_time?.split('T')[1]?.slice(0, 8) || rec.start_time}
                        </span>
                        <span className="text-muted text-xs">
                          {Math.round((rec.duration_seconds || 0) / 60)} phút
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-muted text-xs">
                          {rec.size_bytes ? `${(rec.size_bytes / 1024 / 1024).toFixed(1)} MB` : ''}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteRecording(rec.id);
                          }}
                          className="btn-icon"
                          style={{ 
                            padding: 4, 
                            color: 'var(--danger)', 
                            opacity: 0.8,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            borderRadius: '50%',
                            border: 'none',
                            background: 'none'
                          }}
                          title="Xóa bản ghi"
                          onMouseEnter={(e) => e.currentTarget.style.opacity = 1}
                          onMouseLeave={(e) => e.currentTarget.style.opacity = 0.8}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
