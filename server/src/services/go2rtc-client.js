/**
 * Client for go2rtc REST API (bound to 127.0.0.1:1984 inside Docker)
 * Manages camera streams dynamically and proxies WebRTC/HLS/Snapshot requests
 * so go2rtc API never needs to be exposed publicly.
 */
class Go2RTCClient {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || 'http://127.0.0.1:1984').replace(/\/+$/, '');
  }

  _buildTargetUrl(apiPath) {
    return `${this.baseUrl}${apiPath.startsWith('/') ? '' : '/'}${apiPath}`;
  }

  async _request(method, apiPath, body = null, customHeaders = {}) {
    const url = this._buildTargetUrl(apiPath);

    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...customHeaders,
      },
      signal: AbortSignal.timeout(8000),
    };

    if (body !== null && body !== undefined) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const response = await fetch(url, options);
    if (!response.ok) {
      throw new Error(`go2rtc HTTP ${response.status}`);
    }

    const text = await response.text();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      return text;
    }
  }

  /**
   * Add or update a stream in go2rtc
   */
  async addStream(streamId, rtspUrl) {
    try {
      const apiPath = `/api/streams?name=${encodeURIComponent(streamId)}&src=${encodeURIComponent(rtspUrl)}`;
      await this._request('PUT', apiPath);
      console.log(`[go2rtc] Stream registered: ${streamId}`);
      return true;
    } catch (err) {
      console.error(`[go2rtc] Failed to add stream ${streamId}:`, err.message);
      return false;
    }
  }

  /**
   * Remove a stream from go2rtc
   */
  async removeStream(streamId) {
    try {
      const apiPath = `/api/streams?name=${encodeURIComponent(streamId)}`;
      await this._request('DELETE', apiPath);
      console.log(`[go2rtc] Stream removed: ${streamId}`);
      return true;
    } catch (err) {
      console.error(`[go2rtc] Failed to remove stream ${streamId}:`, err.message);
      return false;
    }
  }

  /**
   * Get all active streams from go2rtc
   */
  async getStreams() {
    try {
      return await this._request('GET', '/api/streams');
    } catch (err) {
      console.error('[go2rtc] Failed to get streams:', err.message);
      return {};
    }
  }

  /**
   * Exchange WebRTC SDP offer with local go2rtc
   */
  async exchangeWebRTCOffer(streamId, sdpOffer) {
    const url = this._buildTargetUrl(`/api/webrtc?src=${encodeURIComponent(streamId)}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: sdpOffer,
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      throw new Error(`go2rtc WebRTC handshake failed (${response.status})`);
    }

    return await response.text();
  }

  /**
   * Fetch raw binary/text response from go2rtc for proxying (Snapshot, HLS m3u8 / ts / m4s)
   */
  async fetchRaw(apiPath) {
    const url = this._buildTargetUrl(apiPath);
    return await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(10000),
    });
  }

  /**
   * Return authenticated Node.js proxy endpoints for a camera
   */
  getClientStreamUrls(cameraId) {
    return {
      webrtc: `/api/cameras/${encodeURIComponent(cameraId)}/webrtc`,
      hls: `/api/cameras/${encodeURIComponent(cameraId)}/hls/stream.m3u8`,
      snapshot: `/api/cameras/${encodeURIComponent(cameraId)}/snapshot`,
    };
  }
}

module.exports = Go2RTCClient;
