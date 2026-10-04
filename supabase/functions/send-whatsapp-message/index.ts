import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Content-Type': 'application/json',
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const authorization = request.headers.get('Authorization') || '';
    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authorization } },
    });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) throw new Error('Sessão inválida');

    const body = await request.json();
    const sessionId = String(body.session_id || '');
    const messageBody = String(body.body || '').trim();
    if (!sessionId || !messageBody) throw new Error('Mensagem inválida');

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false },
    });
    const { data: profile } = await admin.from('profiles').select('access_role,active').eq('id', authData.user.id).single();
    const { data: session } = await admin.from('checklist_chat_sessions')
      .select('operator_id,channel,whatsapp_contact:whatsapp_contacts(wa_id)')
      .eq('id', sessionId).single();
    if (!profile?.active || !session || (profile.access_role !== 'Gestor' && session.operator_id !== authData.user.id)) {
      throw new Error('Sem permissão para enviar esta mensagem');
    }
    if (session.channel !== 'whatsapp' || !session.whatsapp_contact?.wa_id) {
      return new Response(JSON.stringify({ ok: true, skipped: true }), { headers: cors });
    }

    const instanceId = Deno.env.get('ZAPI_INSTANCE_ID') || '';
    const instanceToken = Deno.env.get('ZAPI_INSTANCE_TOKEN') || '';
    const clientToken = Deno.env.get('ZAPI_CLIENT_TOKEN') || '';
    if (!instanceId || !instanceToken || !clientToken) throw new Error('Credenciais da Z-API não configuradas');

    const response = await fetch(
      `https://api.z-api.io/instances/${encodeURIComponent(instanceId)}/token/${encodeURIComponent(instanceToken)}/send-text`,
      {
        method: 'POST',
        headers: { 'Client-Token': clientToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: session.whatsapp_contact.wa_id, message: messageBody, delayTyping: 1 }),
      },
    );
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result?.error || result?.message || `Z-API respondeu ${response.status}`);
    const messageId = result?.messageId || result?.id || result?.zaapId;
    if (messageId) await admin.from('whatsapp_message_events').upsert({
      message_id: messageId,
      wa_id: session.whatsapp_contact.wa_id,
      direction: 'outbound',
      event_status: 'accepted',
      payload: { provider: 'zapi', ...result },
    });
    return new Response(JSON.stringify({ ok: true, message_id: messageId }), { headers: cors });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Falha no envio' }), {
      status: 400,
      headers: cors,
    });
  }
});
