import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  ACTIVE_ALERT_MESSAGE,
  API_FAILURE_MESSAGE,
  RACE_ALERT_MESSAGE,
  UNLOCK_STATES,
  isUnlockIntent,
  parseAlertResponse,
  parseCommandResponse,
  safeSuccessMessage,
  validateCpfCredential,
} from '../_shared/unlock-core.mjs';

const jsonHeaders = { 'Content-Type': 'application/json' };

function digits(value: unknown) {
  return String(value || '').replace(/\D/g, '');
}

function inboundText(payload: Record<string, any>) {
  return String(
    payload.text?.message || payload.buttonsResponseMessage?.message ||
    payload.buttonsResponseMessage?.buttonId || payload.listResponseMessage?.title ||
    payload.listResponseMessage?.message || payload.listResponseMessage?.selectedRowId || '',
  ).trim();
}

function zapiCredentials() {
  const instanceId = Deno.env.get('ZAPI_INSTANCE_ID') || '';
  const instanceToken = Deno.env.get('ZAPI_INSTANCE_TOKEN') || '';
  const clientToken = Deno.env.get('ZAPI_CLIENT_TOKEN') || '';
  if (!instanceId || !instanceToken || !clientToken) throw new Error('Credenciais da Z-API não configuradas');
  return { instanceId, instanceToken, clientToken };
}

async function sendText(to: string, body: string) {
  const { instanceId, instanceToken, clientToken } = zapiCredentials();
  const pieces = String(body).match(/[\s\S]{1,3900}/g) || [];
  let lastResult: Record<string, any> = {};
  for (const piece of pieces) {
    const response = await fetch(
      `https://api.z-api.io/instances/${encodeURIComponent(instanceId)}/token/${encodeURIComponent(instanceToken)}/send-text`,
      { method: 'POST', headers: { 'Client-Token': clientToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: to, message: piece, delayTyping: 1 }) },
    );
    lastResult = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(lastResult?.error || lastResult?.message || `Z-API respondeu ${response.status}`);
  }
  return lastResult;
}

function simulatorCredentials() {
  const baseUrl = (Deno.env.get('SIMULATOR_BASE_URL') || '').replace(/\/$/, '');
  const apiKey = Deno.env.get('SIMULATOR_API_KEY') || '';
  if (!baseUrl || !apiKey) throw new Error('Simulador não configurado');
  return { baseUrl, apiKey };
}

async function simulatorRequest(path: string, init: RequestInit = {}) {
  const { baseUrl, apiKey } = simulatorCredentials();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || payload?.error || `Simulador respondeu ${response.status}`);
  return payload;
}

const checkActiveAlerts = (vehicleId: string) => simulatorRequest(`/api/v1/vehicles/${encodeURIComponent(vehicleId)}/alerts/active`);
const sendUnlockCommand = (requestRow: Record<string, any>) => simulatorRequest('/api/v1/commands/unlock', {
  method: 'POST',
  body: JSON.stringify({
    request_id: requestRow.request_id,
    vehicle_id: requestRow.vehicle_id,
    plate: requestRow.plate,
    driver_id: requestRow.external_driver_id,
    command: 'UNLOCK',
    source: 'SMART_CHAT',
  }),
});

function menu(driver: Record<string, any>) {
  const data = [
    `Nome: ${driver.full_name}`,
    driver.carrier_name ? `Transportadora: ${driver.carrier_name}` : null,
    driver.vehicle_plate ? `Placa: ${driver.vehicle_plate}` : null,
    driver.technology ? `Tecnologia: ${driver.technology}` : null,
  ].filter(Boolean).join('\n');
  return `${data}\n\nComo posso ajudar?\n1 - Tirar uma dúvida\n2 - Falar com um operador\nDigite MENU a qualquer momento para voltar aqui.`;
}

async function updateContact(admin: any, contact: Record<string, any>, values: Record<string, any>) {
  const next = { ...values };
  if (values.context) next.context = { ...(contact.context || {}), ...values.context };
  const { data, error } = await admin.from('whatsapp_contacts').update(next).eq('id', contact.id).select('*').single();
  if (error) throw error;
  return data;
}

async function transferUnlock(admin: any, requestRow: Record<string, any>, reason: string, driverMessage: string) {
  const { error } = await admin.rpc('route_unlock_handoff', { unlock_request: requestRow.id, handoff_reason: reason });
  if (error) throw error;
  await sendText(requestRow.wa_id, driverMessage);
}

async function failAndTransfer(admin: any, requestRow: Record<string, any>, reason: string, message = API_FAILURE_MESSAGE) {
  const { data, error } = await admin.from('vehicle_unlock_requests').update({
    status: UNLOCK_STATES.FAILED, handoff_reason: reason, updated_at: new Date().toISOString(),
  }).eq('id', requestRow.id).select('*').single();
  if (error) throw error;
  await transferUnlock(admin, { ...data, wa_id: requestRow.wa_id }, reason, message);
}

async function blockAndTransfer(admin: any, requestRow: Record<string, any>, alertTypes: string[], message: string, reason: string) {
  const { data, error } = await admin.from('vehicle_unlock_requests').update({
    status: UNLOCK_STATES.BLOCKED, has_active_alert: true, alert_types: alertTypes,
    handoff_reason: reason, updated_at: new Date().toISOString(),
  }).eq('id', requestRow.id).select('*').single();
  if (error) throw error;
  await transferUnlock(admin, { ...data, wa_id: requestRow.wa_id }, reason, message);
}

async function startUnlockFlow(admin: any, contact: Record<string, any>, driver: Record<string, any>, originalMessage: string) {
  const { data: requestRow, error } = await admin.from('vehicle_unlock_requests').insert({
    whatsapp_contact_id: contact.id,
    external_driver_id: driver.id,
    vehicle_id: driver.external_vehicle_id,
    plate: driver.vehicle_plate,
    driver_name: driver.full_name,
    phone_e164: contact.phone_e164,
    carrier_name: driver.carrier_name,
    original_message: originalMessage,
  }).select('*').single();
  if (error) throw error;
  await admin.from('vehicle_unlock_requests').update({ status: UNLOCK_STATES.ALERT_CHECKING, updated_at: new Date().toISOString() }).eq('id', requestRow.id);
  const withWa = { ...requestRow, wa_id: contact.wa_id };

  if (!requestRow.vehicle_id || !requestRow.plate) {
    await failAndTransfer(admin, withWa, 'Veículo não identificado para consulta de segurança.');
    return;
  }

  try {
    const alert = parseAlertResponse(await checkActiveAlerts(requestRow.vehicle_id));
    if (alert.active) {
      await blockAndTransfer(admin, withWa, alert.alertTypes, ACTIVE_ALERT_MESSAGE, 'Desbloqueio bloqueado por alerta ativo.');
      return;
    }
  } catch (error) {
    await failAndTransfer(admin, withWa, `Falha ao consultar alertas: ${error instanceof Error ? error.message : 'erro desconhecido'}.`);
    return;
  }

  if (!driver.cpf_last4_hash) {
    await failAndTransfer(admin, withWa, 'Credencial do condutor indisponível para validação.');
    return;
  }

  await admin.from('vehicle_unlock_requests').update({
    status: UNLOCK_STATES.AUTH_REQUIRED, has_active_alert: false, updated_at: new Date().toISOString(),
  }).eq('id', requestRow.id);
  await updateContact(admin, contact, { state: 'unlock_auth', context: { unlock_request_id: requestRow.id, unlock_auth_attempts: 0 } });
  await sendText(contact.wa_id, 'Para confirmar sua identidade, informe os 4 últimos dígitos do seu CPF.');
}

async function handleUnlockAuthentication(admin: any, contact: Record<string, any>, driver: Record<string, any>, text: string) {
  const requestId = String(contact.context?.unlock_request_id || '');
  const { data: requestRow } = await admin.from('vehicle_unlock_requests').select('*')
    .eq('id', requestId).eq('whatsapp_contact_id', contact.id).maybeSingle();
  if (!requestRow || requestRow.status !== UNLOCK_STATES.AUTH_REQUIRED) {
    await updateContact(admin, contact, { state: 'menu', context: { unlock_request_id: null, unlock_auth_attempts: 0 } });
    await sendText(contact.wa_id, 'Esta solicitação não está mais disponível. Digite MENU para começar novamente.');
    return;
  }

  const validation = await validateCpfCredential(
    text, driver.cpf_last4_hash, Deno.env.get('SMART_CHAT_AUTH_PEPPER') || '', requestRow.auth_attempts, 3,
  );
  await admin.from('vehicle_unlock_requests').update({ auth_attempts: validation.attempts, updated_at: new Date().toISOString() }).eq('id', requestRow.id);
  if (!validation.valid) {
    if (validation.locked) {
      await failAndTransfer(admin, { ...requestRow, auth_attempts: validation.attempts, wa_id: contact.wa_id }, 'Limite de tentativas de autenticação excedido.');
      return;
    }
    await sendText(contact.wa_id, 'Os dados informados não conferem. Tente novamente.');
    return;
  }

  await admin.from('vehicle_unlock_requests').update({
    status: UNLOCK_STATES.AUTHENTICATED,
    authenticated_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }).eq('id', requestRow.id);
  await admin.from('vehicle_unlock_requests').update({
    status: UNLOCK_STATES.AWAITING_CONFIRMATION, updated_at: new Date().toISOString(),
  }).eq('id', requestRow.id);
  await updateContact(admin, contact, { state: 'unlock_confirm', context: { unlock_auth_attempts: validation.attempts } });
  await sendText(contact.wa_id, `Identidade confirmada.\n\nVeículo: ${requestRow.plate}\n\nDeseja solicitar o desbloqueio deste veículo?\n1 - SIM, DESBLOQUEAR\n2 - NÃO`);
}

async function executeAutomaticUnlock(admin: any, contact: Record<string, any>, requestRow: Record<string, any>) {
  if (requestRow.status === UNLOCK_STATES.SENT) {
    await sendText(contact.wa_id, safeSuccessMessage(requestRow.plate));
    return;
  }
  try {
    const alert = parseAlertResponse(await checkActiveAlerts(requestRow.vehicle_id));
    if (alert.active) {
      await blockAndTransfer(admin, { ...requestRow, wa_id: contact.wa_id }, alert.alertTypes, RACE_ALERT_MESSAGE, 'Alerta identificado antes do envio do comando.');
      return;
    }

    const { data: claimed } = await admin.from('vehicle_unlock_requests').update({
      status: UNLOCK_STATES.SENDING, confirmed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', requestRow.id).eq('status', UNLOCK_STATES.AWAITING_CONFIRMATION).select('id').maybeSingle();
    if (!claimed) {
      const { data: current } = await admin.from('vehicle_unlock_requests').select('status').eq('id', requestRow.id).single();
      if (current?.status === UNLOCK_STATES.SENT) await sendText(contact.wa_id, safeSuccessMessage(requestRow.plate));
      return;
    }
    const resultPayload = await sendUnlockCommand(requestRow);
    const result = parseCommandResponse(resultPayload);
    if (result.kind === 'blocked') {
      await blockAndTransfer(admin, { ...requestRow, wa_id: contact.wa_id }, [], RACE_ALERT_MESSAGE, 'Simulador bloqueou o comando por alerta ativo.');
      return;
    }
    if (result.kind !== 'sent') {
      await admin.from('vehicle_unlock_requests').update({ command_result: resultPayload }).eq('id', requestRow.id);
      await failAndTransfer(admin, { ...requestRow, wa_id: contact.wa_id }, `Simulador retornou ${result.status}.`);
      return;
    }

    await admin.from('vehicle_unlock_requests').update({
      status: UNLOCK_STATES.SENT,
      command_sent_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      command_result: resultPayload, updated_at: new Date().toISOString(),
    }).eq('id', requestRow.id);
    await updateContact(admin, contact, { state: 'menu', context: { unlock_request_id: null, unlock_auth_attempts: 0 } });
    await sendText(contact.wa_id, safeSuccessMessage(requestRow.plate));
  } catch (error) {
    await failAndTransfer(admin, { ...requestRow, wa_id: contact.wa_id }, `Falha na API do simulador: ${error instanceof Error ? error.message : 'erro desconhecido'}.`);
  }
}

async function handleUnlockConfirmation(admin: any, contact: Record<string, any>, text: string) {
  const requestId = String(contact.context?.unlock_request_id || '');
  const { data: requestRow } = await admin.from('vehicle_unlock_requests').select('*')
    .eq('id', requestId).eq('whatsapp_contact_id', contact.id).maybeSingle();
  if (!requestRow || requestRow.status !== UNLOCK_STATES.AWAITING_CONFIRMATION) {
    await updateContact(admin, contact, { state: 'menu', context: { unlock_request_id: null, unlock_auth_attempts: 0 } });
    await sendText(contact.wa_id, 'Esta solicitação não está mais disponível. Digite MENU para começar novamente.');
    return;
  }
  const normalized = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  if (normalized === '2' || normalized === 'nao' || normalized === 'cancelar') {
    await admin.from('vehicle_unlock_requests').update({ status: UNLOCK_STATES.COMPLETED, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', requestRow.id);
    await updateContact(admin, contact, { state: 'menu', context: { unlock_request_id: null, unlock_auth_attempts: 0 } });
    await sendText(contact.wa_id, 'Solicitação de desbloqueio cancelada.');
    return;
  }
  if (!(normalized === '1' || normalized === 'sim' || normalized.includes('desbloquear'))) {
    await sendText(contact.wa_id, 'Responda 1 para SIM, DESBLOQUEAR ou 2 para NÃO.');
    return;
  }
  await executeAutomaticUnlock(admin, contact, requestRow);
}

async function handleMessage(admin: any, payload: Record<string, any>) {
  if (payload.fromMe || payload.isGroup || payload.isNewsletter || payload.broadcast || payload.notification) return;
  const rawPhone = String(payload.phone || '').trim();
  const lookupPhone = rawPhone.includes('@lid') ? '' : digits(rawPhone);
  const contactKey = rawPhone || String(payload.senderLid || '').trim();
  const text = inboundText(payload);
  const messageId = String(payload.messageId || '').trim();
  if (!contactKey || !messageId || !text) return;

  const { data: existingContact } = await admin.from('whatsapp_contacts').select('*').eq('wa_id', contactKey).maybeSingle();
  const protectedCredential = existingContact?.state === 'unlock_auth';
  const { error: duplicate } = await admin.from('whatsapp_message_events').insert({
    message_id: messageId, wa_id: contactKey, direction: 'inbound',
    event_status: String(payload.status || 'RECEIVED'),
    payload: protectedCredential
      ? { provider: 'zapi', message_id: messageId, credential_redacted: true }
      : { provider: 'zapi', ...payload },
  });
  if (duplicate?.code === '23505') return;
  if (duplicate) throw duplicate;

  const { data: settings } = await admin.from('whatsapp_bot_settings').select('*').eq('id', true).single();
  if (!settings?.enabled) return;

  const phoneValues = lookupPhone ? [`+${lookupPhone}`, lookupPhone] : [];
  let driver = null;
  if (phoneValues.length) {
    const { data: drivers } = await admin.from('external_driver_directory').select('*')
      .in('phone_e164', phoneValues).eq('active', true).order('synced_at', { ascending: false }).limit(1);
    driver = drivers?.[0] || null;
  }

  let contact;
  if (existingContact) {
    contact = await updateContact(admin, existingContact, {
      phone_e164: lookupPhone ? `+${lookupPhone}` : contactKey,
      external_driver_id: driver?.id || existingContact.external_driver_id || null,
      last_seen_at: new Date().toISOString(),
      context: { provider: 'zapi', sender_lid: payload.senderLid || payload.chatLid || null },
    });
  } else {
    const { data, error } = await admin.from('whatsapp_contacts').insert({
      wa_id: contactKey, phone_e164: lookupPhone ? `+${lookupPhone}` : contactKey,
      external_driver_id: driver?.id || null, last_seen_at: new Date().toISOString(),
      context: { provider: 'zapi', sender_lid: payload.senderLid || payload.chatLid || null },
    }).select('*').single();
    if (error) throw error;
    contact = data;
  }

  if (!driver) {
    await sendText(contactKey, settings.unknown_driver_message);
    return;
  }

  const { data: openSessions } = await admin.from('checklist_chat_sessions').select('id,operator_id')
    .eq('whatsapp_contact_id', contact.id).eq('active', true).order('created_at', { ascending: false }).limit(1);
  const openSession = openSessions?.[0];
  if (openSession) {
    await admin.from('checklist_chat_messages_v2').insert({ session_id: openSession.id, sender_type: 'driver', body: text });
    await admin.from('checklist_chat_sessions').update({ updated_at: new Date().toISOString() }).eq('id', openSession.id);
    return;
  }

  if (contact.state === 'unlock_auth') {
    await handleUnlockAuthentication(admin, contact, driver, text);
    return;
  }
  if (contact.state === 'unlock_confirm') {
    await handleUnlockConfirmation(admin, contact, text);
    return;
  }
  if (isUnlockIntent(text)) {
    await startUnlockFlow(admin, contact, driver, text);
    return;
  }
  if (!existingContact) {
    await sendText(contactKey, `${settings.greeting}\n\n${menu(driver)}`);
    return;
  }

  const normalized = text.toLocaleLowerCase('pt-BR');
  if (['menu', 'oi', 'olá', 'ola', 'início', 'inicio'].includes(normalized)) {
    await updateContact(admin, contact, { state: 'menu', context: { unlock_request_id: null, unlock_auth_attempts: 0 } });
    await sendText(contactKey, `${settings.greeting}\n\n${menu(driver)}`);
    return;
  }
  if (contact.state === 'awaiting_service') {
    if (normalized === '0') {
      await updateContact(admin, contact, { state: 'menu' });
      await sendText(contactKey, menu(driver));
      return;
    }
    const serviceKind = normalized === '1' || normalized.includes('monitor') ? 'monitoring' :
      normalized === '2' || normalized.includes('check') ? 'checklist' : null;
    if (!serviceKind) {
      await sendText(contactKey, 'Responda 1 para Monitoramento, 2 para Checklist ou 0 para voltar.');
      return;
    }
    const { data: routes, error } = await admin.rpc('route_whatsapp_chat', { contact_id: contact.id, service_kind: serviceKind });
    if (error) throw error;
    await sendText(contactKey, routes?.[0]?.notice || 'Não foi possível iniciar o atendimento agora.');
    return;
  }
  if (normalized === '2' || normalized.includes('operador') || normalized.includes('atendimento')) {
    await updateContact(admin, contact, { state: 'awaiting_service' });
    await sendText(contactKey, 'Qual atendimento você precisa?\n1 - Monitoramento\n2 - Checklist\n0 - Voltar ao menu');
    return;
  }
  if (normalized === '1') {
    await updateContact(admin, contact, { state: 'question' });
    await sendText(contactKey, 'Digite sua dúvida. Posso consultar os manuais cadastrados para sua tecnologia.');
    return;
  }

  const { data: answers, error: searchError } = await admin.rpc('search_bot_manuals', {
    question: text, driver_technology: driver.technology || null, result_limit: 2,
  });
  if (searchError) throw searchError;
  if (answers?.length) {
    const response = answers.map((answer: Record<string, any>) => `${answer.title}\n${answer.excerpt}`).join('\n\n');
    await sendText(contactKey, `${response}\n\nSe ainda precisar de ajuda, digite ATENDIMENTO.`);
  } else {
    await sendText(contactKey, settings.fallback_message);
  }
}

Deno.serve(async (request) => {
  if (request.method === 'GET') return new Response(JSON.stringify({ ok: true, provider: 'zapi' }), { status: 200, headers: jsonHeaders });
  if (request.method !== 'POST') return new Response('Método inválido', { status: 405 });
  try {
    const payload = await request.json();
    const configuredSecret = Deno.env.get('ZAPI_WEBHOOK_SECRET') || '';
    const suppliedSecret = new URL(request.url).searchParams.get('secret') || '';
    if (configuredSecret && suppliedSecret !== configuredSecret) return new Response(JSON.stringify({ error: 'Webhook não autorizado' }), { status: 401, headers: jsonHeaders });
    const expectedInstance = Deno.env.get('ZAPI_INSTANCE_ID') || '';
    if (expectedInstance && payload.instanceId && payload.instanceId !== expectedInstance) return new Response(JSON.stringify({ error: 'Instância não autorizada' }), { status: 401, headers: jsonHeaders });
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    await handleMessage(admin, payload);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: jsonHeaders });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Falha no webhook' }), { status: 500, headers: jsonHeaders });
  }
});
