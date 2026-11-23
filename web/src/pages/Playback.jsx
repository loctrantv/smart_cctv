import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  getCameras,
  getTimeline,
  getRecordingStreamUrl,
  deleteRecording,
  getMediaUrl,
} from '../utils/api';
import { format } from 'date-fns';
import { TechSelect, TechDatePicker, useTechDialog } from '../components/TechUI';
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
  Camera,
  Columns,
  Rows,
  ArrowUpSquare,
  ArrowDownSquare,
  Download,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  ZoomIn,
  ZoomOut,
  RotateCcw,
} from 'lucide-react';

/**
 * Lazy-loaded Thumbnail component using IntersectionObserver
 * Prevents network/rendering lag when there are hundreds of recordings or event images.
 */
function LazyThumb({ src, alt, width = 68, height = 42 }) {
  const containerRef = useRef(null);
  const [inView, setInView] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  useEffect(() => {
    setLoaded(false);
    setErrored(false);
  }, [src]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !src) return;
    if (!('IntersectionObserver' in window)) {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setInView(true);
            observer.disconnect();
          }
        });
      },
      { rootMargin: '120px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [src]);

  return (
    <div
      ref={containerRef}
      className="nvr-lazy-thumb"
      style={{ width, height, minWidth: width, minHeight: height }}
    >
      {src && inView && !errored ? (
        <img
          src={src}
          alt={alt || 'thumb'}
          loading="lazy"
          decoding="async"
          className={`nvr-lazy-img ${loaded ? 'is-loaded' : ''}`}
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      ) : null}
      {(!src || !loaded || errored) && (
        <div className="nvr-lazy-placeholder">
          <ImageIcon size={15} className="opacity-40" />
        </div>
      )}
    </div>
  );
}

export default function Playback() {
  const { confirmDialog, showToast } = useTechDialog();
  const [cameras, setCameras] = useState([]);
  const [selectedCamera, setSelectedCamera] = useState(null);
  const [selectedDate, setSelectedDate] = useState(format(new Date(), 'yyyy-MM-dd'));
  const [timeline, setTimeline] = useState({ recordings: [], events: [] });
  const [currentRecording, setCurrentRecording] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);

  // Professional Video Player Scrubber State (for active clip)
  const [clipCurrentTime, setClipCurrentTime] = useState(0);
  const [clipDuration, setClipDuration] = useState(0);
  const [clipBufferedPct, setClipBufferedPct] = useState(0);
  const [clipHoverTime, setClipHoverTime] = useState(null);
  const [clipHoverPct, setClipHoverPct] = useState(0);
  const [isMuted, setIsMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [visibleCount, setVisibleCount] = useState(30); // Incremental list rendering

  // Dual-Lens Playback View Mode ('split' | 'stacked' | 'top' | 'bottom')
  const [lensMode, setLensMode] = useState('split');
  const [hoverTimeLabel, setHoverTimeLabel] = useState(null);
  const [hoverPct, setHoverPct] = useState(0);

  const playerWrapperRef = useRef(null);
  const videoRef = useRef(null);
  const secondaryVideoRef = useRef(null);
  const seekTimeRef = useRef(null);
  const currentVideoIdRef = useRef(null);
  const clipProgressRef = useRef(null);
  const isScrubbingClipRef = useRef(false);

  const [cursorPct, setCursorPct] = useState(null);
  const [aspectRatio, setAspectRatio] = useState(8 / 9);

  const timelineRef = useRef(null);
  const isDragging = useRef(false);

  // Sync secondary video element when in 'split' (Side-by-Side 2x16:9) mode
  // Uses captureStream() from primary video whenever supported so the browser never downloads or seeks the MP4 twice!
  const syncSecondaryPlayback = useCallback(() => {
    const primary = videoRef.current;
    const secondary = secondaryVideoRef.current;
    if (lensMode !== 'split' || !primary || !secondary) return;

    // 1. Prefer zero-overhead MediaStream cloning via captureStream()
    const canCapture =
      typeof primary.captureStream === 'function' ||
      typeof primary.mozCaptureStream === 'function';

    if (canCapture && primary.readyState >= 1) {
      try {
        if (!secondary.srcObject) {
          const captured = primary.captureStream
            ? primary.captureStream()
            : primary.mozCaptureStream();
          secondary.srcObject = captured;
        }
        if (!primary.paused && secondary.paused) {
          secondary.play().catch(() => {});
        } else if (primary.paused && !secondary.paused) {
          secondary.pause();
        }
        return;
      } catch {
        // Fallback to URL sync below if captureStream fails
      }
    }

    // 2. Fallback URL sync (when captureStream is unavailable)
    if (primary.src && secondary.src !== primary.src) {
      secondary.src = primary.src;
    }
    secondary.playbackRate = primary.playbackRate;
    if (!primary.seeking && Math.abs(secondary.currentTime - primary.currentTime) > 0.4) {
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
      setClipCurrentTime(0);
      setClipDuration(0);
      setClipBufferedPct(0);
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
    setVisibleCount(30);
    getTimeline(selectedCamera.id, selectedDate)
      .then(setTimeline)
      .catch(() => setTimeline({ recordings: [], events: [] }));
  }, [selectedCamera, selectedDate]);

  useEffect(() => {
    const onFsChange = () => {
      setIsFullscreen(Boolean(document.fullscreenElement));
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

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

  // Generate 24h ruler ticks (major hour ticks & 15-min minor ticks)
  const rulerTicks = useMemo(() => {
    const ticks = [];
    const spanHours = (timelineBounds.duration / 3600000);
    const stepMinutes = spanHours <= 3 ? 15 : spanHours <= 8 ? 30 : 60;
    const stepMs = stepMinutes * 60 * 1000;
    const firstTick = Math.ceil(timelineBounds.start / stepMs) * stepMs;

    for (let ts = firstTick; ts <= timelineBounds.end; ts += stepMs) {
      const pct = ((ts - timelineBounds.start) / timelineBounds.duration) * 100;
      const d = new Date(ts);
      const mins = d.getMinutes();
      const isMajor = mins === 0;
      const label = d.toLocaleTimeString('vi-VN', {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        timeZone: 'Asia/Ho_Chi_Minh',
      });
      ticks.push({ pct, isMajor, label });
    }
    return ticks;
  }, [timelineBounds]);

  const applySeekToPrimary = useCallback((targetSeconds) => {
    const v = videoRef.current;
    if (!v) return;
    const safeSec = Math.max(0, targetSeconds);
    setClipCurrentTime(safeSec);

    if (v.readyState >= 1) {
      seekTimeRef.current = null;
      try {
        v.currentTime = safeSec;
      } catch {}
      if (secondaryVideoRef.current && !secondaryVideoRef.current.srcObject) {
        try {
          secondaryVideoRef.current.currentTime = safeSec;
        } catch {}
      }
    } else {
      seekTimeRef.current = safeSec;
    }
  }, []);

  const playRecording = useCallback(
    (rec, seekSeconds = 0) => {
      const isSameVideo = currentVideoIdRef.current === rec.id;
      const streamUrl = getRecordingStreamUrl(rec.id);

      if (isSameVideo) {
        applySeekToPrimary(seekSeconds);
        if (videoRef.current) {
          videoRef.current.playbackRate = speed;
          videoRef.current.play().catch(() => {});
        }
        setPlaying(true);
        if (!currentRecording || currentRecording.id !== rec.id) {
          setCurrentRecording(rec);
        }
      } else {
        currentVideoIdRef.current = rec.id;
        setCurrentRecording(rec);
        setPlaying(true);
        setClipCurrentTime(seekSeconds);
        setClipDuration(rec.duration_seconds || 0);
        seekTimeRef.current = seekSeconds;
        setTimeout(() => {
          if (secondaryVideoRef.current) {
            secondaryVideoRef.current.srcObject = null;
          }
          if (videoRef.current) {
            videoRef.current.src = streamUrl;
            videoRef.current.muted = isMuted;
            videoRef.current.volume = volume;
            videoRef.current.playbackRate = speed;
            videoRef.current.play().catch(() => {});
          }
        }, 50);
      }
    },
    [speed, currentRecording, isMuted, volume, applySeekToPrimary]
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
      const v = videoRef.current;
      if (Number.isFinite(v.duration) && v.duration > 0) {
        setClipDuration(v.duration);
      } else if (currentRecording?.duration_seconds) {
        setClipDuration(currentRecording.duration_seconds);
      }

      if (seekTimeRef.current !== null && seekTimeRef.current > 0) {
        v.currentTime = seekTimeRef.current;
        if (secondaryVideoRef.current) {
          secondaryVideoRef.current.currentTime = seekTimeRef.current;
        }
        seekTimeRef.current = null;
      }
      v.playbackRate = speed;
      v.muted = isMuted;
      v.volume = volume;
      if (v.videoWidth && v.videoHeight) {
        setAspectRatio(v.videoWidth / v.videoHeight);
      }
      syncSecondaryPlayback();
    }
  };

  const handleTimeUpdate = () => {
    const v = videoRef.current;
    if (!v || !currentRecording) return;

    // Do not overwrite playhead with 0 while a pending initial seek or user scrub is active
    if (v.seeking || (seekTimeRef.current !== null && seekTimeRef.current > 0)) {
      return;
    }

    if (!isScrubbingClipRef.current) {
      setClipCurrentTime(v.currentTime);
    }

    const dur =
      Number.isFinite(v.duration) && v.duration > 0
        ? v.duration
        : currentRecording.duration_seconds || 0;
    if (dur > 0) {
      setClipDuration(dur);
      if (v.buffered && v.buffered.length > 0) {
        const bufferedEnd = v.buffered.end(v.buffered.length - 1);
        setClipBufferedPct(Math.min(100, (bufferedEnd / dur) * 100));
      }
    }

    if (!isDragging.current) {
      const start = parseUTCDate(currentRecording.start_time);
      const currentTimestamp = start.getTime() + v.currentTime * 1000;
      const pct = ((currentTimestamp - timelineBounds.start) / timelineBounds.duration) * 100;
      setCursorPct(Math.max(0, Math.min(100, pct)));
    }
    syncSecondaryPlayback();
  };

  // Format mm:ss or hh:mm:ss for the clip player progress bar
  const formatClockDuration = (sec) => {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const total = Math.floor(sec);
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hrs > 0) {
      return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(
        secs
      ).padStart(2, '0')}`;
    }
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  // Professional Player Clip Scrubber Interactions
  const seekClipByClientX = (clientX) => {
    if (!clipProgressRef.current || !videoRef.current) return;
    const rect = clipProgressRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const effectiveDur =
      clipDuration ||
      (Number.isFinite(videoRef.current.duration) ? videoRef.current.duration : 0) ||
      currentRecording?.duration_seconds ||
      0;
    if (effectiveDur <= 0) return;

    const targetSec = pct * effectiveDur;
    applySeekToPrimary(targetSec);
  };

  const handleClipScrubStart = (e) => {
    isScrubbingClipRef.current = true;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    seekClipByClientX(clientX);
  };

  const handleClipScrubMove = (e) => {
    if (!clipProgressRef.current) return;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const rect = clipProgressRef.current.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const effectiveDur = clipDuration || currentRecording?.duration_seconds || 0;
    setClipHoverPct(pct * 100);
    setClipHoverTime(pct * effectiveDur);

    if (isScrubbingClipRef.current) {
      seekClipByClientX(clientX);
    }
  };

  const handleClipScrubEnd = () => {
    isScrubbingClipRef.current = false;
    setClipHoverTime(null);
  };

  const togglePlayPause = () => {
    if (!videoRef.current) return;
    if (playing) {
      videoRef.current.pause();
      secondaryVideoRef.current?.pause();
      setPlaying(false);
    } else {
      videoRef.current.play().catch(() => {});
      secondaryVideoRef.current?.play().catch(() => {});
      setPlaying(true);
    }
  };

  const toggleMute = () => {
    const next = !isMuted;
    setIsMuted(next);
    if (videoRef.current) videoRef.current.muted = next;
  };

  const handleVolumeChange = (e) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    setIsMuted(val === 0);
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
    }
  };

  const toggleFullscreenPlayer = () => {
    const el = playerWrapperRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  const zoomTimeline = (factor) => {
    setVisibleRange(([start, end]) => {
      const span = end - start;
      const center = cursorPct !== null ? start + (cursorPct / 100) * span : (start + end) / 2;
      const newSpan = Math.max(0.04, Math.min(1, span * factor));
      let newStart = Math.max(0, center - newSpan / 2);
      let newEnd = newStart + newSpan;
      if (newEnd > 1) {
        newEnd = 1;
        newStart = Math.max(0, 1 - newSpan);
      }
      return [newStart, newEnd];
    });
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
    const ok = await confirmDialog({
      title: 'XÓA ĐOẠN GHI HÌNH NVR',
      message: 'Đoạn video MP4 này sẽ bị xóa vĩnh viễn khỏi ổ cứng lưu trữ. Bạn có chắc chắn muốn xóa?',
      confirmText: 'Xóa vĩnh viễn',
      cancelText: 'Giữ lại',
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteRecording(id);
      showToast('Đã xóa bản ghi thành công', 'success');
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
      showToast(
        'Không thể xóa bản ghi: ' + (err.response?.data?.error || err.message),
        'error'
      );
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

  // Events belonging to the currently playing recording clip (rendered as markers on the clip progress bar!)
  const currentClipEvents = useMemo(() => {
    if (!currentRecording || !timeline.events) return [];
    const startMs = parseUTCDate(currentRecording.start_time).getTime();
    const durSec = clipDuration || currentRecording.duration_seconds || 900;
    const endMs = startMs + durSec * 1000;

    return timeline.events
      .map((evt) => {
        const evtMs = parseUTCDate(evt.timestamp).getTime();
        if (evtMs < startMs || evtMs > endMs) return null;
        const offsetSec = (evtMs - startMs) / 1000;
        const pct = Math.max(0, Math.min(100, (offsetSec / durSec) * 100));
        return { ...evt, offsetSec, pct };
      })
      .filter(Boolean);
  }, [currentRecording, timeline.events, clipDuration]);

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

  // Compute live wall-clock timestamp of current playhead
  const currentWallClockLabel = useMemo(() => {
    if (!currentRecording) return '--:--:--';
    const startMs = parseUTCDate(currentRecording.start_time).getTime();
    return formatTimeLocal(new Date(startMs + clipCurrentTime * 1000).toISOString());
  }, [currentRecording, clipCurrentTime]);

  const effectiveClipDuration =
    clipDuration || currentRecording?.duration_seconds || 0;
  const clipProgressPct =
    effectiveClipDuration > 0
      ? Math.min(100, Math.max(0, (clipCurrentTime / effectiveClipDuration) * 100))
      : 0;

  return (
    <div>
      {/* NVR Top Filter & Dual-Lens Mode Bar */}
      <div className="vms-control-strip mb-3" style={{ borderRadius: 'var(--radius-md)' }}>
        <div className="vms-strip-left">
          <TechSelect
            icon={Camera}
            value={selectedCamera?.id || ''}
            onChange={(val) => setSelectedCamera(cameras.find((c) => c.id === val))}
            options={cameras.map((cam) => ({ value: cam.id, label: cam.name }))}
            placeholder="Chọn kênh camera..."
          />

          <div className="vms-divider" />

          <div className="flex items-center gap-1">
            <button type="button" className="btn-icon btn-sm" onClick={() => changeDate(-1)}>
              <ChevronLeft size={14} />
            </button>
            <TechDatePicker value={selectedDate} onChange={setSelectedDate} />
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
        {/* Left column: Dual-Lens NVR Video Stage + Embedded Professional Player Timeline Bar */}
        <div className="playback-video-section">
          <div
            ref={playerWrapperRef}
            className="playback-video-wrapper nvr-pro-player-shell shadow-md border border-border"
          >
            {currentRecording ? (
              <>
                {/* Top-Left OSD Timecode & Channel Overlay */}
                <div className="nvr-player-osd-header">
                  <span className="nvr-rec-badge">● PLAYBACK</span>
                  <span className="text-xs font-bold">{selectedCamera?.name}</span>
                  <span className="text-xs text-mono" style={{ color: 'var(--accent)' }}>
                    {currentWallClockLabel}
                  </span>
                </div>

                {/* Video Viewport (Dual-Lens Split / Stacked / Top / Bottom) */}
                <div
                  className={`vms-player-root lens-mode-${lensMode}`}
                  onClick={togglePlayPause}
                  style={{ cursor: 'pointer' }}
                >
                  {lensMode === 'split' ? (
                    <div className="vms-dual-split-grid">
                      <div className="vms-split-pane">
                        <span className="vms-lens-tag">MẮT 1 (TRÊN - 16:9)</span>
                        <div className="vms-crop-box crop-top">
                          <video
                            ref={videoRef}
                            playsInline
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
                          <video ref={secondaryVideoRef} muted playsInline />
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
                          playsInline
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
                        playsInline
                        style={{
                          maxWidth: '100%',
                          maxHeight: '100%',
                          aspectRatio: `${aspectRatio}`,
                          objectFit: 'contain',
                        }}
                        onEnded={handleVideoEnded}
                        onLoadedMetadata={handleLoadedMetadata}
                        onTimeUpdate={handleTimeUpdate}
                        onPlay={() => setPlaying(true)}
                        onPause={() => setPlaying(false)}
                      />
                    </div>
                  )}
                </div>

                {/* Professional Embedded Player Control & Scrubber Bar */}
                <div
                  className="nvr-pro-control-bar"
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Interactive Clip Scrubber Track with Buffer Bar, Event Markers & Hover Time Preview */}
                  <div
                    ref={clipProgressRef}
                    className="nvr-clip-scrubber"
                    onMouseDown={handleClipScrubStart}
                    onMouseMove={handleClipScrubMove}
                    onMouseUp={handleClipScrubEnd}
                    onMouseLeave={handleClipScrubEnd}
                    onTouchStart={handleClipScrubStart}
                    onTouchMove={handleClipScrubMove}
                    onTouchEnd={handleClipScrubEnd}
                  >
                    {clipHoverTime !== null && (
                      <div
                        className="nvr-scrubber-tooltip text-mono"
                        style={{ left: `${clipHoverPct}%` }}
                      >
                        {formatClockDuration(clipHoverTime)}
                      </div>
                    )}

                    <div className="nvr-scrubber-rail">
                      {/* Buffered progress */}
                      <div
                        className="nvr-scrubber-buffered"
                        style={{ width: `${clipBufferedPct}%` }}
                      />
                      {/* Played progress */}
                      <div
                        className="nvr-scrubber-played"
                        style={{ width: `${clipProgressPct}%` }}
                      />
                      {/* AI Event tick markers on the clip bar */}
                      {currentClipEvents.map((evt) => (
                        <div
                          key={evt.id}
                          className={`nvr-scrubber-event-dot ${evt.type}`}
                          style={{ left: `${evt.pct}%` }}
                          title={`Sự kiện: ${evt.type} (${formatClockDuration(evt.offsetSec)})`}
                        />
                      ))}
                      {/* Playhead handle */}
                      <div
                        className="nvr-scrubber-thumb"
                        style={{ left: `${clipProgressPct}%` }}
                      />
                    </div>
                  </div>

                  {/* Transport Controls Row */}
                  <div className="nvr-transport-row">
                    <div className="nvr-transport-left">
                      <button
                        type="button"
                        className="nvr-ctrl-btn primary"
                        onClick={togglePlayPause}
                        title={playing ? 'Tạm dừng' : 'Phát'}
                      >
                        {playing ? <Pause size={15} /> : <Play size={15} />}
                      </button>

                      <button
                        type="button"
                        className="nvr-ctrl-btn"
                        title="Lùi 10 giây"
                        onClick={() => {
                          if (videoRef.current) {
                            videoRef.current.currentTime = Math.max(
                              0,
                              videoRef.current.currentTime - 10
                            );
                          }
                        }}
                      >
                        <SkipBack size={14} />
                      </button>

                      <button
                        type="button"
                        className="nvr-ctrl-btn"
                        title="Tua tới 10 giây"
                        onClick={() => {
                          if (videoRef.current) {
                            videoRef.current.currentTime = Math.min(
                              effectiveClipDuration || 9999,
                              videoRef.current.currentTime + 10
                            );
                          }
                        }}
                      >
                        <SkipForward size={14} />
                      </button>

                      {/* Volume Control */}
                      <div className="nvr-volume-group">
                        <button
                          type="button"
                          className="nvr-ctrl-btn"
                          onClick={toggleMute}
                          title={isMuted ? 'Bật tiếng' : 'Tắt tiếng'}
                        >
                          {isMuted || volume === 0 ? (
                            <VolumeX size={14} />
                          ) : (
                            <Volume2 size={14} />
                          )}
                        </button>
                        <input
                          type="range"
                          min="0"
                          max="1"
                          step="0.05"
                          value={isMuted ? 0 : volume}
                          onChange={handleVolumeChange}
                          className="nvr-volume-slider"
                        />
                      </div>

                      {/* Clip Timecode Counter (Current / Duration + Wall-Clock) */}
                      <div className="nvr-timecode-readout text-mono">
                        <span className="tc-curr">{formatClockDuration(clipCurrentTime)}</span>
                        <span className="tc-sep">/</span>
                        <span className="tc-dur">
                          {formatClockDuration(effectiveClipDuration)}
                        </span>
                        <span className="tc-wall">({currentWallClockLabel})</span>
                      </div>
                    </div>

                    <div className="nvr-transport-right">
                      <button
                        type="button"
                        className="nvr-pill-btn"
                        onClick={changeSpeed}
                        title="Tốc độ phát"
                      >
                        <FastForward size={12} /> {speed}x
                      </button>

                      <button
                        type="button"
                        className="nvr-pill-btn"
                        onClick={handlePlaybackSnapshot}
                        title="Chụp ảnh từ khung hình đang xem"
                      >
                        <Camera size={12} /> Snapshot
                      </button>

                      <a
                        href={getRecordingStreamUrl(currentRecording.id)}
                        download={`recording_${currentRecording.id}.mp4`}
                        className="nvr-pill-btn"
                        title="Tải file video MP4 gốc"
                      >
                        <Download size={12} /> MP4
                      </a>

                      <button
                        type="button"
                        className="nvr-ctrl-btn"
                        onClick={toggleFullscreenPlayer}
                        title="Phóng toàn màn hình"
                      >
                        {isFullscreen ? <Minimize size={14} /> : <Maximize size={14} />}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <div
                className="video-placeholder"
                style={{
                  width: '100%',
                  height: '100%',
                  background: 'var(--bg-secondary)',
                }}
              >
                <Play size={36} style={{ color: 'var(--accent)', opacity: 0.7 }} />
                <p style={{ fontSize: '13px', marginTop: '10px', textAlign: 'center' }}>
                  Chọn một đoạn ghi trên thước Timeline 24h hoặc danh sách bên phải để phát lại
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Right column: NVR 24h Master Timeline Ruler & Lazy-Loaded Segment List */}
        <div className="playback-data-section">
          <div className="timeline-container nvr-master-timeline-card">
            <div className="flex items-center justify-between mb-2">
              <div className="flex flex-col">
                <span className="text-xs font-bold uppercase tracking-wider text-muted">
                  Thước Timeline 24 Giờ ({selectedDate})
                </span>
                <span className="text-sm font-bold text-mono" style={{ color: 'var(--accent)' }}>
                  {formatTimeLocal(new Date(timelineBounds.start).toISOString())} —{' '}
                  {formatTimeLocal(new Date(timelineBounds.end).toISOString())}
                </span>
              </div>

              {/* Timeline Zoom Controls */}
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="btn-icon btn-sm"
                  onClick={() => zoomTimeline(0.6)}
                  title="Phóng to thước thời gian (Zoom In)"
                >
                  <ZoomIn size={13} />
                </button>
                <button
                  type="button"
                  className="btn-icon btn-sm"
                  onClick={() => zoomTimeline(1.6)}
                  title="Thu nhỏ thước thời gian (Zoom Out)"
                >
                  <ZoomOut size={13} />
                </button>
                <button
                  type="button"
                  className="btn-icon btn-sm"
                  onClick={() => setVisibleRange([0, 1])}
                  title="Xem toàn bộ 24h"
                >
                  <RotateCcw size={13} />
                </button>
              </div>
            </div>

            {/* 24h Overview Minimap Zoom Window */}
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

            {/* Dual-Track NVR Scrubber Bar with Graduated Hour Ticks & Hover Timecode */}
            <div style={{ position: 'relative', marginTop: 8 }}>
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
                className="timeline-bar nvr-graduated-timeline"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUpOrLeave}
                onMouseLeave={handleMouseUpOrLeave}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleMouseUpOrLeave}
              >
                {/* Hour/Minute Ruler Ticks */}
                {rulerTicks.map((t, idx) => (
                  <div
                    key={idx}
                    className={`nvr-ruler-tick ${t.isMajor ? 'major' : 'minor'}`}
                    style={{ left: `${t.pct}%` }}
                  >
                    {t.isMajor && <span className="nvr-ruler-tick-label">{t.label}</span>}
                  </div>
                ))}

                {/* Track 1: Continuous / Event Recordings */}
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

                {/* Active Playhead Needle */}
                {cursorPct !== null && (
                  <div className="timeline-cursor nvr-playhead-needle" style={{ left: `${cursorPct}%` }}>
                    <div className="nvr-playhead-cap" />
                  </div>
                )}
              </div>

              <div className="flex items-center justify-between mt-2 text-xs text-muted">
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1">
                    <span
                      style={{
                        width: 10,
                        height: 6,
                        borderRadius: 2,
                        background: 'var(--accent)',
                        display: 'inline-block',
                      }}
                    />{' '}
                    Ghi hình ({(timeline.recordings || []).length})
                  </span>
                  <span className="flex items-center gap-1">
                    <span
                      style={{
                        width: 10,
                        height: 6,
                        borderRadius: 2,
                        background: 'var(--danger)',
                        display: 'inline-block',
                      }}
                    />{' '}
                    Sự kiện AI ({(timeline.events || []).length})
                  </span>
                </div>
                <span className="text-mono">Kéo để tua nhanh</span>
              </div>
            </div>
          </div>

          {/* Recorded Segments List with IntersectionObserver Lazy-Loaded Thumbnails */}
          <div className="playback-recordings-section mt-3">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-bold">
                Danh sách đoạn ghi ({recordingsWithEvents.length})
              </h3>
            </div>
            {recordingsWithEvents.length === 0 ? (
              <div
                className="empty-state border border-dashed border-border rounded-lg"
                style={{ padding: 30 }}
              >
                <p className="text-muted">Không có bản ghi nào trong ngày này</p>
              </div>
            ) : (
              <div
                className="recordings-list-scroll"
                onScroll={(e) => {
                  const el = e.currentTarget;
                  if (
                    el.scrollTop + el.clientHeight >= el.scrollHeight - 100 &&
                    visibleCount < recordingsWithEvents.length
                  ) {
                    setVisibleCount((prev) => prev + 30);
                  }
                }}
              >
                <div className="flex flex-col gap-2 pr-1">
                  {recordingsWithEvents.slice(0, visibleCount).map((rec) => {
                    const isSelected = currentRecording?.id === rec.id;
                    return (
                      <div
                        key={rec.id}
                        className={`card nvr-segment-card ${isSelected ? 'is-playing' : ''}`}
                        onClick={() => playRecording(rec)}
                      >
                        <div className="card-body" style={{ padding: '8px 12px' }}>
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-3 flex-1 min-w-0">
                              <LazyThumb
                                src={
                                  rec.thumbUrl
                                    ? getMediaUrl(`snapshots/${rec.thumbUrl}`)
                                    : null
                                }
                                alt="Event thumb"
                                width={68}
                                height={42}
                              />

                              <div className="flex flex-col min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-mono text-sm font-bold">
                                    {formatTimeLocal(rec.start_time)}
                                  </span>
                                  {isSelected && (
                                    <span className="vms-osd-badge ai">ĐANG PHÁT</span>
                                  )}
                                </div>
                                <span className="text-muted text-xs truncate">
                                  Thời lượng: {formatDuration(rec.duration_seconds)}
                                  {rec.eventCount > 0 && ` · ${rec.eventCount} sự kiện`}
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center gap-2">
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
                    );
                  })}
                  {visibleCount < recordingsWithEvents.length && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm w-full mt-1"
                      onClick={() => setVisibleCount((prev) => prev + 30)}
                    >
                      Hiển thị thêm ({recordingsWithEvents.length - visibleCount} đoạn)
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
