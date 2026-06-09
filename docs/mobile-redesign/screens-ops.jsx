// Shepherd Mobile — Console, Files, File preview, Scripts, Run form, Run status.
const { useState: useS2, useRef: useR2, useEffect: useE2 } = React;

/* ---------- Console (faux PTY) ---------- */
const CONSOLE_SEED = (host) => [
  { t: 'out', v: `Shepherd PTY · ${host} · agent v0.2.0` },
  { t: 'out', v: 'Last login: Mon Jun  9 09:38:02 2026 from 10.0.0.2' },
  { t: 'cmd', v: 'uname -a' },
  { t: 'out', v: 'Linux ' + host + ' 6.1.0-21-amd64 #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux' },
  { t: 'cmd', v: 'systemctl is-active nginx' },
  { t: 'out', v: 'active' },
  { t: 'cmd', v: 'df -h /' },
  { t: 'out', v: 'Filesystem      Size  Used Avail Use% Mounted on' },
  { t: 'out', v: '/dev/sda1       78G   49G   29G  64% /' },
];
const CANNED = {
  ls: 'bin   etc   home  lib   opt   root  srv   usr   var',
  whoami: 'root',
  uptime: ' 09:41:12 up 14 days,  3:22,  1 user,  load average: 0.42, 0.51, 0.48',
  'free -h': '               total        used        free      shared\nMem:            31Gi        18Gi        4.2Gi       1.1Gi\nSwap:          2.0Gi       128Mi       1.9Gi',
};

function Console({ id, nav }) {
  const { servers } = window.SHEP;
  const host = servers.find((s) => s.id === id)?.alias ?? 'host';
  const [lines, setLines] = useS2(() => CONSOLE_SEED(host));
  const [cmd, setCmd] = useS2('');
  const [status] = useS2('connected');
  const bodyRef = useR2(null);
  const inputRef = useR2(null);
  useE2(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [lines]);

  const submit = () => {
    const c = cmd.trim();
    const next = [...lines, { t: 'cmd', v: cmd }];
    if (c) {
      const key = Object.keys(CANNED).find((k) => k === c);
      next.push({ t: 'out', v: key ? CANNED[key] : `${c.split(' ')[0]}: command shown in demo console` });
    }
    setLines(next);
    setCmd('');
  };

  const KEYS = ['Esc', 'Tab', '^C', '^D', '^Z', '↑', '↓', '←', '→'];

  return (
    <div className="screen">
      <NavBar title={`console · ${host}`} onBack={() => nav.pop()} backLabel="Host"
        actions={<button className="iconbtn" aria-label="Reconnect" onClick={() => setLines(CONSOLE_SEED(host))}><Icon name="rotate-cw" size={18} /></button>} />
      <div className="statline">
        <Pill kind={status === 'connected' ? 'ok' : 'warn'}>{status}</Pill>
        <span className="dim" style={{ fontSize: 11 }}>24×80 · UTF-8</span>
        <span className="ml-auto sub" onClick={() => nav.pop()} style={{ fontSize: 12 }}>Close</span>
      </div>
      <div className="term" ref={bodyRef} onClick={() => inputRef.current?.focus()}>
        {lines.map((l, i) => (
          l.t === 'cmd'
            ? <div key={i}><span className="pmt">root@{host}</span><span className="pmt2">:~# </span><span className="cmd">{l.v}</span></div>
            : <div key={i} className="out">{l.v}</div>
        ))}
        <div style={{ display: 'flex', alignItems: 'baseline' }}>
          <span className="pmt">root@{host}</span><span className="pmt2">:~# </span>
          <span className="cmd">{cmd}</span><span className="term-cursor" />
        </div>
        <input
          ref={inputRef} value={cmd} onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          autoCapitalize="none" autoCorrect="off" spellCheck="false"
          style={{ position: 'absolute', opacity: 0, height: 1, width: 1, pointerEvents: 'none' }}
        />
      </div>
      <div className="keybar">
        {KEYS.map((k) => (
          <button key={k} className="key" onClick={() => { if (k === 'Tab') setCmd((c) => c + '\t'); inputRef.current?.focus(); }}>{k}</button>
        ))}
      </div>
    </div>
  );
}

/* ---------- Files browser ---------- */
function joinPath(base, name) { return base === '/' ? '/' + name : base + '/' + name; }
function parentPath(p) { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); }
function crumbs(p) {
  const parts = p.split('/').filter(Boolean);
  const out = [{ label: '/', path: '/' }];
  let acc = '';
  for (const part of parts) { acc += '/' + part; out.push({ label: part, path: acc }); }
  return out;
}

function Files({ id, nav }) {
  const { fs } = window.SHEP;
  const { servers } = window.SHEP;
  const host = servers.find((s) => s.id === id)?.alias ?? 'host';
  const [path, setPath] = useS2('/');
  const entries = (fs[path] ?? []).slice().sort((a, b) => (a.is_dir === b.is_dir ? a.name.localeCompare(b.name) : a.is_dir ? -1 : 1));
  const cr = crumbs(path);

  return (
    <div className="screen">
      <NavBar title={`files · ${host}`} onBack={() => nav.pop()} backLabel="Host" />
      <div className="crumbs">
        {cr.map((c, i) => (
          <span key={i}>
            <span className={`cr ${i === cr.length - 1 ? 'cur' : ''}`} onClick={() => setPath(c.path)}>{c.label === '/' ? '/' : c.label}</span>
            {i < cr.length - 1 && i > 0 ? <span className="dim">/</span> : null}
          </span>
        ))}
      </div>
      <div className="screen-body stack-inset">
        <div className="list" style={{ margin: 14, borderRadius: 'var(--radius-lg)' }}>
          {path !== '/' && (
            <div className="lrow mono" onClick={() => setPath(parentPath(path))}>
              <span className="lic"><Icon name="corner-left-up" size={16} /></span>
              <span className="ltitle">..</span>
            </div>
          )}
          {entries.map((e) => (
            <div key={e.name} className="lrow mono" onClick={() => e.is_dir ? setPath(joinPath(path, e.name)) : nav.push({ screen: 'preview', id, path: joinPath(path, e.name) })}>
              <span className="lic" style={{ color: e.is_dir ? 'hsl(var(--primary))' : 'hsl(var(--muted-foreground))' }}>
                <Icon name={e.is_dir ? 'folder' : 'file'} size={16} />
              </span>
              <span className="ltitle" style={{ color: e.is_dir ? 'hsl(var(--primary))' : undefined }}>{e.is_dir ? e.name + '/' : e.name}</span>
              {!e.is_dir && <span className="ldetail">{fmt.bytes(e.size)}</span>}
              {e.is_dir && <Icon name="chevron-right" size={16} color="hsl(var(--fg-dim))" />}
            </div>
          ))}
          {entries.length === 0 && <div className="empty">Empty directory.</div>}
        </div>
        <div className="dim mono" style={{ textAlign: 'center', fontSize: 11, paddingBottom: 12 }}>read-only · every action audit-logged</div>
      </div>
    </div>
  );
}

/* ---------- File preview ---------- */
function FilePreview({ id, path, nav }) {
  const { fileText } = window.SHEP;
  const text = fileText[path];
  const name = path.split('/').pop();
  return (
    <div className="screen">
      <NavBar title={name} onBack={() => nav.pop()} backLabel="Files" />
      <div className="screen-body pad stack-inset stack-3">
        <div className="row gap-2" style={{ justifyContent: 'space-between' }}>
          <span className="mono dim" style={{ fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{path}</span>
          <Pill kind="neutral">read-only</Pill>
        </div>
        {text != null
          ? <pre className="codeblock">{text}</pre>
          : <div className="empty">Binary file — preview unavailable.</div>}
      </div>
    </div>
  );
}

/* ---------- Scripts list ---------- */
function Scripts({ serverId, nav }) {
  const { scripts, servers } = window.SHEP;
  const host = servers.find((s) => s.id === serverId)?.alias;
  return (
    <div className="screen">
      <NavBar title="Scripts" onBack={() => nav.pop()} backLabel={host ? 'Host' : 'Back'} />
      <div className="screen-body pad stack-inset stack-3">
        {host && <div className="sub" style={{ fontSize: 12.5 }}>Target: <span className="mono">{host}</span></div>}
        <div className="list">
          {scripts.map((s) => (
            <div key={s.id} className="lrow" onClick={() => nav.push({ screen: 'runform', id: s.id, serverId })}>
              <span className="lic"><Icon name="scroll-text" size={16} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 14, fontWeight: 500 }}>{s.name}</div>
                <div className="sub" style={{ fontSize: 12, marginTop: 2 }}>{s.description}</div>
              </div>
              <Icon name="chevron-right" size={16} color="hsl(var(--fg-dim))" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------- Run form ---------- */
function RunForm({ id, serverId, nav }) {
  const { scripts, servers } = window.SHEP;
  const script = scripts.find((s) => s.id === id);
  const host = servers.find((s) => s.id === serverId)?.alias;
  const [overrides, setOverrides] = useS2({});
  const [error, setError] = useS2(null);
  if (!script) return <div className="screen"><NavBar title="Run script" onBack={nav.pop} /><div className="empty">Script not found.</div></div>;

  const valueFor = (p) => overrides[p.name] ?? p.default ?? '';
  const run = () => {
    const missing = script.params.filter((p) => p.required && !valueFor(p).trim());
    if (missing.length) { setError(`Required: ${missing.map((p) => p.label ?? p.name).join(', ')}`); return; }
    nav.push({ screen: 'runstatus', runId: 101, script: script.name });
  };

  return (
    <div className="screen">
      <NavBar title="Run script" onBack={() => nav.pop()} backLabel="Scripts" />
      <div className="screen-body pad stack-inset stack-4">
        <div>
          <h1 className="page-title mono" style={{ fontSize: 22 }}>{script.name}</h1>
          <div className="page-sub">{script.description}</div>
          <div className="row gap-2" style={{ marginTop: 10 }}>
            <Pill kind="neutral"><Icon name="target" size={11} />&nbsp;{host ?? 'fan-out'}</Pill>
            <Pill kind="neutral">{script.params.length} params</Pill>
          </div>
        </div>
        <div className="stack-4">
          {script.params.map((p) => (
            <div key={p.name} className="field">
              <label className="label">{p.label ?? p.name}{p.required ? <span className="req"> *</span> : null}</label>
              <input className="input mono" placeholder={p.name} value={valueFor(p)} autoCapitalize="none" autoCorrect="off"
                onChange={(e) => setOverrides((o) => ({ ...o, [p.name]: e.target.value }))} />
            </div>
          ))}
        </div>
        {error && <div className="err-line">{error}</div>}
        <button className="btn btn-primary btn-block" onClick={run}><Icon name="play" size={16} /> Run on {host ?? 'fleet'}</button>
      </div>
    </div>
  );
}

/* ---------- Run status ---------- */
function RunStatus({ runId, script, nav }) {
  const { runs } = window.SHEP;
  const tasks = runs[runId] ?? [];
  const done = tasks.filter((t) => t.status === 'success' || t.status === 'failed').length;
  return (
    <div className="screen">
      <NavBar title={`run #${runId}`} onBack={() => nav.popTo('servers')} backLabel="Run" />
      <div className="screen-body pad stack-inset stack-4">
        <div>
          <h1 className="page-title mono" style={{ fontSize: 22 }}>{script ?? 'script'}</h1>
          <div className="page-sub">run #{runId} · {done}/{tasks.length} hosts complete</div>
        </div>
        <Card>
          {tasks.map((t) => {
            const kind = t.status === 'failed' || t.status === 'error' ? 'err' : t.status === 'running' ? 'warn' : 'ok';
            return (
              <div key={t.id} className="drow" style={{ justifyContent: 'space-between' }}>
                <span className="mono" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>{t.server}</span>
                <div className="row gap-2" style={{ flexShrink: 0 }}>
                  <Pill kind={kind}>{t.status}</Pill>
                  {t.exit_code != null && <span className="dim mono" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>exit {t.exit_code}</span>}
                </div>
              </div>
            );
          })}
        </Card>
        <div className="dim mono" style={{ textAlign: 'center', fontSize: 11 }}>streaming · refreshes as agents report</div>
      </div>
    </div>
  );
}

Object.assign(window, { Console, Files, FilePreview, Scripts, RunForm, RunStatus });
