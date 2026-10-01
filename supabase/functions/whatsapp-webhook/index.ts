import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = { 'Content-Type': 'application/json' };
const encoder = new TextEncoder();

function digits(value: unknown) {
  return String(value || '').replace(/\D/g, '');
}

function inboundText(message: Record<string, any>) {
  if (message.type === 'text') return String(message.text?.body || '').trim();
  if (message.type === 'button') return String(message.button?.text || message.button?.payload || '').trim();
  if (message.type === 'interactive') {
    return String(message.interactive?.button_reply?.title || message.interactive?.button_reply?.id ||
      message.interactive?.list_reply?.title || message.interactive?.list_reply?.id || '').trim();
  }
  return '';
}

async function validSignature(request: Request, rawBody: string) {
  const appSecret = Deno.env.get('WHATSAPP_APP_SECRET') || '';
  const signature = request.headers.get('x-hub-signature-256') || '';
  if (!appSecret || !signature.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', encoder.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(rawBody));
  const expected = `sha256=${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ signature.charCodeAt(index);
  return mismatch === 0;
}

async function sendText(to: string, body: string) {
  const accessToken = Deno.env.get('WHATSAPP_ACCESS_TOKEN') || '';
  const phoneNumberId = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || '';
  const graphVersion = Deno.env.get('WHATSAPP_GRAPH_VERSION') || 'v26.0';
  if (!accessToken || !phoneNumberId) throw new Error('Credenciais de envio do WhatsApp não configuradas');
  const pieces = String(body).match(/[\s\S]{1,3900}/g) || [];
  for (const piece of pieces) {
    const response = await fetch(`https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body: piece } }),
    });
    if (!response.ok) throw new Error(`Falha ao responder pelo WhatsApp (${response.status})`);
  }
}

function menu(driver: Record<string, any>) {
  const data = [
    `Nome: ${driver.full_name}`,
    driver.carrier_name ? `Transportadora: ${driver.carrier_name}` : null,
    driver.vehicle_plate ? `Placa: ${driver.vehicle_plate}` : null,
    driver.technology ? `Tecnologia: ${driver.technology}` : null,
  ].filter(Boolean).join('\n');
  return `${data}\n\nComo posso ajudar?\n1 - Tirar uma dúvida\n2 - Falar com um operador\nDigite MENU a qualquer momento para voltar aqui.`;
}

async function handleMessage(admin: any, message: Record<string, any>) {
  const waId = digits(message.from);
  const text = inboundText(message);
  if (!waId || !message.id || !text) return;

  const { error: duplicate } = await admin.from('whatsapp_message_events').insert({
    message_id: message.id, wa_id: waId, direction: 'inbound', payload: message,
  });
  if (duplicate?.code === '23505') return;
  if (duplicate) throw duplicate;

  const { data: settings } = await admin.from('whatsapp_bot_settings').select('*').eq('id', true).single();
  if (!settings?.enabled) return;

  const phoneValues = [`+${waId}`, waId];
  const { data: drivers } = await admin.from('external_driver_directory').select('*')
    .in('phone_e164', phoneValues).eq('active', true).order('synced_at', { ascending: false }).limit(1);
  const driver = drivers?.[0] || null;

  const { data: existingContact } = await admin.from('whatsapp_contacts').select('id').eq('wa_id', waId).maybeSingle();

  const { data: contact, error: contactError } = await admin.from('whatsapp_contacts').upsert({
    wa_id: waId,
    phone_e164: `+${waId}`,
    external_driver_id: driver?.id || null,
    last_seen_at: new Date().toISOString(),
  }, { onConflict: 'wa_id' }).select('*').single();
  if (contactError) throw contactError;

  if (!driver) {
    await sendText(waId, settings.unknown_driver_message);
    return;
  }

  if (!existingContact) {
    await sendText(waId, `${settings.greeting}\n\n${menu(driver)}`);
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

  const normalized = text.toLocaleLowerCase('pt-BR');
  if (normalized === 'menu' || normalized === 'oi' || normalized === 'olá' || normalized === 'ola' || normalized === 'início' || normalized === 'inicio') {
    await admin.from('whatsapp_contacts').update({ state: 'menu' }).eq('id', contact.id);
    await sendText(waId, `${settings.greeting}\n\n${menu(driver)}`);
    return;
  }

  if (contact.state === 'awaiting_service') {
    if (normalized === '0') {
      await admin.from('whatsapp_contacts').update({ state: 'menu' }).eq('id', contact.id);
      await sendText(waId, menu(driver));
      return;
    }
    const serviceKind = normalized === '1' || normalized.includes('monitor') ? 'monitoring' :
      normalized === '2' || normalized.includes('check') ? 'checklist' : null;
    if (!serviceKind) {
      await sendText(waId, 'Responda 1 para Monitoramento, 2 para Checklist ou 0 para voltar.');
      return;
    }
    const { data: routes, error } = await admin.rpc('route_whatsapp_chat', { contact_id: contact.id, service_kind: serviceKind });
    if (error) throw error;
    const route = routes?.[0];
    await sendText(waId, route?.notice || 'Não foi possível iniciar o atendimento agora.');
    return;
  }

  if (normalized === '2' || normalized.includes('operador') || normalized.includes('atendimento')) {
    await admin.from('whatsapp_contacts').update({ state: 'awaiting_service' }).eq('id', contact.id);
    await sendText(waId, 'Qual atendimento você precisa?\n1 - Monitoramento\n2 - Checklist\n0 - Voltar ao menu');
    return;
  }

  if (normalized === '1') {
    await admin.from('whatsapp_contacts').update({ state: 'question' }).eq('id', contact.id);
    await sendText(waId, 'Digite sua dúvida. Posso consultar os manuais cadastrados para sua tecnologia.');
    return;
  }

  const { data: answers, error: searchError } = await admin.rpc('search_bot_manuals', {
    question: text,
    driver_technology: driver.technology || null,
    result_limit: 2,
  });
  if (searchError) throw searchError;
  if (answers?.length) {
    const response = answers.map((answer: Record<string, any>) => `${answer.title}\n${answer.excerpt}`).join('\n\n');
    await sendText(waId, `${response}\n\nSe ainda precisar de ajuda, digite ATENDIMENTO.`);
  } else {
    await sendText(waId, settings.fallback_message);
  }
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    const mode = url.searchParams.get('hub.mode');
    const token = url.searchParams.get('hub.verify_token');
    const challenge = url.searchParams.get('hub.challenge') || '';
    if (mode === 'subscribe' && token === Deno.env.get('WHATSAPP_VERIFY_TOKEN')) {
      return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Token de verificação inválido', { status: 403 });
  }
  if (request.method !== 'POST') return new Response('Método inválido', { status: 405 });

  const rawBody = await request.text();
  if (!await validSignature(request, rawBody)) return new Response('Assinatura inválida', { status: 401 });

  try {
    const payload = JSON.parse(rawBody);
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false },
    });
    for (const entry of payload.entry || []) {
      for (const change of entry.changes || []) {
        for (const message of change.value?.messages || []) await handleMessage(admin, message);
        for (const status of change.value?.statuses || []) {
          if (!status.id) continue;
          await admin.from('whatsapp_message_events').upsert({
            message_id: `${status.id}:${status.status}`,
            wa_id: digits(status.recipient_id),
            direction: 'status',
            event_status: status.status,
            payload: status,
          });
        }
      }
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: cors });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Falha no webhook' }), { status: 500, headers: cors });
  }
});
