// ---------- Sincronización en la nube (Supabase, tiempo real) ----------
// Local-first: la app sigue guardando en este dispositivo (funciona sin internet) y este módulo
// sincroniza con la tabla genérica public.records del proyecto Supabase multi-app.
//
// Colecciones (ver supabase/migrations/002_app_menu_familiar.sql):
//   menu-day        key = lunes..domingo      data = día completo del menú
//   shopping-check  key = itemKey / extra:id  data = { checked }
//   shopping-extra  key = id                  data = { id, name, qty, unit }
//
// Cómo sincroniza:
//   - `sent` guarda (por espacio) lo último que este dispositivo sabe que está en la nube.
//   - Al cambiar algo local se calcula snapshot() vs sent y se suben solo las diferencias.
//   - Los cambios de otros llegan por Realtime y se aplican al instante.
//   - Al abrir la app / volver internet se hace un pull completo para recuperar lo perdido.
//   - Conflicto sobre el mismo registro: gana el último que escribe (por día / por artículo).

(function(){
  const APP_ID = 'menu-familiar';
  const cfg = window.APP_CONFIG || {};
  const SB_URL = (cfg.SUPABASE_URL || '').trim();
  const SB_KEY = (cfg.SUPABASE_KEY || '').trim();
  const METHODS = Array.isArray(cfg.LOGIN_METHODS) ? cfg.LOGIN_METHODS : ['email', 'google'];
  const COLLS = ['menu-day', 'shopping-check', 'shopping-extra'];
  const LS_SPACE = 'menu-familiar:cloud:space';
  const lsSentKey = id => 'menu-familiar:cloud:sent:' + id;

  const box = document.getElementById('cloudBox');
  let sb = null, user = null, space = null, channel = null;
  let sent = null;              // { coll: { key: stableJson } }
  let pushTimer = null, pushing = false, pushAgain = false, syncing = false;
  let state = 'idle', stateMsg = '';
  let renderPending = false;

  // ---------- utilidades ----------
  const ls = {
    get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } },
    set(k, v){ try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch(e){} }
  };
  // JSON canónico (claves ordenadas): jsonb de Postgres reordena las claves.
  function stable(v){
    if(Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    if(v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
    return JSON.stringify(v === undefined ? null : v);
  }
  const emptyMap = () => ({ 'menu-day': {}, 'shopping-check': {}, 'shopping-extra': {} });
  const esc = s => escapeHtml(s == null ? '' : s);

  function snapshot(){
    const s = emptyMap();
    if(MENU) DAY_ORDER.forEach(d => { if(MENU[d]) s['menu-day'][d] = stable(MENU[d]); });
    Object.entries(shoppingState.checks || {}).forEach(([k, v]) => { s['shopping-check'][k] = stable({ checked: !!v }); });
    (shoppingState.extras || []).forEach(e => { s['shopping-extra'][e.id] = stable(e); });
    return s;
  }

  function diff(prev, cur){
    const rows = [];
    COLLS.forEach(c => {
      const p = prev[c] || {}, n = cur[c] || {};
      for(const k in n) if(p[k] !== n[k]) rows.push({ collection: c, key: k, data: JSON.parse(n[k]), deleted: false });
      for(const k in p) if(!(k in n)) rows.push({ collection: c, key: k, data: {}, deleted: true });
    });
    return rows;
  }

  function loadSent(){
    try { const raw = ls.get(lsSentKey(space.id)); return raw ? { ...emptyMap(), ...JSON.parse(raw) } : null; }
    catch(e){ return null; }
  }
  function saveSent(){ if(space) ls.set(lsSentKey(space.id), JSON.stringify(sent)); }

  // ---------- aplicar cambios remotos ----------
  function editingSomething(){
    const a = document.activeElement;
    return !!(a && a.closest && (a.closest('#mealCards') || a.closest('#shoppingCategories')) &&
              /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));
  }
  function rerender(){
    if(editingSomething()){ renderPending = true; return; }
    renderPending = false;
    renderDayChips();
    renderDay();
    if(document.getElementById('tab-shopping').style.display !== 'none') renderShopping();
  }
  document.addEventListener('focusout', () => setTimeout(() => { if(renderPending) rerender(); }, 150));

  async function applyRecords(records){
    if(!records.length) return;
    records.forEach(r => {
      const d = r.data || {};
      if(r.collection === 'menu-day'){
        if(!r.deleted && DAY_ORDER.includes(r.key)) MENU[r.key] = d;
      } else if(r.collection === 'shopping-check'){
        if(r.deleted) delete shoppingState.checks[r.key];
        else shoppingState.checks[r.key] = !!d.checked;
      } else if(r.collection === 'shopping-extra'){
        shoppingState.extras = shoppingState.extras.filter(x => x.id !== r.key);
        if(!r.deleted) shoppingState.extras.push({ ...d, id: r.key });
      }
    });
    MENU = ensureNotes(MENU);
    // lo aplicado ya está en la nube: actualizamos `sent` para no re-subirlo
    const cur = snapshot();
    records.forEach(r => {
      if(!sent[r.collection]) sent[r.collection] = {};
      const v = cur[r.collection] && cur[r.collection][r.key];
      if(v === undefined) delete sent[r.collection][r.key]; else sent[r.collection][r.key] = v;
    });
    saveSent();
    await storageSet('menu-data-v2', JSON.stringify(MENU), false);
    await storageSet('shopping-state', JSON.stringify(shoppingState), false);
    rerender();
  }

  // ---------- subir cambios locales ----------
  function schedulePush(ms = 700){
    if(!space) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, ms);
  }

  async function push(){
    if(!sb || !user || !space || !sent || syncing) return;
    if(pushing){ pushAgain = true; return; }
    const rows = diff(sent, snapshot());
    if(!rows.length){ setState('ok'); return; }
    if(!navigator.onLine){ setState('offline'); return; }
    pushing = true; setState('saving');
    const { error } = await sb.from('records').upsert(
      rows.map(r => ({ ...r, space_id: space.id })),
      { onConflict: 'space_id,collection,key' }
    );
    pushing = false;
    if(error){ setState('error', error.message); return; }
    rows.forEach(r => {
      if(r.deleted) delete sent[r.collection][r.key];
      else sent[r.collection][r.key] = stable(r.data);
    });
    saveSent();
    setState('ok');
    if(pushAgain){ pushAgain = false; schedulePush(50); }
  }

  // ---------- pull completo ----------
  async function fullSync(){
    if(!sb || !user || !space || syncing) return;
    if(!navigator.onLine){ setState('offline'); return; }
    syncing = true; setState('saving', 'Sincronizando…');
    try {
      const { data, error } = await sb.from('records')
        .select('collection,key,data,deleted').eq('space_id', space.id);
      if(error) throw error;
      const remote = emptyMap();
      data.forEach(r => { if(!r.deleted && remote[r.collection]) remote[r.collection][r.key] = stable(r.data); });

      const known = loadSent();
      if(!known){
        // primera vez de este dispositivo en este espacio
        sent = remote;
        const hasRemote = data.some(r => !r.deleted);
        if(hasRemote){
          const useCloud = confirm(`Ya hay un menú guardado en la nube ("${space.name}").\n\n` +
            `Aceptar → usar el de la nube (recomendado)\nCancelar → reemplazarlo con el de este dispositivo`);
          if(useCloud){
            shoppingState.checks = {};
            shoppingState.extras = [];
            syncing = false;
            await applyRecords(data.filter(r => !r.deleted));
            sent = remote; saveSent();
          }
        }
        saveSent();
      } else {
        sent = known;
        const cur = snapshot();
        const incoming = data.filter(r => {
          const remoteVal = r.deleted ? undefined : stable(r.data);
          const s = sent[r.collection] ? sent[r.collection][r.key] : undefined;
          if(remoteVal === s) return false;                       // ya al día
          const localChanged = (cur[r.collection] || {})[r.key] !== s;
          return !localChanged;                                   // cambio local pendiente: gana el local
        });
        syncing = false;
        await applyRecords(incoming);
      }
    } catch(err){
      setState('error', err.message || String(err));
    } finally {
      syncing = false;
    }
    await push();
  }

  // ---------- realtime ----------
  function subscribe(){
    unsubscribe();
    channel = sb.channel('records-' + space.id)
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'records', filter: 'space_id=eq.' + space.id },
          payload => {
            const r = payload.new;
            if(!r || !r.collection || !sent) return;
            const remoteVal = r.deleted ? undefined : stable(r.data);
            const mine = (snapshot()[r.collection] || {})[r.key];
            if(remoteVal === mine){                     // eco de mi propio cambio (o ya igual)
              if(remoteVal === undefined) delete sent[r.collection][r.key];
              else sent[r.collection][r.key] = remoteVal;
              saveSent();
              return;
            }
            applyRecords([r]);
          })
      .subscribe(status => {
        if(status === 'SUBSCRIBED'){ if(state !== 'saving') setState('ok'); }
        else if(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT'){ setState('offline'); }
      });
  }
  function unsubscribe(){
    if(channel && sb){ sb.removeChannel(channel); }
    channel = null;
  }

  // ---------- espacio ----------
  async function openSpace(s){
    space = s;
    ls.set(LS_SPACE, JSON.stringify({ userId: user.id, id: s.id, name: s.name, join_code: s.join_code, owner_id: s.owner_id }));
    sent = null;
    render();
    await fullSync();
    subscribe();
    render();
  }

  async function resolveSpace(){
    let cached = null;
    try { cached = JSON.parse(ls.get(LS_SPACE) || 'null'); } catch(e){}
    if(cached && cached.userId === user.id){
      space = cached; render();                     // pinta rápido con lo cacheado
      const { data } = await sb.from('spaces').select('*').eq('id', cached.id).maybeSingle();
      if(data) return openSpace(data);
    }
    const { data, error } = await sb.rpc('ensure_space', { p_app: APP_ID, p_name: 'Familia' });
    if(error){ setState('error', error.message); return; }
    return openSpace(data);
  }

  // ---------- acciones de UI ----------
  async function loginGoogle(){
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname }
    });
    if(error) showStatus(error.message, 'err');
  }

  async function loginEmail(){
    const email = (prompt('Tu correo electrónico:') || '').trim();
    if(!email) return;
    setState('saving', 'Enviando enlace…');
    const { error } = await sb.auth.signInWithOtp({
      email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname }
    });
    if(error){
      const msg = /not authorized/i.test(error.message)
        ? 'Ese correo aún no está autorizado para recibir el enlace de acceso.'
        : /rate limit/i.test(error.message)
          ? 'Se enviaron demasiados correos; espera un rato e inténtalo de nuevo.'
          : error.message;
      setState('error', msg);
      return;
    }
    setState('info', `📩 Te enviamos un enlace a ${email}. Ábrelo en este mismo dispositivo para entrar.`);
  }

  async function invite(){
    const code = space.join_code;
    const text = `Únete a nuestro menú de la semana 🍽️\nAbre ${location.origin + location.pathname}, entra con tu correo y toca "Unirme con código": ${code}`;
    if(navigator.share){ try { await navigator.share({ title: 'Menú de la semana', text }); return; } catch(e){} }
    try { await navigator.clipboard.writeText(text); showStatus('Invitación copiada ✓', 'ok'); }
    catch(e){ prompt('Comparte este código:', code); }
  }

  async function join(){
    const code = (prompt('Código del menú familiar (8 caracteres):') || '').trim();
    if(!code) return;
    const { data, error } = await sb.rpc('join_space', { p_code: code });
    if(error){ showStatus(/invalid_code/.test(error.message) ? 'Código no válido' : error.message, 'err'); return; }
    unsubscribe();
    await openSpace(data);
    showStatus(`Te uniste a "${data.name}" ✓`, 'ok');
  }

  async function logout(){
    if(!confirm('¿Cerrar sesión? Tus datos se quedan en este dispositivo.')) return;
    unsubscribe();
    await sb.auth.signOut();
  }

  // ---------- render ----------
  function setState(s, msg = ''){ state = s; stateMsg = msg; render(); }

  function render(){
    if(!box) return;
    if(!SB_URL || !SB_KEY){
      box.innerHTML = `<div class="cloud-info warn">⚠️ Nube sin configurar: completa SUPABASE_URL y SUPABASE_KEY en <code>config.js</code>.</div>`;
      return;
    }
    if(!user){
      box.innerHTML = `
        <div class="data-bar">
          ${METHODS.includes('google') ? '<button class="data-btn primary" data-act="google">🔐 Entrar con Google</button>' : ''}
          ${METHODS.includes('email') ? `<button class="data-btn ${METHODS.includes('google') ? '' : 'primary'}" data-act="email">✉️ Entrar con mi correo</button>` : ''}
        </div>
        <div class="cloud-info ${state === 'error' ? 'err' : ''}">${state === 'error' ? esc(stateMsg) :
          (state === 'saving' || state === 'info') ? esc(stateMsg) : 'Entra para guardar en la nube y compartir el menú en tiempo real con tu familia.'}</div>`;
    } else {
      const labels = {
        ok: '🟢 En vivo — sincronizado',
        saving: '🔄 ' + (stateMsg || 'Guardando…'),
        offline: '🟠 Sin internet — se sincroniza al volver',
        error: '🔴 ' + (stateMsg || 'Error de sincronización'),
        idle: '⏳ Conectando…'
      };
      box.innerHTML = `
        <div class="data-bar">
          <button class="data-btn" data-act="invite">👨‍👩‍👧 Invitar</button>
          <button class="data-btn" data-act="join">🔑 Unirme con código</button>
          <button class="data-btn" data-act="logout">Salir</button>
        </div>
        <div class="cloud-info ${state === 'error' ? 'err' : state === 'offline' ? 'warn' : ''}">
          ${labels[state] || labels.idle}${space ? ` · ${esc(space.name)}` : ''} · ${esc(user.email || '')}
        </div>`;
    }
    box.querySelectorAll('[data-act]').forEach(b => b.onclick = () => ({
      google: loginGoogle, email: loginEmail, invite, join, logout
    })[b.dataset.act]());

    const badge = document.getElementById('storageBadge');
    if(badge){
      badge.classList.toggle('local', !(user && state === 'ok'));
      badge.innerHTML = user && space
        ? `<span class="dot"></span> ${state === 'ok' ? 'En la nube' : 'Este dispositivo'} · ${esc(space.name)}`
        : `<span class="dot"></span> Guardado en este dispositivo · funciona sin internet`;
    }
  }

  // ---------- arranque ----------
  async function onUser(newUser){
    const changed = (newUser && newUser.id) !== (user && user.id);
    user = newUser;
    if(!changed){ render(); return; }
    unsubscribe(); space = null; sent = null;
    if(user){ setState('idle'); await resolveSpace(); }
    else { setState('idle'); }
  }

  function init(){
    render();
    if(!SB_URL || !SB_KEY) return;
    if(!(window.supabase && window.supabase.createClient)){ setState('error', 'No se cargó la librería de Supabase'); return; }
    sb = window.supabase.createClient(SB_URL, SB_KEY, {
      auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    // no hacer awaits de supabase dentro del callback (recomendación oficial)
    sb.auth.onAuthStateChange((_evt, session) => {
      setTimeout(() => onUser(session ? session.user : null), 0);
    });

    window.addEventListener('menu-data-changed', () => schedulePush());
    window.addEventListener('online', () => { fullSync(); });
    window.addEventListener('offline', () => { if(user) setState('offline'); });
    document.addEventListener('visibilitychange', () => {
      if(document.visibilityState === 'visible' && user && space) fullSync();
    });
  }

  // espera a que la app haya cargado MENU antes de sincronizar
  const start = () => (MENU ? init() : setTimeout(start, 50));
  start();

  window.CloudSync = { push, fullSync, _debug: () => ({ user, space, sent, state }) };
})();
