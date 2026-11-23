import React, {
  createContext,
  useContext,
  useState,
  useRef,
  useEffect,
  useCallback,
  useMemo,
} from 'react';
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  AlertTriangle,
  Info,
  CheckCircle2,
  XCircle,
  Calendar as CalendarIcon,
  Minus,
  Plus,
  Upload,
  X,
} from 'lucide-react';
import {
  format,
  addMonths,
  subMonths,
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isSameMonth,
  isSameDay,
  parseISO,
  isValid,
} from 'date-fns';

// ============================================================
// 1. GLOBAL TECH DIALOG (CONFIRM / ALERT) & TOAST PROVIDER
// Replaces native window.alert() and window.confirm() 100%!
// ============================================================

const TechDialogContext = createContext(null);

export const useTechDialog = () => useContext(TechDialogContext);

export function TechDialogProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [confirmState, setConfirmState] = useState(null);

  const showToast = useCallback((message, type = 'info', title = '') => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const defaultTitles = {
      success: 'THÀNH CÔNG',
      error: 'LỖI HỆ THỐNG',
      warning: 'CẢNH BÁO',
      info: 'THÔNG BÁO VMS',
    };
    setToasts((prev) => [
      ...prev,
      {
        id,
        type,
        title: title || defaultTitles[type] || 'THÔNG BÁO',
        message: String(message),
      },
    ]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4200);
  }, []);

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  /**
   * Promise-based custom confirm modal replacing window.confirm()
   * Usage: const ok = await confirmDialog({ title: 'XÓA CAMERA', message: '...', danger: true });
   */
  const confirmDialog = useCallback((options) => {
    const opts =
      typeof options === 'string'
        ? {
            title: 'XÁC NHẬN THAO TÁC',
            message: options,
            confirmText: 'Xác nhận',
            cancelText: 'Hủy bỏ',
            danger: true,
          }
        : {
            title: options.title || 'XÁC NHẬN HỆ THỐNG',
            message: options.message || '',
            confirmText: options.confirmText || 'Thực thi',
            cancelText: options.cancelText || 'Hủy bỏ',
            danger: options.danger !== undefined ? options.danger : true,
          };

    return new Promise((resolve) => {
      setConfirmState({
        ...opts,
        onConfirm: () => {
          setConfirmState(null);
          resolve(true);
        },
        onCancel: () => {
          setConfirmState(null);
          resolve(false);
        },
      });
    });
  }, []);

  const alertDialog = useCallback(
    (message, type = 'info', title = '') => {
      showToast(message, type, title);
    },
    [showToast]
  );

  const ctxValue = useMemo(
    () => ({
      showToast,
      alertDialog,
      confirmDialog,
    }),
    [showToast, alertDialog, confirmDialog]
  );

  return (
    <TechDialogContext.Provider value={ctxValue}>
      {children}

      {/* Floating Cyber-Tech Toast Stack */}
      <div className="tech-toast-stack">
        {toasts.map((t) => (
          <div key={t.id} className={`tech-toast-card type-${t.type}`}>
            <div className="tech-toast-accent-bar" />
            <div className="tech-toast-icon">
              {t.type === 'success' && <CheckCircle2 size={18} />}
              {t.type === 'error' && <XCircle size={18} />}
              {t.type === 'warning' && <AlertTriangle size={18} />}
              {t.type === 'info' && <Info size={18} />}
            </div>
            <div className="tech-toast-content">
              <div className="tech-toast-title text-mono">{t.title}</div>
              <div className="tech-toast-msg">{t.message}</div>
            </div>
            <button
              type="button"
              className="tech-toast-close"
              onClick={() => dismissToast(t.id)}
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>

      {/* Custom Cyber-Tech Confirm Modal */}
      {confirmState && (
        <div className="tech-modal-backdrop" onClick={confirmState.onCancel}>
          <div
            className={`tech-confirm-modal ${confirmState.danger ? 'is-danger' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tech-corner tl" />
            <div className="tech-corner tr" />
            <div className="tech-corner bl" />
            <div className="tech-corner br" />

            <div className="tech-confirm-header">
              <div className="tech-confirm-icon">
                <AlertTriangle size={20} />
              </div>
              <div>
                <div className="tech-confirm-tag text-mono">SYSTEM SECURITY PROMPT</div>
                <h3 className="tech-confirm-title">{confirmState.title}</h3>
              </div>
            </div>

            <div className="tech-confirm-body">{confirmState.message}</div>

            <div className="tech-confirm-footer">
              <button
                type="button"
                className="tech-btn tech-btn-ghost"
                onClick={confirmState.onCancel}
              >
                {confirmState.cancelText}
              </button>
              <button
                type="button"
                className={`tech-btn ${
                  confirmState.danger ? 'tech-btn-danger' : 'tech-btn-primary'
                }`}
                onClick={confirmState.onConfirm}
                autoFocus
              >
                {confirmState.confirmText}
              </button>
            </div>
          </div>
        </div>
      )}
    </TechDialogContext.Provider>
  );
}

// ============================================================
// 2. TECH SELECT (Custom Dropdown replacing native <select>)
// ============================================================

export function TechSelect({
  value,
  onChange,
  options = [],
  placeholder = 'Chọn...',
  icon: Icon,
  size = 'md',
  className = '',
  style = {},
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const selectedOpt = options.find((o) => String(o.value) === String(value));

  return (
    <div
      ref={wrapRef}
      className={`tech-select-root size-${size} ${open ? 'is-open' : ''} ${className}`}
      style={style}
    >
      <button
        type="button"
        className="tech-select-trigger"
        onClick={() => setOpen((prev) => !prev)}
      >
        <div className="tech-select-value-wrap">
          {Icon && <Icon size={14} className="tech-select-leading-icon" />}
          <span className="tech-select-label truncate">
            {selectedOpt ? selectedOpt.label : placeholder}
          </span>
        </div>
        <ChevronDown size={14} className={`tech-select-arrow ${open ? 'rotated' : ''}`} />
      </button>

      {open && (
        <div className="tech-select-menu custom-scrollbar">
          {options.map((opt) => {
            const isSelected = String(opt.value) === String(value);
            return (
              <button
                key={String(opt.value)}
                type="button"
                className={`tech-select-option ${isSelected ? 'selected' : ''}`}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span className="truncate">{opt.label}</span>
                {isSelected && <Check size={13} className="tech-select-check" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ============================================================
// 3. TECH DATE PICKER (Custom Calendar Popover replacing <input type="date">)
// ============================================================

export function TechDatePicker({
  value,
  onChange,
  placeholder = 'Chọn ngày...',
  allowClear = false,
  size = 'md',
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  const parsedDate = useMemo(() => {
    if (!value) return null;
    const d = parseISO(value);
    return isValid(d) ? d : null;
  }, [value]);

  const [viewMonth, setViewMonth] = useState(() => parsedDate || new Date());

  useEffect(() => {
    if (parsedDate) setViewMonth(parsedDate);
  }, [parsedDate]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(viewMonth), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(viewMonth), { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [viewMonth]);

  const weekDays = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'];

  return (
    <div ref={wrapRef} className={`tech-datepicker-root size-${size}`}>
      <button
        type="button"
        className={`tech-datepicker-trigger ${open ? 'is-open' : ''}`}
        onClick={() => setOpen((prev) => !prev)}
      >
        <CalendarIcon size={14} className="tech-select-leading-icon" />
        <span className="text-mono">
          {parsedDate ? format(parsedDate, 'dd/MM/yyyy') : placeholder}
        </span>
        {allowClear && value ? (
          <span
            className="tech-datepicker-clear"
            onClick={(e) => {
              e.stopPropagation();
              onChange('');
              setOpen(false);
            }}
          >
            ✕
          </span>
        ) : (
          <ChevronDown size={13} className="tech-select-arrow" />
        )}
      </button>

      {open && (
        <div className="tech-calendar-popover">
          <div className="tech-calendar-header">
            <button
              type="button"
              className="tech-cal-nav-btn"
              onClick={() => setViewMonth((m) => subMonths(m, 1))}
            >
              <ChevronLeft size={14} />
            </button>
            <span className="tech-cal-title text-mono">
              THÁNG {format(viewMonth, 'MM / yyyy')}
            </span>
            <button
              type="button"
              className="tech-cal-nav-btn"
              onClick={() => setViewMonth((m) => addMonths(m, 1))}
            >
              <ChevronRight size={14} />
            </button>
          </div>

          <div className="tech-calendar-weekdays">
            {weekDays.map((w) => (
              <span key={w} className="tech-cal-weekday text-mono">
                {w}
              </span>
            ))}
          </div>

          <div className="tech-calendar-grid">
            {days.map((day) => {
              const inMonth = isSameMonth(day, viewMonth);
              const isSelected = parsedDate && isSameDay(day, parsedDate);
              const isToday = isSameDay(day, new Date());

              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  className={`tech-cal-day text-mono ${!inMonth ? 'muted' : ''} ${
                    isSelected ? 'selected' : ''
                  } ${isToday ? 'today' : ''}`}
                  onClick={() => {
                    onChange(format(day, 'yyyy-MM-dd'));
                    setOpen(false);
                  }}
                >
                  {format(day, 'd')}
                </button>
              );
            })}
          </div>

          <div className="tech-calendar-footer">
            <button
              type="button"
              className="tech-cal-quick-btn"
              onClick={() => {
                const todayStr = format(new Date(), 'yyyy-MM-dd');
                onChange(todayStr);
                setOpen(false);
              }}
            >
              Hôm nay
            </button>
            {allowClear && (
              <button
                type="button"
                className="tech-cal-quick-btn"
                onClick={() => {
                  onChange('');
                  setOpen(false);
                }}
              >
                Tất cả ngày
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// 4. TECH INPUT & TECH NUMBER STEPPER
// ============================================================

export function TechInput({
  label,
  hint,
  icon: Icon,
  rightElement,
  mono = false,
  className = '',
  ...props
}) {
  return (
    <div className={`tech-field-group ${className}`}>
      {label && <label className="tech-field-label">{label}</label>}
      <div className="tech-input-shell">
        {Icon && (
          <span className="tech-input-icon-left">
            <Icon size={15} />
          </span>
        )}
        <input
          className={`tech-input-control ${Icon ? 'has-left-icon' : ''} ${
            rightElement ? 'has-right-el' : ''
          } ${mono ? 'text-mono' : ''}`}
          {...props}
        />
        {rightElement && <span className="tech-input-el-right">{rightElement}</span>}
      </div>
      {hint && <div className="tech-field-hint">{hint}</div>}
    </div>
  );
}

export function TechNumberInput({
  label,
  hint,
  value,
  onChange,
  min = -999999,
  max = 999999,
  step = 1,
  unit = '',
  size = 'md',
}) {
  const numVal = Number(value);
  const safeVal = Number.isFinite(numVal) ? numVal : 0;

  const adjust = (delta) => {
    const precision = String(step).includes('.') ? String(step).split('.')[1].length : 0;
    const next = Math.max(min, Math.min(max, Number((safeVal + delta).toFixed(precision))));
    onChange(String(next));
  };

  return (
    <div className={`tech-field-group size-${size}`}>
      {label && <label className="tech-field-label">{label}</label>}
      <div className="tech-number-stepper">
        <button
          type="button"
          className="tech-stepper-btn"
          onClick={() => adjust(-step)}
          title="Giảm"
        >
          <Minus size={13} />
        </button>
        <div className="tech-stepper-input-wrap">
          <input
            type="text"
            inputMode="decimal"
            className="tech-stepper-input text-mono"
            value={value ?? ''}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '' || raw === '-' || /^-?\d*\.?\d*$/.test(raw)) {
                onChange(raw);
              }
            }}
          />
          {unit && <span className="tech-stepper-unit text-mono">{unit}</span>}
        </div>
        <button
          type="button"
          className="tech-stepper-btn"
          onClick={() => adjust(step)}
          title="Tăng"
        >
          <Plus size={13} />
        </button>
      </div>
      {hint && <div className="tech-field-hint">{hint}</div>}
    </div>
  );
}

// ============================================================
// 5. TECH SWITCH (Cyber Toggle Switch for On/Off settings)
// ============================================================

export function TechSwitch({ checked, onChange, label, description }) {
  return (
    <div
      className={`tech-switch-card ${checked ? 'is-on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <div className="tech-switch-info">
        {label && <div className="tech-switch-label">{label}</div>}
        {description && <div className="tech-switch-desc">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`tech-switch-track ${checked ? 'on' : 'off'}`}
      >
        <span className="tech-switch-thumb" />
        <span className="tech-switch-state text-mono">{checked ? 'ON' : 'OFF'}</span>
      </button>
    </div>
  );
}

// ============================================================
// 6. TECH CHECKBOX (Custom SVG Checkbox replacing <input type="checkbox">)
// ============================================================

export function TechCheckbox({ checked, onChange, label, className = '' }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      className={`tech-checkbox-root ${checked ? 'checked' : ''} ${className}`}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
    >
      <span className="tech-checkbox-box">{checked && <Check size={12} strokeWidth={3} />}</span>
      {label && <span className="tech-checkbox-label">{label}</span>}
    </button>
  );
}

// ============================================================
// 7. TECH FILE DROPZONE (Replacing native <input type="file">)
// ============================================================

export function TechFileDropzone({ label, accept = 'image/*', onFileSelect, previewUrl }) {
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);
  const [fileName, setFileName] = useState('');

  const handleFileObj = (f) => {
    if (!f) return;
    setFileName(f.name);
    onFileSelect(f);
  };

  return (
    <div className="tech-field-group">
      {label && <label className="tech-field-label">{label}</label>}
      <div
        className={`tech-dropzone ${dragging ? 'is-dragging' : ''}`}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            handleFileObj(e.dataTransfer.files[0]);
          }
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          style={{ display: 'none' }}
          onChange={(e) => handleFileObj(e.target.files?.[0])}
        />
        {previewUrl ? (
          <div className="tech-dropzone-preview">
            <img src={previewUrl} alt="Preview" />
            <div className="tech-dropzone-overlay">
              <Upload size={16} />
              <span>Nhấn hoặc kéo thả để đổi ảnh</span>
            </div>
          </div>
        ) : (
          <div className="tech-dropzone-empty">
            <Upload size={22} style={{ color: 'var(--accent)' }} />
            <span className="text-xs font-bold">
              {fileName || 'Nhấn để chọn file hoặc kéo thả ảnh vào đây'}
            </span>
            <span className="text-xs text-muted text-mono">Hỗ trợ: JPEG, PNG, WebP (Tối đa 5MB)</span>
          </div>
        )}
      </div>
    </div>
  );
}
