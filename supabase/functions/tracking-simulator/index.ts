import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const headers = { 'Content-Type': 'application/json' };
const reply = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers });

function endpointPath(request: Request) {
  const pathname = new URL(request.url).pathname;
  const marker = '/tracking-simulator';
  const index = pathname.indexOf(marker);
  return index >= 0 ? pathname.slice(index + marker.length) || '/' : pathname;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers });

  const configuredKey = Deno.env.get('SIMULATOR_API_KEY') || '';
  const suppliedKey = request.headers.get('x-api-key') || '';
  if (!configuredKey || suppliedKey !== configuredKey) {
    return reply(401, { error: 'Chave do simulador inválida' });
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );
  const path = endpointPath(request);

  try {
    const alertMatch = path.match(/^\/api\/v1\/vehicles\/([^/]+)\/alerts\/active$/);
    if (request.method === 'GET' && alertMatch) {
      const vehicleId = decodeURIComponent(alertMatch[1]);
      const { data, error } = await admin.from('tracking_simulator_alerts')
        .select('id,alert_type,created_at')
        .eq('vehicle_id', vehicleId)
        .eq('active', true)
        .order('created_at', { ascending: false });
      if (error) throw error;
      const alerts = (data || []).map((row: Record<string, unknown>) => ({
        id: row.id, type: row.alert_type, created_at: row.created_at,
      }));
      return reply(200, { has_active_alert: alerts.length > 0, alerts });
    }

    if (request.method === 'POST' && path === '/api/v1/commands/unlock') {
      const body = await request.json();
      const requestId = String(body?.request_id || '').trim();
      const vehicleId = String(body?.vehicle_id || '').trim();
      const command = String(body?.command || '').trim().toUpperCase();
      if (!requestId || !vehicleId || command !== 'UNLOCK') {
        return reply(400, { error: 'Solicitação de comando inválida' });
      }

      const { data: previous } = await admin.from('tracking_simulator_commands')
        .select('status').eq('request_id', requestId).maybeSingle();
      if (previous) return reply(200, { status: previous.status, idempotent: true });

      const { count, error: alertError } = await admin.from('tracking_simulator_alerts')
        .select('id', { count: 'exact', head: true })
        .eq('vehicle_id', vehicleId).eq('active', true);
      if (alertError) throw alertError;
      const status = Number(count || 0) > 0 ? 'BLOCKED_BY_ACTIVE_ALERT' : 'SENT_TO_VEHICLE';

      const { error } = await admin.from('tracking_simulator_commands').insert({
        request_id: requestId,
        vehicle_id: vehicleId,
        plate: body?.plate || null,
        driver_id: body?.driver_id ? String(body.driver_id) : null,
        command,
        source: body?.source || 'SMART_CHAT',
        status,
        payload: body,
      });
      if (error) throw error;
      return reply(200, { status });
    }

    return reply(404, { error: 'Endpoint não encontrado' });
  } catch (error) {
    console.error(error);
    return reply(500, { error: error instanceof Error ? error.message : 'Falha no simulador' });
  }
});
