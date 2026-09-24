import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization,apikey,content-type,x-client-info',
  'Access-Control-Allow-Methods': 'POST,OPTIONS',
};
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: cors });
const defaultSheetUrl = 'https://docs.google.com/spreadsheets/d/1U2RyPFX83muXk5Goal1_HrQnoOpfXLGado_LOLsLS1w/export?format=csv&gid=0';

function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { cell += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(cell.trim()); cell = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell.trim());
      if (row.some(Boolean)) rows.push(row);
      row = []; cell = '';
    } else cell += char;
  }
  row.push(cell.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

const normalize = (value: string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return json({ error: 'Método não permitido' }, 405);
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  try {
    const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const authResult = await admin.auth.getUser(token);
    if (!authResult.data.user) return json({ error: 'Faça login novamente.' }, 401);
    const profileResult = await admin.from('profiles').select('access_role,active').eq('id', authResult.data.user.id).maybeSingle();
    if (!profileResult.data?.active || !['Administrador', 'Gerente'].includes(profileResult.data.access_role)) {
      return json({ error: 'Somente Administrador ou Gerente pode sincronizar a planilha.' }, 403);
    }

    const sheetUrl = Deno.env.get('FLEET_SHEET_CSV_URL') || defaultSheetUrl;
    const response = await fetch(sheetUrl, { headers: { 'User-Agent': 'SmartChatFleetSync/1.0' } });
    if (!response.ok) return json({ error: 'Não foi possível acessar a planilha compartilhada.' }, 502);
    const rows = parseCsv(await response.text());
    if (rows.length < 2) return json({ error: 'A planilha não possui registros.' }, 400);
    const headers = rows.shift()!.map(normalize);
    const indexes = {
      carrier: headers.indexOf('transportadora'),
      plate: headers.indexOf('placa'),
      driver: headers.indexOf('condutor'),
      technology: headers.indexOf('tecnologia'),
    };
    if (Object.values(indexes).some((index) => index < 0)) {
      return json({ error: 'Use as colunas Transportadora, Placa, Condutor e Tecnologia.' }, 400);
    }

    const carrierResult = await admin.from('carriers').select('id,name');
    if (carrierResult.error) throw carrierResult.error;
    const carriers = new Map((carrierResult.data || []).map((item) => [normalize(item.name), item]));
    let imported = 0, ignored = 0, createdCarriers = 0;
    for (const columns of rows) {
      const carrierName = columns[indexes.carrier]?.trim();
      const plate = (columns[indexes.plate] || '').toUpperCase().replace(/[-\s]/g, '');
      if (!carrierName || !/^[A-Z]{3}[0-9][A-Z0-9][0-9]{2}$/.test(plate)) { ignored += 1; continue; }
      const key = normalize(carrierName);
      let carrier = carriers.get(key);
      if (!carrier) {
        const created = await admin.from('carriers').insert({ name: carrierName }).select('id,name').single();
        if (created.error) throw created.error;
        carrier = created.data;
        carriers.set(key, carrier);
        createdCarriers += 1;
      }
      const saved = await admin.from('mock_fleet_drivers').upsert({
        plate,
        driver_name: columns[indexes.driver]?.trim() || null,
        technology: columns[indexes.technology]?.trim() || null,
        carrier_id: carrier.id,
      }, { onConflict: 'plate' });
      if (saved.error) throw saved.error;
      imported += 1;
    }
    return json({ imported, ignored, created_carriers: createdCarriers, source: 'Google Sheets', synced_at: new Date().toISOString() });
  } catch (error) {
    console.error('fleet-sheet-sync', error instanceof Error ? error.message : error);
    return json({ error: error instanceof Error ? error.message : 'Falha ao sincronizar a planilha.' }, 500);
  }
});
