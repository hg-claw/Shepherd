// Shepherd Mobile — frozen mock data. Mirrors the live shapes of the repo's
// api/servers, api/scripts, api/plugins, api/files. No network, no drift.
window.SHEP = (() => {
  const servers = [
    { id: 1, name:'srv-iad-01', alias:'iad-01', group:'us-east', os:'linux/amd64', cc:'US', online:true,  cpu:12.4, mem:54.1, disk:41.2, load:0.42, tcp:1284,  rx:1.2e6,  tx:0.8e6,  stage:'installed', lastSeen:'just now' },
    { id: 2, name:'srv-iad-02', alias:'iad-02', group:'us-east', os:'linux/amd64', cc:'US', online:true,  cpu:18.0, mem:60.3, disk:33.8, load:0.78, tcp:1903,  rx:2.8e6,  tx:1.4e6,  stage:'installed', lastSeen:'just now' },
    { id: 3, name:'srv-iad-03', alias:'iad-03', group:'us-east', os:'linux/amd64', cc:'US', online:true,  cpu:86.0, mem:71.5, disk:64.0, load:3.18, tcp:8402,  rx:18.4e6, tx:9.2e6,  stage:'installed', lastSeen:'just now' },
    { id: 4, name:'srv-iad-04', alias:'iad-04', group:'us-east', os:'linux/amd64', cc:'US', online:false, cpu:0,    mem:0,    disk:0,    load:0,    tcp:0,     rx:0,      tx:0,      stage:'installed', lastSeen:'4 min ago' },
    { id: 5, name:'srv-fra-01', alias:'fra-01', group:'eu-central', os:'linux/arm64', cc:'DE', online:true,  cpu:22.1, mem:51.0, disk:38.5, load:0.61, tcp:2114,  rx:3.2e6,  tx:1.9e6,  stage:'installed', lastSeen:'just now' },
    { id: 6, name:'srv-fra-02', alias:'fra-02', group:'eu-central', os:'linux/arm64', cc:'DE', online:true,  cpu:93.4, mem:88.2, disk:71.0, load:5.20, tcp:11254, rx:28.1e6, tx:14.0e6, stage:'installed', lastSeen:'just now' },
    { id: 7, name:'srv-fra-03', alias:'fra-03', group:'eu-central', os:'linux/arm64', cc:'DE', online:true,  cpu:8.2,  mem:42.0, disk:28.1, load:0.18, tcp:624,   rx:0.8e6,  tx:0.4e6,  stage:'installing', lastSeen:'just now' },
    { id: 8, name:'srv-sgp-01', alias:'sgp-01', group:'ap-southeast', os:'linux/amd64', cc:'SG', online:true,  cpu:31.5, mem:67.4, disk:52.0, load:1.42, tcp:3290, rx:5.6e6,  tx:2.4e6,  stage:'installed', lastSeen:'just now' },
    { id: 9, name:'srv-sgp-02', alias:'sgp-02', group:'ap-southeast', os:'linux/amd64', cc:'SG', online:true,  cpu:14.6, mem:49.1, disk:22.3, load:0.32, tcp:1502, rx:1.4e6,  tx:0.9e6,  stage:'installed', lastSeen:'just now' },
    { id:10, name:'srv-sgp-03', alias:'sgp-03', group:'ap-southeast', os:'linux/amd64', cc:'SG', online:false, cpu:0,    mem:0,    disk:0,    load:0,    tcp:0,    rx:0,      tx:0,      stage:'failed',    lastSeen:'2 hr ago' },
    { id:11, name:'srv-syd-01', alias:'syd-01', group:'ap-southeast', os:'darwin/arm64', cc:'AU', online:true,  cpu:6.4, mem:38.2, disk:18.0, load:0.12, tcp:412, rx:0.3e6,  tx:0.2e6,  stage:'installed', lastSeen:'just now' },
    { id:12, name:'srv-iad-05', alias:'iad-05', group:'us-east', os:'linux/amd64', cc:'US', online:true,  cpu:41.0, mem:73.8, disk:58.4, load:1.91, tcp:4982,  rx:7.8e6,  tx:3.4e6,  stage:'installed', lastSeen:'just now' },
    { id:13, name:'srv-iad-06', alias:'iad-06', group:'us-east', os:'linux/amd64', cc:'US', online:true,  cpu:27.3, mem:65.2, disk:49.6, load:1.02, tcp:2611,  rx:4.2e6,  tx:1.8e6,  stage:'installed', lastSeen:'just now' },
    { id:14, name:'srv-fra-04', alias:'fra-04', group:'eu-central', os:'linux/arm64', cc:'DE', online:true,  cpu:11.4, mem:44.0, disk:31.2, load:0.24, tcp:982,  rx:1.1e6,  tx:0.6e6,  stage:'pending',   lastSeen:'just now' },
  ];

  function trace(seed, base, vol, drift = 0) {
    let s = seed; const out = [];
    for (let i = 0; i < 60; i++) {
      s = (s * 9301 + 49297) % 233280;
      const r = (s / 233280) - 0.5;
      out.push(Math.max(0, Math.min(100, base + r * vol + drift * i)));
    }
    return out;
  }
  for (const sv of servers) {
    sv.spark = {
      cpu:  trace(sv.id * 7,  sv.cpu, 18, sv.online ? 0 : -1.5),
      mem:  trace(sv.id * 11, sv.mem, 6),
      net:  trace(sv.id * 13, 40, 30),
      load: trace(sv.id * 17, Math.min(70, sv.load * 12), 12),
    };
    sv.arch = sv.os.split('/')[1] || 'amd64';
    sv.kernel = '6.1';
  }

  // ----- Scripts (parameterized fan-out) -----
  const scripts = [
    { id: 1, name:'apt-upgrade', description:'Update + upgrade all apt packages, autoremove.', params:[
      { name:'reboot', label:'Reboot if required', required:false, default:'no' },
    ]},
    { id: 2, name:'rolling-restart', description:'Gracefully restart a systemd service across hosts.', params:[
      { name:'service', label:'Service name', required:true, default:'nginx' },
      { name:'delay', label:'Delay between hosts (sec)', required:false, default:'5' },
    ]},
    { id: 3, name:'disk-cleanup', description:'Prune logs, docker images, apt cache.', params:[
      { name:'older_than', label:'Older than (days)', required:false, default:'14' },
    ]},
    { id: 4, name:'cert-renew', description:'Renew Let\u2019s Encrypt certs via certbot.', params:[
      { name:'domain', label:'Domain', required:true, default:'' },
    ]},
  ];
  const runs = {
    101: [
      { id:1, server_id:3, server:'srv-iad-03', status:'success', exit_code:0 },
      { id:2, server_id:12, server:'srv-iad-05', status:'success', exit_code:0 },
      { id:3, server_id:13, server:'srv-iad-06', status:'running', exit_code:null },
      { id:4, server_id:6, server:'srv-fra-02', status:'failed',  exit_code:1 },
    ],
  };

  // ----- Plugins -----
  const plugins = [
    { id:'uptime-kuma', icon:'activity', meta:{ name:'Uptime Kuma', category:'Monitoring', description:'Self-hosted uptime monitoring with status pages and multi-channel alerts.', host_aware:true }, enabled:true,  host_count:9 },
    { id:'cloudflared',  icon:'cloud',    meta:{ name:'Cloudflare Tunnel', category:'Networking', description:'Expose local services through a secure outbound-only tunnel.', host_aware:true }, enabled:true,  host_count:4 },
    { id:'netdata',      icon:'gauge',    meta:{ name:'Netdata', category:'Monitoring', description:'Per-second metrics, health alarms, and ML anomaly detection.', host_aware:true }, enabled:false, host_count:0 },
    { id:'borgmatic',    icon:'archive',  meta:{ name:'Borgmatic', category:'Backup', description:'Scheduled, deduplicated, encrypted backups via BorgBackup.', host_aware:true }, enabled:true,  host_count:12 },
    { id:'fail2ban',     icon:'shield',   meta:{ name:'Fail2ban', category:'Security', description:'Ban hosts that show malicious signs \u2014 brute force, scans.', host_aware:true }, enabled:true,  host_count:14 },
    { id:'tailscale',    icon:'network',  meta:{ name:'Tailscale', category:'Networking', description:'Zero-config mesh VPN built on WireGuard.', host_aware:false }, enabled:false, host_count:null },
  ];
  const pluginConfig = {
    'uptime-kuma': [
      { key:'interval', label:'Check interval (sec)', value:'60' },
      { key:'retries', label:'Retries before down', value:'3' },
      { key:'notify_url', label:'Notification webhook', value:'https://hooks.slack.com/\u2026' },
    ],
    'fail2ban': [
      { key:'bantime', label:'Ban time (sec)', value:'3600' },
      { key:'findtime', label:'Find time (sec)', value:'600' },
      { key:'maxretry', label:'Max retries', value:'5' },
    ],
  };

  // ----- File system (per host, rooted at /) -----
  const fs = {
    '/': [
      { name:'etc', is_dir:true, size:0 }, { name:'var', is_dir:true, size:0 },
      { name:'home', is_dir:true, size:0 }, { name:'opt', is_dir:true, size:0 },
      { name:'usr', is_dir:true, size:0 },
      { name:'.bashrc', is_dir:false, size:3771 }, { name:'docker-compose.yml', is_dir:false, size:1658 },
    ],
    '/etc': [
      { name:'nginx', is_dir:true, size:0 }, { name:'systemd', is_dir:true, size:0 },
      { name:'ssh', is_dir:true, size:0 },
      { name:'hostname', is_dir:false, size:11 }, { name:'hosts', is_dir:false, size:221 },
      { name:'os-release', is_dir:false, size:386 },
    ],
    '/etc/nginx': [
      { name:'sites-enabled', is_dir:true, size:0 }, { name:'conf.d', is_dir:true, size:0 },
      { name:'nginx.conf', is_dir:false, size:1482 }, { name:'mime.types', is_dir:false, size:5349 },
    ],
    '/var': [
      { name:'log', is_dir:true, size:0 }, { name:'lib', is_dir:true, size:0 },
      { name:'www', is_dir:true, size:0 },
    ],
    '/var/log': [
      { name:'syslog', is_dir:false, size:184320 }, { name:'auth.log', is_dir:false, size:92160 },
      { name:'nginx', is_dir:true, size:0 }, { name:'dpkg.log', is_dir:false, size:40960 },
    ],
  };
  const fileText = {
    '/.bashrc': '# ~/.bashrc: executed by bash(1) for non-login shells.\ncase $- in\n    *i*) ;;\n      *) return;;\nesac\n\nHISTSIZE=1000\nHISTFILESIZE=2000\nshopt -s histappend\nshopt -s checkwinsize\n\nexport EDITOR=vim\nexport LANG=en_US.UTF-8\n\nalias ll=\'ls -alF\'\nalias la=\'ls -A\'\nalias l=\'ls -CF\'\nalias grep=\'grep --color=auto\'\n\nPS1=\'\\u@\\h:\\w\\$ \'\n\n[ -f ~/.bash_aliases ] && . ~/.bash_aliases\n',
    '/etc/hosts': '127.0.0.1   localhost\n127.0.1.1   srv-iad-03\n\n# The following lines are desirable for IPv6 capable hosts\n::1     localhost ip6-localhost ip6-loopback\nff02::1 ip6-allnodes\nff02::2 ip6-allrouters\n\n10.0.4.13   srv-iad-03\n10.0.4.11   srv-iad-01\n',
    '/etc/hostname': 'srv-iad-03\n',
    '/etc/os-release': 'PRETTY_NAME="Ubuntu 22.04.4 LTS"\nNAME="Ubuntu"\nVERSION_ID="22.04"\nVERSION="22.04.4 LTS (Jammy Jellyfish)"\nID=ubuntu\nID_LIKE=debian\nHOME_URL="https://www.ubuntu.com/"\nSUPPORT_URL="https://help.ubuntu.com/"\n',
    '/etc/nginx/nginx.conf': 'user www-data;\nworker_processes auto;\npid /run/nginx.pid;\n\nevents {\n    worker_connections 768;\n}\n\nhttp {\n    sendfile on;\n    tcp_nopush on;\n    types_hash_max_size 2048;\n    include /etc/nginx/mime.types;\n    default_type application/octet-stream;\n    access_log /var/log/nginx/access.log;\n    error_log /var/log/nginx/error.log;\n    gzip on;\n    include /etc/nginx/conf.d/*.conf;\n    include /etc/nginx/sites-enabled/*;\n}\n',
    '/docker-compose.yml': 'services:\n  shepherd:\n    image: ghcr.io/hg-claw/shepherd:latest\n    restart: unless-stopped\n    ports:\n      - "8080:8080"\n    volumes:\n      - ./data:/data\n    environment:\n      - SHEPHERD_ADMIN_USER=admin\n',
  };

  // ----- Recent activity (audit) -----
  const activity = [
    { ts:'just now',  action:'pty.open',      target:'srv-iad-03', kind:'ok' },
    { ts:'4 min ago', action:'script.run',    target:'12 hosts',   kind:'warn', meta:'rolling-restart' },
    { ts:'12 min ago',action:'apt-upgrade',   target:'14 hosts',   kind:'ok',   meta:'completed' },
    { ts:'38 min ago',action:'file.delete',   target:'srv-fra-02', kind:'err',  meta:'sandbox denied' },
    { ts:'2 hr ago',  action:'server.create', target:'srv-fra-04', kind:'ok' },
  ];

  return { servers, scripts, runs, plugins, pluginConfig, fs, fileText, activity };
})();

// ---- formatters ----
window.fmt = {
  bps(v) {
    if (!v) return '0 b/s';
    if (v >= 1e9) return (v/1e9).toFixed(1) + ' GB/s';
    if (v >= 1e6) return (v/1e6).toFixed(1) + ' MB/s';
    if (v >= 1e3) return (v/1e3).toFixed(0) + ' KB/s';
    return v.toFixed(0) + ' B/s';
  },
  bytes(n) {
    if (n >= 1e6) return (n/1e6).toFixed(1) + ' MB';
    if (n >= 1e3) return (n/1e3).toFixed(1) + ' KB';
    return n + ' B';
  },
  pct(v) { return v == null ? '\u2014' : Math.round(v) + '%'; },
};
