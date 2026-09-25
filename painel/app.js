(function () {
  'use strict';
  const cfg = window.PAINEL_CONFIG;
  if (!cfg || !/^https:\/\/.+\.supabase\.co$/.test(cfg.url || '') || !cfg.key || cfg.key.includes('SUA-CHAVE')) {
    document.body.innerHTML = '<main class="config-error"><h1>Smart Chat ainda não foi configurado</h1><p>Preencha a URL e a Publishable Key em <code>painel/config.js</code>.</p></main>';
    return;
  }
  const sb = window.supabase.createClient(cfg.url, cfg.key, { auth: { persistSession: true, autoRefreshToken: true } });
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
  async function notifyDriver(sessionId, body, title = 'Smart Chat') {
    try { await sb.functions.invoke('send-chat-push', { body: { session_id: sessionId, body, title } }); } catch (_) {}
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
    $('who-name').textContent = me.full_name || me.username;
    $('who-role').textContent = me.access_role;
    $('who-avatar').textContent = (me.full_name || me.username || 'U').trim().charAt(0).toUpperCase();
    buildTabs();
    await sb.rpc('touch_presence');
    clearInterval(boot.heartbeat);
    boot.heartbeat = setInterval(() => sb.rpc('touch_presence'), 45000);
  }

  function buildTabs() {
    const list = [];
    if (perms.dashboard_view || me.access_role === 'Operador') list.push(['dashboard', me.access_role === 'Gestor' ? 'Dashboard' : 'Meu dashboard']);
    if (me.chat_enabled && (perms.checklist_chat || perms.monitoring_chat)) list.push(['atendimentos', 'Atendimentos']);
    list.push(['historico', me.access_role === 'Gestor' ? 'Histórico' : 'Meu histórico']);
    if (perms.bases_admin || perms.base_operators_manage) list.push(['bases', 'Bases e transportadoras']);
    if (perms.users_manage) list.push(['usuarios', 'Usuários e acessos']);
    list.push(['instalacao', 'Instalar aplicativo']);
    const icons = {
      dashboard: '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
      atendimentos: '<svg viewBox="0 0 24 24"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>',
      historico: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
      bases: '<svg viewBox="0 0 24 24"><path d="M4 21V8l8-5 8 5v13M8 21v-7h8v7M8 9h.01M16 9h.01"/></svg>',
      usuarios: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 21a7 7 0 0 1 14 0M17 11a4 4 0 0 1 5 4v3"/></svg>',
      instalacao: '<svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>'
    };
    $('tabs').innerHTML = list.map(([id, label]) => '<button data-tab="' + id + '"><span class="tab-icon">' + icons[id] + '</span><span>' + label + '</span></button>').join('');
    $('tabs').querySelectorAll('button').forEach((b) => (b.onclick = () => goTo(b.dataset.tab)));
    goTo(list[0] ? list[0][0] : '');
  }

  function goTo(next) {
    tab = next;
    clearInterval(queuePoll);
    $('tabs').querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    if (tab === 'atendimentos') renderAtendimentos();
    else if (tab === 'dashboard') renderDashboard();
    else if (tab === 'historico') renderHistorico();
    else if (tab === 'bases') renderBases();
    else if (tab === 'usuarios') renderUsuarios();
    else if (tab === 'instalacao') renderInstalacao();
    else $('view').innerHTML = '<div class="empty-state">Você não tem acesso a nenhuma área do painel ainda.</div>';
  }

  // ============================================================
  // ATENDIMENTOS (fila em tempo real + chat)
  // ============================================================
  let selectedSession = null;
  async function renderAtendimentos() {
    $('view').innerHTML =
      '<div class="queue">' +
      '<div class="queue-list-wrap"><div class="queue-list-head"><span>CONVERSAS</span><h2>Atendimentos</h2></div><div class="queue-list" id="queue-list"><div class="queue-empty">Carregando…</div></div></div>' +
      '<div class="thread" id="thread"><div class="queue-empty">Selecione um atendimento na lista ao lado.</div></div>' +
      '<aside class="conversation-details" id="conversation-details"><div class="details-empty">Os dados do atendimento aparecerão aqui.</div></aside>' +
      '</div>';
    await loadQueue();
    queuePoll = setInterval(() => { loadQueue(); if (selectedSession) refreshThreadMessages(selectedSession.id); }, 4000);
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
      '<div class="queue-section-title">MEUS ATENDIMENTOS (' + mine.length + ')</div>' +
      (mine.length ? mine.map((s) => item(s, false)).join('') : '<div class="queue-empty">Nenhum atendimento ativo.</div>') +
      (perms.base_operators_manage
        ? '<div class="queue-section-title">NÃO ROTEADOS (' + unrouted.length + ')</div>' +
          (unrouted.length ? unrouted.map((s) => item(s, true)).join('') : '<div class="queue-empty">Nenhum atendimento pendente de roteamento.</div>')
        : '');
    box.querySelectorAll('[data-id]').forEach((b) => (b.onclick = (ev) => { if (ev.target.closest('[data-claim]')) return; openSession([...mine, ...unrouted].find((s) => s.id === b.dataset.id)); }));
    box.querySelectorAll('[data-claim]').forEach((b) => (b.onclick = async (ev) => { ev.stopPropagation(); try { await call(sb.rpc('claim_unrouted_session', { chat_session: b.dataset.claim }), 'Atendimento encaminhado ao operador disponível.'); await loadQueue(); } catch (e) {} }));
  }

  function openSession(session) {
    if (!session) return;
    selectedSession = session;
    loadQueue();
    renderSessionDetails(session);
    loadThread(session.id);
  }

  function renderSessionDetails(s) {
    const panel = $('conversation-details');
    if (!panel) return;
    const initials = String(s.driver_name || 'C').trim().split(/\s+/).slice(0, 2).map((part) => part.charAt(0)).join('').toUpperCase();
    panel.innerHTML =
      '<div class="details-title">Informações</div>' +
      '<div class="details-profile"><div class="details-avatar">' + esc(initials) + '</div><div><b>' + esc(s.driver_name || 'Condutor') + '</b><span>' + esc(s.vehicle_plate || 'Sem placa') + '</span></div></div>' +
      '<div class="details-card"><span>Tipo de atendimento</span><b>' + (s.service_type === 'monitoring' ? 'Monitoramento' : 'Checklist') + '</b></div>' +
      '<div class="details-card"><span>Tecnologia</span><b>' + esc(s.technology || 'Não informada') + '</b></div>' +
      '<div class="details-card"><span>Iniciado em</span><b>' + new Date(s.created_at).toLocaleString('pt-BR') + '</b></div>' +
      '<div class="details-card"><span>Situação</span><b class="online-label"><i></i>Em atendimento</b></div>';
  }

  async function loadThread(sessionId) {
    const s = selectedSession;
    if (!s || s.id !== sessionId) return;
    const box = $('thread');
    if (!box) return;
    if (box.dataset.sessionId === sessionId) {
      await refreshThreadMessages(sessionId);
      return;
    }
    box.dataset.sessionId = sessionId;
    box.innerHTML =
      '<div class="thread-head"><div class="thread-person"><div class="thread-avatar">' + esc(String(s.driver_name || 'C').trim().charAt(0).toUpperCase()) + '</div><div><h3>' + esc(s.driver_name) + '</h3><small>' + esc(s.vehicle_plate) + ' · ' + esc(s.technology || '') + '</small></div></div>' +
      '<button class="btn small" id="finish-btn">Encerrar atendimento</button></div>' +
      '<div class="thread-body" id="thread-body"></div>' +
      '<form class="thread-foot" id="thread-form"><textarea id="thread-input" rows="1" placeholder="Digite sua mensagem…"></textarea><button class="send-button" type="submit" aria-label="Enviar mensagem"><svg viewBox="0 0 24 24"><path d="m3 3 18 9-18 9 3-9-3-9Z"/><path d="M6 12h15"/></svg></button></form>' +
      '<div id="finish-panel" class="finish-panel" hidden></div>';
    $('thread-form').onsubmit = async (e) => {
      e.preventDefault();
      const input = $('thread-input'), text = input.value.trim();
      if (!text) return;
      input.value = '';
      try { await call(sb.from('checklist_chat_messages_v2').insert({ session_id: s.id, sender_type: 'operator', sender_id: me.id, body: text })); notifyDriver(s.id, text, me.full_name || 'Smart Chat'); await loadThread(s.id); } catch (e) {}
    };
    $('finish-btn').onclick = () => openFinishPanel(s);
    await refreshThreadMessages(sessionId, true);
  }

  async function refreshThreadMessages(sessionId, force = false) {
    const s = selectedSession;
    const box = $('thread');
    if (!s || s.id !== sessionId || !box || box.dataset.sessionId !== sessionId) return;
    const msgs = await call(sb.from('checklist_chat_messages_v2').select('*').eq('session_id', sessionId).order('created_at'));
    if (!selectedSession || selectedSession.id !== sessionId || box.dataset.sessionId !== sessionId) return;
    const body = $('thread-body');
    if (!body) return;
    const signature = msgs.map((m) => m.id + ':' + m.created_at).join('|');
    if (!force && body.dataset.signature === signature) return;
    const stayAtBottom = force || body.scrollHeight - body.scrollTop - body.clientHeight < 120;
    body.dataset.signature = signature;
    body.innerHTML = msgs.map((m) => '<div class="msg ' + (m.sender_type === 'operator' ? 'mine' : m.sender_type === 'bot' ? 'bot' : '') + '" data-message-id="' + m.id + '"><p style="margin:0;white-space:pre-wrap">' + esc(m.body) + '</p><time>' + new Date(m.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) + '</time></div>').join('') || '<div class="queue-empty">Nenhuma mensagem ainda.</div>';
    msgs.forEach((message) => {
      if (!message.attachment) return;
      const host = body.querySelector('[data-message-id="' + CSS.escape(message.id) + '"]');
      if (host && window.ChecklistMedia) ChecklistMedia.render(host, message.attachment, { local: false, client: sb, sessionId: s.id, token: null });
    });
    if (stayAtBottom) body.scrollTop = body.scrollHeight;
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
        const button = $('finish-confirm');
        try {
          const status = $('finish-status').value;
          const items = $('finish-items').value.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean);
          const scheduled = $('finish-schedule').value ? new Date($('finish-schedule').value).toISOString() : null;
          const reason = $('finish-reason').value.trim();
          if (status !== 'Aprovado' && reason.length < 3) throw new Error('Informe o motivo com pelo menos 3 caracteres.');
          if (status === 'Reprovado' && !items.length) throw new Error('Informe ao menos um acessório ou item reprovado.');
          if (status === 'Reagendado' && (!scheduled || new Date(scheduled) <= new Date())) throw new Error('Informe uma data futura para o reagendamento.');
          button.disabled = true;
          await call(sb.rpc('finish_checklist_chat_complete', { chat_session: s.id, checklist_status: status, outcome_reason: reason, failed_items: items, scheduled_for: scheduled }), 'Checklist encerrado.');
          notifyDriver(s.id, 'Seu checklist foi finalizado. Consulte o resultado na aba Registros.');
          selectedSession = null; $('thread').removeAttribute('data-session-id'); $('thread').innerHTML = '<div class="queue-empty">Selecione um atendimento na lista ao lado.</div>'; $('conversation-details').innerHTML = '<div class="details-empty">Os dados do atendimento aparecerão aqui.</div>'; await loadQueue();
        } catch (e) { toast(e.message || 'Não foi possível encerrar o atendimento.'); }
        finally { if (button && document.body.contains(button)) button.disabled = false; }
      };
    } else {
      panel.innerHTML =
        '<div class="form-row"><label>Resultado</label><select id="finish-status"><option>Concluído</option><option>Cancelado</option></select></div>' +
        '<div class="form-row"><label>Observação (opcional)</label><input id="finish-reason"></div>' +
        '<button class="btn primary" id="finish-confirm">Confirmar encerramento</button>';
      $('finish-confirm').onclick = async () => {
        const button = $('finish-confirm');
        try {
          button.disabled = true;
          await call(sb.rpc('finish_monitoring_chat', { chat_session: s.id, outcome: $('finish-status').value, note: $('finish-reason').value }), 'Atendimento encerrado.');
          notifyDriver(s.id, 'Seu atendimento de monitoramento foi finalizado.');
          selectedSession = null; $('thread').removeAttribute('data-session-id'); $('thread').innerHTML = '<div class="queue-empty">Selecione um atendimento na lista ao lado.</div>'; $('conversation-details').innerHTML = '<div class="details-empty">Os dados do atendimento aparecerão aqui.</div>'; await loadQueue();
        } catch (e) { toast(e.message || 'Não foi possível encerrar o atendimento.'); }
        finally { if (button && document.body.contains(button)) button.disabled = false; }
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
      '<div class="page-head"><div><span class="page-kicker">VISÃO GERAL</span><h1>' + (me.access_role === 'Gestor' ? 'Dashboard' : 'Meu dashboard') + '</h1><p>' + (me.access_role === 'Gestor' ? 'Acompanhe volume, tempo de atendimento e disponibilidade da equipe.' : 'Acompanhe seus atendimentos, resultados e tempo médio no período.') + '</p></div></div>' +
      '<div class="inline-form"><div class="form-row"><label>De</label><input type="date" id="dash-from" value="' + weekAgo + '"></div>' +
      '<div class="form-row"><label>Até</label><input type="date" id="dash-to" value="' + today + '"></div>' +
      '<button class="btn primary" id="dash-refresh">Atualizar</button></div>' +
      '<div id="dash-body"><div class="empty-state">Carregando…</div></div>';
    $('dash-refresh').onclick = loadDashboard;
    await loadDashboard();
  }

  async function loadDashboard() {
    const metricFunction = me.access_role === 'Gestor' ? 'dashboard_metrics' : 'operator_dashboard_metrics';
    const d = await call(sb.rpc(metricFunction, { date_from: $('dash-from').value, date_to: $('dash-to').value }));
    if (me.access_role === 'Operador') {
      $('dash-body').innerHTML =
        '<div class="grid cols-4" style="margin-bottom:14px">' +
        kpi('Meus atendimentos', d.total_atendimentos) +
        kpi('Em andamento', d.em_andamento) +
        kpi('Finalizados', Math.max(0, Number(d.total_atendimentos) - Number(d.em_andamento))) +
        kpi('Tempo médio', fmtDuration(d.tempo_medio_segundos)) +
        '</div>' +
        '<div class="grid cols-2">' +
        '<div class="card"><h2>Meus atendimentos por base</h2>' + table(['Base', 'Total', 'Tempo médio'], d.por_base.map((r) => [r.base, r.total, fmtDuration(r.tempo_medio_segundos)])) + '</div>' +
        '<div class="card"><h2>Tipos de atendimento</h2>' + table(['Tipo', 'Total'], [['Checklist', d.por_tipo.checklist], ['Monitoramento', d.por_tipo.monitoramento]]) + '</div>' +
        '</div>';
      return;
    }
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
  // HISTÓRICO GLOBAL PARA GESTORES E PRÓPRIO PARA OPERADORES
  // ============================================================
  async function renderHistorico() {
    const manager = me.access_role === 'Gestor';
    $('view').innerHTML =
      '<div class="page-head"><div><span class="page-kicker">' + (manager ? 'GESTÃO' : 'MEUS RESULTADOS') + '</span><h1>' + (manager ? 'Histórico de atendimentos' : 'Meu histórico') + '</h1><p>' + (manager ? 'Consulte os atendimentos de qualquer usuário, independentemente da base.' : 'Consulte todos os atendimentos que você realizou.') + '</p></div></div>' +
      '<div class="card"><div class="history-filter">' + (manager ? '<div class="form-row"><label>Operador</label><select id="history-user"><option value="">Todos os usuários</option></select></div>' : '') +
      '<div class="form-row"><label>Tipo</label><select id="history-type"><option value="">Todos</option><option value="checklist">Checklist</option><option value="monitoring">Monitoramento</option></select></div>' +
      '<button class="btn primary" id="history-filter">Filtrar</button></div><div id="history-body"><div class="empty-state">Carregando…</div></div></div>';
    if (manager) {
      const profiles = await call(sb.from('profiles').select('id,full_name,username').order('full_name'));
      $('history-user').innerHTML += profiles.map((p) => '<option value="' + p.id + '">' + esc(p.full_name || p.username) + '</option>').join('');
    }
    const load = async () => {
      let query = sb.from('checklist_chat_sessions').select('*,operator:profiles!checklist_chat_sessions_operator_id_fkey(full_name,username)').eq('active', false).order('finished_at', { ascending: false }).limit(300);
      if (!manager) query = query.eq('operator_id', me.id);
      else if ($('history-user').value) query = query.eq('operator_id', $('history-user').value);
      if ($('history-type').value) query = query.eq('service_type', $('history-type').value);
      const rows = await call(query);
      $('history-body').innerHTML = table(
        ['Data', 'Condutor', 'Placa', 'Tipo', 'Resultado', 'Responsável'],
        rows.map((s) => [
          s.finished_at ? new Date(s.finished_at).toLocaleString('pt-BR') : '—',
          s.driver_name,
          s.vehicle_plate,
          s.service_type === 'monitoring' ? 'Monitoramento' : 'Checklist',
          s.status || 'Concluído',
          s.operator ? (s.operator.full_name || s.operator.username) : '—',
        ])
      );
    };
    $('history-filter').onclick = load;
    await load();
  }

  // ============================================================
  // INSTALAÇÃO DO PWA
  // ============================================================
  function renderInstalacao() {
    const appUrl = new URL('../driver-app/', location.href).href;
    $('view').innerHTML =
      '<div class="page-head"><div><span class="page-kicker">APLICATIVO DO CONDUTOR</span><h1>Como instalar o Smart Chat</h1><p>Compartilhe o link abaixo. O condutor abre no celular e adiciona o aplicativo à tela inicial.</p></div></div>' +
      '<div class="install-panel"><div class="card"><h2>Instalação no celular</h2><div class="install-steps">' +
      '<div class="install-step"><div><b>Abra o link no celular</b><span>Use o Chrome no Android ou o Safari no iPhone.</span></div></div>' +
      '<div class="install-step"><div><b>Abra o menu do navegador</b><span>No Android, toque nos três pontos. No iPhone, toque em Compartilhar.</span></div></div>' +
      '<div class="install-step"><div><b>Instale na tela inicial</b><span>Escolha “Instalar aplicativo” ou “Adicionar à Tela de Início”.</span></div></div>' +
      '<div class="install-step"><div><b>Entre uma única vez</b><span>O acesso ficará salvo neste aparelho até o condutor finalizar a sessão.</span></div></div>' +
      '</div><div class="share-link"><input id="driver-link" readonly value="' + esc(appUrl) + '"><button class="btn primary" id="copy-driver-link">Copiar link</button><a class="btn" target="_blank" rel="noopener" href="' + esc(appUrl) + '">Abrir</a></div></div>' +
      '<div class="phone-card"><img src="../driver-app/icons/smart-risk.png" alt=""><h3>Converse com a central pelo Smart Chat.</h3><p>Checklist e monitoramento com mensagens, áudio, imagens e documentos.</p><div class="phone-chat"><div class="phone-bubble">Olá! Como posso ajudar?</div><div class="phone-bubble mine">Preciso realizar um checklist.</div></div></div></div>';
    $('copy-driver-link').onclick = async () => {
      await navigator.clipboard.writeText(appUrl);
      toast('Link do aplicativo copiado.');
    };
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
      call(sb.from('profiles').select('id,full_name,username,access_role,chat_enabled,active').order('full_name')),
    ]);
    const baseName = (id) => (bases.find((b) => b.id === id) || {}).name || '—';
    const carrierName = (id) => (carriers.find((c) => c.id === id) || {}).name || '—';
    const profName = (id) => { const p = profiles.find((x) => x.id === id); return p ? p.full_name || p.username : '—'; };
    const canAdmin = !!perms.bases_admin;
    const isAdminOrManager = false;
    const activeBases = bases.filter((b) => b.active);
    const activeCarriers = carriers.filter((c) => c.active);
    const attendants = profiles.filter((p) => p.active && p.chat_enabled);

    $('view').innerHTML =
      '<div class="page-head"><div><span class="page-kicker">CONFIGURAÇÃO OPERACIONAL</span><h1>Bases e transportadoras</h1><p>Defina quais usuários recebem Checklist ou Monitoramento em cada operação.</p></div></div>' +
      '<div class="grid cols-2">' +
      // Bases
      '<div class="card"><h2>Bases</h2>' +
      (canAdmin ? '<div class="inline-form"><div class="form-row"><label>Nova base</label><input id="new-base-name" placeholder="Ex.: Operação São Paulo"></div><button class="btn primary" id="add-base">Adicionar</button></div>' : '') +
      '<table><thead><tr><th>Base</th><th>Status</th><th></th></tr></thead><tbody>' + bases.map((b) => '<tr><td>' + esc(b.name) + '</td><td><span class="status' + (b.active ? '' : ' off') + '">' + (b.active ? 'Ativa' : 'Excluída') + '</span></td><td class="row-actions">' + (canAdmin && b.name.toLowerCase() !== 'checklist' ? '<button class="btn small' + (b.active ? ' danger' : '') + '" data-base-active="' + b.id + '" data-next="' + (!b.active) + '">' + (b.active ? 'Excluir' : 'Reativar') + '</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>' +

      // Transportadoras
      '<div class="card"><h2>Transportadoras</h2>' +
      (canAdmin ? '<div class="inline-form"><div class="form-row"><label>Nova transportadora</label><input id="new-carrier-name" placeholder="Ex.: TransBrasil"></div>' +
        '<div class="form-row"><label>Base vinculada</label><select id="new-carrier-base"><option value="">Sem base</option>' + activeBases.map((b) => '<option value="' + b.id + '">' + esc(b.name) + '</option>').join('') + '</select></div>' +
        '<button class="btn primary" id="add-carrier">Adicionar</button></div>' : '') +
      '<table><thead><tr><th>Transportadora</th><th>Base vinculada</th><th></th></tr></thead><tbody>' + carriers.map((c) => '<tr><td>' + esc(c.name) + '</td><td>' + esc(baseName((baseCarriers.find((bc) => bc.carrier_id === c.id) || {}).base_id)) + '</td><td class="row-actions">' + (canAdmin ? '<button class="btn small' + (c.active ? ' danger' : '') + '" data-carrier-active="' + c.id + '" data-next="' + (!c.active) + '">' + (c.active ? 'Excluir' : 'Reativar') + '</button>' : '') + '</td></tr>').join('') + '</tbody></table></div>' +

      // Vínculo de operadores por base (Coordenador consegue mexer aqui, escopado por RLS)
      '<div class="card"><h2>Atendentes por base</h2>' +
      (perms.base_operators_manage ? '<div class="inline-form"><div class="form-row"><label>Base</label><select id="op-base">' + activeBases.map((b) => '<option value="' + b.id + '">' + esc(b.name) + '</option>').join('') + '</select></div>' +
        '<div class="form-row"><label>Usuário com chat ativo</label><select id="op-user">' + attendants.map((p) => '<option value="' + p.id + '">' + esc(p.full_name || p.username) + ' · ' + esc(p.access_role) + '</option>').join('') + '</select></div>' +
        '<button class="btn primary" id="add-base-operator">Vincular</button></div>' : '') +
      '<div class="tag-row">' + baseOperators.map((bo) => '<span class="tag">' + esc(baseName(bo.base_id)) + ' · ' + esc(profName(bo.user_id)) + (perms.base_operators_manage ? ' <button data-remove-op="' + bo.id + '">×</button>' : '') + '</span>').join('') + '</div>' +
      '<p class="card-subtitle" style="margin-top:12px">Checklist é encaminhado apenas pela base Checklist. Monitoramento segue a base vinculada à transportadora do veículo.</p></div>' +

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
        '<div class="form-row"><label>Transportadora</label><select id="fleet-carrier">' + activeCarriers.map((c) => '<option value="' + c.id + '">' + esc(c.name) + '</option>').join('') + '</select></div>' +
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
      document.querySelectorAll('[data-base-active]').forEach((b) => (b.onclick = async () => { try { await call(sb.rpc('admin_set_base_active', { target_base: b.dataset.baseActive, is_active: b.dataset.next === 'true' }), b.dataset.next === 'true' ? 'Base reativada.' : 'Base excluída.'); renderBases(); } catch (e) {} }));
      document.querySelectorAll('[data-carrier-active]').forEach((b) => (b.onclick = async () => { try { await call(sb.rpc('admin_set_carrier_active', { target_carrier: b.dataset.carrierActive, is_active: b.dataset.next === 'true' }), b.dataset.next === 'true' ? 'Transportadora reativada.' : 'Transportadora excluída.'); renderBases(); } catch (e) {} }));
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
  const ROLES = ['Operador', 'Gestor'];
  async function renderUsuarios() {
    $('view').innerHTML = '<div class="empty-state">Carregando…</div>';
    const list = await call(sb.from('profiles').select('*').order('full_name'));
    $('view').innerHTML =
      '<div class="page-head"><div><span class="page-kicker">ADMINISTRAÇÃO</span><h1>Usuários e acessos</h1><p>Crie acessos, escolha o perfil e defina quem participa da distribuição de chats.</p></div></div>' +
      '<div class="card" style="margin-bottom:16px"><h2>Criar usuário</h2><div class="inline-form">' +
      '<div class="form-row"><label>Nome completo</label><input id="user-name" autocomplete="off"></div>' +
      '<div class="form-row"><label>E-mail</label><input id="user-email" type="email" autocomplete="off"></div>' +
      '<div class="form-row"><label>Senha inicial</label><input id="user-password" type="password" minlength="8" autocomplete="new-password"></div>' +
      '<div class="form-row"><label>Perfil</label><select id="user-role"><option>Operador</option><option>Gestor</option></select></div>' +
      '<button class="btn primary" id="create-user">Criar usuário</button></div><p class="card-subtitle">O usuário poderá trocar a senha posteriormente pelo fluxo de recuperação do Supabase.</p></div>' +
      '<div class="card">' +
      '<h2>Equipe cadastrada</h2><table><thead><tr><th>Nome</th><th>Usuário</th><th>Perfil</th><th>Recebe chats</th><th>Acesso</th><th>Visto por último</th></tr></thead><tbody>' +
      list.map((u) => '<tr>' +
        '<td>' + esc(u.full_name || '—') + '</td>' +
        '<td>' + esc(u.username || '—') + '</td>' +
        '<td><select data-role="' + u.id + '">' + ROLES.map((r) => '<option' + (r === u.access_role ? ' selected' : '') + '>' + r + '</option>').join('') + '</select></td>' +
        '<td><input type="checkbox" data-chat="' + u.id + '"' + (u.chat_enabled ? ' checked' : '') + '></td>' +
        '<td><input type="checkbox" data-active="' + u.id + '"' + (u.active ? ' checked' : '') + '></td>' +
        '<td>' + (u.last_seen_at ? timeAgo(u.last_seen_at) + ' atrás' : '—') + '</td>' +
        '</tr>').join('') +
      '</tbody></table></div>';
    $('create-user').onclick = async () => {
      const button = $('create-user');
      const payload = { full_name: $('user-name').value.trim(), email: $('user-email').value.trim(), password: $('user-password').value, access_role: $('user-role').value };
      if (!payload.full_name || !payload.email || payload.password.length < 8) { toast('Preencha nome, e-mail e uma senha com pelo menos 8 caracteres.'); return; }
      button.disabled = true;
      try {
        const { data, error } = await sb.functions.invoke('admin-create-user', { body: payload });
        if (error) throw error;
        if (data && data.error) throw new Error(data.error);
        toast('Usuário criado.');
        renderUsuarios();
      } catch (error) { toast(error.message || 'Não foi possível criar o usuário.'); }
      finally { button.disabled = false; }
    };
    document.querySelectorAll('[data-role]').forEach((s) => (s.onchange = async () => { try { await call(sb.rpc('admin_set_user_role', { target_user: s.dataset.role, new_role: s.value }), 'Função atualizada.'); } catch (e) { renderUsuarios(); } }));
    document.querySelectorAll('[data-chat]').forEach((c) => (c.onchange = async () => { try { await call(sb.rpc('admin_set_user_chat', { target_user: c.dataset.chat, is_enabled: c.checked }), c.checked ? 'Atendimento por chat ativado.' : 'Atendimento por chat desativado.'); } catch (e) { renderUsuarios(); } }));
    document.querySelectorAll('[data-active]').forEach((c) => (c.onchange = async () => { try { await call(sb.rpc('admin_set_user_active', { target_user: c.dataset.active, is_active: c.checked }), 'Acesso atualizado.'); } catch (e) { renderUsuarios(); } }));
  }

  $('mobile-menu').onclick = () => document.querySelector('.sidebar').classList.toggle('open');

  // ============================================================
  boot();
})();
