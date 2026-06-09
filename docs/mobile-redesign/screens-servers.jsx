// Shepherd Mobile — Servers list + Server detail.
const { useState: useS1 } = React;

function cmpStr(a, b) { return String(a).localeCompare(String(b)); }

function HostCard({ s, onPress }) {
  const st = statusOf(s);
  return (
    <div className={`host-card ${s.online ? '' : 'offline'}`} onClick={onPress}>
      <div className="host-head">
        <OnlineDot online={s.online} />
        <span className="cc">{s.cc}</span>
        <span className="host-name">{s.alias}</span>
        {s.online ? <Pill kind={st.kind}>{st.label}</Pill> : <span className="host-meta">{s.lastSeen}</span>}
      </div>
      {s.online ? (
        <>
          <div className="host-meta" style={{ marginTop: 6 }}>{s.os} · load {s.load.toFixed(2)}</div>
          <div className="host-bars">
            <MetricBar label="CPU" value={s.cpu} />
            <MetricBar label="MEM" value={s.mem} />
            <MetricBar label="DSK" value={s.disk} />
          </div>
          <div className="host-net">
            <span>↓ {fmt.bps(s.rx)}</span>
            <span>↑ {fmt.bps(s.tx)}</span>
            <span className="ml-auto dim">{s.tcp.toLocaleString()} conns</span>
          </div>
        </>
      ) : (
        <div className="host-meta" style={{ marginTop: 8 }}>agent offline · {s.stage}</div>
      )}
    </div>
  );
}

function ActivityCard() {
  const { activity } = window.SHEP;
  return (
    <Card>
      <CardHead>
        <span className="ttl">Recent activity</span>
        <span className="ml-auto eyebrow">audit log</span>
      </CardHead>
      <div style={{ padding: '4px 0' }}>
        {activity.map((r, i) => (
          <div key={i} className="drow">
            <Dot tone={r.kind} />
            <span className="mono" style={{ fontSize: 12, fontWeight: 500 }}>{r.action}</span>
            <span className="mono sub" style={{ fontSize: 11.5, minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              · {r.target}{r.meta ? <span className="dim"> · {r.meta}</span> : null}
            </span>
            <span className="dim mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{r.ts}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function ServersList({ nav, onToggleTheme, dark }) {
  const { servers } = window.SHEP;
  const total = servers.length;
  const online = servers.filter((s) => s.online);
  const offline = total - online.length;
  const alerts = servers.filter((s) => s.online && Math.max(s.cpu, s.mem, s.disk) >= 80).length;
  const rx = online.reduce((a, s) => a + s.rx, 0);
  const tx = online.reduce((a, s) => a + s.tx, 0);

  const groups = new Map();
  for (const s of servers) {
    const a = groups.get(s.group) ?? [];
    a.push(s); groups.set(s.group, a);
  }
  const ordered = [...groups.entries()].sort(([a], [b]) => cmpStr(a, b));

  return (
    <div className="screen">
      <Header
        title="Servers"
        sub="Fleet at a glance · 30s samples"
        actions={
          <>
            <button className="iconbtn" onClick={onToggleTheme} aria-label="Toggle theme">
              <Icon name={dark ? 'sun' : 'moon'} size={19} />
            </button>
            <button className="iconbtn" aria-label="Add server"><Icon name="plus" size={20} /></button>
          </>
        }
      />
      <div className="screen-body pad tab-inset stack-4">
        <div className="kpi-grid">
          <Kpi label="Nodes" value={total} />
          <Kpi label="Online" value={online.length} tone="ok" />
          <Kpi label="Offline" value={offline} tone={offline > 0 ? 'err' : undefined} />
          <Kpi label="Alerting" value={alerts} tone={alerts > 0 ? 'warn' : undefined} />
        </div>

        <Card>
          <div className="row" style={{ padding: '13px 14px' }}>
            <div className="row gap-2" style={{ flex: 1, minWidth: 0 }}>
              <Icon name="arrow-down" size={15} color="hsl(var(--primary))" />
              <span className="mono" style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap' }}>{fmt.bps(rx)}</span>
              <span className="dim mono" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>in</span>
            </div>
            <div style={{ width: 1, alignSelf: 'stretch', background: 'hsl(var(--border))', margin: '-2px 14px' }} />
            <div className="row gap-2" style={{ flex: 1, minWidth: 0, justifyContent: 'flex-end' }}>
              <Icon name="arrow-up" size={15} color="hsl(var(--muted-foreground))" />
              <span className="mono" style={{ fontSize: 14, fontWeight: 500, whiteSpace: 'nowrap' }}>{fmt.bps(tx)}</span>
              <span className="dim mono" style={{ fontSize: 10.5, whiteSpace: 'nowrap' }}>out</span>
            </div>
          </div>
        </Card>

        {ordered.map(([group, ss]) => {
          const gOnline = ss.filter((s) => s.online).length;
          const sorted = ss.slice().sort((a, b) => (a.online === b.online ? cmpStr(a.alias, b.alias) : a.online ? -1 : 1));
          return (
            <div key={group} className="stack-2">
              <div className="group-head">
                <span className="g">{group}</span>
                <span className="c">{gOnline}/{ss.length} online</span>
              </div>
              {sorted.map((s) => <HostCard key={s.id} s={s} onPress={() => nav.push({ screen: 'server', id: s.id })} />)}
            </div>
          );
        })}

        <ActivityCard />
      </div>
    </div>
  );
}

/* ---------- Server detail ---------- */
function MiniKpi({ label, value, tone }) {
  const tc = tone === 'warn' ? 'hsl(var(--warn))' : tone === 'err' ? 'hsl(var(--err))' : undefined;
  return (
    <div style={{ background: 'hsl(var(--bg-elev))', border: '1px solid hsl(var(--border))', borderRadius: 'var(--radius-lg)', padding: '11px 12px' }}>
      <div className="eyebrow">{label}</div>
      <div className="mono tabular" style={{ fontSize: 22, marginTop: 5, lineHeight: 1, letterSpacing: '-0.01em', color: tc }}>{value}</div>
    </div>
  );
}

function ChartCell({ title, children }) {
  return (
    <div className="chart-cell">
      <div className="ttl">{title}</div>
      {children}
    </div>
  );
}

function ServerDetail({ id, nav }) {
  const { servers } = window.SHEP;
  const s = servers.find((x) => x.id === id);
  const [range, setRange] = useS1('1h');
  if (!s) return <div className="screen"><NavBar title="Not found" onBack={nav.pop} backLabel="Servers" /><div className="empty">Host #{id} not found.</div></div>;

  const st = statusOf(s);
  const rangeLen = range === '1h' ? 60 : range === '24h' ? 96 : 84;
  const resample = (arr, n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * (arr.length - 1);
      const lo = Math.floor(t), hi = Math.ceil(t), f = t - lo;
      out.push(arr[lo] * (1 - f) + arr[hi] * f);
    }
    return out;
  };
  const cpu = resample(s.spark.cpu, rangeLen);
  const mem = resample(s.spark.mem, rangeLen);
  const net = resample(s.spark.net, rangeLen).map((v) => v * 1e5);
  const load = resample(s.spark.load, rangeLen).map((v) => v / 10);

  return (
    <div className="screen">
      <NavBar title={s.alias} onBack={nav.pop} backLabel="Servers"
        actions={<button className="iconbtn" onClick={() => nav.push({ screen: 'console', id: s.id })} aria-label="Console"><Icon name="square-terminal" size={20} /></button>} />
      <div className="screen-body pad stack-inset stack-4">
        <div>
          <div className="row gap-2" style={{ alignItems: 'center' }}>
            <h1 className="page-title mono" style={{ fontSize: 23, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.name}</h1>
          </div>
          <div className="row gap-2" style={{ marginTop: 9, flexWrap: 'wrap' }}>
            <Pill kind={st.kind}>{st.label}</Pill>
            <Pill kind="neutral">{s.group}</Pill>
            <Pill kind="neutral"><Cc code={s.cc} /></Pill>
          </div>
        </div>

        <div className="kpi-grid">
          <MiniKpi label="CPU" value={s.online ? fmt.pct(s.cpu) : '\u2014'} tone={barKind(s.cpu) || undefined} />
          <MiniKpi label="Memory" value={s.online ? fmt.pct(s.mem) : '\u2014'} tone={barKind(s.mem) || undefined} />
          <MiniKpi label="Disk" value={s.online ? fmt.pct(s.disk) : '\u2014'} tone={barKind(s.disk) || undefined} />
          <MiniKpi label="Load 1m" value={s.online ? s.load.toFixed(2) : '\u2014'} />
        </div>

        <Card style={{ overflow: 'hidden' }}>
          <CardHead>
            <span className="ttl">Telemetry</span>
            <div className="ml-auto"><Segmented value={range} onChange={setRange} options={[{ value: '1h', label: '1h' }, { value: '24h', label: '24h' }, { value: '7d', label: '7d' }]} /></div>
          </CardHead>
          {s.online ? (
            <>
              <ChartCell title={`CPU · ${range}`}><AreaChart series={[{ values: cpu }]} yMin={0} yMax={100} yFormat={(v) => `${v.toFixed(0)}%`} /></ChartCell>
              <div style={{ borderTop: '1px solid hsl(var(--border))' }}><ChartCell title={`Memory · ${range}`}><AreaChart series={[{ values: mem }]} yMin={0} yMax={100} yFormat={(v) => `${v.toFixed(0)}%`} /></ChartCell></div>
              <div style={{ borderTop: '1px solid hsl(var(--border))' }}><ChartCell title={`Network · ${range}`}><AreaChart series={[{ values: net }, { values: net.map((v) => v * 0.6) }]} yFormat={(v) => fmt.bps(v)} /></ChartCell></div>
              <div style={{ borderTop: '1px solid hsl(var(--border))' }}><ChartCell title={`Load · ${range}`}><AreaChart series={[{ values: load }]} yFormat={(v) => v.toFixed(2)} /></ChartCell></div>
            </>
          ) : <div className="empty">No telemetry — agent offline since {s.lastSeen}.</div>}
        </Card>

        <Card>
          {[
            ['Net', s.online ? `↓ ${fmt.bps(s.rx)}  ↑ ${fmt.bps(s.tx)}` : '\u2014'],
            ['TCP conns', s.online ? s.tcp.toLocaleString() : '\u2014'],
            ['OS / Arch', `${s.os.split('/')[0]} / ${s.arch}`],
            ['Kernel', s.kernel],
            ['Last seen', s.lastSeen],
          ].map(([k, v], i) => (
            <div key={k} className="drow" style={{ justifyContent: 'space-between' }}>
              <span className="sub" style={{ fontSize: 13 }}>{k}</span>
              <span className="mono tabular" style={{ fontSize: 13 }}>{v}</span>
            </div>
          ))}
        </Card>

        <div className="stack-3">
          <button className="btn btn-primary btn-block" onClick={() => nav.push({ screen: 'console', id: s.id })}>
            <Icon name="square-terminal" size={16} /> Open console
          </button>
          <div className="row gap-3">
            <button className="btn btn-outline btn-block" onClick={() => nav.push({ screen: 'files', id: s.id })}>
              <Icon name="folder-tree" size={16} /> Files
            </button>
            <button className="btn btn-outline btn-block" onClick={() => nav.push({ screen: 'scripts', serverId: s.id })}>
              <Icon name="play" size={16} /> Run script
            </button>
          </div>
        </div>

        <div className="dim mono" style={{ textAlign: 'center', fontSize: 11, padding: '2px 0 8px' }}>
          agent v0.2.0 · sampled every 30s · audit-logged
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { ServersList, ServerDetail });
