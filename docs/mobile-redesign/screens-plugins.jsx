// Shepherd Mobile — Plugins list, detail, config, hosts.
const { useState: useS3 } = React;

function Plugins({ nav, onToggleTheme, dark }) {
  const { plugins } = window.SHEP;
  const [state, setState] = useS3(() => Object.fromEntries(plugins.map((p) => [p.id, p.enabled])));
  const enabledCount = Object.values(state).filter(Boolean).length;

  const cats = new Map();
  for (const p of plugins) { const a = cats.get(p.meta.category) ?? []; a.push(p); cats.set(p.meta.category, a); }
  const ordered = [...cats.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="screen">
      <Header title="Plugins" sub={`${enabledCount} of ${plugins.length} enabled`}
        actions={<button className="iconbtn" onClick={onToggleTheme} aria-label="Toggle theme"><Icon name={dark ? 'sun' : 'moon'} size={19} /></button>} />
      <div className="screen-body pad tab-inset stack-4">
        {ordered.map(([cat, ps]) => (
          <div key={cat} className="stack-2">
            <div className="section-label" style={{ padding: '2px 2px' }}>{cat}</div>
            <div className="list">
              {ps.map((p) => (
                <div key={p.id} className="lrow" onClick={() => nav.push({ screen: 'plugin', id: p.id })}>
                  <span className="lic" style={{ color: 'hsl(var(--primary))' }}><Icon name={p.icon} size={17} /></span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{p.meta.name}</div>
                    <div className="sub mono" style={{ fontSize: 11.5, marginTop: 1 }}>{p.meta.host_aware && state[p.id] && p.host_count ? `${p.host_count} hosts` : p.meta.category.toLowerCase()}</div>
                  </div>
                  <div onClick={(e) => e.stopPropagation()}>
                    <Switch on={state[p.id]} onChange={(v) => setState((s) => ({ ...s, [p.id]: v }))} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PluginDetail({ id, nav }) {
  const { plugins } = window.SHEP;
  const p = plugins.find((x) => x.id === id);
  const [on, setOn] = useS3(p?.enabled ?? false);
  if (!p) return <div className="screen"><NavBar title="Plugin" onBack={nav.pop} backLabel="Plugins" /><div className="empty">Plugin not found.</div></div>;

  return (
    <div className="screen">
      <NavBar title={p.meta.name} onBack={() => nav.pop()} backLabel="Plugins" />
      <div className="screen-body pad stack-inset stack-4">
        <div className="row gap-3" style={{ alignItems: 'flex-start' }}>
          <span className="lic" style={{ width: 46, height: 46, borderRadius: 12, color: 'hsl(var(--primary))', flexShrink: 0 }}><Icon name={p.icon} size={24} /></span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 className="page-title" style={{ fontSize: 22 }}>{p.meta.name}</h1>
            <div className="row gap-2" style={{ marginTop: 6 }}>
              <Pill kind={on ? 'ok' : 'neutral'}>{on ? 'enabled' : 'disabled'}</Pill>
              <Pill kind="neutral">{p.meta.category}</Pill>
            </div>
          </div>
        </div>
        <p className="sub" style={{ fontSize: 13.5, margin: 0, lineHeight: 1.5 }}>{p.meta.description}</p>

        <div className="list">
          <div className="lrow">
            <span className="ltitle">Enabled</span>
            <Switch on={on} onChange={setOn} />
          </div>
          <ListRow icon="sliders-horizontal" title="Edit config" onClick={() => nav.push({ screen: 'pluginconfig', id: p.id })} />
          {p.meta.host_aware && (
            <ListRow icon="server" title="Hosts" detail={p.host_count != null ? String(p.host_count) : ''} onClick={() => nav.push({ screen: 'pluginhosts', id: p.id })} />
          )}
        </div>
        <div className="dim mono" style={{ textAlign: 'center', fontSize: 11 }}>plugin id · {p.id}</div>
      </div>
    </div>
  );
}

function PluginConfig({ id, nav }) {
  const { plugins, pluginConfig } = window.SHEP;
  const p = plugins.find((x) => x.id === id);
  const fields = pluginConfig[id] ?? [];
  const [vals, setVals] = useS3(() => Object.fromEntries(fields.map((f) => [f.key, f.value])));
  return (
    <div className="screen">
      <NavBar title="Config" onBack={() => nav.pop()} backLabel={p?.meta.name ?? 'Plugin'} />
      <div className="screen-body pad stack-inset stack-4">
        <div>
          <h1 className="page-title" style={{ fontSize: 22 }}>{p?.meta.name} config</h1>
          <div className="page-sub mono">{id}.yml</div>
        </div>
        {fields.length === 0
          ? <div className="empty">No editable config for this plugin.</div>
          : <div className="stack-4">
              {fields.map((f) => (
                <div key={f.key} className="field">
                  <label className="label mono" style={{ fontFamily: 'var(--font-mono)' }}>{f.label}</label>
                  <input className="input mono" value={vals[f.key]} autoCapitalize="none" autoCorrect="off"
                    onChange={(e) => setVals((v) => ({ ...v, [f.key]: e.target.value }))} />
                </div>
              ))}
            </div>}
        {fields.length > 0 && <button className="btn btn-primary btn-block" onClick={() => nav.pop()}><Icon name="check" size={16} /> Save config</button>}
      </div>
    </div>
  );
}

function PluginHosts({ id, nav }) {
  const { plugins, servers } = window.SHEP;
  const p = plugins.find((x) => x.id === id);
  // deterministic subset of online hosts
  const online = servers.filter((s) => s.online);
  const count = Math.min(p?.host_count ?? 0, online.length);
  const hosts = online.slice(0, count);
  const [state, setState] = useS3(() => Object.fromEntries(hosts.map((h) => [h.id, true])));
  return (
    <div className="screen">
      <NavBar title="Hosts" onBack={() => nav.pop()} backLabel={p?.meta.name ?? 'Plugin'} />
      <div className="screen-body pad stack-inset stack-3">
        <div className="sub" style={{ fontSize: 12.5 }}>Hosts running <span className="mono">{p?.meta.name}</span></div>
        <div className="list">
          {hosts.map((h) => (
            <div key={h.id} className="lrow mono">
              <OnlineDot online={h.online} />
              <span className="ltitle" style={{ fontFamily: 'var(--font-mono)' }}>{h.alias}</span>
              <span className="ldetail">{h.group}</span>
              <div onClick={(e) => e.stopPropagation()}><Switch on={state[h.id]} onChange={(v) => setState((s) => ({ ...s, [h.id]: v }))} /></div>
            </div>
          ))}
          {hosts.length === 0 && <div className="empty">Not deployed to any host yet.</div>}
        </div>
      </div>
    </div>
  );
}

Object.assign(window, { Plugins, PluginDetail, PluginConfig, PluginHosts });
