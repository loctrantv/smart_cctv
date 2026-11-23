import React, { useRef, useEffect, useState, useCallback } from 'react';
import {
  VideoOff,
  Volume2,
  VolumeX,
  Camera as CameraIcon,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  RefreshCw,
  Columns,
  Rows,
  ArrowUpSquare,
  ArrowDownSquare,
} from 'lucide-react';
import { resolveStreamUrl } from '../utils/api';

/**
 * VMS-grade VideoPlayer component with built-in support for Dual-Lens (8:9 stacked 2x16:9) cameras.
 * View Modes (`lensMode`):
 *   - 'stacked' : Original vertical 8:9 frame showing both Top (Lens 1) and Bottom (Lens 2)
 *   - 'split'   : Side-by-Side horizontal 2x16:9 (Top Lens on Left, Bottom Lens on Right) sharing 1 MediaStream
 *   - 'top'     : Crop & zoom Top Lens (0% - 50% Y) into a standard 16:9 viewport
 *   - 'bottom'  : Crop & zoom Bottom Lens (50% - 100% Y) into a standard 16:9 viewport
 */
export default function VideoPlayer({
  streamId,
  streams,
  cameraName = '',
  autoPlay = true,
  muted: initialMuted = true,
  compact = false,
  lensMode: controlledLensMode,
  onLensModeChange,
  defaultLensMode = 'stacked',
  showOsd = true,
  showControls = true,
  lockStacked = false, // Used when drawing AI detection zones on raw 8:9 coordinates
  onAspectRatioChange,
}) {
  const videoRef = useRef(null);
  const secondaryVideoRef = useRef(null);
  const pcRef = useRef(null);
  const mediaStreamRef = useRef(null);

  const [mode, setMode] = useState('webrtc'); // webrtc | hls | error
  const [connected, setConnected] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [isMuted, setIsMuted] = useState(initialMuted);
  const [videoMeta, setVideoMeta] = useState({ width: 0, height: 0, isDualLens: true });

  // Uncontrolled or controlled lensMode
  const [internalLensMode, setInternalLensMode] = useState(defaultLensMode);
  const activeLensMode = lockStacked
    ? 'stacked'
    : controlledLensMode !== undefined
    ? controlledLensMode
    : internalLensMode;

  const setLensMode = (nextMode) => {
    if (lockStacked) return;
    setInternalLensMode(nextMode);
    if (onLensModeChange) onLensModeChange(nextMode);
    // Reset digital zoom when switching lens mode
    setZoom(1);
    setPan({ x: 0, y: 0 });
  };

  // Digital Zoom & Pan state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanningRef = useRef(false);
  const panStartRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    setIsMuted(initialMuted);
  }, [initialMuted]);

  const syncSecondaryVideo = useCallback(() => {
    if (activeLensMode !== 'split' || !secondaryVideoRef.current || !videoRef.current) return;
    if (mediaStreamRef.current) {
      if (secondaryVideoRef.current.srcObject !== mediaStreamRef.current) {
        secondaryVideoRef.current.srcObject = mediaStreamRef.current;
        secondaryVideoRef.current.play().catch(() => {});
      }
    } else if (videoRef.current.currentSrc) {
      if (secondaryVideoRef.current.src !== videoRef.current.currentSrc) {
        secondaryVideoRef.current.src = videoRef.current.currentSrc;
        secondaryVideoRef.current.play().catch(() => {});
      }
    }
  }, [activeLensMode]);

  useEffect(() => {
    syncSecondaryVideo();
  }, [activeLensMode, connected, syncSecondaryVideo]);

  const handleLoadedMetadata = (e) => {
    const video = e.target;
    if (video.videoWidth && video.videoHeight) {
      setConnected(true);
      const ratio = video.videoWidth / video.videoHeight;
      // Dual-lens cameras stack two 16:9 frames vertically -> ratio ~ 0.888 (8:9) or < 1.15
      const isDual = ratio < 1.15;
      setVideoMeta({
        width: video.videoWidth,
        height: video.videoHeight,
        isDualLens: isDual,
      });
      if (onAspectRatioChange) {
        onAspectRatioChange(ratio);
      }
    }
    syncSecondaryVideo();
  };

  useEffect(() => {
    if (!streams || !streamId) return;

    let cancelled = false;
    let firstFrameReceived = false;
    let fallbackTimer = null;
    setConnected(false);

    const switchToHlsFallback = (reason) => {
      if (cancelled || firstFrameReceived) return;
      console.warn(`[VideoPlayer] Switching ${streamId} to HLS fallback (${reason})`);
      if (pcRef.current) {
        try {
          pcRef.current.close();
        } catch {}
        pcRef.current = null;
      }
      setConnected(false);
      setMode('hls');
    };

    async function connectWebRTC() {
      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
        });
        pcRef.current = pc;

        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        pc.ontrack = (event) => {
          const stream =
            (event.streams && event.streams[0]) ||
            (event.track ? new MediaStream([event.track]) : null);
          if (stream) {
            mediaStreamRef.current = stream;
            if (videoRef.current && videoRef.current.srcObject !== stream) {
              videoRef.current.srcObject = stream;
              videoRef.current.play().catch(() => {});
            }
            if (secondaryVideoRef.current && secondaryVideoRef.current.srcObject !== stream) {
              secondaryVideoRef.current.srcObject = stream;
              secondaryVideoRef.current.play().catch(() => {});
            }
          }
        };

        pc.oniceconnectionstatechange = () => {
          const state = pc.iceConnectionState;
          if (state === 'failed' || state === 'disconnected' || state === 'closed') {
            switchToHlsFallback(`ICE ${state}`);
          }
        };

        pc.onconnectionstatechange = () => {
          const state = pc.connectionState;
          if (state === 'failed' || state === 'disconnected') {
            switchToHlsFallback(`PeerConnection ${state}`);
          }
        };

        // Watchdog: If WebRTC SDP handshake succeeds (200 OK) but UDP/TCP 8555 media or H.265 codec
        // fails to decode any video frame within 6 seconds, automatically switch to HLS!
        fallbackTimer = setTimeout(() => {
          const v = videoRef.current;
          if (!v || !v.videoWidth || v.readyState < 2) {
            switchToHlsFallback('No decoded video frame within 6s (Codec H.265 or Port 8555 blocked)');
          }
        }, 6000);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await new Promise((resolve) => {
          if (pc.iceGatheringState === 'complete') {
            resolve();
          } else {
            const check = () => {
              if (pc.iceGatheringState === 'complete') {
                pc.removeEventListener('icegatheringstatechange', check);
                resolve();
              }
            };
            pc.addEventListener('icegatheringstatechange', check);
            setTimeout(resolve, 2500);
          }
        });

        if (cancelled) return;

        const token = localStorage.getItem('smart_cctv_token');
        const headers = { 'Content-Type': 'application/sdp' };
        if (token) {
          headers.Authorization = `Bearer ${token}`;
        }

        const response = await fetch(resolveStreamUrl(streams.webrtc), {
          method: 'POST',
          headers,
          credentials: 'include',
          body: pc.localDescription.sdp,
        });

        if (!response.ok) throw new Error('WebRTC handshake failed');

        const sdp = await response.text();
        await pc.setRemoteDescription(
          new RTCSessionDescription({
            type: 'answer',
            sdp,
          })
        );
      } catch (err) {
        switchToHlsFallback(err.message);
      }
    }

    async function connectHLS() {
      try {
        mediaStreamRef.current = null;
        if (videoRef.current && videoRef.current.srcObject) {
          videoRef.current.srcObject = null;
        }
        if (secondaryVideoRef.current && secondaryVideoRef.current.srcObject) {
          secondaryVideoRef.current.srcObject = null;
        }

        const Hls = (await import('hls.js')).default;
        const hlsUrl = resolveStreamUrl(streams.hls);

        if (!Hls.isSupported()) {
          if (videoRef.current?.canPlayType('application/vnd.apple.mpegurl')) {
            videoRef.current.src = hlsUrl;
            if (autoPlay) videoRef.current.play().catch(() => {});
            return;
          }
          throw new Error('HLS not supported');
        }

        const token = localStorage.getItem('smart_cctv_token');
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          maxBufferLength: 5,
          maxMaxBufferLength: 10,
          xhrSetup: (xhr) => {
            xhr.withCredentials = true;
            if (token) {
              xhr.setRequestHeader('Authorization', `Bearer ${token}`);
            }
          },
        });

        hls.loadSource(hlsUrl);
        hls.attachMedia(videoRef.current);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (autoPlay && videoRef.current) videoRef.current.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            console.error('[VideoPlayer] HLS fatal error:', data.details);
            if (!cancelled) setMode('error');
          }
        });

        return () => hls.destroy();
      } catch (err) {
        console.error('[VideoPlayer] HLS failed:', err.message);
        if (!cancelled) setMode('error');
      }
    }

    let hlsCleanup = null;
    if (mode === 'webrtc') {
      connectWebRTC();
    } else if (mode === 'hls') {
      connectHLS().then((cleanup) => {
        hlsCleanup = cleanup;
      });
    }

    return () => {
      cancelled = true;
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (typeof hlsCleanup === 'function') hlsCleanup();
      mediaStreamRef.current = null;
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };
  }, [streamId, streams, mode, autoPlay, retryKey]);

  // Instant Frame Snapshot to PNG (respects active lens mode: full 8:9, top lens, or bottom lens)
  const handleSnapshot = (e) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const vw = video.videoWidth;
    const vh = video.videoHeight;

    if (activeLensMode === 'top') {
      canvas.width = vw;
      canvas.height = Math.floor(vh / 2);
      ctx.drawImage(video, 0, 0, vw, Math.floor(vh / 2), 0, 0, canvas.width, canvas.height);
    } else if (activeLensMode === 'bottom') {
      canvas.width = vw;
      canvas.height = Math.floor(vh / 2);
      ctx.drawImage(
        video,
        0,
        Math.floor(vh / 2),
        vw,
        Math.floor(vh / 2),
        0,
        0,
        canvas.width,
        canvas.height
      );
    } else if (activeLensMode === 'split') {
      // Export side-by-side 32:9 composite
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

    // Watermark timestamp
    const stamp = new Date().toLocaleString('vi-VN');
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.fillRect(12, canvas.height - 38, 360, 28);
    ctx.fillStyle = '#00d4ff';
    ctx.font = 'bold 14px monospace';
    ctx.fillText(`${cameraName || streamId} • ${stamp}`, 20, canvas.height - 19);

    const link = document.createElement('a');
    link.download = `snapshot_${streamId}_${activeLensMode}_${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  };

  const handleToggleMute = (e) => {
    e.stopPropagation();
    setIsMuted((prev) => !prev);
  };

  const handleRetry = (e) => {
    e.stopPropagation();
    setMode('webrtc');
    setRetryKey((k) => k + 1);
  };

  const handleZoomChange = (e, delta) => {
    e.stopPropagation();
    setZoom((prev) => {
      const next = Math.max(1, Math.min(5, Number((prev + delta).toFixed(1))));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const handleWheelZoom = (e) => {
    if (compact || lockStacked) return;
    if (!e.ctrlKey && zoom === 1) return;
    e.preventDefault();
    const delta = e.deltaY < 0 ? 0.25 : -0.25;
    setZoom((prev) => {
      const next = Math.max(1, Math.min(5, Number((prev + delta).toFixed(2))));
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  };

  const handlePanMouseDown = (e) => {
    if (zoom <= 1 || lockStacked) return;
    e.stopPropagation();
    isPanningRef.current = true;
    panStartRef.current = { x: e.clientX - pan.x, y: e.clientY - pan.y };
  };

  const handlePanMouseMove = (e) => {
    if (!isPanningRef.current || zoom <= 1) return;
    e.stopPropagation();
    const maxOffset = (zoom - 1) * 180;
    const nx = Math.max(-maxOffset, Math.min(maxOffset, e.clientX - panStartRef.current.x));
    const ny = Math.max(-maxOffset, Math.min(maxOffset, e.clientY - panStartRef.current.y));
    setPan({ x: nx, y: ny });
  };

  const handlePanMouseUp = () => {
    isPanningRef.current = false;
  };

  if (!streams) {
    return (
      <div className="vms-player-root">
        <div className="video-placeholder">
          <VideoOff size={compact ? 20 : 32} />
          {!compact && <p>Không có luồng camera</p>}
        </div>
      </div>
    );
  }

  if (mode === 'error') {
    return (
      <div className="vms-player-root">
        <div className="video-placeholder">
          <VideoOff size={compact ? 22 : 32} style={{ color: 'var(--danger)' }} />
          <p className="text-xs">Mất tín hiệu camera</p>
          <button type="button" className="vms-retry-btn" onClick={handleRetry}>
            <RefreshCw size={12} /> Kết nối lại
          </button>
        </div>
      </div>
    );
  }

  const zoomTransform =
    zoom > 1
      ? `scale(${zoom}) translate(${pan.x / zoom}px, ${pan.y / zoom}px)`
      : undefined;

  return (
    <div
      className={`vms-player-root lens-mode-${activeLensMode} ${zoom > 1 ? 'is-zoomed' : ''}`}
      onWheel={handleWheelZoom}
      onMouseDown={handlePanMouseDown}
      onMouseMove={handlePanMouseMove}
      onMouseUp={handlePanMouseUp}
      onMouseLeave={handlePanMouseUp}
    >
      {/* Top-Right Technical OSD Badge (Clickable Protocol Toggle + Resolution) */}
      {showOsd && connected && (
        <div className="vms-osd-tech" style={{ pointerEvents: 'auto' }}>
          <button
            type="button"
            className={`vms-proto-tag ${mode}`}
            style={{ cursor: 'pointer' }}
            onClick={(e) => {
              e.stopPropagation();
              setMode((prev) => (prev === 'webrtc' ? 'hls' : 'webrtc'));
            }}
            title="Nhấn để chuyển đổi giữa WebRTC và HLS"
          >
            {mode.toUpperCase()} ⇄
          </button>
          {videoMeta.width > 0 && (
            <span className="vms-res-tag">
              {videoMeta.width}×{videoMeta.height}
            </span>
          )}
          {zoom > 1 && <span className="vms-zoom-tag">{zoom.toFixed(1)}x</span>}
        </div>
      )}

      {/* Dual-Lens Viewport Rendering */}
      {activeLensMode === 'split' ? (
        <div
          className="vms-dual-split-grid"
          style={{ transform: zoomTransform, transformOrigin: 'center center' }}
        >
          {/* Left Pane: Top Lens (0% - 50% Y) */}
          <div className="vms-split-pane">
            <span className="vms-lens-tag">MẮT 1 (TRÊN - CỐ ĐỊNH)</span>
            <div className="vms-crop-box crop-top">
              <video
                ref={videoRef}
                autoPlay={autoPlay}
                muted={isMuted}
                playsInline
                onLoadedMetadata={handleLoadedMetadata}
              />
            </div>
          </div>

          {/* Right Pane: Bottom Lens (50% - 100% Y) */}
          <div className="vms-split-pane">
            <span className="vms-lens-tag">MẮT 2 (DƯỚI - PTZ)</span>
            <div className="vms-crop-box crop-bottom">
              <video
                ref={secondaryVideoRef}
                autoPlay={autoPlay}
                muted
                playsInline
              />
            </div>
          </div>
        </div>
      ) : activeLensMode === 'top' || activeLensMode === 'bottom' ? (
        <div
          className="vms-single-lens-stage"
          style={{ transform: zoomTransform, transformOrigin: 'center center' }}
        >
          <span className="vms-lens-tag">
            {activeLensMode === 'top' ? 'MẮT 1 (KHUNG TRÊN 16:9)' : 'MẮT 2 (KHUNG DƯỚI 16:9)'}
          </span>
          <div className={`vms-crop-box ${activeLensMode === 'top' ? 'crop-top' : 'crop-bottom'}`}>
            <video
              ref={videoRef}
              autoPlay={autoPlay}
              muted={isMuted}
              playsInline
              onLoadedMetadata={handleLoadedMetadata}
            />
          </div>
        </div>
      ) : (
        /* Default 'stacked' mode: Full 8:9 dual frame */
        <div
          className="vms-stacked-stage"
          style={{ transform: zoomTransform, transformOrigin: 'center center' }}
        >
          <video
            ref={videoRef}
            autoPlay={autoPlay}
            muted={isMuted}
            playsInline
            onLoadedMetadata={handleLoadedMetadata}
          />
          {videoMeta.isDualLens && connected && (
            <div className="vms-dual-divider" title="Ranh giới 2 khung hình 16:9 (50%)" />
          )}
        </div>
      )}

      {/* Floating Bottom-Left Lens Switcher & Quick Media Controls */}
      {showControls && !lockStacked && (
        <div className="vms-player-hud-bar" onClick={(e) => e.stopPropagation()}>
          {/* 4 Dual-Lens Mode Buttons */}
          <div className="vms-lens-switcher" title="Chế độ hiển thị Camera 2 mắt">
            <button
              type="button"
              className={`vms-hud-btn ${activeLensMode === 'stacked' ? 'active' : ''}`}
              onClick={() => setLensMode('stacked')}
              title="Kép Dọc (Xem cả 2 mắt trên/dưới 8:9)"
            >
              <Rows size={13} />
              {!compact && <span>2 Mắt Dọc</span>}
            </button>
            <button
              type="button"
              className={`vms-hud-btn ${activeLensMode === 'split' ? 'active' : ''}`}
              onClick={() => setLensMode('split')}
              title="Tách Ngang (Mắt trên bên trái, Mắt dưới bên phải - 2x16:9)"
            >
              <Columns size={13} />
              {!compact && <span>Tách Ngang</span>}
            </button>
            <button
              type="button"
              className={`vms-hud-btn ${activeLensMode === 'top' ? 'active' : ''}`}
              onClick={() => setLensMode('top')}
              title="Chỉ xem Mắt 1 (Khung trên 16:9)"
            >
              <ArrowUpSquare size={13} />
              <span>Mắt 1</span>
            </button>
            <button
              type="button"
              className={`vms-hud-btn ${activeLensMode === 'bottom' ? 'active' : ''}`}
              onClick={() => setLensMode('bottom')}
              title="Chỉ xem Mắt 2 (Khung dưới 16:9)"
            >
              <ArrowDownSquare size={13} />
              <span>Mắt 2</span>
            </button>
          </div>

          {/* Audio, Snapshot & Digital Zoom Controls */}
          <div className="vms-media-tools">
            <button
              type="button"
              className={`vms-hud-icon-btn ${!isMuted ? 'active' : ''}`}
              onClick={handleToggleMute}
              title={isMuted ? 'Bật âm thanh' : 'Tắt âm thanh'}
            >
              {isMuted ? <VolumeX size={13} /> : <Volume2 size={13} />}
            </button>

            <button
              type="button"
              className="vms-hud-icon-btn"
              onClick={handleSnapshot}
              title="Chụp ảnh nhanh (Lưu PNG)"
            >
              <CameraIcon size={13} />
            </button>

            {!compact && (
              <>
                <button
                  type="button"
                  className="vms-hud-icon-btn"
                  onClick={(e) => handleZoomChange(e, 0.5)}
                  title="Phóng to kỹ thuật số (Digital Zoom In)"
                >
                  <ZoomIn size={13} />
                </button>
                {zoom > 1 && (
                  <>
                    <button
                      type="button"
                      className="vms-hud-icon-btn"
                      onClick={(e) => handleZoomChange(e, -0.5)}
                      title="Thu nhỏ (Zoom Out)"
                    >
                      <ZoomOut size={13} />
                    </button>
                    <button
                      type="button"
                      className="vms-hud-icon-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setZoom(1);
                        setPan({ x: 0, y: 0 });
                      }}
                      title="Khôi phục góc nhìn 1.0x"
                    >
                      <RotateCcw size={13} />
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* Connecting State Overlay */}
      {!connected && (
        <div
          className="video-placeholder"
          style={{
            position: 'absolute',
            inset: 0,
            background: 'rgba(6, 7, 12, 0.85)',
            zIndex: 5,
          }}
        >
          <div className="status-dot" />
          <p className="text-xs text-mono">ĐANG KẾT NỐI LUỒNG...</p>
        </div>
      )}
    </div>
  );
}
