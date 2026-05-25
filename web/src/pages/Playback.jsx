import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  getCameras,
  getTimeline,
  getRecordingStreamUrl,
  deleteRecording,
  getMediaUrl,
} from '../utils/api';
import { format } from 'date-fns';
import { vi } from 'date-fns/locale';
import { ChevronLeft, ChevronRight, Play, Pause, FastForward, SkipBack, SkipForward, Trash2, Image as ImageIcon } from 'lucide-react';

export default function Playback() {
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState(null);
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [timeline, setTimeline] = useState({ recordings: [], events: [] });
  const [currentRecording, setCurrentRecording] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const videoRef = useRef(null);
  const seekTimeRef = useRef(null);
  const [cursorPct, setCursorPct] = useState(null);
  
  const timelineRef = useRef(null);
  const isDragging = useRef(false);
  
  useEffect(() => {
    if (!currentRecording) {
      setCursorPct(null);
    }
  }, [currentRecording]);
  
  useEffect(() => {
    getCameras().then(data => {
      setCameras(data);
      if (data.length > 0) setSelectedCamera(data[0]);
    });
  }, []);
  
  useEffect(() => {
    if (!selectedCamera) return;
    getTimeline(selectedCamera.id, selectedDate)
    .then(setTimeline)
    .catch(() => setTimeline({ recordings: [], events: [] }));
  }, [selectedCamera, selectedDate]);
  
  const parseUTCDate = (str) => {
    if (!str) return new Date();
    const iso = str.includes('Z') || str.includes('+') ? str : str.replace(' ', 'T') + 'Z';
    return new Date(iso);
  };
  
  // 1. TÍNH TOÁN KHOẢNG THỜI GIAN THỰC TẾ CÓ BẢN GHI (BOUNDS)
  // Xác định mốc bắt đầu và kết thúc của timeline dựa trên các bản ghi thực tế có trong ngày
  const timelineBounds = useMemo(() => {
    if (!timeline.recordings || timeline.recordings.length === 0) {
      const dayStart = new Date(selectedDate + 'T00:00:00').getTime();
      return { start: dayStart, end: dayStart + 86400000, duration: 86400000 };
    }
    
    let minStart = Infinity;
    let maxEnd = -Infinity;
    
    timeline.recordings.forEach(rec => {
      const start = parseUTCDate(rec.start_time).getTime();
      const end = rec.end_time ? parseUTCDate(rec.end_time).getTime() : start + (rec.duration_seconds || 900) * 1000;
      if (start < minStart) minStart = start;
      if (end > maxEnd) maxEnd = end;
    });
    
    // Thêm một chút khoảng đệm (padding) 5 phút ở 2 đầu cho dễ nhìn
    minStart = minStart - 5 * 60 * 1000;
    maxEnd = maxEnd + 5 * 60 * 1000;
    
    return {
      start: minStart,
      end: maxEnd,
      duration: maxEnd - minStart
    };
  }, [timeline.recordings, selectedDate]);
  
  const playRecording = (rec, seekSeconds = 0) => {
    const isSameVideo = currentRecording && currentRecording.id === rec.id;
    
    if (isSameVideo) {
      if (videoRef.current) {
        videoRef.current.currentTime = seekSeconds;
        videoRef.current.playbackRate = speed;
        videoRef.current.play().catch(err => console.log("Play error:", err));
      }
      setPlaying(true);
    } else {
      setCurrentRecording(rec);
      setPlaying(true);
      seekTimeRef.current = seekSeconds;
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.src = getRecordingStreamUrl(rec.id);
          videoRef.current.playbackRate = speed;
          videoRef.current.play().catch(err => console.log("Play error:", err));
        }
      }, 100);
    }
  };
  
  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      if (seekTimeRef.current !== null && seekTimeRef.current > 0) {
        videoRef.current.currentTime = seekTimeRef.current;
        seekTimeRef.current = null;
      }
      videoRef.current.playbackRate = speed;
    }
  };
  
  const handleTimeUpdate = () => {
    if (!videoRef.current || !currentRecording || isDragging.current) return;
    const start = parseUTCDate(currentRecording.start_time);
    const currentTimestamp = start.getTime() + videoRef.current.currentTime * 1000;
    
    // Tính % vị trí con trỏ dựa theo khoảng timeline thu gọn mới
    const pct = ((currentTimestamp - timelineBounds.start) / timelineBounds.duration) * 100;
    setCursorPct(Math.max(0, Math.min(100, pct)));
  };
  
  const handleDeleteRecording = async (id) => {
    if (!confirm('Bạn có chắc chắn muốn xóa bản ghi này?')) return;
    try {
      await deleteRecording(id);
      if (currentRecording && currentRecording.id === id) {
        setCurrentRecording(null);
        setPlaying(false);
        if (videoRef.current) videoRef.current.src = '';
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
  
  const formatTimeLocal = (utcString) => {
    if (!utcString) return '';
    let isoString = utcString;
    if (!utcString.includes('Z') && !utcString.includes('+')) {
      isoString = utcString.replace(' ', 'T') + 'Z';
    }
    try {
      const date = new Date(isoString);
      return date.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch {
      return utcString;
    }
  };
  
  const formatDuration = (seconds) => {
    if (!seconds) return '0s';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${mins}ph ${secs}s` : `${mins} phút`;
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
  
  // Tạo các đoạn timeline dựa trên khoảng bounds thu gọn
  const timelineSegments = useCallback(() => {
    const segments = [];
    timeline.recordings.forEach(rec => {
      const start = parseUTCDate(rec.start_time).getTime();
      const end = rec.end_time ? parseUTCDate(rec.end_time).getTime() : start + (rec.duration_seconds || 900) * 1000;
      
      const startPct = Math.max(0, (start - timelineBounds.start) / timelineBounds.duration) * 100;
      const widthPct = Math.max(0.5, ((end - start) / timelineBounds.duration) * 100);
      segments.push({ type: 'recording', left: startPct, width: widthPct, rec });
    });
    
    timeline.events.forEach(evt => {
      const time = parseUTCDate(evt.timestamp).getTime();
      if (time >= timelineBounds.start && time <= timelineBounds.end) {
        const pct = ((time - timelineBounds.start) / timelineBounds.duration) * 100;
        segments.push({ type: 'event', left: pct, width: 0.4, evt });
      }
    });
    return segments;
  }, [timeline, timelineBounds]);
  
  const handleTimelineAction = (clientX) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    
    setCursorPct(pct * 100);
    
    const targetTimestamp = timelineBounds.start + (pct * timelineBounds.duration);
    
    const closest = timeline.recordings.find(rec => {
      const start = parseUTCDate(rec.start_time).getTime();
      const end = rec.end_time ? parseUTCDate(rec.end_time).getTime() : start + (rec.duration_seconds || 900) * 1000;
      return targetTimestamp >= start && targetTimestamp <= end;
    });
    
    if (closest) {
      const offsetSeconds = Math.max(0, (targetTimestamp - parseUTCDate(closest.start_time).getTime()) / 1000);
      playRecording(closest, offsetSeconds);
    }
  };
  
  const handleMouseDown = (e) => {
    isDragging.current = true;
    handleTimelineAction(e.clientX);
  };
  const handleMouseMove = (e) => {
    if (!isDragging.current) return;
    handleTimelineAction(e.clientX);
  };
  const handleMouseUpOrLeave = () => { isDragging.current = false; };
  
  const handleTouchStart = (e) => {
    isDragging.current = true;
    if (e.touches[0]) handleTimelineAction(e.touches[0].clientX);
  };
  const handleTouchMove = (e) => {
    if (!isDragging.current) return;
    if (e.touches[0]) handleTimelineAction(e.touches[0].clientX);
  };
  
  const recordingsWithEvents = useMemo(() => {
    if (!timeline.recordings) return [];
    return [...timeline.recordings]
    .sort((a, b) => parseUTCDate(b.start_time).getTime() - parseUTCDate(a.start_time).getTime())
    .map(rec => {
      const startMs = parseUTCDate(rec.start_time).getTime();
      const endMs = rec.end_time ? parseUTCDate(rec.end_time).getTime() : startMs + (rec.duration_seconds || 900) * 1000;
      
      const relatedEvents = (timeline.events || []).filter(evt => {
        const evtMs = parseUTCDate(evt.timestamp).getTime();
        return evtMs >= startMs && evtMs <= endMs && evt.snapshot_path;
      });
      
      const thumbUrl = relatedEvents.length > 0 ? relatedEvents[0].snapshot_path : null;
      return { ...rec, thumbUrl, eventCount: relatedEvents.length };
    });
  }, [timeline.recordings, timeline.events]);
  
  return (
    <div>
      {/* Controls */}
      <div className="toolbar">
        <div className="toolbar-group">
          <select
            className="form-select camera-select"
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
              className="form-input date-input"
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
            />
            <button className="btn-icon" onClick={() => changeDate(1)}><ChevronRight size={16} /></button>
          </div>
        </div>
      </div>
  
      {/* Video Player - 2 video 16:9 ghép DỌC (Tỷ lệ tổng 8:9) */}
      <div className="mb-4" style={{ width: 360, height: 405, margin: '0 auto 16px', backgroundColor: '#000', borderRadius: '8px', overflow: 'hidden', position: 'relative' }}>
        {currentRecording ? (
          <video
            ref={videoRef}
            controls
            style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }}
            onEnded={() => setPlaying(false)}
            onLoadedMetadata={handleLoadedMetadata}
            onTimeUpdate={handleTimeUpdate}
          />
        ) : (
          <div className="video-placeholder" style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#1f2937', color: '#9ca3af' }}>
            <Play size={32} />
            <p style={{ fontSize: '13px', marginTop: '10px', padding: '0 16px', textAlign: 'center' }}>
              Chọn một đoạn trên timeline hoặc trượt để xem lại
            </p>
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
        
        {/* Timeline - Chỉ hiển thị vùng có recordings */}
        <div className="timeline-container">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-bold">
              Timeline ({formatTimeLocal(new Date(timelineBounds.start).toISOString())} - {formatTimeLocal(new Date(timelineBounds.end).toISOString())})
            </span>
            <span className="text-xs text-muted">
              {timeline.recordings.length} đoạn ghi · {timeline.events.length} sự kiện
            </span>
          </div>
          <div
            ref={timelineRef}
            className="timeline-bar"
            style={{ cursor: 'ew-resize', userSelect: 'none', background: '#333' }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUpOrLeave}
            onMouseLeave={handleMouseUpOrLeave}
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleMouseUpOrLeave}
          >
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
            {cursorPct !== null && (
              <div className="timeline-cursor" style={{ left: `${cursorPct}%` }} />
            )}
          </div>
          
          {/* Nhãn thời gian động thay đổi dựa theo mốc thực tế */}
          <div className="timeline-labels">
            <span>{formatTimeLocal(new Date(timelineBounds.start).toISOString())}</span>
            <span>{formatTimeLocal(new Date(timelineBounds.start + timelineBounds.duration / 2).toISOString())}</span>
            <span>{formatTimeLocal(new Date(timelineBounds.end).toISOString())}</span>
          </div>
        </div>
        
        {/* Danh sách bản ghi tích hợp Thumbnail của Event */}
        <div className="mt-4">
          <h3 className="text-sm font-bold mb-2">Danh sách bản ghi</h3>
          {recordingsWithEvents.length === 0 ? (
            <div className="empty-state" style={{ padding: 30 }}>
              <p className="text-muted">Không có bản ghi nào trong ngày này</p>
            </div>
          ) : (
            <div className="recordings-list-scroll">
              <div className="flex flex-col gap-2">
                {recordingsWithEvents.map(rec => (
                  <div
                    key={rec.id}
                    className="card"
                    style={{
                      cursor: 'pointer',
                      borderColor: currentRecording?.id === rec.id ? 'var(--accent)' : undefined,
                      overflow: 'hidden'
                    }}
                    onClick={() => playRecording(rec)}
                  >
                    <div className="card-body" style={{ padding: '8px 12px' }}>
                      <div className="flex items-center justify-between gap-4">
                        
                        {/* Khu vực hiển thị nội dung & Thumb ảnh */}
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          {/* Khối hiển thị Thumbnail thực tế lấy từ Event */}
                          {rec.thumbUrl ? (
                            <img
                              src={getMediaUrl(`snapshots/${rec.thumbUrl}`)}
                              alt="Event thumb"
                              className="rounded object-cover"
                              style={{ width: '64px', height: '40px', background: '#000' }}
                              onError={(e) => { e.currentTarget.style.display = 'none'; }} // Ẩn nếu link lỗi
                            />
                          ) : (
                            <div
                              className="rounded flex items-center justify-center text-muted"
                              style={{ width: '64px', height: '40px', background: 'rgba(255,255,255,0.05)' }}
                            >
                              <ImageIcon size={16} className="opacity-40" />
                            </div>
                          )}
                          
                          <div className="flex flex-col">
                            <span className="text-mono text-sm font-bold">
                              {formatTimeLocal(rec.start_time)}
                            </span>
                            <span className="text-muted text-xs">
                              Thời lượng: {formatDuration(rec.duration_seconds)}
                              {rec.eventCount > 0 && ` · (${rec.eventCount} sự kiện)`}
                            </span>
                          </div>
                        </div>
                        
                        {/* Khu vực Dung lượng & Nút Xóa */}
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
                              padding: 6,
                              color: 'var(--danger)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              borderRadius: '50%',
                              border: 'none',
                              background: 'none'
                            }}
                            title="Xóa bản ghi"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}