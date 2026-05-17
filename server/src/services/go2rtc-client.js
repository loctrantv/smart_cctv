const http = require('http');
const https = require('https');

/**
 * Client for go2rtc REST API
 * Manages camera streams dynamically
 */
class Go2RTCClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }

  async _request(method, path, body = null) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const client = url.protocol === 'https:' ? https : http;

      const options = {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: { 'Content-Type': 'application/json' },
        timeout: 5000,
      };

      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(data ? JSON.parse(data) : {});
          } catch {
            resolve(data);
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Request timeout'));
      });

      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }

  /**
   * Add or update a stream in go2rtc
   */
  async addStream(streamId, rtspUrl) {
    try {
      const url = `/api/streams?name=${encodeURIComponent(streamId)}&src=${encodeURIComponent(rtspUrl)}`;
      await this._request('PUT', url);
      console.log(`[go2rtc] Stream added: ${streamId}`);
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
      await this._request('DELETE', `/api/streams?name=${encodeURIComponent(streamId)}`);
      console.log(`[go2rtc] Stream removed: ${streamId}`);
      return true;
    } catch (err) {
      console.error(`[go2rtc] Failed to remove stream ${streamId}:`, err.message);
      return false;
    }
  }

  /**
   * Get all active streams
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
   * Get info about a specific stream
   */
  async getStreamInfo(streamId) {
    try {
      const streams = await this.getStreams();
      return streams[streamId] || null;
    } catch {
      return null;
    }
  }

  /**
   * Get WebRTC URL for a stream
   */
  getWebRTCUrl(streamId) {
    return `${this.baseUrl}/api/webrtc?src=${encodeURIComponent(streamId)}`;
  }

  /**
   * Get HLS URL for a stream
   */
  getHLSUrl(streamId) {
    return `${this.baseUrl}/api/stream.m3u8?src=${encodeURIComponent(streamId)}`;
  }

  /**
   * Get snapshot URL for a stream
   */
  getSnapshotUrl(streamId) {
    return `${this.baseUrl}/api/frame.jpeg?src=${encodeURIComponent(streamId)}`;
  }
}

module.exports = Go2RTCClient;
