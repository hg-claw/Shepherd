// Shepherd Mobile — app shell: navigator (tabs + stack), theme, tweaks, device frame.
const { useState: useA, useEffect: useAE } = React;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "dark": true,
  "accent": "blue",
  "density": "regular"
}/*EDITMODE-END*/;

function accentVars(accent, dark) {
  const map = { green: 152, violet: 265, amber: 35 };
  if (!(accent in map)) return {};
  const h = map[accent];
  const L = dark ? '64%' : '47%';
  const v = `${h} 80% ${L}`;
  return { '--primary': v, '--ring': v, '--glow-primary': v };
}

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const dark = !!t.dark;

  const [authed, setAuthed] = useA(false);
  const [locked, setLocked] = useA(false);
  const [lockEnabled, setLockEnabled] = useA(true);
  const [tab, setTab] = useA('servers');
  const [stack, setStack] = useA([]);

  const nav = {
    push: (s) => setStack((st) => [...st, s]),
    pop: () => setStack((st) => st.slice(0, -1)),
    popTo: (tabId) => { setStack([]); if (tabId) setTab(tabId); },
  };
  const switchTab = (id) => { setStack([]); setTab(id); };

  // re-render lucide icons after each screen change (covers freshly-mounted nodes)
  useAE(() => { if (window.lucide) window.lucide.createIcons({ attrs: { 'stroke-width': 1.6 } }); });

  const top = stack[stack.length - 1] || null;

  const renderTabRoot = () => {
    if (tab === 'plugins') return <Plugins nav={nav} dark={dark} onToggleTheme={() => setTweak('dark', !dark)} />;
    if (tab === 'settings') return (
      <Settings
        dark={dark} onToggleTheme={() => setTweak('dark', !dark)}
        accent={t.accent} onAccent={(a) => setTweak('accent', a)}
        lockEnabled={lockEnabled} onLockEnabled={setLockEnabled}
        onLockNow={() => lockEnabled && setLocked(true)}
        onSignOut={() => { setAuthed(false); setStack([]); setTab('servers'); }}
      />
    );
    return <ServersList nav={nav} dark={dark} onToggleTheme={() => setTweak('dark', !dark)} />;
  };

  const renderStack = (s) => {
    switch (s.screen) {
      case 'server': return <ServerDetail id={s.id} nav={nav} />;
      case 'console': return <Console id={s.id} nav={nav} />;
      case 'files': return <Files id={s.id} nav={nav} />;
      case 'preview': return <FilePreview id={s.id} path={s.path} nav={nav} />;
      case 'scripts': return <Scripts serverId={s.serverId} nav={nav} />;
      case 'runform': return <RunForm id={s.id} serverId={s.serverId} nav={nav} />;
      case 'runstatus': return <RunStatus runId={s.runId} script={s.script} nav={nav} />;
      case 'plugin': return <PluginDetail id={s.id} nav={nav} />;
      case 'pluginconfig': return <PluginConfig id={s.id} nav={nav} />;
      case 'pluginhosts': return <PluginHosts id={s.id} nav={nav} />;
      default: return null;
    }
  };

  const appStyle = { ...accentVars(t.accent, dark) };

  return (
    <>
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, background: dark ? '#161617' : '#e9e8e4' }}>
        <IOSDevice dark={dark}>
          <div className={`shep-app ${dark ? 'dark' : ''}`} data-density={t.density} style={appStyle}>
            {!authed
              ? <Login onLogin={() => setAuthed(true)} dark={dark} />
              : (
                <>
                  {top ? renderStack(top) : renderTabRoot()}
                  {!top && <TabBar active={tab} onChange={switchTab} />}
                  {locked && lockEnabled && <Lock onUnlock={() => setLocked(false)} />}
                </>
              )}
          </div>
        </IOSDevice>
      </div>

      <TweaksPanel>
        <TweakSection label="Theme" />
        <TweakToggle label="Dark mode" value={t.dark} onChange={(v) => setTweak('dark', v)} />
        <TweakRadio label="Accent" value={t.accent} options={['blue', 'green', 'violet', 'amber']} onChange={(v) => setTweak('accent', v)} />
        <TweakSection label="Layout" />
        <TweakRadio label="Density" value={t.density} options={['compact', 'regular', 'comfy']} onChange={(v) => setTweak('density', v)} />
      </TweaksPanel>
    </>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
