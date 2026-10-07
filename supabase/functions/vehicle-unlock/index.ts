import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  API_FAILURE_MESSAGE,
  RACE_ALERT_MESSAGE,
  UNLOCK_STATES,
  parseAlertResponse,
  parseCommandResponse,
  safeSuccessMessage,
} from '../_shared/unlock-core.mjs';
import { sendGreenApiText } from '../_shared/green-api.ts';

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

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

async function sendText(to: string, message: string) {
  if (!to) return;
  await sendGreenApiText(to, message);
}

async function recordMessage(admin: any, requestRow: Record<string, any>, message: string) {
  if (requestRow.session_id) {
    await admin.from('checklist_chat_messages_v2').insert({ session_id: requestRow.session_id, sender_type: 'bot', body: message });
  }
  await sendText(requestRow.contact?.wa_id, message);
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers });
  try {
    const authorization = request.headers.get('Authorization') || '';
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, { global: { headers: { Authorization: authorization } } });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) throw new Error('Sessão inválida');

    const body = await request.json();
    const unlockRequestId = String(body.unlock_request_id || '');
    if (!unlockRequestId) throw new Error('Solicitação inválida');

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: profile } = await admin.from('profiles').select('access_role,active').eq('id', authData.user.id).single();
    const { data: requestRow, error: requestError } = await admin.from('vehicle_unlock_requests')
      .select('*,contact:whatsapp_contacts(wa_id)')
      .eq('id', unlockRequestId).single();
    if (requestError || !requestRow) throw new Error('Solicitação não encontrada');
    if (!profile?.active || (profile.access_role !== 'Gestor' && requestRow.operator_id !== authData.user.id)) {
      throw new Error('Sem permissão para executar este desbloqueio');
    }

    if (requestRow.status === UNLOCK_STATES.SENT) {
      return new Response(JSON.stringify({ ok: true, status: UNLOCK_STATES.SENT, message: safeSuccessMessage(requestRow.plate), idempotent: true }), { headers });
    }
    if (!requestRow.vehicle_id || !requestRow.plate) throw new Error('Veículo não identificado');

    let alert;
    try {
      alert = parseAlertResponse(await simulatorRequest(`/api/v1/vehicles/${encodeURIComponent(requestRow.vehicle_id)}/alerts/active`));
    } catch (error) {
      await admin.from('vehicle_unlock_requests').update({
        status: UNLOCK_STATES.FAILED,
        handoff_reason: `Falha ao consultar alertas: ${error instanceof Error ? error.message : 'erro desconhecido'}.`,
        updated_at: new Date().toISOString(),
      }).eq('id', requestRow.id);
      await recordMessage(admin, requestRow, API_FAILURE_MESSAGE);
      return new Response(JSON.stringify({ ok: false, status: UNLOCK_STATES.FAILED, message: API_FAILURE_MESSAGE }), { headers });
    }
    if (alert.active) {
      await admin.from('vehicle_unlock_requests').update({
        status: UNLOCK_STATES.BLOCKED, has_active_alert: true, alert_types: alert.alertTypes,
        handoff_reason: 'Operador tentou desbloquear, mas o alerta continua ativo.', updated_at: new Date().toISOString(),
      }).eq('id', requestRow.id);
      await recordMessage(admin, requestRow, RACE_ALERT_MESSAGE);
      return new Response(JSON.stringify({ ok: false, status: UNLOCK_STATES.BLOCKED, message: RACE_ALERT_MESSAGE }), { headers });
    }

    const { data: claimed } = await admin.from('vehicle_unlock_requests').update({
      status: UNLOCK_STATES.SENDING, updated_at: new Date().toISOString(),
    }).eq('id', requestRow.id).eq('status', requestRow.status).select('id').maybeSingle();
    if (!claimed) {
      const { data: current } = await admin.from('vehicle_unlock_requests').select('status').eq('id', requestRow.id).single();
      return new Response(JSON.stringify({ ok: current?.status === UNLOCK_STATES.SENT, status: current?.status, idempotent: true, message: 'Solicitação já processada ou em processamento.' }), { headers });
    }

    let resultPayload;
    try {
      resultPayload = await simulatorRequest('/api/v1/commands/unlock', {
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
    } catch (error) {
      await admin.from('vehicle_unlock_requests').update({
        status: UNLOCK_STATES.FAILED,
        handoff_reason: `Falha ao enviar comando: ${error instanceof Error ? error.message : 'erro desconhecido'}.`,
        updated_at: new Date().toISOString(),
      }).eq('id', requestRow.id);
      await recordMessage(admin, requestRow, API_FAILURE_MESSAGE);
      return new Response(JSON.stringify({ ok: false, status: UNLOCK_STATES.FAILED, message: API_FAILURE_MESSAGE }), { headers });
    }
    const result = parseCommandResponse(resultPayload);
    if (result.kind === 'blocked') {
      await admin.from('vehicle_unlock_requests').update({
        status: UNLOCK_STATES.BLOCKED, has_active_alert: true, command_result: resultPayload,
        handoff_reason: 'Simulador bloqueou o comando por alerta ativo.', updated_at: new Date().toISOString(),
      }).eq('id', requestRow.id);
      await recordMessage(admin, requestRow, RACE_ALERT_MESSAGE);
      return new Response(JSON.stringify({ ok: false, status: UNLOCK_STATES.BLOCKED, message: RACE_ALERT_MESSAGE }), { headers });
    }
    if (result.kind !== 'sent') {
      await admin.from('vehicle_unlock_requests').update({ status: UNLOCK_STATES.FAILED, command_result: resultPayload, updated_at: new Date().toISOString() }).eq('id', requestRow.id);
      await recordMessage(admin, requestRow, API_FAILURE_MESSAGE);
      return new Response(JSON.stringify({ ok: false, status: UNLOCK_STATES.FAILED, message: API_FAILURE_MESSAGE }), { headers });
    }

    const message = safeSuccessMessage(requestRow.plate);
    await admin.from('vehicle_unlock_requests').update({
      status: UNLOCK_STATES.SENT, has_active_alert: false,
      command_sent_at: new Date().toISOString(), completed_at: new Date().toISOString(),
      command_result: resultPayload, updated_at: new Date().toISOString(),
    }).eq('id', requestRow.id);
    await admin.from('whatsapp_contacts').update({
      state: 'post_command',
      last_seen_at: new Date().toISOString(),
    }).eq('id', requestRow.whatsapp_contact_id);
    await recordMessage(admin, requestRow, message);
    return new Response(JSON.stringify({ ok: true, status: UNLOCK_STATES.SENT, message }), { headers });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : 'Falha no desbloqueio' }), { status: 400, headers });
  }
});
