// This is the only script in the opaque frame. Generated JavaScript runs on Cloudflare.
const bridge = String.raw`(() => {
  const channel = "__PI_CHANNEL__";
  let enabled = false;
  const controls = [...document.querySelectorAll('input,textarea,select,button')];
  const originallyDisabled = new Set(controls.filter(control => control.disabled));
  const send = value => parent.postMessage({channel,...value}, '*');
  function permission(value) {
    enabled = value;
    for (const control of controls) control.disabled = !enabled || originallyDisabled.has(control);
  }
  permission(false);
  addEventListener('message', event => {
    if (event.source === parent && event.data?.channel === channel && event.data.type === 'enabled') permission(event.data.enabled === true);
  });
  const actionName = element => element ? Element.prototype.getAttribute.call(element, "data-action") : null;
  function action(name, form) {
    if (!enabled) return;
    if (typeof name !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(name) || ["constructor","prototype","__proto__"].includes(name)) { send({type:"error"}); return; }
    const values = Object.create(null);
    if (form) for (const [key,value] of new FormData(form)) {
      if (!/^[a-z][a-z0-9_-]{0,39}$/.test(key) || ['constructor','prototype','__proto__'].includes(key) || typeof value !== 'string' || value.length > 1000) { send({type:'error',message:'Use short text fields with valid names.'}); return; }
      if (Object.hasOwn(values,key)) { send({type:'error',message:'Each submitted field needs a unique name.'}); return; }
      values[key] = value;
    }
    if (Object.keys(values).length > 8) { send({type:'error',message:'This app supports at most eight fields per action.'}); return; }
    permission(false);
    send({type:'action',name,values});
  }
  document.addEventListener('submit', event => {
    event.preventDefault();
    if (!event.isTrusted || !(event.target instanceof HTMLFormElement)) return;
    action(actionName(event.submitter) || actionName(event.target), event.target);
  });
  document.addEventListener('click', event => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    const button = event.target.closest('button[data-action]');
    if (!button || (button.type === 'submit' && button.form)) return;
    event.preventDefault();
    action(actionName(button), button.form);
  });
  new ResizeObserver(() => send({type:'height',height:document.documentElement.scrollHeight})).observe(document.body);
  send({type:'ready'});
})();`
const baseStyle = `:root{font:14px/1.5 system-ui,sans-serif;color:#202820;background:#fff;color-scheme:light}*{box-sizing:border-box}body{margin:0;padding:16px;overflow-wrap:anywhere}button,input,textarea,select{font:inherit;max-width:100%}button{padding:8px 14px;border:1px solid #d9dfda;border-radius:8px;background:#eaf0eb;cursor:pointer}button:disabled{opacity:.55;cursor:default}input,textarea,select{padding:8px;border:1px solid #d9dfda;border-radius:6px}form{display:grid;gap:12px}table{border-collapse:collapse;width:100%}td,th{padding:8px;text-align:left;border-bottom:1px solid #e0e5e1}pre{white-space:pre-wrap}fieldset{border:1px solid #d9dfda;border-radius:8px}label{display:grid;gap:4px}`
export function webFrame(
  html: string,
  css: string,
  channel: string,
  nonce = crypto.randomUUID()
) {
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'`
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"><style>${baseStyle}\n${css.replace(/</g, "\\3c ")}</style></head><body>${html}<script nonce="${nonce}" data-channel="${channel}">${bridge.replace("__PI_CHANNEL__", channel)}</script></body></html>`
}
