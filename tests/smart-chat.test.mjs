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

test('desktop Enter sends chat messages while mobile Enter keeps a line break', () => {
  const panel = read('painel/app.js');
  assert.match(panel, /thread-input'\)\.onkeydown/);
  assert.match(panel, /navigator\.userAgentData\?\.mobile/);
  assert.match(panel, /e\.key !== 'Enter'/);
  assert.match(panel, /e\.currentTarget\.form\.requestSubmit\(\)/);
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

test('GREEN-API webhook validates instance and secret and routes support', () => {
  const webhook = read('supabase/functions/whatsapp-webhook/index.ts');
  const provider = read('supabase/functions/_shared/green-api.ts');
  assert.match(webhook, /GREEN_API_ID_INSTANCE/);
  assert.match(webhook, /GREEN_API_WEBHOOK_TOKEN/);
  assert.match(provider, /api\.green-api\.com/);
  assert.match(webhook, /textMessageData\?\.textMessage/);
  assert.match(webhook, /incomingMessageReceived/);
  assert.match(webhook, /route_whatsapp_chat/);
  assert.match(webhook, /search_bot_manuals/);
  assert.match(webhook, /external_driver_directory/);
});

test('WhatsApp routing skips unavailable operators and randomly selects an available operator from the base', () => {
  const sql = read('supabase/031_live_operator_presence_and_command_routing.sql');
  assert.match(sql, /bo\.base_id=target_base/);
  assert.match(sql, /operator_enabled/);
  assert.match(sql, /p\.chat_available/);
  assert.match(sql, /p\.chat_presence_at>now\(\)-interval '75 seconds'/);
  assert.match(sql, /order by random\(\)/);
  assert.doesNotMatch(sql, /operador habilitado e aparece quando ele entrar/i);
});

test('operator presence follows the visible authenticated panel and stale chats are reassigned', () => {
  const panel = read('painel/app.js');
  const sql = read('supabase/031_live_operator_presence_and_command_routing.sql');
  assert.match(panel, /set_chat_presence/);
  assert.match(panel, /visibilitychange/);
  assert.match(panel, /pagehide/);
  assert.match(panel, /20000/);
  assert.match(sql, /chat_available=false/);
  assert.match(sql, /for update of s skip locked/);
  assert.match(sql, /operator_id=current_user_id/);
});

test('bot converses first and only shows options or driver data when requested', async () => {
  const webhook = read('supabase/functions/whatsapp-webhook/index.ts');
  const core = read('supabase/functions/_shared/unlock-core.mjs');
  const conversation = await import('../supabase/functions/_shared/conversation-core.mjs');
  assert.doesNotMatch(webhook, /Como posso ajudar\?\s*\\n1 - Tirar uma dúvida/);
  assert.equal(conversation.conversationalGreeting('Olá! Sou o assistente da Central Smart Risk.'), 'Olá! Sou o assistente da Central Smart Risk.\n\nComo posso ajudar?');
  assert.equal(conversation.isAttendanceIntent('quero atendimento'), true);
  assert.match(conversation.ATTENDANCE_OPTIONS, /Monitoramento/);
  assert.match(conversation.driverDataAnswer({ full_name: 'Ygor', vehicle_plate: 'IKX4440' }, 'plate'), /IKX4440/);
  assert.match(webhook, /state: 'awaiting_command'/);
  assert.match(webhook, /state: 'post_command'/);
  assert.match(webhook, /state: 'closed'/);
  assert.match(core, /Precisa de ajuda com algo mais/);
});

test('WhatsApp waiting queue never assigns disconnected operators or expires immediately', () => {
  const sql = read('supabase/032_reliable_whatsapp_queue_and_simulator.sql');
  assert.match(sql, /s\.channel<>'whatsapp'/);
  assert.match(sql, /p\.chat_available/);
  assert.match(sql, /p\.chat_presence_at>now\(\)-interval '75 seconds'/);
  assert.match(sql, /order by random\(\)/);
  assert.doesNotMatch(sql, /p\.last_seen_at>now\(\)-interval '2 minutes'/);
});

test('internal command simulator validates its key and supports alert and unlock endpoints', () => {
  const simulator = read('supabase/functions/tracking-simulator/index.ts');
  const sql = read('supabase/032_reliable_whatsapp_queue_and_simulator.sql');
  assert.match(simulator, /SIMULATOR_API_KEY/);
  assert.match(simulator, /alerts\\\/active/);
  assert.match(simulator, /commands\/unlock/);
  assert.match(simulator, /SENT_TO_VEHICLE/);
  assert.match(sql, /tracking_simulator_commands/);
});

test('operator replies are sent to WhatsApp and bot manuals are manageable', () => {
  const panel = read('painel/app.js');
  const sender = read('supabase/functions/send-whatsapp-message/index.ts');
  assert.match(panel, /send-whatsapp-message/);
  assert.match(panel, /renderBot/);
  assert.match(panel, /manualTextFromFile/);
  assert.match(panel, /bot_manuals/);
  assert.match(sender, /sendGreenApiText/);
  assert.match(read('supabase/functions/_shared/green-api.ts'), /GREEN_API_TOKEN_INSTANCE/);
  assert.match(read('supabase/functions/_shared/green-api.ts'), /sendMessage/);
  assert.equal(fs.existsSync(path.join(root, 'supabase/functions/send-chat-push')), false);
});

test('manuals accept TXT, searchable PDF and Word DOCX', () => {
  const panel = read('painel/app.js');
  const sql = read('supabase/033_manual_search_and_whatsapp_media.sql');
  assert.match(panel, /mammoth@1\.8\.0\/mammoth\.browser\.min\.js/);
  assert.match(panel, /extractRawText/);
  assert.match(panel, /\.docx,application\/vnd\.openxmlformats/);
  assert.match(panel, /pdfjs-dist/);
  assert.match(sql, /loose_query/);
  assert.match(sql, /replace\(plainto_tsquery/);
});

test('keyboard help asks technology before searching the manuals', async () => {
  const webhook = read('supabase/functions/whatsapp-webhook/index.ts');
  const conversation = await import('../supabase/functions/_shared/conversation-core.mjs');
  assert.equal(conversation.isKeyboardIntent('preciso de ajuda no teclado'), true);
  assert.match(webhook, /awaiting_keyboard_technology/);
  assert.match(webhook, /Qual é a tecnologia do rastreador/);
  assert.match(webhook, /awaiting_keyboard_question/);
  assert.match(webhook, /manual_technology/);
});

test('WhatsApp media and live location are stored in the operator conversation and history', () => {
  const webhook = read('supabase/functions/whatsapp-webhook/index.ts');
  const renderer = read('js/checklist-media.js');
  assert.match(webhook, /locationMessageData/);
  assert.match(webhook, /fileMessageData/);
  assert.match(webhook, /checklist-chat-files/);
  assert.match(webhook, /attachment,/);
  assert.match(renderer, /attachment\.kind==='location'/);
  assert.match(renderer, /google\.com\/maps/);
});

test('future bot engine remains an isolated inactive prototype', () => {
  const engine = read('motor-bot/index.html');
  assert.match(engine, /Ambiente inativo/);
  assert.match(engine, /Sem conexão com produção/);
  assert.doesNotMatch(engine, /supabase-js|config\.js|app\.js/);
});
