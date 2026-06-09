// Shepherd Mobile — Login, Settings, Lock overlay.
const { useState: useS4 } = React;

function Login({ onLogin, dark }) {
  const [url, setUrl] = useS4('https://fleet.shepherd.app');
  const [user, setUser] = useS4('admin');
  const [pass, setPass] = useS4('');
  const [busy, setBusy] = useS4(false);
  const submit = () => { setBusy(true); setTimeout(() => { setBusy(false); onLogin(); }, 550); };
  return (
    <div className="screen">
      <div className="login-wrap">
        <div className="login-mark">
          <span className="glow" />
          <span className="br">[</span>
          <span className="nm">Shepherd</span>
          <span className="br">]</span>
        </div>
        <div className="sub" style={{ textAlign: 'center', fontSize: 12.5, marginBottom: 8 }}>Self-hosted server fleet manager</div>
        <div className="field">
          <label className="label">Server</label>
          <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} autoCapitalize="none" autoCorrect="off" placeholder="https://your-server" />
        </div>
        <div className="field">
          <label className="label">Username</label>
          <input className="input" value={user} onChange={(e) => setUser(e.target.value)} autoCapitalize="none" autoCorrect="off" placeholder="admin" />
        </div>
        <div className="field">
          <label className="label">Password</label>
          <input className="input" type="password" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="password" />
        </div>
        <button className="btn btn-primary btn-block" style={{ marginTop: 6, opacity: busy ? 0.6 : 1 }} onClick={submit} disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="dim mono" style={{ textAlign: 'center', fontSize: 11, marginTop: 4 }}>token stored in secure enclave · v0.2.1</div>
      </div>
    </div>
  );
}

function Settings({ dark, onToggleTheme, accent, onAccent, lockEnabled, onLockEnabled, onLockNow, onSignOut }) {
  const ACCENTS = [
    { id: 'blue', label: 'Blue', h: 217 },
    { id: 'green', label: 'Green', h: 152 },
    { id: 'violet', label: 'Violet', h: 265 },
    { id: 'amber', label: 'Amber', h: 35 },
  ];
  return (
    <div className="screen">
      <Header title="Settings" sub="admin · fleet.shepherd.app" />
      <div className="screen-body pad tab-inset stack-4">
        <div className="stack-2">
          <div className="section-label" style={{ padding: '2px 2px' }}>Appearance</div>
          <div className="list">
            <div className="lrow">
              <span className="lic"><Icon name={dark ? 'moon' : 'sun'} size={16} /></span>
              <span className="ltitle">Dark mode</span>
              <Switch on={dark} onChange={onToggleTheme} />
            </div>
            <div className="lrow" style={{ alignItems: 'center' }}>
              <span className="lic"><Icon name="palette" size={16} /></span>
              <span className="ltitle">Accent</span>
              <div className="row gap-2">
                {ACCENTS.map((a) => (
                  <button key={a.id} onClick={() => onAccent(a.id)} aria-label={a.label}
                    style={{ width: 26, height: 26, borderRadius: '50%', background: `hsl(${a.h} 85% ${dark ? '62%' : '47%'})`, border: accent === a.id ? '2px solid hsl(var(--foreground))' : '2px solid transparent', boxShadow: accent === a.id ? '0 0 0 2px hsl(var(--bg-elev))' : 'none' }} />
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="stack-2">
          <div className="section-label" style={{ padding: '2px 2px' }}>Security</div>
          <div className="list">
            <div className="lrow">
              <span className="lic"><Icon name="scan-face" size={16} /></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ltitle" style={{ fontSize: 14 }}>Require Face ID</div>
                <div className="sub" style={{ fontSize: 11.5, marginTop: 1 }}>Lock when app is backgrounded</div>
              </div>
              <Switch on={lockEnabled} onChange={onLockEnabled} />
            </div>
            <ListRow icon="lock" title="Lock now" chevron={false} onClick={onLockNow}
              right={<span className="dim" style={{ fontSize: 12 }} />} />
          </div>
        </div>

        <div className="stack-2">
          <div className="section-label" style={{ padding: '2px 2px' }}>Account</div>
          <div className="list">
            <ListRow icon="user" title="Signed in as" detail="admin" chevron={false} />
            <ListRow icon="globe" title="Server" detail="fleet.shepherd.app" chevron={false} mono />
            <div className="lrow" onClick={onSignOut}>
              <span className="lic" style={{ color: 'hsl(var(--err))' }}><Icon name="log-out" size={16} /></span>
              <span className="ltitle" style={{ color: 'hsl(var(--err))' }}>Sign out</span>
            </div>
          </div>
        </div>

        <div className="dim mono" style={{ textAlign: 'center', fontSize: 11 }}>Shepherd mobile · v0.2.1 · build ee8e48f</div>
      </div>
    </div>
  );
}

function Lock({ onUnlock }) {
  return (
    <div className="lock">
      <div className="login-mark">
        <span className="glow" />
        <span className="br">[</span><span className="nm">Shepherd</span><span className="br">]</span>
      </div>
      <div className="ring"><Icon name="scan-face" size={38} /></div>
      <div className="sub" style={{ textAlign: 'center', fontSize: 13 }}>Locked · authenticate to continue</div>
      <button className="btn btn-primary" style={{ minWidth: 200 }} onClick={onUnlock}><Icon name="scan-face" size={16} /> Unlock with Face ID</button>
    </div>
  );
}

Object.assign(window, { Login, Settings, Lock });
