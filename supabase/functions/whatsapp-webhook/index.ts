import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const jsonHeaders = { 'Content-Type': 'application/json' };

function digits(value: unknown) {
  return String(value || '').replace(/\D/g, '');
}

function inboundText(payload: Record<string, any>) {
  return String(
    payload.text?.message ||
    payload.buttonsResponseMessage?.message ||
    payload.buttonsResponseMessage?.buttonId ||
    payload.listResponseMessage?.title ||
    payload.listResponseMessage?.message ||
    payload.listResponseMessage?.selectedRowId ||
    '',
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
      {
        method: 'POST',
        headers: { 'Client-Token': clientToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: to, message: piece, delayTyping: 1 }),
      },
    );
    lastResult = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(lastResult?.error || lastResult?.message || `Z-API respondeu ${response.status}`);
  }
  return lastResult;
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

async function handleMessage(admin: any, payload: Record<string, any>) {
  if (payload.fromMe || payload.isGroup || payload.isNewsletter || payload.broadcast || payload.notification) return;

  const rawPhone = String(payload.phone || '').trim();
  const lookupPhone = rawPhone.includes('@lid') ? '' : digits(rawPhone);
  const contactKey = rawPhone || String(payload.senderLid || '').trim();
  const text = inboundText(payload);
  const messageId = String(payload.messageId || '').trim();
  if (!contactKey || !messageId || !text) return;

  const { error: duplicate } = await admin.from('whatsapp_message_events').insert({
    message_id: messageId,
    wa_id: contactKey,
    direction: 'inbound',
    event_status: String(payload.status || 'RECEIVED'),
    payload: { provider: 'zapi', ...payload },
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

  const { data: existingContact } = await admin.from('whatsapp_contacts').select('id').eq('wa_id', contactKey).maybeSingle();
  const { data: contact, error: contactError } = await admin.from('whatsapp_contacts').upsert({
    wa_id: contactKey,
    phone_e164: lookupPhone ? `+${lookupPhone}` : contactKey,
    external_driver_id: driver?.id || null,
    last_seen_at: new Date().toISOString(),
    context: { provider: 'zapi', sender_lid: payload.senderLid || payload.chatLid || null },
  }, { onConflict: 'wa_id' }).select('*').single();
  if (contactError) throw contactError;

  if (!driver) {
    await sendText(contactKey, settings.unknown_driver_message);
    return;
  }

  if (!existingContact) {
    await sendText(contactKey, `${settings.greeting}\n\n${menu(driver)}`);
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
  if (['menu', 'oi', 'olá', 'ola', 'início', 'inicio'].includes(normalized)) {
    await admin.from('whatsapp_contacts').update({ state: 'menu' }).eq('id', contact.id);
    await sendText(contactKey, `${settings.greeting}\n\n${menu(driver)}`);
    return;
  }

  if (contact.state === 'awaiting_service') {
    if (normalized === '0') {
      await admin.from('whatsapp_contacts').update({ state: 'menu' }).eq('id', contact.id);
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
    const route = routes?.[0];
    await sendText(contactKey, route?.notice || 'Não foi possível iniciar o atendimento agora.');
    return;
  }

  if (normalized === '2' || normalized.includes('operador') || normalized.includes('atendimento')) {
    await admin.from('whatsapp_contacts').update({ state: 'awaiting_service' }).eq('id', contact.id);
    await sendText(contactKey, 'Qual atendimento você precisa?\n1 - Monitoramento\n2 - Checklist\n0 - Voltar ao menu');
    return;
  }

  if (normalized === '1') {
    await admin.from('whatsapp_contacts').update({ state: 'question' }).eq('id', contact.id);
    await sendText(contactKey, 'Digite sua dúvida. Posso consultar os manuais cadastrados para sua tecnologia.');
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
    await sendText(contactKey, `${response}\n\nSe ainda precisar de ajuda, digite ATENDIMENTO.`);
  } else {
    await sendText(contactKey, settings.fallback_message);
  }
}

Deno.serve(async (request) => {
  if (request.method === 'GET') {
    return new Response(JSON.stringify({ ok: true, provider: 'zapi' }), { status: 200, headers: jsonHeaders });
  }
  if (request.method !== 'POST') return new Response('Método inválido', { status: 405 });

  try {
    const payload = await request.json();
    const configuredSecret = Deno.env.get('ZAPI_WEBHOOK_SECRET') || '';
    const suppliedSecret = new URL(request.url).searchParams.get('secret') || '';
    if (configuredSecret && suppliedSecret !== configuredSecret) {
      return new Response(JSON.stringify({ error: 'Webhook não autorizado' }), { status: 401, headers: jsonHeaders });
    }
    const expectedInstance = Deno.env.get('ZAPI_INSTANCE_ID') || '';
    if (expectedInstance && payload.instanceId && payload.instanceId !== expectedInstance) {
      return new Response(JSON.stringify({ error: 'Instância não autorizada' }), { status: 401, headers: jsonHeaders });
    }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
      auth: { persistSession: false },
    });
    await handleMessage(admin, payload);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: jsonHeaders });
  } catch (error) {
    console.error(error);
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Falha no webhook' }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
