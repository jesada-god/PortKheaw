/**
 * Runs synchronously in <head>. Keep this dependency-free: it must restore the
 * presentation preference before CSS paints, without evaluating application
 * stores or touching unrelated persisted settings.
 *
 * `premiumAllowed` is server-resolved from the reader's effective access tier
 * and baked into the string, which is what makes a premium theme impossible to
 * flash. The browser never gets to decide it: the script only accepts a paid
 * theme when the server already said yes, so a forged `"bitswap"` in
 * localStorage — or a subscription that lapsed between two page loads — paints
 * PortKheaw on the very first frame rather than being corrected afterwards.
 *
 * It still writes nothing. Persisting the corrected preference is the
 * provider's job on mount; doing it here would mean a storage write on every
 * single page load before paint.
 */
export function themeBootstrap(premiumAllowed: boolean): string {
  return `(()=>{try{const k='portkheaw-theme-preferences',d={theme:'portkheaw',appearance:'system'},P=${premiumAllowed ? 'true' : 'false'};let v=null;try{v=JSON.parse(localStorage.getItem(k)||'null')}catch{}if(!v){for(const x of ['nexora-theme','theme-preference','appearance']){const r=localStorage.getItem(x);if(r!=null){try{v=JSON.parse(r)}catch{v=r}break}}}if(v==='Nexora AI Technical Dark')v={appearance:'dark'};if(typeof v==='string')v={appearance:v};v=v&&typeof v==='object'?(v.state||v.preferences||v):d;const a=['system','light','dark'].includes(v.appearance)?v.appearance:d.appearance;const r=a==='system'?(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'):a;const t=P&&['bitswap','dokturek'].includes(v.theme)?v.theme:'portkheaw';const e=document.documentElement;e.dataset.theme=t;e.dataset.appearance=r;e.style.colorScheme=r}catch{document.documentElement.dataset.theme='portkheaw';document.documentElement.dataset.appearance='dark'}})();`;
}
