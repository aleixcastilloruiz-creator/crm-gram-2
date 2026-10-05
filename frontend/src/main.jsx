import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const SECTIONS = [
  ['mensajes','Mensajes','💬','Conversaciones'],
  ['mensajes-pro','Mensajes Pro','⭐','Bandeja multi-cuenta'],
  ['canales-free','Canales free','📣','Canales y difusión'],
  ['sfs','SFS','🔄','Seguimiento'],
  ['guiones','Guiones','📝','Scripts y respuestas'],
  ['programar-posts','Programar posts','🗓️','Publicaciones'],
  ['reenviador','Reenviador','📤','Campañas y envíos'],
  ['detector-pagos','Detector de pagos','🛡️','Reglas y alertas'],
  ['whatsapp','Conectar WhatsApp','📱','WhatsApp'],
  ['pagos','Pagos','💳','Cobros'],
  ['informes','Informes','📊','Métricas'],
  ['configuracion','Configuración','⚙️','Ajustes'],
];

function loadLegacyAssets(){
  if(!document.getElementById('legacy-style')){
    const a=document.createElement('link'); a.id='legacy-style'; a.rel='stylesheet'; a.href='/legacy/style.css'; document.head.appendChild(a);
  }
  if(!document.getElementById('legacy-modern-style')){
    const b=document.createElement('link'); b.id='legacy-modern-style'; b.rel='stylesheet'; b.href='/legacy/modern.css'; document.head.appendChild(b);
  }
}

function loadLegacy(){
  loadLegacyAssets();
  return new Promise((resolve,reject)=>{
    if(window.__lureqoLegacyLoaded){ resolve(); return; }
    const existing=document.getElementById('legacy-app-script');
    if(existing){ existing.addEventListener('load',resolve,{once:true}); existing.addEventListener('error',reject,{once:true}); return; }
    const s=document.createElement('script'); s.id='legacy-app-script'; s.src='/legacy/app.js'; s.defer=true;
    s.onload=()=>{window.__lureqoLegacyLoaded=true; resolve()}; s.onerror=reject; document.body.appendChild(s);
  });
}

function App(){
  const [started,setStarted]=useState(false);
  const [open,setOpen]=useState(false);
  const [selected,setSelected]=useState('reenviador');
  const [ready,setReady]=useState(false);
  const [error,setError]=useState('');

  const launch = async (id)=>{
    setSelected(id); setOpen(false);
    if(!started) setStarted(true);
    try{
      await loadLegacy();
      setReady(true);
      if(id==='mensajes-pro'){
        window.open('/mensajes-pro','_blank','noopener');
        return;
      }
      if(typeof window.goToView==='function') window.goToView(id);
      else window.dispatchEvent(new CustomEvent('lureqo:navigate',{detail:{id}}));
    }catch(e){setError('No se pudo cargar el CRM: '+(e?.message||e));}
  };

  useEffect(()=>{
    if(started){
      loadLegacy().then(()=>setReady(true)).catch(e=>setError('No se pudo cargar el CRM: '+e.message));
    }
  },[started]);

  if(!started) return <Landing onStart={()=>launch('reenviador')}/>;

  return <div className="new-shell">
    <header className="new-topbar">
      <button className="hamburger" onClick={()=>setOpen(v=>!v)} aria-label="Abrir menú">☰</button>
      <div className="new-brand"><span className="brand-mark">L</span><span><b>LUREQO</b><em>CRM</em></span></div>
      <div className="top-status"><i/> Sistema operativo</div>
    </header>
    <aside className={'new-sidebar '+(open?'is-open':'')}>
      <div className="sidebar-head"><div className="brand-mark">L</div><div><b>LUREQO CRM</b><small>Workspace</small></div><button onClick={()=>setOpen(false)}>×</button></div>
      <nav className="module-nav">
        <div className="nav-caption">MÓDULOS</div>
        {SECTIONS.map(([id,label,icon,desc])=><button key={id} className={'module '+(selected===id?'active':'')} onClick={()=>launch(id)}><span className="module-icon">{icon}</span><span className="module-copy"><b>{label}</b><small>{desc}</small></span></button>)}
      </nav>
      <div className="sidebar-foot">Motor y datos <strong>protegidos</strong></div>
    </aside>
    {open&&<div className="nav-backdrop" onClick={()=>setOpen(false)}/>} 
    <main className="new-content">
      {!ready&&<div className="module-boot"><div className="spinner"/><b>Preparando módulo…</b><span>Conservando todas las funciones existentes</span></div>}
      {error&&<div className="error-card">{error}</div>}
      <div className="legacy-runtime" aria-hidden={!ready}>
        <div className="legacy-mobile-topbar" id="legacyMobileTopbar"><button id="mobileNavToggle" type="button">☰</button><img id="mobileTopbarLogo" className="hidden" alt=""/><span id="mobileTopbarTitle"/></div>
        <div id="mobileNavBackdrop" className="legacy-mobile-backdrop"/>
        <div className="shell legacy-shell">
          <aside className="sidebar"><div className="brand" id="brandBlock"><img id="brandLogo" src="" alt="" className="hidden"/><div className="brand-text" id="brandText"/></div><nav id="sidenav"/></aside>
          <div className="workspace"><div className="reenviador-layout"><aside className="account-list" id="accountList"/><main id="app"><div className="legacy-wait"><div className="spinner"/>Cargando módulo…</div></main></div></div>
        </div>
        <div id="toast" className="toast hidden"/>
      </div>
    </main>
  </div>;
}

function Landing({onStart}){return <div className="landing"><div className="landing-card"><div className="hero-mark">L</div><div className="eyebrow">LUREQO / CRM</div><h1>Tu operación,<br/><span>en un solo lugar.</span></h1><p>Una interfaz nueva sobre el motor actual del CRM, manteniendo Telegram, campañas, mensajes, pagos, WhatsApp y el resto de tus módulos.</p><button onClick={onStart}>Entrar al CRM <span>→</span></button><div className="landing-meta"><span>● Backend conectado</span><span>● Datos preservados</span></div></div></div>}

createRoot(document.getElementById('root')).render(<App/>);
