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

test('Supabase public configuration is present in both clients', () => {
  for (const file of ['painel/config.js', 'driver-app/config.js']) {
    const config = read(file);
    assert.match(config, /https:\/\/[a-z0-9]+\.supabase\.co/);
    assert.match(config, /sb_publishable_/);
    assert.doesNotMatch(config, /SEU-PROJETO|SUA-CHAVE/);
    assert.doesNotMatch(config, /service_role/);
  }
});

test('PWA manifest and service worker use existing local assets', () => {
  const manifest = JSON.parse(read('driver-app/manifest.webmanifest'));
  assert.equal(manifest.name, 'Smart Chat');
  assert.equal(manifest.display, 'standalone');
  for (const icon of manifest.icons) assert.ok(fs.existsSync(path.join(root, 'driver-app', icon.src)), icon.src);
  const sw = read('driver-app/sw.js');
  assert.doesNotMatch(sw, /images\/icons/);
});

test('the occurrence password SQL qualifies pgcrypto functions', () => {
  const sql = read('supabase/013_driver_pwa_login_and_results.sql');
  assert.match(sql, /extensions\.crypt/);
  assert.match(sql, /extensions\.gen_salt/);
});

test('complete flows include rescheduling, rejection items and operator routing', () => {
  const sql = read('supabase/016_complete_service_flows.sql');
  assert.match(sql, /'Reagendado'/);
  assert.match(sql, /failed_items text\[\]/);
  assert.match(sql, /base_operators/);
  const panel = read('painel/app.js');
  assert.match(panel, /finish_checklist_chat_complete/);
  assert.match(panel, /Encaminhar ao operador/);
});

test('Google Sheets synchronization expects the supplied columns', () => {
  const fn = read('supabase/functions/fleet-sheet-sync/index.ts');
  assert.match(fn, /Transportadora/i);
  assert.match(fn, /1U2RyPFX83muXk5Goal1_HrQnoOpfXLGado_LOLsLS1w/);
  assert.match(fn, /mock_fleet_drivers/);
});

test('operator panel renders driver attachments', () => {
  assert.match(read('painel/index.html'), /checklist-media\.js/);
  assert.match(read('painel/app.js'), /ChecklistMedia\.render/);
});

test('PWA restores the driver session behind a native launch screen', () => {
  assert.match(read('driver-app/index.html'), /id="launch-screen"/);
  assert.match(read('driver-app/app.js'), /localStorage\.getItem\(SESSION\)/);
  assert.match(read('driver-app/app.js'), /visibilitychange/);
  assert.doesNotMatch(read('driver-app/index.html'), /id="install-settings"/);
});

test('routing is constrained by base and unavailable queues are rejected', () => {
  const sql = read('supabase/019_smart_chat_roles_routing_admin.sql');
  assert.match(sql, /lower\(name\)=lower\('Checklist'\)/);
  assert.match(sql, /join public\.base_operators/);
  assert.match(sql, /Não há atendentes disponíveis no momento/);
  assert.match(sql, /access_role in \('Operador','Gestor'\)/);
});

test('management includes install guide, user chat toggle and history', () => {
  const panel = read('painel/app.js');
  assert.match(panel, /renderInstalacao/);
  assert.match(panel, /renderHistorico/);
  assert.match(panel, /admin_set_user_chat/);
  assert.match(panel, /admin-create-user/);
});
