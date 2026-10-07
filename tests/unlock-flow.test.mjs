import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  UNLOCK_STATES,
  credentialHash,
  isUnlockIntent,
  parseCommandResponse,
  runUnlockCommand,
  safeSuccessMessage,
  validateCpfCredential,
} from '../supabase/functions/_shared/unlock-core.mjs';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('1. desbloqueio sem alerta envia o comando ao veículo', async () => {
  let calls = 0;
  const result = await runUnlockCommand({
    checkAlerts: async () => ({ has_active_alert: false }),
    sendCommand: async () => { calls += 1; return { status: 'SENT_TO_VEHICLE' }; },
  });
  assert.equal(result.kind, 'sent');
  assert.equal(calls, 1);
});

test('2. alerta ativo bloqueia sem chamar o comando', async () => {
  let calls = 0;
  const result = await runUnlockCommand({
    checkAlerts: async () => ({ has_active_alert: true, alerts: [{ type: 'PANIC_BUTTON' }] }),
    sendCommand: async () => { calls += 1; return { status: 'SENT_TO_VEHICLE' }; },
  });
  assert.equal(result.status, UNLOCK_STATES.BLOCKED);
  assert.deepEqual(result.alertTypes, ['PANIC_BUTTON']);
  assert.equal(calls, 0);
});

test('3. simulador bloqueia quando o alerta surge entre consulta e POST', async () => {
  const result = await runUnlockCommand({
    checkAlerts: async () => ({ has_active_alert: false }),
    sendCommand: async () => ({ status: 'BLOCKED_BY_ACTIVE_ALERT' }),
  });
  assert.equal(result.kind, 'blocked');
  assert.equal(result.commandCalled, true);
});

test('4. os quatro dígitos corretos autenticam o condutor', async () => {
  const pepper = 'teste-local-seguro';
  const expected = await credentialHash('8942', pepper);
  assert.equal((await validateCpfCredential('8942', expected, pepper)).valid, true);
});

test('5. senha incorreta é recusada sem revelar a correta', async () => {
  const pepper = 'teste-local-seguro';
  const expected = await credentialHash('8942', pepper);
  const result = await validateCpfCredential('1111', expected, pepper);
  assert.equal(result.valid, false);
  assert.equal(result.locked, false);
});

test('6. terceira tentativa incorreta bloqueia a autenticação', async () => {
  const pepper = 'teste-local-seguro';
  const expected = await credentialHash('8942', pepper);
  const result = await validateCpfCredential('1111', expected, pepper, 2, 3);
  assert.equal(result.locked, true);
  assert.equal(result.attempts, 3);
});

test('7. condutor não identificado não entra no desbloqueio', () => {
  const webhook = read('supabase/functions/whatsapp-webhook/index.ts');
  assert.match(webhook, /if \(!driver\)/);
  assert.match(webhook, /unknown_driver_message/);
});

test('8. veículo ausente transfere o atendimento sem consultar comando', () => {
  const webhook = read('supabase/functions/whatsapp-webhook/index.ts');
  assert.match(webhook, /if \(!requestRow\.vehicle_id \|\| !requestRow\.plate\)/);
  assert.match(webhook, /Veículo não identificado para consulta de segurança/);
});

test('9. indisponibilidade da API é propagada para o fallback seguro', async () => {
  await assert.rejects(() => runUnlockCommand({
    checkAlerts: async () => { throw new Error('offline'); },
    sendCommand: async () => ({ status: 'SENT_TO_VEHICLE' }),
  }), /offline/);
  assert.match(read('supabase/functions/whatsapp-webhook/index.ts'), /Falha ao consultar alertas/);
});

test('10. resposta FAILED nunca é interpretada como sucesso', () => {
  assert.equal(parseCommandResponse({ status: 'FAILED' }).kind, 'failed');
});

test('11. SENT_TO_VEHICLE é interpretado como comando enviado', () => {
  assert.equal(parseCommandResponse({ status: 'SENT_TO_VEHICLE' }).kind, 'sent');
});

test('12. retry de request concluído usa resultado idempotente', () => {
  const operatorEdge = read('supabase/functions/vehicle-unlock/index.ts');
  assert.match(operatorEdge, /requestRow\.status === UNLOCK_STATES\.SENT/);
  assert.match(operatorEdge, /idempotent: true/);
  assert.match(read('supabase/028_vehicle_unlock_flow.sql'), /request_id text not null unique/);
});

test('13. handoff registra o contexto completo para o operador', () => {
  const sql = read('supabase/028_vehicle_unlock_flow.sql');
  for (const field of ['Condutor:', 'Telefone:', 'Placa:', 'Transportadora:', 'Intenção:', 'Alerta ativo:', 'Tipo do alerta:', 'Request ID:']) {
    assert.match(sql, new RegExp(field));
  }
});

test('14. alerta ativo é verificado antes da solicitação de CPF', () => {
  const webhook = read('supabase/functions/whatsapp-webhook/index.ts');
  assert.ok(webhook.indexOf('checkActiveAlerts(requestRow.vehicle_id)') < webhook.indexOf("state: 'unlock_auth'"));
});

test('15. sucesso não afirma que o veículo já foi desbloqueado', () => {
  const message = safeSuccessMessage('IKX4440');
  assert.match(message, /comando de desbloqueio foi enviado/i);
  assert.doesNotMatch(message, /veículo desbloqueado/i);
});

test('16. chave do simulador não aparece no frontend', () => {
  const frontend = read('painel/app.js') + read('painel/config.js') + read('painel/index.html');
  assert.doesNotMatch(frontend, /SIMULATOR_API_KEY|x-api-key/i);
  assert.match(read('supabase/functions/whatsapp-webhook/index.ts'), /Deno\.env\.get\('SIMULATOR_API_KEY'\)/);
});

test('17. os quatro dígitos do CPF são persistidos somente como hash', () => {
  const migration = read('supabase/028_vehicle_unlock_flow.sql');
  const sync = read('supabase/functions/lovable-driver-sync/index.ts');
  assert.match(migration, /cpf_last4_hash text/);
  assert.doesNotMatch(migration, /cpf_last4\s+text/);
  assert.match(sync, /credentialHash/);
  assert.match(sync, /redactSensitive/);
  assert.match(read('supabase/functions/whatsapp-webhook/index.ts'), /credential_redacted: true/);
});

test('intenção de desbloqueio é reconhecida sem menu', () => {
  for (const phrase of [
    'preciso desbloquear', 'meu caminhão está bloqueado', 'libera meu caminhão',
    'preciso liberar o veículo', 'desbloqueio', 'meu veículo está travado',
    'pode desbloquear?', 'quero desbloquear meu caminhão',
  ]) assert.equal(isUnlockIntent(phrase), true, phrase);
});
