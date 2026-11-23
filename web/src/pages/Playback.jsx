import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  getCameras,
  getTimeline,
  getRecordingStreamUrl,
  deleteRecording,
  getMediaUrl,
} from '../utils/api';
import { format } from 'date-fns';
import {
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  FastForward,
  SkipBack,
  SkipForward,
  Trash2,
  Image as ImageIcon,
  ChevronDown,
  Camera,
  Columns,
  Rows,
  ArrowUpSquare,
  ArrowDownSquare,
  Download,
} from 'lucide-react';

export default function Playback() {
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState(null);
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [timeline, setTimeline] = useState({ recordings: [], events: [] });
  const [currentRecording, setCurrentRecording] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  // Dual-Lens Playback View Mode ('split' | 'stacked' | 'top' | 'bottom')
  const [lensMode, setLensMode] = useState('split');
  const [hoverTimeLabel, setHoverTimeLabel] = useState(null);
  const [hoverPct, setHoverPct] = useState(0);

  const videoRef = useRef(null);
  const secondaryVideoRef = useRef(null);
  const seekTimeRef = useRef(null);
  const currentVideoIdRef = useRef(null);
  const [cursorPct, setCursorPct] = useState(null);
  const [aspectRatio, setAspectRatio] = useState(8 / 9);

  const timelineRef = useRef(null);
  const isDragging = useRef(false);

  // Sync secondary video element when in 'split' (Side-by-Side 2x16:9) mode
  const syncSecondaryPlayback = useCallback(() => {
    const primary = videoRef.current;
    const secondary = secondaryVideoRef.current;
    if (lensMode !== 'split' || !primary || !secondary) return;

    if (primary.src && secondary.src !== primary.src) {
      secondary.src = primary.src;
    }
    secondary.playbackRate = primary.playbackRate;
    if (Math.abs(secondary.currentTime - primary.currentTime) > 0.35) {
      secondary.currentTime = primary.currentTime;
    }
    if (!primary.paused && secondary.paused) {
      secondary.play().catch(() => {});
    } else if (primary.paused && !secondary.paused) {
      secondary.pause();
    }
  }, [lensMode]);

  useEffect(() => {
    syncSecondaryPlayback();
  }, [lensMode, playing, speed, currentRecording, syncSecondaryPlayback]);

  useEffect(() => {
    if (!currentRecording) {
      setCursorPct(null);
      setAspectRatio(8 / 9);
    }
  }, [currentRecording]);

  useEffect(() => {
    getCameras().then((data) => {
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

  const [visibleRange, setVisibleRange] = useState([0, 1]);

  const timelineDayBounds = useMemo(() => {
    const dayStart = new Date(selectedDate + 'T00:00:00+07:00').getTime();
    return {
      start: dayStart,
      end: dayStart + 86400000,
      duration: 86400000,
    };
  }, [selectedDate]);

  const timelineBounds = useMemo(() => {
    return {
      start: timelineDayBounds.start + visibleRange[0] * timelineDayBounds.duration,
      end: timelineDayBounds.start + visibleRange[1] * timelineDayBounds.duration,
      duration: (visibleRange[1] - visibleRange[0]) * timelineDayBounds.duration,
    };
  }, [timelineDayBounds, visibleRange]);

  const playRecording = useCallback(
    (rec, seekSeconds = 0) => {
      const isSameVideo = currentVideoIdRef.current === rec.id;
      const streamUrl = getRecordingStreamUrl(rec.id);

      if (isSameVideo) {
        if (videoRef.current) {
          videoRef.current.currentTime = seekSeconds;
          videoRef.current.playbackRate = speed;
          videoRef.current.play().catch(() => {});
        }
        if (secondaryVideoRef.current) {
          secondaryVideoRef.current.currentTime = seekSeconds;
          secondaryVideoRef.current.playbackRate = speed;
          secondaryVideoRef.current.play().catch(() => {});
        }
        setPlaying(true);
        if (!currentRecording || currentRecording.id !== rec.id) {
          setCurrentRecording(rec);
        }
      } else {
        currentVideoIdRef.current = rec.id;
        setCurrentRecording(rec);
        setPlaying(true);
        seekTimeRef.current = seekSeconds;
        setTimeout(() => {
          if (videoRef.current) {
            videoRef.current.src = streamUrl;
            videoRef.current.playbackRate = speed;
            videoRef.current.play().catch(() => {});
          }
          if (secondaryVideoRef.current) {
            secondaryVideoRef.current.src = streamUrl;
            secondaryVideoRef.current.playbackRate = speed;
            secondaryVideoRef.current.play().catch(() => {});
          }
        }, 50);
      }
    },
    [speed, currentRecording]
  );

  // Seamless auto-advance to next segment when current segment ends
  const handleVideoEnded = () => {
    setPlaying(false);
    if (!currentRecording || !timeline.recordings) return;
    const sorted = [...timeline.recordings].sort(
      (a, b) => parseUTCDate(a.start_time).getTime() - parseUTCDate(b.start_time).getTime()
    );
    const idx = sorted.findIndex((r) => r.id === currentRecording.id);
    if (idx !== -1 && idx + 1 < sorted.length) {
      playRecording(sorted[idx + 1], 0);
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      if (seekTimeRef.current !== null && seekTimeRef.current > 0) {
        videoRef.current.currentTime = seekTimeRef.current;
        if (secondaryVideoRef.current) {
          secondaryVideoRef.current.currentTime = seekTimeRef.current;
        }
        seekTimeRef.current = null;
      }
      videoRef.current.playbackRate = speed;
      if (videoRef.current.videoWidth && videoRef.current.videoHeight) {
        setAspectRatio(videoRef.current.videoWidth / videoRef.current.videoHeight);
      }
      syncSecondaryPlayback();
    }
  };

  const handleTimeUpdate = () => {
    if (!videoRef.current || !currentRecording || isDragging.current) return;
    const start = parseUTCDate(currentRecording.start_time);
    const currentTimestamp = start.getTime() + videoRef.current.currentTime * 1000;

    const pct = ((currentTimestamp - timelineBounds.start) / timelineBounds.duration) * 100;
    setCursorPct(Math.max(0, Math.min(100, pct)));
    syncSecondaryPlayback();
  };

  // Capture PNG snapshot directly from recorded video playback
  const handlePlaybackSnapshot = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    if (lensMode === 'top') {
      canvas.width = vw;
      canvas.height = Math.floor(vh / 2);
      ctx.drawImage(video, 0, 0, vw, canvas.height, 0, 0, vw, canvas.height);
    } else if (lensMode === 'bottom') {
      canvas.width = vw;
      canvas.height = Math.floor(vh / 2);
      ctx.drawImage(video, 0, canvas.height, vw, canvas.height, 0, 0, vw, canvas.height);
    } else if (lensMode === 'split') {
      const halfH = Math.floor(vh / 2);
      canvas.width = vw * 2;
      canvas.height = halfH;
      ctx.drawImage(video, 0, 0, vw, halfH, 0, 0, vw, halfH);
      ctx.drawImage(video, 0, halfH, vw, halfH, vw, 0, vw, halfH);
    } else {
      canvas.width = vw;
      canvas.height = vh;
      ctx.drawImage(video, 0, 0, vw, vh);
    }

    const link = document.createElement('a');
    link.download = `playback_${selectedCamera?.stream_id || 'cam'}_${lensMode}_${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  const handleDeleteRecording = async (id) => {
    if (!confirm('Bạn có chắc chắn muốn xóa bản ghi này?')) return;
    try {
      await deleteRecording(id);
      if (currentRecording && currentRecording.id === id) {
        setCurrentRecording(null);
        setPlaying(false);
        if (videoRef.current) videoRef.current.src = '';
        if (secondaryVideoRef.current) secondaryVideoRef.current.src = '';
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
      return date.toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZone: 'Asia/Ho_Chi_Minh',
      });
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
    if (secondaryVideoRef.current) secondaryVideoRef.current.playbackRate = next;
  };

  const changeDate = (delta) => {
    const d = new Date(selectedDate);
    d.setDate(d.getDate() + delta);
    setSelectedDate(format(d, 'yyyy-MM-dd'));
  };

  const timelineSegments = useCallback(
    (bounds) => {
      const segments = [];
      (timeline.recordings || []).forEach((rec) => {
        const start = parseUTCDate(rec.start_time).getTime();
        const end = rec.end_time
          ? parseUTCDate(rec.end_time).getTime()
          : start + (rec.duration_seconds || 900) * 1000;

        const startPct = ((start - bounds.start) / bounds.duration) * 100;
        const widthPct = Math.max(0.15, ((end - start) / bounds.duration) * 100);
        segments.push({ type: 'recording', left: startPct, width: widthPct, rec });
      });

      (timeline.events || []).forEach((evt) => {
        const time = parseUTCDate(evt.timestamp).getTime();
        if (time >= bounds.start && time <= bounds.end) {
          const pct = ((time - bounds.start) / bounds.duration) * 100;
          segments.push({ type: 'event', left: pct, width: 0.45, evt });
        }
      });
      return segments;
    },
    [timeline]
  );

  const [isDraggingRange, setIsDraggingRange] = useState(false);
  const [dragType, setDragType] = useState(null);
  const dragStartData = useRef({ x: 0, range: [0, 1] });
  const minimapRef = useRef(null);

  const handleMinimapPanStart = (type) => (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDraggingRange(true);
    setDragType(type);
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    dragStartData.current = { x: clientX, range: [...visibleRange] };
  };

  useEffect(() => {
    if (!isDraggingRange) return;

    const handleMove = (e) => {
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const deltaX = clientX - dragStartData.current.x;
      const rect = minimapRef.current.getBoundingClientRect();
      const deltaPct = deltaX / rect.width;

      let [start, end] = dragStartData.current.range;

      if (dragType === 'window') {
        const span = end - start;
        start = Math.max(0, Math.min(1 - span, start + deltaPct));
        end = start + span;
      } else if (dragType === 'left') {
        start = Math.max(0, Math.min(end - 0.02, start + deltaPct));
      } else if (dragType === 'right') {
        end = Math.max(start + 0.02, Math.min(1, end + deltaPct));
      }

      setVisibleRange([start, end]);
    };

    const handleUp = () => {
      setIsDraggingRange(false);
      setDragType(null);
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    window.addEventListener('touchmove', handleMove);
    window.addEventListener('touchend', handleUp);

    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
      window.removeEventListener('touchmove', handleMove);
      window.removeEventListener('touchend', handleUp);
    };
  }, [isDraggingRange, dragType, visibleRange]);

  const handleTimelineAction = (clientX) => {
    if (!timelineRef.current) return;
    const rect = timelineRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));

    setCursorPct(pct * 100);

    const targetTimestamp = timelineBounds.start + pct * timelineBounds.duration;

    let closest = null;
    let minDiff = Infinity;

    (timeline.recordings || []).forEach((rec) => {
      const start = parseUTCDate(rec.start_time).getTime();
      const end = rec.end_time
        ? parseUTCDate(rec.end_time).getTime()
        : start + (rec.duration_seconds || 900) * 1000;

      if (targetTimestamp >= start && targetTimestamp <= end) {
        if (0 < minDiff) {
          minDiff = 0;
          closest = rec;
        }
      } else {
        const diffStart = Math.abs(targetTimestamp - start);
        const diffEnd = Math.abs(targetTimestamp - end);
        const diff = Math.min(diffStart, diffEnd);

        if (diff < minDiff) {
          minDiff = diff;
          closest = rec;
        }
      }
    });

    if (closest) {
      const start = parseUTCDate(closest.start_time).getTime();
      const end = closest.end_time
        ? parseUTCDate(closest.end_time).getTime()
        : start + (closest.duration_seconds || 900) * 1000;

      let offsetSeconds = 0;
      if (targetTimestamp >= start && targetTimestamp <= end) {
        offsetSeconds = Math.max(0, (targetTimestamp - start) / 1000);
      }
      if (targetTimestamp > end) {
        offsetSeconds = Math.max(0, (end - start) / 1000 - 1);
      }
      playRecording(closest, offsetSeconds);
    }
  };

  const handleMouseDown = (e) => {
    isDragging.current = true;
    handleTimelineAction(e.clientX);
  };
  const handleMouseMove = (e) => {
    if (timelineRef.current) {
      const rect = timelineRef.current.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const hoverTs = timelineBounds.start + pct * timelineBounds.duration;
      setHoverPct(pct * 100);
      setHoverTimeLabel(formatTimeLocal(new Date(hoverTs).toISOString()));
    }
    if (!isDragging.current) return;
    handleTimelineAction(e.clientX);
  };
  const handleMouseUpOrLeave = () => {
    isDragging.current = false;
    setHoverTimeLabel(null);
  };

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
      .map((rec) => {
        const startMs = parseUTCDate(rec.start_time).getTime();
        const endMs = rec.end_time
          ? parseUTCDate(rec.end_time).getTime()
          : startMs + (rec.duration_seconds || 900) * 1000;

        const relatedEvents = (timeline.events || []).filter((evt) => {
          const evtMs = parseUTCDate(evt.timestamp).getTime();
          return evtMs >= startMs && evtMs <= endMs && evt.snapshot_path;
        });

        const thumbUrl = relatedEvents.length > 0 ? relatedEvents[0].snapshot_path : null;
        return { ...rec, thumbUrl, eventCount: relatedEvents.length };
      });
  }, [timeline.recordings, timeline.events]);

  return (
    <div>
      {/* NVR Top Filter & Dual-Lens Mode Bar */}
      <div className="vms-control-strip mb-3" style={{ borderRadius: 'var(--radius-md)' }}>
        <div className="vms-strip-left">
          <div className="flex items-center gap-2 text-muted">
            <Camera size={16} />
            <span className="text-xs font-bold uppercase">Kênh:</span>
          </div>

          <div className="filter-select-wrapper">
            <select
              className="filter-select"
              value={selectedCamera?.id || ''}
              onChange={(e) =>
                setSelectedCamera(cameras.find((c) => c.id === e.target.value))
              }
            >
              {cameras.map((cam) => (
                <option key={cam.id} value={cam.id}>
                  {cam.name}
                </option>
              ))}
            </select>
            <ChevronDown className="filter-chevron" />
          </div>

          <div className="vms-divider" />

          <div className="flex items-center gap-1">
            <button type="button" className="btn-icon btn-sm" onClick={() => changeDate(-1)}>
              <ChevronLeft size={14} />
            </button>
            <input
              type="date"
              className="filter-select"
              style={{ minWidth: 140, paddingRight: 10 }}
              value={selectedDate}
              onChange={(e) => setSelectedDate(e.target.value)}
            />
            <button type="button" className="btn-icon btn-sm" onClick={() => changeDate(1)}>
              <ChevronRight size={14} />
            </button>
          </div>
        </div>

        {/* Dual-Lens Playback View Selector */}
        <div className="vms-strip-right">
          <div className="vms-btn-group" title="Chế độ xem lại cho Camera 2 mắt">
            <button
              type="button"
              className={`vms-strip-btn ${lensMode === 'split' ? 'active' : ''}`}
              onClick={() => setLensMode('split')}
            >
              <Columns size={13} /> <span>Tách Ngang 2 Mắt</span>
            </button>
            <button
              type="button"
              className={`vms-strip-btn ${lensMode === 'stacked' ? 'active' : ''}`}
              onClick={() => setLensMode('stacked')}
            >
              <Rows size={13} /> <span>Kép Dọc (8:9)</span>
            </button>
            <button
              type="button"
              className={`vms-strip-btn ${lensMode === 'top' ? 'active' : ''}`}
              onClick={() => setLensMode('top')}
            >
              <ArrowUpSquare size={13} /> <span>Mắt 1 (Trên)</span>
            </button>
            <button
              type="button"
              className={`vms-strip-btn ${lensMode === 'bottom' ? 'active' : ''}`}
              onClick={() => setLensMode('bottom')}
            >
              <ArrowDownSquare size={13} /> <span>Mắt 2 (Dưới)</span>
            </button>
          </div>
        </div>
      </div>

      <div className="playback-layout-container">
        {/* Left column: Dual-Lens NVR Video Stage and Deck Controls */}
        <div className="playback-video-section">
          <div className="playback-video-wrapper shadow-md border border-border">
            {currentRecording ? (
              <div className={`vms-player-root lens-mode-${lensMode}`}>
                {lensMode === 'split' ? (
                  <div className="vms-dual-split-grid">
                    <div className="vms-split-pane">
                      <span className="vms-lens-tag">MẮT 1 (TRÊN - 16:9)</span>
                      <div className="vms-crop-box crop-top">
                        <video
                          ref={videoRef}
                          onEnded={handleVideoEnded}
                          onLoadedMetadata={handleLoadedMetadata}
                          onTimeUpdate={handleTimeUpdate}
                          onPlay={() => setPlaying(true)}
                          onPause={() => setPlaying(false)}
                        />
                      </div>
                    </div>
                    <div className="vms-split-pane">
                      <span className="vms-lens-tag">MẮT 2 (DƯỚI - 16:9)</span>
                      <div className="vms-crop-box crop-bottom">
                        <video ref={secondaryVideoRef} muted />
                      </div>
                    </div>
                  </div>
                ) : lensMode === 'top' || lensMode === 'bottom' ? (
                  <div className="vms-single-lens-stage">
                    <span className="vms-lens-tag">
                      {lensMode === 'top' ? 'MẮT 1 (TRÊN 16:9)' : 'MẮT 2 (DƯỚI 16:9)'}
                    </span>
                    <div
                      className={`vms-crop-box ${
                        lensMode === 'top' ? 'crop-top' : 'crop-bottom'
                      }`}
                    >
                      <video
                        ref={videoRef}
                        onEnded={handleVideoEnded}
                        onLoadedMetadata={handleLoadedMetadata}
                        onTimeUpdate={handleTimeUpdate}
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                      />
                    </div>
                  </div>
                ) : (
                  <div className="vms-stacked-stage">
                    <video
                      ref={videoRef}
                      controls
                      style={{
                        maxWidth: '100%',
                        maxHeight: '100%',
                        aspectRatio: `${aspectRatio}`,
                        objectFit: 'contain',
                      }}
                      onEnded={handleVideoEnded}
                      onLoadedMetadata={handleLoadedMetadata}
                      onTimeUpdate={handleTimeUpdate}
                    />
                  </div>
                )}
              </div>
            ) : (
              <div
                className="video-placeholder"
                style={{
                  width: '100%',
                  height: '100%',
                  background: 'var(--bg-secondary)',
                }}
              >
                <Play size={32} />
                <p style={{ fontSize: '13px', marginTop: '10px', textAlign: 'center' }}>
                  Chọn một đoạn ghi trên thước Timeline 24h hoặc danh sách bên phải để phát lại
                </p>
              </div>
            )}
          </div>

          {/* NVR Transport Deck Controls */}
          <div className="card">
            <div className="card-body" style={{ padding: '10px 14px' }}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn-icon"
                    title="Lùi 10 giây"
                    onClick={() => {
                      if (videoRef.current) videoRef.current.currentTime -= 10;
                    }}
                  >
                    <SkipBack size={16} />
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      if (!videoRef.current) return;
                      if (playing) {
                        videoRef.current.pause();
                        secondaryVideoRef.current?.pause();
                      } else {
                        videoRef.current.play().catch(() => {});
                        secondaryVideoRef.current?.play().catch(() => {});
                      }
                      setPlaying(!playing);
                    }}
                  >
                    {playing ? <Pause size={16} /> : <Play size={16} />}
                  </button>
                  <button
                    type="button"
                    className="btn-icon"
                    title="Tua tới 10 giây"
                    onClick={() => {
                      if (videoRef.current) videoRef.current.currentTime += 10;
                    }}
                  >
                    <SkipForward size={16} />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={changeSpeed}
                    title="Tốc độ phát lại"
                  >
                    <FastForward size={14} /> {speed}x
                  </button>

                  {currentRecording && (
                    <>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={handlePlaybackSnapshot}
                        title="Chụp ảnh PNG từ khung hình đang xem lại"
                      >
                        <Camera size={14} /> Chụp ảnh
                      </button>

                      <a
                        href={getRecordingStreamUrl(currentRecording.id)}
                        download={`recording_${currentRecording.id}.mp4`}
                        className="btn btn-secondary btn-sm"
                        title="Tải file video MP4 về máy"
                      >
                        <Download size={14} /> Tải MP4
                      </a>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Right column: NVR 24h Timeline Scrubber & Segment List */}
        <div className="playback-data-section">
          <div className="timeline-container">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-bold text-mono">
                {formatTimeLocal(new Date(timelineBounds.start).toISOString())} —{' '}
                {formatTimeLocal(new Date(timelineBounds.end).toISOString())}
              </span>
              <span className="text-xs text-muted">
                {(timeline.recordings || []).length} đoạn · {(timeline.events || []).length} sự kiện
              </span>
            </div>

            {/* 24h Minimap Zoom Window */}
            <div className="minimap-container" ref={minimapRef}>
              <div className="minimap-track">
                {timelineSegments(timelineDayBounds).map(
                  (seg, i) =>
                    seg.type === 'recording' && (
                      <div
                        key={`m-${i}`}
                        className="minimap-segment"
                        style={{ left: `${seg.left}%`, width: `${seg.width}%` }}
                      />
                    )
                )}
              </div>
              <div
                className="minimap-window"
                style={{
                  left: `${visibleRange[0] * 100}%`,
                  right: `${100 - visibleRange[1] * 100}%`,
                }}
                onMouseDown={handleMinimapPanStart('window')}
                onTouchStart={handleMinimapPanStart('window')}
              >
                <div
                  className="minimap-handle left"
                  onMouseDown={handleMinimapPanStart('left')}
                  onTouchStart={handleMinimapPanStart('left')}
                />
                <div
                  className="minimap-handle right"
                  onMouseDown={handleMinimapPanStart('right')}
                  onTouchStart={handleMinimapPanStart('right')}
                />
              </div>
            </div>

            {/* Interactive Scrubber Bar with Hover Time Tooltip */}
            <div style={{ position: 'relative' }}>
              {hoverTimeLabel && (
                <div
                  className="vms-timeline-tooltip text-mono"
                  style={{ left: `${hoverPct}%` }}
                >
                  {hoverTimeLabel}
                </div>
              )}
              <div
                ref={timelineRef}
                className="timeline-bar"
                style={{ cursor: 'ew-resize', userSelect: 'none' }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUpOrLeave}
                onMouseLeave={handleMouseUpOrLeave}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleMouseUpOrLeave}
              >
                {timelineSegments(timelineBounds).map((seg, i) => (
                  <div
                    key={i}
                    className={`timeline-segment ${seg.type}`}
                    style={{ left: `${seg.left}%`, width: `${seg.width}%` }}
                    title={
                      seg.type === 'recording'
                        ? `${formatTimeLocal(seg.rec.start_time)} - ${
                            seg.rec.end_time ? formatTimeLocal(seg.rec.end_time) : 'đang ghi'
                          }`
                        : `${seg.evt.type}: ${formatTimeLocal(seg.evt.timestamp)}`
                    }
                  />
                ))}
                {cursorPct !== null && (
                  <div className="timeline-cursor" style={{ left: `${cursorPct}%` }} />
                )}
              </div>

              <div className="timeline-labels">
                <span>{formatTimeLocal(new Date(timelineBounds.start).toISOString())}</span>
                <span>
                  {formatTimeLocal(
                    new Date(timelineBounds.start + timelineBounds.duration * 0.25).toISOString()
                  )}
                </span>
                <span>
                  {formatTimeLocal(
                    new Date(timelineBounds.start + timelineBounds.duration * 0.5).toISOString()
                  )}
                </span>
                <span>
                  {formatTimeLocal(
                    new Date(timelineBounds.start + timelineBounds.duration * 0.75).toISOString()
                  )}
                </span>
                <span>{formatTimeLocal(new Date(timelineBounds.end).toISOString())}</span>
              </div>
            </div>
          </div>

          {/* Recorded Segments List */}
          <div className="playback-recordings-section mt-3">
            <h3 className="text-sm font-bold mb-2">Danh sách đoạn ghi hình</h3>
            {recordingsWithEvents.length === 0 ? (
              <div
                className="empty-state border border-dashed border-border rounded-lg"
                style={{ padding: 30 }}
              >
                <p className="text-muted">Không có bản ghi nào trong ngày này</p>
              </div>
            ) : (
              <div className="recordings-list-scroll">
                <div className="flex flex-col gap-2 h-full overflow-y-auto pr-2 custom-scrollbar">
                  {recordingsWithEvents.map((rec) => (
                    <div
                      key={rec.id}
                      className="card"
                      style={{
                        cursor: 'pointer',
                        borderColor:
                          currentRecording?.id === rec.id ? 'var(--accent)' : undefined,
                      }}
                      onClick={() => playRecording(rec)}
                    >
                      <div className="card-body" style={{ padding: '8px 12px' }}>
                        <div className="flex items-center justify-between gap-4">
                          <div className="flex items-center gap-3 flex-1 min-w-0">
                            {rec.thumbUrl ? (
                              <img
                                src={getMediaUrl(`snapshots/${rec.thumbUrl}`)}
                                alt="Event thumb"
                                style={{
                                  width: 64,
                                  height: 40,
                                  objectFit: 'cover',
                                  borderRadius: 4,
                                  background: '#000',
                                  flexShrink: 0,
                                }}
                                onError={(e) => {
                                  e.currentTarget.style.display = 'none';
                                }}
                              />
                            ) : (
                              <div
                                style={{
                                  width: 64,
                                  height: 40,
                                  borderRadius: 4,
                                  background: 'rgba(255,255,255,0.05)',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  flexShrink: 0,
                                }}
                              >
                                <ImageIcon size={16} className="text-muted" />
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

                          <div className="flex items-center gap-3">
                            <span
                              className={`text-xs ${
                                rec.status === 'completed' ? 'text-muted' : 'text-accent'
                              }`}
                            >
                              {rec.status === 'completed' ? 'Đã lưu' : 'Đang ghi...'}
                            </span>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteRecording(rec.id);
                              }}
                              className="btn-icon"
                              style={{
                                width: 28,
                                height: 28,
                                color: 'var(--danger)',
                                border: 'none',
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
    </div>
  );
}
