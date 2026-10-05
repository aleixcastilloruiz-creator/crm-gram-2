export async function api(path, options={}){
  const res=await fetch(path,{credentials:'include',headers:{'Content-Type':'application/json',...(options.headers||{})},...options});
  const text=await res.text(); let data=null; try{data=text?JSON.parse(text):null}catch{data=text}
  if(!res.ok) throw new Error(data?.error||data?.message||`Error ${res.status}`);
  return data;
}
export const get=(p)=>api(p);
export const post=(p,b)=>api(p,{method:'POST',body:JSON.stringify(b)});
export const patch=(p,b)=>api(p,{method:'PATCH',body:JSON.stringify(b)});
export const del=(p)=>api(p,{method:'DELETE'});
