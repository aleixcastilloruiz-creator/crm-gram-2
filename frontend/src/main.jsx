import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import './styles.css';

const modules=[
 ['dashboard','Dashboard','Resumen y actividad','⌂'],
 ['messages','Mensajes','Conversaciones y chats','✉'],
 ['messages-pro','Mensajes Pro','Gestión avanzada de mensajes','✦'],
 ['forwarder','Reenviador','Campañas y automatizaciones','↗'],
 ['accounts','Cuentas Telegram','Cuentas conectadas','◎'],
 ['campaigns','Campañas','Fuentes, carpetas y campañas','▣'],
 ['schedules','Horarios','Envíos programados','◷'],
 ['content','Contenido','Biblioteca de contenido','□'],
 ['scheduled','Posts programados','Publicaciones automáticas','◫'],
 ['reports','Informes','Rendimiento y actividad','▥'],
 ['payments','Pagos','Control y detección de pagos','€'],
 ['whatsapp','WhatsApp','Conexiones y mensajes','◉'],
 ['team','Equipo','Usuarios y permisos','♙'],
 ['scripts','Guiones','Guiones y categorías','≡'],
 ['settings','Configuración','Preferencias del CRM','⚙']
];

function App(){
 const [open,setOpen]=useState(false),[active,setActive]=useState('dashboard'),[loading,setLoading]=useState(false);
 const [health,setHealth]=useState('checking');
 useEffect(()=>{fetch('/health',{credentials:'include'}).then(r=>r.ok?setHealth('online'):setHealth('error')).catch(()=>setHealth('error'))},[]);
 const openLegacy=(name)=>{setActive(name);setOpen(false);setLoading(true)};
 const logout=()=>{fetch('/api/auth/logout',{method:'POST',credentials:'include'}).finally(()=>location.reload())};
 return <div className="app-shell">
  <header className="mobile-head"><button onClick={()=>setOpen(!open)}>☰</button><div className="logo">LUREQO<span>CRM</span></div><div className={'dot '+health}></div></header>
  <aside className={'sidebar '+(open?'open':'')}><div className="brand"><div className="mark">L</div><div><strong>LUREQO</strong><small>CRM PLATFORM</small></div></div>
   <nav><button className={active==='dashboard'?'active':''} onClick={()=>{setActive('dashboard');setOpen(false)}}><b>⌂</b> Dashboard</button>
   <div className="nav-label">OPERACIONES</div>{modules.slice(1,10).map(m=><button key={m[0]} className={active===m[0]?'active':''} onClick={()=>openLegacy(m[0])}><b>{m[3]}</b>{m[1]}</button>)}
   <div className="nav-label">GESTIÓN</div>{modules.slice(10).map(m=><button key={m[0]} className={active===m[0]?'active':''} onClick={()=>openLegacy(m[0])}><b>{m[3]}</b>{m[1]}</button>)}</nav>
   <button className="logout" onClick={logout}>↪ Cerrar sesión</button>
  </aside>
  {open&&<div className="backdrop" onClick={()=>setOpen(false)}/>} 
  <main className="content">{active==='dashboard'?<Dashboard onOpen={openLegacy} health={health}/>:<section className="module"><div className="module-head"><div><span> LUREQO CRM</span><h1>{modules.find(m=>m[0]===active)?.[1]}</h1><p>{modules.find(m=>m[0]===active)?.[2]}</p></div><button className="back" onClick={()=>setActive('dashboard')}>← Dashboard</button></div><div className="legacy-wrap">{loading&&<div className="loader">Cargando módulo…</div>}<iframe title={active} src="/legacy/index.html" onLoad={()=>setLoading(false)} /></div></section>}</main>
 </div>
}
function Dashboard({onOpen,health}){return <section className="dashboard"><div className="hero"><div><span className="eyebrow">CONTROL CENTER</span><h1>Tu CRM, más rápido.</h1><p>Accede a tus operaciones de Telegram y gestión desde una interfaz optimizada.</p></div><div className="status"><i className={'dot '+health}></i>{health==='online'?'Sistema online':'Comprobando…'}</div></div><div className="grid">{modules.slice(1,10).map((m,i)=><button className="card" key={m[0]} onClick={()=>onOpen(m[0])}><span className="icon">{m[3]}</span><div><strong>{m[1]}</strong><p>{m[2]}</p></div><span className="arrow">→</span></button>)}</div><div className="quick"><div><span>ACCESO RÁPIDO</span><h2>Empieza por una sección</h2></div><div className="quick-actions"><button onClick={()=>onOpen('messages')}>✉ Mensajes</button><button onClick={()=>onOpen('forwarder')}>↗ Reenviador</button><button onClick={()=>onOpen('accounts')}>◎ Cuentas</button></div></div></section>}
createRoot(document.getElementById('root')).render(<App/>);
