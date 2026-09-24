(function () {
  'use strict';
  const cfg = window.PAINEL_CONFIG;
  if (!cfg || !/^https:\/\/.+\.supabase\.co$/.test(cfg.url || '') || !cfg.key || cfg.key.includes('SUA-CHAVE')) {
    document.body.innerHTML = '<main class="config-error"><h1>Smart Chat ainda não foi configurado</h1><p>Preencha a URL e a Publishable Key em <code>painel/config.js</code>.</p></main>';
    return;
  }
  const sb = window.supabase.createClient(cfg.url, cfg.key);
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let me = null; // { id, full_name, username, access_role }
  let perms = {};
  let tab = '';
  let queuePoll = null;

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 4000);
  }

  function timeAgo(iso) {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'agora';
    if (s < 3600) return Math.floor(s / 60) + ' min';
    if (s < 86400) return Math.floor(s / 3600) + ' h';
    return Math.floor(s / 86400) + ' d';
  }

  function fmtDuration(totalSeconds) {
    if (totalSeconds == null) return '—';
    const s = Math.round(totalSeconds);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? h + 'h ' + m + 'min' : m ? m + 'min ' + sec + 's' : sec + 's';
  }

  async function call(promise, okMsg) {
    const { data, error } = await promise;
    if (error) { toast(error.message || 'Não foi possível concluir.'); throw error; }
    if (okMsg) toast(okMsg);
    return data;
  }

  // ============================================================
  // LOGIN / SESSÃO
  // ============================================================
  $('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('login-email').value.trim(), password = $('login-password').value;
    const btn = e.currentTarget.querySelector('button');
    btn.disabled = true;
    try {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await boot();
    } catch (err) {
      toast(err.message || 'Não foi possível entrar.');
    } finally { btn.disabled = false; }
  };

  $('logout').onclick = async () => {
    clearInterval(queuePoll);
    await sb.auth.signOut();
    me = null; perms = {};
    $('app-screen').hidden = true;
    $('login-screen').hidden = false;
  };

  async function boot() {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) return;
    const profile = await call(sb.from('profiles').select('*').eq('id', session.user.id).single());
    if (!profile.active) { toast('Seu acesso está desativado. Fale com um administrador.'); await sb.auth.signOut(); return; }
    me = profile;
    perms = await call(sb.rpc('my_permissions'));
    $('login-screen').hidden = true;
    $('app-screen').hidden = false;
    $('who-name').textContent = (me.full_name || me.username) + ' · ' + me.access_role;
    buildTabs();
    await sb.rpc('touch_presence');
    clearInterval(boot.heartbeat);
    boot.heartbeat = setInterval(() => sb.rpc('touch_presence'), 45000);
  }

  function buildTabs() {
    const list = [];
    if (perms.checklist_chat || perms.monitoring_chat || perms.base_operators_manage) list.push(['atendimentos', 'Atendimentos']);
    if (perms.dashboard_view) list.push(['dashboard', 'Dashboard']);
    if (perms.bases_admin || perms.base_operators_manage) list.push(['bases', 'Bases']);
    if (perms.users_manage) list.push(['usuarios', 'Usuários']);
    $('tabs').innerHTML = list.map(([id, label]) => '<button data-tab="' + id + '">' + label + '</button>').join('');
    $('tabs').querySelectorAll('button').forEach((b) => (b.onclick = () => goTo(b.dataset.tab)));
    goTo(list[0] ? list[0][0] : '');
  }

  function goTo(next) {
    tab = next;
    clearInterval(queuePoll);
    $('tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'atendimentos') renderAtendimentos();
    else if (tab === 'dashboard') renderDashboard();
    else if (tab === 'bases') renderBases();
    else if (tab === 'usuarios') renderUsuarios();
    else $('view').innerHTML = '<div class="empty-state">Você não tem acesso a nenhuma área do painel ainda.</div>';
  }

  // ============================================================
  // ATENDIMENTOS (fila em tempo real + chat)
  // ============================================================
  let selectedSession = null;
  async function renderAtendimentos() {
    $('view').innerHTML =
      '<div class="queue">' +
      '<div class="queue-list" id="queue-list"><div class="queue-empty">Carregando…</div></div>' +
      '<div class="thread" id="thread"><div class="queue-empty">Selecione um atendimento na lista ao lado.</div></div>' +
      '</div>';
    await loadQueue();
    queuePoll = setInterval(() => { loadQueue(); if (selectedSession) loadThread(selectedSession.id); }, 4000);
  }

  async function loadQueue() {
    const mine = await call(sb.from('checklist_chat_sessions').select('*').eq('operator_id', me.id).eq('active', true).order('updated_at', { ascending: false }));
    let unrouted = [];
    if (perms.base_operators_manage) {
      unrouted = await call(sb.from('checklist_chat_sessions').select('*').is('operator_id', null).eq('active', true).order('created_at', { ascending: false }));
    }
    const box = $('queue-list');
    if (!box) return;
    const item = (s, isUnrouted) =>
      '<button class="queue-item' + (selectedSession && selectedSession.id === s.id ? ' selected' : '') + '" data-id="' + s.id + '">' +
      '<b>' + esc(s.driver_name) + '</b>' +
      '<small>' + esc(s.vehicle_plate) + ' · <span class="pill ' + (s.service_type === 'monitoring' ? 'monitoring' : 'checklist') + '">' + (s.service_type === 'monitoring' ? 'Monitoramento' : 'Checklist') + '</span>' + (isUnrouted ? ' <span class="pill unrouted">Não roteado</span>' : '') + '</small>' +
      '<small>' + timeAgo(s.created_at) + ' atrás' + (s.routing_note ? ' · ' + esc(s.routing_note) : '') + '</small>' +
      (isUnrouted ? '<div style="margin-top:6px"><span class="btn small primary" data-claim="' + s.id + '">Encaminhar ao operador</span></div>' : '') +
      '</button>';
    box.innerHTML =
      '<div style="padding:10px 12px;font-size:11px;font-weight:800;color:var(--muted)">MEUS ATENDIMENTOS (' + mine.length + ')</div>' +
      (mine.length ? mine.map((s) => item(s, false)).join('') : '<div class="queue-empty">Nenhum atendimento ativo.</div>') +
      (perms.base_operators_manage
        ? '<div style="padding:10px 12px;font-size:11px;font-weight:800;color:var(--muted)">NÃO ROTEADOS (' + unrouted.length + ')</div>' +
          (unrouted.length ? unrouted.map((s) => item(s, true)).join('') : '<div class="queue-empty">Nenhum atendimento pendente de roteamento.</div>')
        : '');
    box.querySelectorAll('[data-id]').forEach((b) => (b.onclick = (ev) => { if (ev.target.closest('[data-claim]')) return; openSession([...mine, ...unrouted].find((s) => s.id === b.dataset.id)); }));
    box.querySelectorAll('[data-claim]').forEach((b) => (b.onclick = async (ev) => { ev.stopPropagation(); try { await call(sb.rpc('claim_unrouted_session', { chat_session: b.dataset.claim }), 'Atendimento encaminhado ao operador disponível.'); await loadQueue(); } catch (e) {} }));
  }

  function openSession(session) {
    if (!session) return;
    selectedSession = session;
    loadQueue();
    loadThread(session.id);
  }

  async function loadThread(sessionId) {
    const s = selectedSession;
    if (!s || s.id !== sessionId) return;
    const msgs = await call(sb.from('checklist_chat_messages_v2').select('*').eq('session_id', sessionId).order('created_at'));
    const box = $('thread');
    if (!box) return;
    box.innerHTML =
      '<div class="thread-head"><div><h3>' + esc(s.driver_name) + '</h3><small>' + esc(s.vehicle_plate) + ' · ' + esc(s.technology || '') + '</small></div>' +
      '<button class="btn small" id="finish-btn">Encerrar atendimento</button></div>' +
      '<div class="thread-body" id="thread-body"></div>' +
      '<form class="thread-foot" id="thread-form"><textarea id="thread-input" placeholder="Escreva uma mensagem…"></textarea><button class="btn primary" type="submit">Enviar</button></form>' +
      '<div id="finish-panel" hidden style="padding:12px;border-top:1px solid var(--line)"></div>';
    const body = $('thread-body');
    body.innerHTML = msgs.map((m) => '<div class="msg ' + (m.sender_type === 'operator' ? 'mine' : m.sender_type === 'bot' ? 'bot' : '') + '" data-message-id="' + m.id + '"><p style="margin:0;white-space:pre-wrap">' + esc(m.body) + '</p><time>' + new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '</time></div>').join('') || '<div class="queue-empty">Nenhuma mensagem ainda.</div>';
    msgs.forEach((message) => {
      if (!message.attachment) return;
      const host = body.querySelector('[data-message-id="' + CSS.escape(message.id) + '"]');
      if (host && window.ChecklistMedia) ChecklistMedia.render(host, message.attachment, { local: false, client: sb, sessionId: s.id, token: null });
    });
    body.scrollTop = body.scrollHeight;
    $('thread-form').onsubmit = async (e) => {
      e.preventDefault();
      const input = $('thread-input'), text = input.value.trim();
      if (!text) return;
      input.value = '';
      try { await call(sb.from('checklist_chat_messages_v2').insert({ session_id: s.id, sender_type: 'operator', sender_id: me.id, body: text })); await loadThread(s.id); } catch (e) {}
    };
    $('finish-btn').onclick = () => openFinishPanel(s);
  }

  function openFinishPanel(s) {
    const panel = $('finish-panel');
    panel.hidden = false;
    if (s.service_type === 'checklist') {
      panel.innerHTML =
        '<div class="form-row"><label>Resultado</label><select id="finish-status"><option>Aprovado</option><option>Reprovado</option><option>Cancelado</option><option>Reagendado</option></select></div>' +
        '<div class="form-row" id="finish-reason-row" hidden><label>Motivo</label><textarea id="finish-reason" rows="3"></textarea></div>' +
        '<div class="form-row" id="finish-items-row" hidden><label>Acessórios ou itens reprovados</label><textarea id="finish-items" rows="3" placeholder="Informe um item por linha"></textarea></div>' +
        '<div class="form-row" id="finish-schedule-row" hidden><label>Nova data e horário</label><input type="datetime-local" id="finish-schedule"></div>' +
        '<button class="btn primary" id="finish-confirm">Confirmar encerramento</button>';
      const updateFinishFields = () => {
        const status = $('finish-status').value;
        $('finish-reason-row').hidden = status === 'Aprovado';
        $('finish-items-row').hidden = status !== 'Reprovado';
        $('finish-schedule-row').hidden = status !== 'Reagendado';
      };
      $('finish-status').onchange = updateFinishFields;
      updateFinishFields();
      $('finish-confirm').onclick = async () => {
        try {
          const status = $('finish-status').value;
          const items = $('finish-items').value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
          const scheduled = $('finish-schedule').value ? new Date($('finish-schedule').value).toISOString() : null;
          await call(sb.rpc('finish_checklist_chat_complete', { chat_session: s.id, checklist_status: status, outcome_reason: $('finish-reason').value, failed_items: items, scheduled_for: scheduled }), 'Checklist encerrado.');
          selectedSession = null; $('thread').innerHTML = '<div class="queue-empty">Selecione um atendimento na lista ao lado.</div>'; await loadQueue();
        } catch (e) {}
      };
    } else {
      panel.innerHTML =
        '<div class="form-row"><label>Resultado</label><select id="finish-status"><option>Concluído</option><option>Cancelado</option></select></div>' +
        '<div class="form-row"><label>Observação (opcional)</label><input id="finish-reason"></div>' +
        '<button class="btn primary" id="finish-confirm">Confirmar encerramento</button>';
      $('finish-confirm').onclick = async () => {
        try {
          await call(sb.rpc('finish_monitoring_chat', { chat_session: s.id, outcome: $('finish-status').value, note: $('finish-reason').value }), 'Atendimento encerrado.');
          selectedSession = null; $('thread').innerHTML = '<div class="queue-empty">Selecione um atendimento na lista ao lado.</div>'; await loadQueue();
        } catch (e) {}
      };
    }
  }

  // ============================================================
  // DASHBOARD
  // ============================================================
  async function renderDashboard() {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
    $('view').innerHTML =
      '<div class="inline-form"><div class="form-row"><label>De</label><input type="date" id="dash-from" value="' + weekAgo + '"></div>' +
      '<div class="form-row"><label>Até</label><input type="date" id="dash-to" value="' + today + '"></div>' +
      '<button class="btn primary" id="dash-refresh">Atualizar</button></div>' +
      '<div id="dash-body"><div class="empty-state">Carregando…</div></div>';
    $('dash-refresh').onclick = loadDashboard;
    await loadDashboard();
  }

  async function loadDashboard() {
    const d = await call(sb.rpc('dashboard_metrics', { date_from: $('dash-from').value, date_to: $('dash-to').value }));
    $('dash-body').innerHTML =
      '<div class="grid cols-4" style="margin-bottom:14px">' +
      kpi('Total de atendimentos', d.total_atendimentos) +
      kpi('Em andamento', d.em_andamento) +
      kpi('Não roteados', d.nao_roteados) +
      kpi('Operadores ativos agora', d.operadores_ativos) +
      '</div>' +
      '<div class="grid cols-2" style="margin-bottom:14px">' +
      kpi('Tempo médio de atendimento', fmtDuration(d.tempo_medio_segundos)) +
      kpi('Checklist × Monitoramento', d.por_tipo.checklist + ' / ' + d.por_tipo.monitoramento) +
      '</div>' +
      '<div class="grid cols-2">' +
      '<div class="card"><h2>Atendimentos por base</h2>' + table(['Base', 'Total', 'Tempo médio'], d.por_base.map((r) => [r.base, r.total, fmtDuration(r.tempo_medio_segundos)])) + '</div>' +
      '<div class="card"><h2>Atendimentos por operador</h2>' + table(['Operador', 'Total', 'Tempo médio'], d.por_operador.map((r) => [r.operador, r.total, fmtDuration(r.tempo_medio_segundos)])) + '</div>' +
      '</div>';
  }

  function kpi(label, value) { return '<div class="kpi"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>'; }
  function table(headers, rows) {
    if (!rows.length) return '<div class="empty-state">Sem dados no período.</div>';
    return '<table><thead><tr>' + headers.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
      rows.map((r) => '<tr>' + r.map((c) => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
  }

  // ============================================================
  // BASES (transportadoras, vínculos, planilha de teste)
  // ============================================================
  async function renderBases() {
    $('view').innerHTML = '<div class="empty-state">Carregando…</div>';
    const [bases, carriers, baseCarriers, baseOperators, coordinators, fleet, profiles] = await Promise.all([
      call(sb.from('operation_bases').select('*').order('name')),
      call(sb.from('carriers').select('*').order('name')),
      call(sb.from('base_carriers').select('*')),
      call(sb.from('base_operators').select('*')),
      call(sb.from('base_coordinators').select('*')),
      call(sb.from('mock_fleet_drivers').select('*').order('plate')),
      call(sb.from('profiles').select('id,full_name,username,access_role').order('full_name')),
    ]);
    const baseName = (id) => (bases.find((b) => b.id === id) || {}).name || '—';
    const carrierName = (id) => (carriers.find((c) => c.id === id) || {}).name || '—';
    const profName = (id) => { const p = profiles.find((x) => x.id === id); return p ? p.full_name || p.username : '—'; };
    const canAdmin = !!perms.bases_admin;
    const isAdminOrManager = me.access_role === 'Administrador' || me.access_role === 'Gerente';

    $('view').innerHTML =
      '<div class="grid cols-2">' +
      // Bases
      '<div class="card"><h2>Bases</h2>' +
      (canAdmin ? '<div class="inline-form"><div class="form-row"><label>Nova base</label><input id="new-base-name" placeholder="Ex.: Operação São Paulo"></div><button class="btn primary" id="add-base">Adicionar</button></div>' : '') +
      table(['Base', 'Ativa'], bases.map((b) => [b.name, b.active ? 'Sim' : 'Não'])) + '</div>' +

      // Transportadoras
      '<div class="card"><h2>Transportadoras</h2>' +
      (canAdmin ? '<div class="inline-form"><div class="form-row"><label>Nova transportadora</label><input id="new-carrier-name" placeholder="Ex.: TransBrasil"></div>' +
        '<div class="form-row"><label>Base vinculada</label><select id="new-carrier-base"><option value="">Sem base</option>' + bases.map((b) => '<option value="' + b.id + '">' + esc(b.name) + '</option>').join('') + '</select></div>' +
        '<button class="btn primary" id="add-carrier">Adicionar</button></div>' : '') +
      table(['Transportadora', 'Base vinculada'], carriers.map((c) => [c.name, baseName((baseCarriers.find((bc) => bc.carrier_id === c.id) || {}).base_id)])) + '</div>' +

      // Vínculo de operadores por base (Coordenador consegue mexer aqui, escopado por RLS)
      '<div class="card"><h2>Operadores por base (vínculo de operação)</h2>' +
      (perms.base_operators_manage ? '<div class="inline-form"><div class="form-row"><label>Base</label><select id="op-base">' + bases.map((b) => '<option value="' + b.id + '">' + esc(b.name) + '</option>').join('') + '</select></div>' +
        '<div class="form-row"><label>Operador</label><select id="op-user">' + profiles.map((p) => '<option value="' + p.id + '">' + esc(p.full_name || p.username) + '</option>').join('') + '</select></div>' +
        '<button class="btn primary" id="add-base-operator">Vincular</button></div>' : '') +
      '<div class="tag-row">' + baseOperators.map((bo) => '<span class="tag">' + esc(baseName(bo.base_id)) + ' · ' + esc(profName(bo.user_id)) + (perms.base_operators_manage ? ' <button data-remove-op="' + bo.id + '">×</button>' : '') + '</span>').join('') + '</div>' +
      '<p style="color:var(--muted);font-size:11.5px;margin-top:10px">Só recebe atendimentos de Monitoramento quem também tiver a permissão "monitoring_chat" liberada na aba Usuários (individual) ou por função.</p></div>' +

      // Coordenadores por base (só Admin/Gerente)
      (isAdminOrManager ? '<div class="card"><h2>Coordenadores por base</h2>' +
        '<div class="inline-form"><div class="form-row"><label>Base</label><select id="co-base">' + bases.map((b) => '<option value="' + b.id + '">' + esc(b.name) + '</option>').join('') + '</select></div>' +
        '<div class="form-row"><label>Coordenador</label><select id="co-user">' + profiles.filter((p) => p.access_role === 'Coordenador').map((p) => '<option value="' + p.id + '">' + esc(p.full_name || p.username) + '</option>').join('') + '</select></div>' +
        '<button class="btn primary" id="add-base-coordinator">Vincular</button></div>' +
        '<div class="tag-row">' + coordinators.map((c) => '<span class="tag">' + esc(baseName(c.base_id)) + ' · ' + esc(profName(c.user_id)) + ' <button data-remove-co="' + c.id + '">×</button></span>').join('') + '</div></div>' : '') +
      '</div>' +

      // Base de veículos sincronizada da planilha Google (mock_fleet_drivers)
      (canAdmin ? '<div class="card" style="margin-top:14px"><div class="card-title-row"><div><h2>Base de veículos</h2><p class="card-subtitle">Dados usados para localizar a transportadora e encaminhar o Monitoramento.</p></div><button class="btn primary" id="sync-fleet">Sincronizar planilha Google</button></div>' +
        '<p class="source-line">Fonte: <a href="https://docs.google.com/spreadsheets/d/1U2RyPFX83muXk5Goal1_HrQnoOpfXLGado_LOLsLS1w/edit" target="_blank" rel="noopener">Base de dados compartilhada</a></p>' +
        '<div class="inline-form"><div class="form-row"><label>Placa</label><input id="fleet-plate" placeholder="ABC1D23"></div>' +
        '<div class="form-row"><label>Condutor</label><input id="fleet-driver"></div>' +
        '<div class="form-row"><label>Tecnologia</label><input id="fleet-tech"></div>' +
        '<div class="form-row"><label>Transportadora</label><select id="fleet-carrier">' + carriers.map((c) => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('') + '</select></div>' +
        '<button class="btn primary" id="add-fleet">Adicionar linha</button></div>' +
        table(['Placa', 'Condutor', 'Tecnologia', 'Transportadora'], fleet.map((f) => [f.plate, f.driver_name, f.technology, carrierName(f.carrier_id)])) + '</div>' : '');

    if (canAdmin) {
      $('add-base').onclick = async () => { const name = $('new-base-name').value.trim(); if (!name) return; try { await call(sb.from('operation_bases').insert({ name }), 'Base criada.'); renderBases(); } catch (e) {} };
      $('add-carrier').onclick = async () => {
        const name = $('new-carrier-name').value.trim(); const baseId = $('new-carrier-base').value;
        if (!name) return;
        try {
          const created = await call(sb.from('carriers').insert({ name }).select().single(), 'Transportadora criada.');
          if (baseId) await call(sb.from('base_carriers').insert({ base_id: baseId, carrier_id: created.id }));
          renderBases();
        } catch (e) {}
      };
      $('add-fleet').onclick = async () => {
        const plate = $('fleet-plate').value.trim().toUpperCase().replace(/[-\s]/g, '');
        if (!/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(plate)) { toast('Informe uma placa válida, como ABC1D23.'); return; }
        try { await call(sb.from('mock_fleet_drivers').insert({ plate, driver_name: $('fleet-driver').value.trim(), technology: $('fleet-tech').value.trim(), carrier_id: $('fleet-carrier').value }), 'Linha adicionada.'); renderBases(); } catch (e) {}
      };
      $('sync-fleet').onclick = async () => {
        const button = $('sync-fleet');
        button.disabled = true;
        button.textContent = 'Sincronizando…';
        try {
          const source = 'https://docs.google.com/spreadsheets/d/1U2RyPFX83muXk5Goal1_HrQnoOpfXLGado_LOLsLS1w/export?format=csv&gid=0';
          const response = await fetch(source);
          if (!response.ok) throw new Error('Não foi possível acessar a planilha compartilhada.');
          const lines = (await response.text()).trim().split(/\r?\n/).map((line) => line.split(',').map((cell) => cell.trim().replace(/^"|"$/g, '')));
          const header = lines.shift().map((cell) => cell.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase());
          const index = { carrier: header.indexOf('transportadora'), plate: header.indexOf('placa'), driver: header.indexOf('condutor'), technology: header.indexOf('tecnologia') };
          if (Object.values(index).some((value) => value < 0)) throw new Error('A planilha precisa ter Transportadora, Placa, Condutor e Tecnologia.');
          const currentCarriers = await call(sb.from('carriers').select('id,name'));
          const carrierByName = new Map(currentCarriers.map((item) => [item.name.trim().toLowerCase(), item]));
          let imported = 0;
          for (const columns of lines) {
            const carrierName = columns[index.carrier];
            const plate = (columns[index.plate] || '').toUpperCase().replace(/[-\s]/g, '');
            if (!carrierName || !/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(plate)) continue;
            const key = carrierName.toLowerCase();
            let carrier = carrierByName.get(key);
            if (!carrier) {
              carrier = await call(sb.from('carriers').insert({ name: carrierName }).select().single());
              carrierByName.set(key, carrier);
            }
            await call(sb.from('mock_fleet_drivers').upsert({ plate, driver_name: columns[index.driver] || null, technology: columns[index.technology] || null, carrier_id: carrier.id }, { onConflict: 'plate' }));
            imported += 1;
          }
          toast(imported + ' veículo(s) sincronizado(s).');
          await renderBases();
        } catch (e) {
          button.disabled = false;
          button.textContent = 'Sincronizar planilha Google';
        }
      };
    }
    if (perms.base_operators_manage) {
      $('add-base-operator').onclick = async () => { try { await call(sb.from('base_operators').insert({ base_id: $('op-base').value, user_id: $('op-user').value }), 'Operador vinculado.'); renderBases(); } catch (e) {} };
      document.querySelectorAll('[data-remove-op]').forEach((b) => (b.onclick = async () => { try { await call(sb.from('base_operators').delete().eq('id', b.dataset.removeOp)); renderBases(); } catch (e) {} }));
    }
    if (isAdminOrManager) {
      const addCo = $('add-base-coordinator');
      if (addCo) addCo.onclick = async () => { try { await call(sb.from('base_coordinators').insert({ base_id: $('co-base').value, user_id: $('co-user').value }), 'Coordenador vinculado.'); renderBases(); } catch (e) {} };
      document.querySelectorAll('[data-remove-co]').forEach((b) => (b.onclick = async () => { try { await call(sb.from('base_coordinators').delete().eq('id', b.dataset.removeCo)); renderBases(); } catch (e) {} }));
    }
  }

  // ============================================================
  // USUÁRIOS / ACESSOS
  // ============================================================
  const ROLES = ['Administrador', 'Gerente', 'Coordenador', 'Supervisor', 'Lider', 'Operador'];
  async function renderUsuarios() {
    $('view').innerHTML = '<div class="empty-state">Carregando…</div>';
    const list = await call(sb.from('profiles').select('*').order('full_name'));
    $('view').innerHTML =
      '<div class="card">' +
      '<p style="color:var(--muted);font-size:12px;margin-top:0">Para cadastrar um novo usuário, crie o login em Authentication → Users no painel do Supabase; ele aparecerá aqui automaticamente para você definir a função e liberar os acessos.</p>' +
      '<table><thead><tr><th>Nome</th><th>Usuário</th><th>Função</th><th>Ativo</th><th>Visto por último</th></tr></thead><tbody>' +
      list.map((u) => '<tr>' +
        '<td>' + esc(u.full_name || '—') + '</td>' +
        '<td>' + esc(u.username || '—') + '</td>' +
        '<td><select data-role="' + u.id + '">' + ROLES.map((r) => '<option' + (r === u.access_role ? ' selected' : '') + '>' + r + '</option>').join('') + '</select></td>' +
        '<td><input type="checkbox" data-active="' + u.id + '"' + (u.active ? ' checked' : '') + '></td>' +
        '<td>' + (u.last_seen_at ? timeAgo(u.last_seen_at) + ' atrás' : '—') + '</td>' +
        '</tr>').join('') +
      '</tbody></table></div>';
    document.querySelectorAll('[data-role]').forEach((s) => (s.onchange = async () => { try { await call(sb.rpc('admin_set_user_role', { target_user: s.dataset.role, new_role: s.value }), 'Função atualizada.'); } catch (e) { renderUsuarios(); } }));
    document.querySelectorAll('[data-active]').forEach((c) => (c.onchange = async () => { try { await call(sb.rpc('admin_set_user_active', { target_user: c.dataset.active, is_active: c.checked }), 'Acesso atualizado.'); } catch (e) { renderUsuarios(); } }));
  }

  // ============================================================
  boot();
})();
