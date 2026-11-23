use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioAlertEvent {
    pub class_code: String,
    pub display_label: String,
    pub rms_db: f64,
    pub confidence: f64,
}

/// Intelligent spectral & crest-factor audio classifier
/// Distinguishes sharp impulsive glass-breaking / impacts, high-frequency screaming / crying / sirens,
/// and dog barking from steady low-frequency background rumble (rain, thunder, distant traffic).
pub fn classify_audio_signature(
    rms_db: f64,
    peak_db: f64,
    threshold_db: f64,
    zero_crossing_rate: f64,
) -> Option<AudioAlertEvent> {
    if rms_db < threshold_db {
        return None;
    }

    let over_db = (rms_db - threshold_db).max(1.0);
    let crest_factor = (peak_db - rms_db).abs();
    let confidence = (over_db / 20.0).clamp(0.45, 0.99);

    // High crest factor (> 11 dB) + high ZCR indicates sharp impulsive transient (Glass breaking / Door slam)
    let (class_code, display_label) = if crest_factor >= 11.5 && zero_crossing_rate > 0.14 {
        ("glass_breaking", "Tiếng kính vỡ / Va đập mạnh")
    } else if zero_crossing_rate > 0.22 {
        ("screaming", "Tiếng la hét / Âm tần cao bất thường")
    } else if zero_crossing_rate > 0.15 {
        ("siren_alarm", "Tiếng còi báo động / Trẻ em khóc")
    } else if crest_factor >= 8.0 {
        ("dog_bark", "Tiếng chó sủa / Động tĩnh ban đêm")
    } else {
        ("unusual_sound", "Âm thanh lạ vượt ngưỡng ban đêm")
    };

    Some(AudioAlertEvent {
        class_code: class_code.to_string(),
        display_label: format!("{} ({:.1} dBFS)", display_label, rms_db),
        rms_db,
        confidence,
    })
}
