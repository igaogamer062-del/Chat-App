import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('GitHub Pages opens the staff login directly', () => {
  const html = read('index.html');
  assert.match(html, /location\.replace\('painel\/'\)/);
  assert.doesNotMatch(html, /README\.md/);
});

test('Supabase public configuration exists only in the staff panel', () => {
  const config = read('painel/config.js');
  assert.match(config, /https:\/\/[a-z0-9]+\.supabase\.co/);
  assert.match(config, /sb_publishable_/);
  assert.doesNotMatch(config, /SEU-PROJETO|SUA-CHAVE|service_role/);
  assert.equal(fs.existsSync(path.join(root, 'driver-app')), false);
});

test('the occurrence password SQL qualifies pgcrypto functions', () => {
  const sql = read('supabase/013_driver_pwa_login_and_results.sql');
  assert.match(sql, /extensions\.crypt/);
  assert.match(sql, /extensions\.gen_salt/);
});

test('complete flows include rescheduling, rejection items and routed operator handling', () => {
  const sql = read('supabase/016_complete_service_flows.sql');
  assert.match(sql, /'Reagendado'/);
  assert.match(sql, /failed_items text\[\]/);
  assert.match(sql, /base_operators/);
  const panel = read('painel/app.js');
  assert.match(panel, /finish_checklist_chat_complete/);
  assert.match(panel, /not\('operator_id', 'is', null\)/);
  assert.doesNotMatch(panel, /Encaminhar ao operador/);
});

test('carrier management supports permanent deletion, base linking and file import', () => {
  const panel = read('painel/app.js');
  const sql = read('supabase/023_carriers_management.sql');
  assert.match(panel, /carrier-import-file/);
  assert.match(panel, /accept="\.txt,text\/plain,\.pdf,application\/pdf"/);
  assert.match(panel, /admin_set_carrier_base/);
  assert.match(panel, /admin_delete_carrier/);
  assert.match(sql, /carrier_name_snapshot/);
  assert.match(sql, /on delete set null/i);
  assert.match(sql, /admin_bulk_upsert_carriers/);
  assert.doesNotMatch(panel, /Sincronizar planilha Google|docs\.google\.com\/spreadsheets/);
  assert.equal(fs.existsSync(path.join(root, 'supabase/functions/fleet-sheet-sync/index.ts')), false);
});

test('operator panel renders driver attachments', () => {
  assert.match(read('painel/index.html'), /checklist-media\.js/);
  assert.match(read('painel/app.js'), /ChecklistMedia\.render/);
});

test('routing is constrained by base and unavailable queues are rejected', () => {
  const sql = read('supabase/019_smart_chat_roles_routing_admin.sql');
  assert.match(sql, /lower\(name\)=lower\('Checklist'\)/);
  assert.match(sql, /join public\.base_operators/);
  assert.match(sql, /Não há atendentes disponíveis no momento/);
  assert.match(sql, /access_role in \('Operador','Gestor'\)/);
});

test('management includes user chat toggle and history without exposing the legacy PWA', () => {
  const panel = read('painel/app.js');
  assert.match(panel, /renderHistorico/);
  assert.match(panel, /admin_set_user_chat/);
  assert.match(panel, /admin-create-user/);
  assert.doesNotMatch(panel, /renderInstalacao|Instalar aplicativo/);
});

test('chat polling preserves typed text and the finish form', () => {
  const panel = read('painel/app.js');
  assert.match(panel, /setInterval\(\(\) => \{ loadQueue\(\); if \(selectedSession\) refreshThreadMessages/);
  assert.match(panel, /body\.dataset\.signature === signature/);
  assert.doesNotMatch(panel, /setInterval\(\(\) => \{ loadQueue\(\); if \(selectedSession\) loadThread/);
});

test('operators receive a private dashboard and their own history', () => {
  const panel = read('painel/app.js');
  const sql = read('supabase/020_operator_dashboard.sql');
  assert.match(panel, /operator_dashboard_metrics/);
  assert.match(panel, /query = query\.eq\('operator_id', me\.id\)/);
  assert.match(sql, /s\.operator_id=auth\.uid\(\)/);
  assert.match(sql, /\('Operador','dashboard_view',true\)/);
});

test('history opens the complete conversation with messages and attachments', () => {
  const panel = read('painel/app.js');
  assert.match(panel, /Ver conversa/);
  assert.match(panel, /openHistoryConversation/);
  assert.match(panel, /checklist_chat_messages_v2/);
  assert.match(panel, /data-history-message/);
  assert.match(panel, /ChecklistMedia\.render/);
});

test('Lovable driver API stays behind a Supabase Edge Function', () => {
  const panel = read('painel/app.js');
  const edge = read('supabase/functions/lovable-driver-sync/index.ts');
  const sql = read('supabase/024_lovable_driver_integration.sql');
  assert.match(panel, /functions\.invoke\('lovable-driver-sync'/);
  assert.doesNotMatch(panel, /sr_live_|LOVABLE_API_KEY/);
  assert.match(edge, /LOVABLE_API_BASE_URL/);
  assert.match(edge, /LOVABLE_API_KEY/);
  assert.match(edge, /x-api-key/);
  assert.match(sql, /external_driver_directory/);
  assert.match(sql, /lower\(regexp_replace\(trim\(d\.full_name\)/);
  assert.doesNotMatch(sql, /mock_fleet_drivers f/);
});

test('the whole staff panel supports persistent dark and light themes', () => {
  const html = read('painel/index.html');
  const panel = read('painel/app.js');
  const css = read('painel/app.css');
  assert.match(html, /smart-chat-theme/);
  assert.match(panel, /function applyTheme/);
  assert.match(css, /:root\[data-theme="dark"\]/);
  assert.match(css, /:root\[data-theme="light"\]/);
});

test('unrouted conversations are not exposed in the staff chat queue', () => {
  const panel = read('painel/app.js');
  assert.doesNotMatch(panel, /NÃO ROTEADOS|data-claim|claim_unrouted_session/);
  assert.match(panel, /not\('operator_id', 'is', null\)/);
});

test('WhatsApp migration decommissions mobile auth without deleting chat history', () => {
  const sql = read('supabase/025_whatsapp_bot.sql');
  assert.match(sql, /drop function if exists public\.start_mobile_smart_chat/);
  assert.match(sql, /drop table if exists public\.mobile_driver_profiles/);
  assert.match(sql, /create table if not exists public\.whatsapp_contacts/);
  assert.match(sql, /create table if not exists public\.bot_manuals/);
  assert.doesNotMatch(sql, /drop table.*checklist_chat_sessions/i);
  assert.doesNotMatch(sql, /drop table.*checklist_chat_messages_v2/i);
});

test('Z-API webhook validates instance and secret and routes support', () => {
  const webhook = read('supabase/functions/whatsapp-webhook/index.ts');
  assert.match(webhook, /ZAPI_INSTANCE_ID/);
  assert.match(webhook, /ZAPI_WEBHOOK_SECRET/);
  assert.match(webhook, /api\.z-api\.io/);
  assert.match(webhook, /text\?\.message/);
  assert.match(webhook, /route_whatsapp_chat/);
  assert.match(webhook, /search_bot_manuals/);
  assert.match(webhook, /external_driver_directory/);
});

test('WhatsApp routing skips unavailable operators and randomly selects an available operator from the base', () => {
  const sql = read('supabase/027_random_operator_routing.sql');
  assert.match(sql, /bo\.base_id=target_base/);
  assert.match(sql, /operator_enabled/);
  assert.match(sql, /last_seen_at>now\(\)-interval '5 minutes'/);
  assert.match(sql, /order by random\(\)/);
  assert.doesNotMatch(sql, /order by\s*\(\s*select count/i);
});

test('operator replies are sent to WhatsApp and bot manuals are manageable', () => {
  const panel = read('painel/app.js');
  const sender = read('supabase/functions/send-whatsapp-message/index.ts');
  assert.match(panel, /send-whatsapp-message/);
  assert.match(panel, /renderBot/);
  assert.match(panel, /manualTextFromFile/);
  assert.match(panel, /bot_manuals/);
  assert.match(sender, /ZAPI_INSTANCE_TOKEN/);
  assert.match(sender, /Client-Token/);
  assert.match(sender, /api\.z-api\.io/);
  assert.equal(fs.existsSync(path.join(root, 'supabase/functions/send-chat-push')), false);
});

test('future bot engine remains an isolated inactive prototype', () => {
  const engine = read('motor-bot/index.html');
  assert.match(engine, /Ambiente inativo/);
  assert.match(engine, /Sem conexão com produção/);
  assert.doesNotMatch(engine, /supabase-js|config\.js|app\.js/);
});
