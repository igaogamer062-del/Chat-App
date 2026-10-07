import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { cpfLast4, credentialHash } from '../_shared/unlock-core.mjs';

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
  for (const key of ['data', 'drivers', 'vehicles', 'reports', 'shipments', 'sms', 'items', 'results', 'records']) {
    const candidate = body[key];
    if (Array.isArray(candidate)) return candidate.map(asRecord).filter(Boolean) as JsonRecord[];
    const nested = asRecord(candidate);
    if (nested) {
      for (const nestedKey of ['data', 'drivers', 'vehicles', 'reports', 'shipments', 'sms', 'items', 'results', 'records']) {
        if (Array.isArray(nested[nestedKey])) return (nested[nestedKey] as unknown[]).map(asRecord).filter(Boolean) as JsonRecord[];
      }
    }
  }
  return [];
}

function firstTextFrom(sources: JsonRecord[], paths: string[]) {
  for (const source of sources) {
    const value = firstText(source, paths);
    if (value) return value;
  }
  return null;
}

function normalizedKey(value: unknown) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]/g, '');
}

function fieldNames(source: unknown, prefix = '', depth = 0): string[] {
  const object = asRecord(source);
  if (!object || depth > 1) return [];
  return Object.entries(object).flatMap(([key, value]) => {
    const field = prefix ? `${prefix}.${key}` : key;
    const nested = asRecord(value);
    return nested ? [field, ...fieldNames(nested, field, depth + 1)] : [field];
  }).sort();
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  const object = asRecord(value);
  if (!object) return value;
  return Object.fromEntries(Object.entries(object)
    .filter(([key]) => !['cpf', 'document', 'document_number', 'senha', 'password'].includes(key.toLocaleLowerCase('pt-BR')))
    .map(([key, nested]) => [key, redactSensitive(nested)]));
}

function driverIdentity(source: JsonRecord) {
  return {
    ids: [firstText(source, ['id', 'driver_id', 'driverId', 'external_id', 'uuid', 'codigo', 'driver.id', 'condutor.id'])]
      .filter(Boolean).map(normalizedKey),
    phone: normalizedKey(firstText(source, [
      'phone', 'phone_number', 'phoneNumber', 'mobile', 'telefone', 'celular', 'driver_phone', 'driverPhone',
      'driver.phone', 'condutor.telefone', 'condutor.celular',
    ])),
    name: normalizedKey(firstText(source, [
      'full_name', 'fullName', 'name', 'driver_name', 'driverName', 'nome', 'nome_completo', 'driver.name', 'condutor.nome',
    ])),
  };
}

function referencesDriver(source: JsonRecord, driver: JsonRecord) {
  const identity = driverIdentity(driver);
  const linkedId = normalizedKey(firstText(source, [
    'driver_id', 'driverId', 'driver.id', 'driver.uuid', 'condutor_id', 'condutorId', 'condutor.id', 'motorista_id', 'motorista.id',
  ]));
  const linkedPhone = normalizedKey(firstText(source, [
    'driver_phone', 'driverPhone', 'driver.phone', 'condutor.telefone', 'condutor.celular', 'telefone_condutor', 'motorista.telefone',
  ]));
  const linkedName = normalizedKey(firstText(source, [
    'driver_name', 'driverName', 'driver.name', 'condutor.nome', 'nome_condutor', 'motorista.nome',
  ]));
  return Boolean(
    (linkedId && identity.ids.includes(linkedId)) ||
    (identity.phone && linkedPhone === identity.phone) ||
    (identity.name && linkedName === identity.name)
  );
}

function findAssignment(driver: JsonRecord, assignments: JsonRecord[]) {
  return assignments.find((assignment) => referencesDriver(assignment, driver)) || null;
}

function findVehicle(driver: JsonRecord, vehicles: JsonRecord[], assignment: JsonRecord | null, knownPlate: string | null = null) {
  const storedPlate = normalizedKey(knownPlate);
  if (storedPlate) {
    const storedMatch = vehicles.find((vehicle) => normalizedKey(firstText(vehicle, ['plate', 'vehicle_plate', 'vehiclePlate', 'placa'])) === storedPlate);
    if (storedMatch) return storedMatch;
  }
  if (assignment) {
    const assignmentVehicleId = normalizedKey(firstText(assignment, [
      'vehicle_id', 'vehicleId', 'vehicle.id', 'veiculo_id', 'veiculoId', 'veiculo.id',
    ]));
    const assignmentPlate = normalizedKey(firstText(assignment, [
      'plate', 'vehicle_plate', 'vehiclePlate', 'placa', 'vehicle.plate', 'vehicle.placa', 'veiculo.placa',
    ]));
    const linked = vehicles.find((vehicle) => {
      const vehicleId = normalizedKey(firstText(vehicle, ['id', 'vehicle_id', 'vehicleId', 'uuid', 'codigo']));
      const vehiclePlate = normalizedKey(firstText(vehicle, ['plate', 'vehicle_plate', 'vehiclePlate', 'placa']));
      return Boolean((assignmentVehicleId && vehicleId === assignmentVehicleId) || (assignmentPlate && vehiclePlate === assignmentPlate));
    });
    if (linked) return linked;
  }
  const ids = [firstText(driver, ['id', 'driver_id', 'driverId', 'external_id', 'uuid', 'codigo'])].filter(Boolean).map(normalizedKey);
  const phone = normalizedKey(firstText(driver, ['phone', 'phone_number', 'phoneNumber', 'mobile', 'telefone', 'celular']));
  const name = normalizedKey(firstText(driver, ['full_name', 'fullName', 'name', 'driver_name', 'driverName', 'nome', 'nome_completo']));
  const direct = vehicles.find((vehicle) => {
    const vehicleDriverId = normalizedKey(firstText(vehicle, [
      'driver_id', 'driverId', 'driver.id', 'driver.uuid', 'condutor_id', 'condutorId', 'condutor.id',
    ]));
    const vehiclePhone = normalizedKey(firstText(vehicle, [
      'driver_phone', 'driverPhone', 'driver.phone', 'condutor.telefone', 'condutor.celular', 'telefone_condutor',
    ]));
    const vehicleName = normalizedKey(firstText(vehicle, [
      'driver_name', 'driverName', 'driver.name', 'condutor.nome', 'nome_condutor',
    ]));
    return Boolean((vehicleDriverId && ids.includes(vehicleDriverId)) || (phone && vehiclePhone === phone) || (name && vehicleName === name));
  }) || null;
  if (direct) return direct;

  const driverCarrier = normalizedKey(firstText(driver, [
    'carrier_id', 'carrierId', 'transporter_id', 'transporterId', 'transportadora_id', 'transportadoraId',
    'carrier_name', 'carrierName', 'carrier', 'transporter', 'transportadora', 'carrier.name', 'transportadora.nome',
  ]));
  if (!driverCarrier) return null;
  const sameCarrier = vehicles.filter((vehicle) => normalizedKey(firstText(vehicle, [
    'carrier_id', 'carrierId', 'transporter_id', 'transporterId', 'transportadora_id', 'transportadoraId',
    'carrier_name', 'carrierName', 'carrier', 'transporter', 'transportadora', 'carrier.name', 'transportadora.nome',
  ])) === driverCarrier);
  return sameCarrier.length === 1 ? sameCarrier[0] : null;
}

async function normalizeDriver(row: JsonRecord, assignment: JsonRecord | null, vehicle: JsonRecord | null, index: number, pepper: string) {
  const sources = [row, ...(assignment ? [assignment] : []), ...(vehicle ? [vehicle] : [])];
  const fullName = firstTextFrom(sources, [
    'full_name', 'fullName', 'name', 'driver_name', 'driverName', 'nome', 'nome_completo', 'driver', 'driver.name', 'condutor.nome',
  ]);
  if (!fullName || fullName.length < 2) return null;
  const carrierName = firstTextFrom(sources, [
    'carrier_name', 'carrierName', 'carrier', 'transportadora', 'transportadora_nome', 'transportadoraName',
    'transporter', 'transporter_name', 'transporterName', 'carrier.name', 'carrier.nome', 'transporter.name',
    'transportadora.nome', 'transportadora.name', 'transportadora.razao_social', 'company.name', 'companyName',
  ]);
  const externalId = firstText(row, ['id', 'driver_id', 'driverId', 'external_id', 'uuid', 'codigo', 'driver.id']) ||
    `${fullName.toLocaleLowerCase('pt-BR')}::${carrierName?.toLocaleLowerCase('pt-BR') || ''}::${index}`;
  const rawPhone = firstTextFrom(sources, [
    'phone', 'phone_number', 'phoneNumber', 'mobile', 'telefone', 'celular', 'driver_phone', 'driverPhone',
    'driver.phone', 'condutor.telefone', 'condutor.celular',
  ]);
  const phoneDigits = String(rawPhone || '').replace(/\D/g, '');
  const cpf = firstText(row, ['cpf', 'document', 'document_number', 'driver.cpf', 'condutor.cpf']);
  const last4 = cpfLast4(cpf);
  return {
    provider: 'lovable-alert-hub',
    external_id: externalId,
    full_name: fullName.replace(/\s+/g, ' '),
    carrier_name: carrierName?.replace(/\s+/g, ' ') || null,
    phone_e164: phoneDigits ? `+${phoneDigits.startsWith('55') ? phoneDigits : `55${phoneDigits}`}` : null,
    vehicle_plate: firstTextFrom(sources, [
      'plate', 'vehicle_plate', 'vehiclePlate', 'placa', 'vehicle.plate', 'vehicle.placa', 'veiculo.placa',
    ]),
    technology: firstTextFrom(sources, [
      'technology', 'technology.name', 'technology_name', 'technologyName', 'tracker_technology', 'trackerTechnology',
      'tracking_technology', 'trackingTechnology', 'tecnologia', 'tracker', 'tracker.name', 'tracker.technology',
      'rastreador', 'rastreador.nome', 'rastreador.tecnologia', 'veiculo.tecnologia',
    ]),
    external_vehicle_id: firstTextFrom([...(vehicle ? [vehicle] : []), ...(assignment ? [assignment] : [])], [
      'id', 'vehicle_id', 'vehicleId', 'uuid', 'codigo', 'vehicle.id', 'veiculo.id', 'veiculo_id', 'veiculoId',
    ]),
    cpf_last4_hash: last4 ? await credentialHash(last4, pepper) : null,
    active: row.active !== false && row.ativo !== false && row.status !== 'inactive' && row.status !== 'inativo',
    raw_payload: redactSensitive({ driver: row, assignment, vehicle }),
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
    const vehiclesPath = Deno.env.get('LOVABLE_VEHICLES_PATH') || '/api/public/v1/vehicles';
    const assignmentsPath = Deno.env.get('LOVABLE_ASSIGNMENTS_PATH') || '/api/public/v1/reports';
    const authPepper = Deno.env.get('SMART_CHAT_AUTH_PEPPER') || '';
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

    let vehicles: JsonRecord[] = [];
    const vehicleResponse = await fetch(`${externalBase}${vehiclesPath.startsWith('/') ? vehiclesPath : `/${vehiclesPath}`}`, {
      headers: { 'x-api-key': externalKey, Accept: 'application/json' },
    });
    if (vehicleResponse.ok) vehicles = listFromPayload(await vehicleResponse.json());

    let assignments: JsonRecord[] = [];
    const assignmentsResponse = await fetch(`${externalBase}${assignmentsPath.startsWith('/') ? assignmentsPath : `/${assignmentsPath}`}`, {
      headers: { 'x-api-key': externalKey, Accept: 'application/json' },
    });
    if (assignmentsResponse.ok) assignments = listFromPayload(await assignmentsResponse.json());

    const sourceExternalIds = rows.map((row) => firstText(row, ['id', 'driver_id', 'driverId', 'external_id', 'uuid', 'codigo', 'driver.id'])).filter(Boolean) as string[];
    const { data: existingRows, error: existingError } = await admin.from('external_driver_directory')
      .select('external_id,carrier_id,carrier_name,vehicle_plate,technology,external_vehicle_id,cpf_last4_hash')
      .eq('provider', 'lovable-alert-hub')
      .in('external_id', sourceExternalIds);
    if (existingError) throw existingError;
    const existingById = new Map((existingRows || []).map((row) => [row.external_id, row]));

    const normalized = (await Promise.all(rows.map((row, index) => {
      const assignment = findAssignment(row, assignments);
      const externalId = firstText(row, ['id', 'driver_id', 'driverId', 'external_id', 'uuid', 'codigo', 'driver.id']);
      const existing = externalId ? existingById.get(externalId) : null;
      return normalizeDriver(row, assignment, findVehicle(row, vehicles, assignment, existing?.vehicle_plate || null), index, authPepper);
    }))).filter(
      (row): row is NonNullable<ReturnType<typeof normalizeDriver>> => row !== null,
    );
    const ignored = rows.length - normalized.length;
    if (!normalized.length) throw new Error('Nenhum condutor válido foi encontrado na resposta da API');

    const carrierNames = [...new Set(normalized.map((row) => row.carrier_name).filter(Boolean))] as string[];
    const carrierByName = new Map<string, string>();
    if (carrierNames.length) {
      const { data: carriers, error } = await admin.from('carriers').select('id,name').eq('active', true);
      if (error) throw error;
      for (const carrier of carriers || []) carrierByName.set(normalizedKey(carrier.name), carrier.id);
    }

    const prepared = normalized.map((row) => ({
      ...row,
      carrier_id: row.carrier_name ? (() => {
        const wanted = normalizedKey(row.carrier_name);
        const exact = carrierByName.get(wanted);
        if (exact) return exact;
        const compatible = [...carrierByName.entries()].filter(([name]) => name.length > 4 && (name.includes(wanted) || wanted.includes(name)));
        return compatible.length === 1 ? compatible[0][1] : null;
      })() : null,
    }));
    const upserts = prepared.map((row) => {
      const existing = existingById.get(row.external_id);
      return {
        ...row,
        carrier_id: row.carrier_id || existing?.carrier_id || null,
        carrier_name: row.carrier_name || existing?.carrier_name || null,
        vehicle_plate: row.vehicle_plate || existing?.vehicle_plate || null,
        technology: row.technology || existing?.technology || null,
        external_vehicle_id: row.external_vehicle_id || existing?.external_vehicle_id || null,
        cpf_last4_hash: row.cpf_last4_hash || existing?.cpf_last4_hash || null,
      };
    });
    const { error: upsertError } = await admin.from('external_driver_directory').upsert(upserts, { onConflict: 'provider,external_id' });
    if (upsertError) throw upsertError;

    return new Response(JSON.stringify({
      ok: true,
      imported: upserts.length,
      ignored,
      vehicles_read: vehicles.length,
      assignments_read: assignments.length,
      with_phone: upserts.filter((row) => row.phone_e164).length,
      with_carrier: upserts.filter((row) => row.carrier_id).length,
      with_vehicle: upserts.filter((row) => row.vehicle_plate || row.technology).length,
      diagnostic_fields: {
        drivers: fieldNames(rows[0]),
        vehicles: fieldNames(vehicles[0]),
        assignments: fieldNames(assignments[0]),
      },
    }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : 'Falha na sincronização' }), {
      status: 400,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
});
