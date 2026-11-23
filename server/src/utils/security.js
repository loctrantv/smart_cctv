const path = require('path');

/**
 * Validate RTSP URL to prevent SSRF or go2rtc command execution (exec:, echo:, ffmpeg:, file:, etc.)
 */
function validateRtspUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { valid: false, error: 'RTSP URL không hợp lệ' };
  }
  const trimmed = rawUrl.trim();
  if (trimmed.length > 512) {
    return { valid: false, error: 'RTSP URL quá dài' };
  }
  // Disallow control characters, whitespace, or shell metacharacters
  if (/[\r\n\t\0]/.test(trimmed)) {
    return { valid: false, error: 'RTSP URL chứa ký tự điều khiển không hợp lệ' };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: 'Định dạng RTSP URL không hợp lệ (ví dụ: rtsp://user:pass@ip:554/stream)' };
  }

  if (parsed.protocol !== 'rtsp:' && parsed.protocol !== 'rtsps:') {
    return { valid: false, error: 'Chỉ cho phép giao thức rtsp:// hoặc rtsps://' };
  }

  if (!parsed.hostname) {
    return { valid: false, error: 'RTSP URL thiếu địa chỉ IP hoặc hostname của camera' };
  }

  // Block loopback access to internal services (e.g. go2rtc itself or local ports) unless explicitly allowed
  const hostLower = parsed.hostname.toLowerCase();
  if (
    (hostLower === 'localhost' || hostLower === '127.0.0.1' || hostLower === '::1') &&
    process.env.ALLOW_LOCAL_RTSP !== 'true'
  ) {
    return { valid: false, error: 'Không cho phép trỏ RTSP URL vào địa chỉ loopback của chính máy chủ' };
  }

  return { valid: true, url: trimmed };
}

/**
 * Mask password inside RTSP URL before returning to client UI
 */
function maskRtspUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      parsed.password = '******';
    }
    return parsed.toString();
  } catch {
    // Fallback regex masking
    return rawUrl.replace(/(\/\/[^:/@]+:)([^@]+)(@)/, '$1******$3');
  }
}

/**
 * Validate and normalize detection zones (JSON array of {x, y, w, h} in [0, 1])
 */
function validateDetectionZone(zoneInput) {
  if (zoneInput === undefined || zoneInput === null || zoneInput === '') {
    return { valid: true, value: '' };
  }

  let raw = zoneInput;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return { valid: true, value: '' };
    if (trimmed.startsWith('[')) {
      try {
        raw = JSON.parse(trimmed);
      } catch {
        return { valid: false, error: 'Dữ liệu detection_zone không phải JSON hợp lệ' };
      }
    } else {
      const parts = trimmed.split(',').map(Number);
      if (parts.length === 4 && parts.every((n) => Number.isFinite(n))) {
        raw = [{ x: parts[0], y: parts[1], w: parts[2], h: parts[3] }];
      } else {
        return { valid: false, error: 'Định dạng vùng phát hiện không hợp lệ' };
      }
    }
  }

  if (!Array.isArray(raw)) {
    return { valid: false, error: 'detection_zone phải là mảng các vùng' };
  }

  if (raw.length > 10) {
    return { valid: false, error: 'Tối đa 10 vùng phát hiện trên mỗi camera' };
  }

  const sanitized = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      return { valid: false, error: 'Tọa độ vùng phát hiện không hợp lệ' };
    }
    const x = Number(item.x);
    const y = Number(item.y);
    const w = Number(item.w);
    const h = Number(item.h);

    if (![x, y, w, h].every((v) => Number.isFinite(v))) {
      return { valid: false, error: 'Tọa độ vùng phát hiện phải là số thực' };
    }
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.05 || y + h > 1.05) {
      return { valid: false, error: 'Tọa độ vùng phát hiện vượt ngoài phạm vi [0..1]' };
    }

    sanitized.push({
      x: Math.max(0, Math.min(1, Number(x.toFixed(4)))),
      y: Math.max(0, Math.min(1, Number(y.toFixed(4)))),
      w: Math.max(0.01, Math.min(1, Number(w.toFixed(4)))),
      h: Math.max(0.01, Math.min(1, Number(h.toFixed(4)))),
    });
  }

  return { valid: true, value: sanitized.length > 0 ? JSON.stringify(sanitized) : '' };
}

/**
 * Safely resolve a file inside a base directory and prevent Path Traversal (../)
 */
function resolveSafePath(baseDir, relativeTarget) {
  if (!relativeTarget || typeof relativeTarget !== 'string') return null;
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, relativeTarget);
  if (
    resolvedTarget !== resolvedBase &&
    !resolvedTarget.startsWith(resolvedBase + path.sep)
  ) {
    return null;
  }
  return resolvedTarget;
}

/**
 * Verify image magic bytes (JPEG, PNG, WebP) from Buffer
 */
function detectImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: 'image/jpeg', ext: '.jpg' };
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { mime: 'image/png', ext: '.png' };
  }

  // WebP: RIFF....WEBP
  if (
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return { mime: 'image/webp', ext: '.webp' };
  }

  return null;
}

module.exports = {
  validateRtspUrl,
  maskRtspUrl,
  validateDetectionZone,
  resolveSafePath,
  detectImageType,
};
