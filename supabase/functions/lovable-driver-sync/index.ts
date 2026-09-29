import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function readPath(source: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => asRecord(value)?.[key], source);
}

function firstText(source: JsonRecord, paths: string[]): string | null {
  for (const path of paths) {
    const value = readPath(source, path);
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return null;
}

function listFromPayload(payload: unknown): JsonRecord[] {
  if (Array.isArray(payload)) return payload.map(asRecord).filter(Boolean) as JsonRecord[];
  const body = asRecord(payload);
  if (!body) return [];
  for (const key of ['data', 'drivers', 'items', 'results', 'records']) {
    const candidate = body[key];
    if (Array.isArray(candidate)) return candidate.map(asRecord).filter(Boolean) as JsonRecord[];
    const nested = asRecord(candidate);
    if (nested) {
      for (const nestedKey of ['data', 'drivers', 'items', 'results', 'records']) {
        if (Array.isArray(nested[nestedKey])) return (nested[nestedKey] as unknown[]).map(asRecord).filter(Boolean) as JsonRecord[];
      }
    }
  }
  return [];
}

function normalizeDriver(row: JsonRecord, index: number) {
  const fullName = firstText(row, ['full_name', 'name', 'driver_name', 'nome', 'nome_completo', 'driver.name', 'condutor.nome']);
  if (!fullName || fullName.length < 2) return null;
  const carrierName = firstText(row, [
    'carrier_name', 'transportadora', 'transporter_name', 'carrier.name',
    'transporter.name', 'transportadora.nome', 'company.name',
  ]);
  const externalId = firstText(row, ['id', 'driver_id', 'external_id', 'uuid', 'codigo', 'driver.id']) ||
    `${fullName.toLocaleLowerCase('pt-BR')}::${carrierName?.toLocaleLowerCase('pt-BR') || ''}::${index}`;
  return {
    provider: 'lovable-alert-hub',
    external_id: externalId,
    full_name: fullName.replace(/\s+/g, ' '),
    carrier_name: carrierName?.replace(/\s+/g, ' ') || null,
    active: row.active !== false && row.ativo !== false && row.status !== 'inactive' && row.status !== 'inativo',
    raw_payload: row,
    synced_at: new Date().toISOString(),
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const externalBase = (Deno.env.get('LOVABLE_API_BASE_URL') || '').replace(/\/$/, '');
    const externalKey = Deno.env.get('LOVABLE_API_KEY') || '';
    const driversPath = Deno.env.get('LOVABLE_DRIVERS_PATH') || '/api/public/v1/drivers';
    if (!externalBase || !externalKey) throw new Error('Configure LOVABLE_API_BASE_URL e LOVABLE_API_KEY nos segredos do Supabase');

    const authorization = request.headers.get('Authorization') || '';
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } });
    const { data: authData, error: authError } = await userClient.auth.getUser();
    if (authError || !authData.user) throw new Error('Sessão inválida');

    const admin = createClient(supabaseUrl, serviceRole, { auth: { persistSession: false } });
    const { data: manager } = await admin.from('profiles').select('access_role,active').eq('id', authData.user.id).single();
    if (!manager?.active || manager.access_role !== 'Gestor') throw new Error('Somente gestores podem sincronizar condutores');

    const response = await fetch(`${externalBase}${driversPath.startsWith('/') ? driversPath : `/${driversPath}`}`, {
      headers: { 'x-api-key': externalKey, Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`A API externa respondeu ${response.status}`);
    const payload = await response.json();
    const rows = listFromPayload(payload);
    if (!rows.length) throw new Error('A API não retornou uma lista de condutores reconhecível');

    const normalized = rows.map(normalizeDriver).filter(
      (row): row is NonNullable<ReturnType<typeof normalizeDriver>> => row !== null,
    );
    const ignored = rows.length - normalized.length;
    if (!normalized.length) throw new Error('Nenhum condutor válido foi encontrado na resposta da API');

    const carrierNames = [...new Set(normalized.map((row) => row.carrier_name).filter(Boolean))] as string[];
    const carrierByName = new Map<string, string>();
    if (carrierNames.length) {
      const { data: carriers, error } = await admin.from('carriers').select('id,name').eq('active', true);
      if (error) throw error;
      for (const carrier of carriers || []) carrierByName.set(String(carrier.name).trim().toLocaleLowerCase('pt-BR'), carrier.id);
    }

    const upserts = normalized.map((row) => ({
      ...row,
      carrier_id: row.carrier_name ? carrierByName.get(row.carrier_name.toLocaleLowerCase('pt-BR')) || null : null,
    }));
    const { error: upsertError } = await admin.from('external_driver_directory').upsert(upserts, { onConflict: 'provider,external_id' });
    if (upsertError) throw upsertError;

    return new Response(JSON.stringify({ ok: true, imported: upserts.length, ignored }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Falha na sincronização' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
