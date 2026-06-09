// Shepherd Mobile — shared UI primitives. Exported to window for other Babel files.
const { useState, useEffect, useRef, useLayoutEffect, useMemo } = React;

/* ---------- Lucide icon ---------- */
function Icon({ name, size = 18, color, style, strokeWidth = 1.6 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    ref.current.innerHTML = '';
    const i = document.createElement('i');
    i.setAttribute('data-lucide', name);
    ref.current.appendChild(i);
    if (window.lucide) window.lucide.createIcons({ nodes: [i], attrs: { 'stroke-width': strokeWidth, width: size, height: size } });
  }, [name, size, strokeWidth]);
  return <span ref={ref} className="lucide-slot" style={{ display: 'inline-flex', width: size, height: size, color, ...style }} />;
}

/* ---------- Pills / dots ---------- */
function Pill({ kind = 'neutral', children }) {
  return <span className={`pill pill-${kind}`}><span className="dot" />{children}</span>;
}
function Dot({ tone = 'ok', size = 7 }) {
  const bg = tone === 'ok' ? 'hsl(var(--ok))' : tone === 'warn' ? 'hsl(var(--warn))' : tone === 'err' ? 'hsl(var(--err))' : 'hsl(var(--fg-dim))';
  return <span style={{ display: 'inline-block', width: size, height: size, borderRadius: '50%', background: bg, flexShrink: 0 }} />;
}
function OnlineDot({ online }) { return <span className={`online-dot ${online ? 'ok' : 'off'}`} />; }

function statusOf(s) {
  if (!s.online) return { kind: 'neutral', label: 'offline' };
  const top = Math.max(s.cpu, s.mem, s.disk);
  if (top >= 92) return { kind: 'err', label: 'critical' };
  if (top >= 80) return { kind: 'warn', label: 'warn' };
  return { kind: 'ok', label: 'healthy' };
}
function barKind(v) { return v == null ? '' : v >= 92 ? 'err' : v >= 80 ? 'warn' : ''; }

/* ---------- KPI ---------- */
function Kpi({ label, value, sub, tone }) {
  const tc = tone ? { color: `hsl(var(--${tone}))` } : undefined;
  return (
    <div className="kpi">
      <div className="l">{label}</div>
      <div className="v" style={tc}>{value}</div>
      {sub && <div className="s">{sub}</div>}
    </div>
  );
}

/* ---------- Metric bar ---------- */
function MetricBar({ label, value }) {
  const v = value == null ? 0 : Math.min(100, Math.max(0, value));
  return (
    <div className={`mbar ${barKind(value)}`}>
      {label && <span className="k">{label}</span>}
      <span className="track"><i style={{ width: v + '%' }} /></span>
      <span className="v">{value == null ? '\u2014' : Math.round(value) + '%'}</span>
    </div>
  );
}

/* ---------- Sparkline ---------- */
function Sparkline({ values, width = 64, height = 22, color = 'hsl(var(--primary))', strokeWidth = 1.5 }) {
  if (!values || values.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...values), max = Math.max(...values);
  const span = max - min || 1;
  const dx = width / (values.length - 1);
  const pts = values.map((v, i) => `${(i * dx).toFixed(1)},${(height - ((v - min) / span) * height).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" width={width} height={height} aria-hidden="true">
      <polyline fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinejoin="round" strokeLinecap="round" points={pts} />
    </svg>
  );
}

/* ---------- Area chart (host detail) ---------- */
function AreaChart({ series, yMin = 0, yMax, yFormat = (v) => v.toFixed(0), height = 120 }) {
  const ref = useRef(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const measure = () => setW(Math.max(120, Math.round(ref.current.getBoundingClientRect().width)));
    measure();
    const r = new ResizeObserver(measure);
    r.observe(ref.current);
    return () => r.disconnect();
  }, []);
  const colors = ['hsl(var(--primary))', 'hsl(var(--warn))'];
  const allVals = series.flatMap((s) => s.values);
  const max = yMax != null ? yMax : Math.max(...allVals, 1) * 1.1;
  const min = yMin;
  const padL = 34, padR = 4, padT = 6, padB = 16;
  const innerH = height - padT - padB;
  const innerW = Math.max(0, w - padL - padR);
  const xStep = innerW / Math.max(1, (series[0]?.values.length ?? 1) - 1);
  const yPos = (v) => padT + innerH - ((v - min) / (max - min || 1)) * innerH;
  const gridYs = [0.25, 0.5, 0.75, 1].map((p) => padT + innerH * (1 - p));
  return (
    <div ref={ref} style={{ width: '100%', height, overflow: 'hidden' }}>
      {w > 0 && (
        <svg width={w} height={height} style={{ display: 'block' }}>
          {gridYs.map((y, i) => <line key={i} x1={padL} x2={w - padR} y1={y} y2={y} stroke="hsl(var(--border))" strokeDasharray="2 3" />)}
          {[0.25, 0.5, 0.75, 1].map((p, i) => (
            <text key={i} x={padL - 6} y={padT + innerH * (1 - p) + 3} textAnchor="end" fill="hsl(var(--fg-dim))" style={{ fontFamily: 'var(--font-mono)', fontSize: 9.5 }}>{yFormat(min + (max - min) * p)}</text>
          ))}
          {series.map((s, si) => {
            const pts = s.values.map((v, i) => `${(padL + i * xStep).toFixed(1)},${yPos(v).toFixed(1)}`).join(' ');
            const areaPts = `${padL},${padT + innerH} ${pts} ${(padL + (s.values.length - 1) * xStep).toFixed(1)},${padT + innerH}`;
            return (
              <g key={si}>
                <polyline points={areaPts} fill={colors[si % colors.length]} fillOpacity="0.08" stroke="none" />
                <polyline points={pts} fill="none" stroke={colors[si % colors.length]} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}

/* ---------- Switch ---------- */
function Switch({ on, onChange, disabled }) {
  return (
    <button type="button" className={`switch ${on ? 'on' : ''} ${disabled ? 'disabled' : ''}`} onClick={() => !disabled && onChange(!on)} aria-pressed={on}>
      <span className="thumb" />
    </button>
  );
}

/* ---------- Segmented ---------- */
function Segmented({ value, onChange, options }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/* ---------- Card primitives ---------- */
function Card({ children, style }) { return <div className="card" style={style}>{children}</div>; }
function CardHead({ children }) { return <div className="card-head">{children}</div>; }

/* ---------- Country code chip ---------- */
function Cc({ code }) { return code ? <span className="cc">{code}</span> : null; }

/* ---------- Brand tile ---------- */
function BrandTile() { return <span className="hdr-brand-tile">Sh</span>; }

/* ---------- Root header (tab screens) ---------- */
function Header({ title, sub, actions }) {
  return (
    <div className="hdr">
      <div className="hdr-row">
        <h1 className="hdr-title">{title}</h1>
        {actions && <div className="hdr-actions">{actions}</div>}
      </div>
      {sub && <div className="hdr-sub">{sub}</div>}
    </div>
  );
}

/* ---------- Stack navbar (pushed screens) ---------- */
function NavBar({ title, onBack, backLabel = 'Back', actions }) {
  return (
    <div className="navbar" style={{ position: 'relative' }}>
      <button className="navbar-back" onClick={onBack}>
        <Icon name="chevron-left" size={22} />
        <span>{backLabel}</span>
      </button>
      <div className="navbar-title">{title}</div>
      {actions && <div className="navbar-actions">{actions}</div>}
    </div>
  );
}

/* ---------- Bottom tab bar ---------- */
const TABS = [
  { id: 'servers', label: 'Servers', icon: 'server' },
  { id: 'plugins', label: 'Plugins', icon: 'puzzle' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];
function TabBar({ active, onChange }) {
  return (
    <div className="tabbar">
      {TABS.map((t) => (
        <button key={t.id} className={`tab ${active === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>
          <Icon name={t.icon} size={22} />
          <span className="lbl">{t.label}</span>
        </button>
      ))}
    </div>
  );
}

/* ---------- List row ---------- */
function ListRow({ icon, iconColor, title, detail, chevron = true, mono, onClick, right }) {
  return (
    <div className={`lrow ${mono ? 'mono' : ''}`} onClick={onClick}>
      {icon && <span className="lic" style={iconColor ? { color: iconColor } : undefined}><Icon name={icon} size={16} /></span>}
      <span className="ltitle">{title}</span>
      {detail && <span className="ldetail">{detail}</span>}
      {right}
      {chevron && <Icon name="chevron-right" size={16} color="hsl(var(--fg-dim))" />}
    </div>
  );
}

Object.assign(window, {
  Icon, Pill, Dot, OnlineDot, statusOf, barKind, Kpi, MetricBar, Sparkline, AreaChart,
  Switch, Segmented, Card, CardHead, Cc, BrandTile, Header, NavBar, TabBar, ListRow,
});
