// TERMINAL_HTML is a self-contained xterm.js host. RN drives it via document
// 'message' events ({type:'data'|'fit'}) and receives postMessage payloads
// ({type:'input'|'resize'|'ready'}). xterm is loaded from a CDN (the app needs
// network to reach the server anyway).
export const TERMINAL_HTML = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<style>html,body,#t{height:100%;width:100%;margin:0;background:#0a0a0b}</style></head>
<body><div id="t"></div><script>
var post=function(o){if(window.ReactNativeWebView)window.ReactNativeWebView.postMessage(JSON.stringify(o))};
function fail(msg){document.getElementById('t').innerHTML='<div style="color:#f08a8a;font-family:monospace;font-size:12px;padding:12px;white-space:pre-wrap">'+msg+'</div>';}
if(!window.Terminal||!window.FitAddon){
  fail('Failed to load terminal assets (xterm).\\nThe device must be able to reach cdn.jsdelivr.net.');
}else{
try{
var term=new window.Terminal({fontSize:13,convertEol:false,cursorBlink:true,theme:{background:'#0a0a0b'}});
var fit=new window.FitAddon.FitAddon();term.loadAddon(fit);
term.open(document.getElementById('t'));term.focus();
function doFit(){try{fit.fit();post({type:'resize',rows:term.rows,cols:term.cols})}catch(e){}}
term.onData(function(d){
  var b=[];for(var i=0;i<d.length;i++)b.push(d.charCodeAt(i)&255);
  post({type:'input',b64:btoa(String.fromCharCode.apply(null,b))});
});
function onMsg(ev){
  var m;try{m=JSON.parse(ev.data)}catch(e){return}
  if(m.type==='data'){var s=atob(m.b64);var u=new Uint8Array(s.length);for(var j=0;j<s.length;j++)u[j]=s.charCodeAt(j)&255;term.write(u)}
  else if(m.type==='fit'){doFit()}
}
document.addEventListener('message',onMsg);window.addEventListener('message',onMsg);
window.addEventListener('resize',doFit);
// Copy: the current xterm selection, else the whole scrollback buffer.
window.__shepCopy=function(){
  var txt=(term.getSelection&&term.getSelection())||'';
  if(!txt){var b=term.buffer.active,ls=[];for(var i=0;i<b.length;i++){var ln=b.getLine(i);if(ln)ls.push(ln.translateToString(true));}txt=ls.join('\\n').replace(/[ \\n]+$/,'');}
  post({type:'copy',text:txt});
};
setTimeout(function(){doFit();post({type:'ready'})},50);
}catch(e){fail('Terminal init error: '+e.message);}
}
</script></body></html>`
