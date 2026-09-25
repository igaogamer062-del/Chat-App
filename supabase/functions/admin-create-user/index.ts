import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
    const authorization = request.headers.get('Authorization') || '';
    const userClient = createClient(url, anon, { global: { headers: { Authorization: authorization } } });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) throw new Error('Sessão inválida');

    const admin = createClient(url, serviceRole, { auth: { persistSession: false } });
    const { data: manager } = await admin.from('profiles').select('access_role,active').eq('id', authData.user.id).single();
    if (!manager?.active || manager.access_role !== 'Gestor') throw new Error('Somente gestores podem criar usuários');

    const body = await request.json();
    const fullName = String(body.full_name || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const accessRole = body.access_role === 'Gestor' ? 'Gestor' : 'Operador';
    if (fullName.length < 3 || !email.includes('@') || password.length < 8) throw new Error('Dados de cadastro inválidos');

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });
    if (createError) throw createError;
    const { error: profileError } = await admin.from('profiles').upsert({
      id: created.user.id,
      username: email.split('@')[0],
      full_name: fullName,
      access_role: accessRole,
      chat_enabled: accessRole === 'Operador',
      active: true,
    });
    if (profileError) throw profileError;
    return new Response(JSON.stringify({ ok: true, user_id: created.user.id }), { headers: { ...cors, 'Content-Type': 'application/json' } });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Não foi possível criar o usuário' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
