/**
 * Runs synchronously in <head>. Keep this dependency-free: it must restore the
 * presentation preference before CSS paints, without evaluating application
 * stores or touching unrelated persisted settings.
 */
export const THEME_BOOTSTRAP = `(()=>{try{const k='portkheaw-theme-preferences',d={theme:'portkheaw',appearance:'system'};let v=null;try{v=JSON.parse(localStorage.getItem(k)||'null')}catch{}if(!v){for(const x of ['nexora-theme','theme-preference','appearance']){const r=localStorage.getItem(x);if(r!=null){try{v=JSON.parse(r)}catch{v=r}break}}}if(v==='Nexora AI Technical Dark')v={appearance:'dark'};if(typeof v==='string')v={appearance:v};v=v&&typeof v==='object'?(v.state||v.preferences||v):d;const a=['system','light','dark'].includes(v.appearance)?v.appearance:d.appearance;const r=a==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):a;const e=document.documentElement;e.dataset.theme='portkheaw';e.dataset.appearance=r;e.style.colorScheme=r}catch{document.documentElement.dataset.theme='portkheaw';document.documentElement.dataset.appearance='dark'}})();`;
