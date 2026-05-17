/**
 * Client for go2rtc REST API
 * Manages camera streams dynamically
 * Requires Node.js 18+ for native fetch API
 */
class Go2RTCClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
  }
  
  async _request(method, path, body = null) {
    const url = new URL(path, this.baseUrl);
    
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
      // Sử dụng AbortSignal để xử lý timeout một cách tự nhiên
      signal: AbortSignal.timeout(5000),
    };
    
    if (body) {
      options.body = JSON.stringify(body);
    }
    
    try {
      const response = await fetch(url, options);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const text = await response.text();
      try {
        return text ? JSON.parse(text) : {};
      } catch {
        return text;
      }
    } catch (error) {
      if (error.name === 'TimeoutError') {
        throw new Error('Request timeout');
      }
      throw error; // Ném lỗi ra ngoài để hàm gọi xử lý
    }
  }
  
  /**
   * Add or update a stream in go2rtc
   */
  async addStream(streamId, rtspUrl) {
    try {
      // Go2rtc API sử dụng 'name' thay vì 'dst' trong các phiên bản mới
      const url = `/go2rtc/api/streams?name=${encodeURIComponent(streamId)}&src=${encodeURIComponent(rtspUrl)}`;
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
      // Tương tự, sử dụng 'name' để xóa stream
      const url = `/go2rtc/api/streams?name=${encodeURIComponent(streamId)}`;
      await this._request('DELETE', url);
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
      return await this._request('GET', '/go2rtc/api/streams');
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
    return `${this.baseUrl}/go2rtc/api/webrtc?src=${encodeURIComponent(streamId)}`;
  }
  
  /**
   * Get HLS URL for a stream
   */
  getHLSUrl(streamId) {
    return `${this.baseUrl}/go2rtc/api/stream.m3u8?src=${encodeURIComponent(streamId)}`;
  }
  
  /**
   * Get snapshot URL for a stream
   */
  getSnapshotUrl(streamId) {
    return `${this.baseUrl}/go2rtc/api/frame.jpeg?src=${encodeURIComponent(streamId)}`;
  }
}

module.exports = Go2RTCClient;