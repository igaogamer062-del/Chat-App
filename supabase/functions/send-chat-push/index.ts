import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const publicKey = Deno.env.get('VAPID_PUBLIC_KEY')!;
    const privateKey = Deno.env.get('VAPID_PRIVATE_KEY')!;
    const subject = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@example.com';
    const authorization = request.headers.get('Authorization') || '';
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) throw new Error('Sessão inválida');

    const admin = createClient(url, serviceRole, { auth: { persistSession: false } });
    const { session_id, body, title } = await request.json();
    const { data: session } = await admin.from('checklist_chat_sessions').select('driver_account_id,operator_id,active').eq('id', session_id).single();
    if (!session || session.operator_id !== authData.user.id) throw new Error('Atendimento não autorizado');
    const { data: subscriptions } = await admin.from('driver_push_subscriptions').select('id,subscription').eq('driver_account_id', session.driver_account_id).eq('active', true);
    webpush.setVapidDetails(subject, publicKey, privateKey);
    let delivered = 0;
    for (const row of subscriptions || []) {
      try {
        await webpush.sendNotification(row.subscription, JSON.stringify({
          title: title || 'Smart Chat',
          body: body || 'Você recebeu uma nova mensagem.',
          tag: 'smart-chat-' + session_id,
        }));
        delivered += 1;
      } catch (error) {
        const status = Number((error as { statusCode?: number }).statusCode || 0);
        if (status === 404 || status === 410) await admin.from('driver_push_subscriptions').update({ active: false }).eq('id', row.id);
      }
    }
    return new Response(JSON.stringify({ ok: true, delivered }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Falha ao enviar notificação' }), { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
