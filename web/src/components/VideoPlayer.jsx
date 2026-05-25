import React, { useRef, useEffect, useState } from 'react';
import { VideoOff } from 'lucide-react';

/**
 * VideoPlayer component supporting WebRTC and HLS playback
 * Falls back gracefully: WebRTC → HLS → Snapshot
 */
export default function VideoPlayer({ streamId, streams, autoPlay = true, muted = true, compact = false, onAspectRatioChange }) {
  const videoRef = useRef(null);
  const pcRef = useRef(null);
  const [mode, setMode] = useState('webrtc'); // webrtc | hls | error
  const [connected, setConnected] = useState(false);
  const [aspectRatio, setLocalAspectRatio] = useState(16 / 9);

  const handleLoadedMetadata = (e) => {
    const video = e.target;
    if (video.videoWidth && video.videoHeight) {
      const ratio = video.videoWidth / video.videoHeight;
      setLocalAspectRatio(ratio);
      if (onAspectRatioChange) {
        onAspectRatioChange(ratio);
      }
    }
  };

  useEffect(() => {
    if (!streams || !streamId) return;

    let cancelled = false;

    async function connectWebRTC() {
      try {
        const pc = new RTCPeerConnection({
          iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });
        pcRef.current = pc;

        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.addTransceiver('audio', { direction: 'recvonly' });

        pc.ontrack = (event) => {
          if (videoRef.current && event.streams[0]) {
            videoRef.current.srcObject = event.streams[0];
            if (!cancelled) setConnected(true);
          }
        };

        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'disconnected') {
            if (!cancelled) {
              setMode('hls');
              setConnected(false);
            }
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        // Wait for ICE gathering
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
            setTimeout(resolve, 3000); // Timeout
          }
        });

        if (cancelled) return;

        const response = await fetch(streams.webrtc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/sdp' },
          body: pc.localDescription.sdp,
        });

        if (!response.ok) throw new Error('WebRTC handshake failed');

        const sdp = await response.text();
        await pc.setRemoteDescription(new RTCSessionDescription({
          type: 'answer',
          sdp,
        }));
      } catch (err) {
        console.warn('[VideoPlayer] WebRTC failed, falling back to HLS:', err.message);
        if (!cancelled) setMode('hls');
      }
    }

    async function connectHLS() {
      try {
        const Hls = (await import('hls.js')).default;
        if (!Hls.isSupported()) {
          // Try native HLS (Safari)
          if (videoRef.current?.canPlayType('application/vnd.apple.mpegurl')) {
            videoRef.current.src = streams.hls;
            if (autoPlay) videoRef.current.play();
            setConnected(true);
            return;
          }
          throw new Error('HLS not supported');
        }

        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          maxBufferLength: 5,
          maxMaxBufferLength: 10,
        });

        hls.loadSource(streams.hls);
        hls.attachMedia(videoRef.current);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (autoPlay && videoRef.current) videoRef.current.play();
          if (!cancelled) setConnected(true);
        });

        hls.on(Hls.Events.ERROR, (event, data) => {
          if (data.fatal) {
            console.error('[VideoPlayer] HLS fatal error');
            if (!cancelled) setMode('error');
          }
        });

        return () => hls.destroy();
      } catch (err) {
        console.error('[VideoPlayer] HLS failed:', err.message);
        if (!cancelled) setMode('error');
      }
    }

    if (mode === 'webrtc') {
      connectWebRTC();
    } else if (mode === 'hls') {
      const cleanup = connectHLS();
      return () => {
        cancelled = true;
        if (typeof cleanup === 'function') cleanup();
      };
    }

    return () => {
      cancelled = true;
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
    };
  }, [streamId, streams, mode, autoPlay]);

  if (!streams) {
    return (
      <div className="video-player-container" style={{ aspectRatio, width: '100%', height: 'auto' }}>
        <div className="video-placeholder">
          <VideoOff size={compact ? 20 : 32} />
          {!compact && <p>Không có stream</p>}
        </div>
      </div>
    );
  }

  if (mode === 'error') {
    return (
      <div className="video-player-container" style={{ aspectRatio, width: '100%', height: 'auto' }}>
        <div className="video-placeholder">
          <VideoOff size={compact ? 20 : 32} />
          {!compact && <p>Không thể kết nối camera</p>}
        </div>
      </div>
    );
  }

  return (
    
    <div className="video-player-container" style={{ aspectRatio, width: '100%', height: 'auto' }}>
      <video
        ref={videoRef}
        autoPlay={autoPlay}
        muted={muted}
        playsInline
        controls={!compact}
        onLoadedMetadata={handleLoadedMetadata}
        style={{ width: '100%', height: '100%', objectFit: 'contain'}}
      />
      {!connected && (
        <div className="video-placeholder" style={{ position: 'absolute', inset: 0, background: 'var(--bg-secondary)' }}>
          <div className="status-dot" />
          {!compact && <p className="text-xs">Đang kết nối...</p>}
        </div>
      )}
    </div>
  );
}
