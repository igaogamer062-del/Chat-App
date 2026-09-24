import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: cors });
const allowed = /^(image\/(jpeg|png|webp|gif)|audio\/(webm|ogg|mpeg|mp4|wav|x-wav)|video\/(mp4|webm|quicktime)|application\/pdf)$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'Método inválido' }, 405);
  try {
    if (Number(req.headers.get('content-length') || 0) > 27 * 1024 * 1024) return reply({ error: 'Arquivo muito grande' }, 413);
    const multipart = (req.headers.get('content-type') || '').includes('multipart/form-data');
    const body = multipart ? await req.formData() : await req.json();
    const get = (key: string) => multipart ? body.get(key) : body[key];
    const sessionId = String(get('session_id') || '');
    const chatToken = String(get('chat_token') || '');
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const sessionResult = await admin.from('checklist_chat_sessions').select('id,driver_token,operator_id,active').eq('id', sessionId).single();
    const session = sessionResult.data;
    if (sessionResult.error || !session) return reply({ error: 'Atendimento indisponível' }, 403);

    let operator = false;
    if (!chatToken || chatToken !== session.driver_token) {
      const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
      const userResult = await admin.auth.getUser(token);
      if (!userResult.data.user || userResult.data.user.id !== session.operator_id) return reply({ error: 'Acesso negado' }, 403);
      operator = true;
    }

    if (multipart) {
      if (!session.active) return reply({ error: 'Atendimento encerrado' }, 409);
      const file = get('file');
      if (!(file instanceof File) || file.size < 1 || file.size > 26214400) return reply({ error: 'Limite: 25 MB' }, 400);
      const type = file.type.split(';')[0];
      if (!allowed.test(type)) return reply({ error: 'Formato não permitido' }, 400);
      const path = sessionId + '/' + crypto.randomUUID();
      const saved = await admin.storage.from('checklist-chat-files').upload(path, file, { contentType: type, upsert: false });
      if (saved.error) throw saved.error;
      return reply({ path });
    }

    if (get('action') !== 'sign') return reply({ error: 'Ação inválida' }, 400);
    if (!operator && !session.active) return reply({ error: 'Este atendimento foi encerrado' }, 403);
    const path = String(get('path') || '');
    if (path.split('/')[0] !== sessionId) return reply({ error: 'Arquivo não pertence ao atendimento' }, 403);
    const signed = await admin.storage.from('checklist-chat-files').createSignedUrl(path, 300);
    if (signed.error) throw signed.error;
    return reply({ url: signed.data.signedUrl });
  } catch (error) {
    console.error('checklist-media', error instanceof Error ? error.message : error);
    return reply({ error: 'Não foi possível acessar o arquivo. Tente novamente.' }, 400);
  }
});
