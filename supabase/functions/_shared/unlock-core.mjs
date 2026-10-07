export const UNLOCK_STATES = Object.freeze({
  REQUESTED: 'UNLOCK_REQUESTED',
  ALERT_CHECKING: 'ALERT_CHECKING',
  BLOCKED: 'BLOCKED_BY_ACTIVE_ALERT',
  AUTH_REQUIRED: 'AUTHENTICATION_REQUIRED',
  AUTHENTICATED: 'AUTHENTICATED',
  AWAITING_CONFIRMATION: 'AWAITING_CONFIRMATION',
  SENDING: 'COMMAND_SENDING',
  SENT: 'COMMAND_SENT_TO_VEHICLE',
  FAILED: 'COMMAND_FAILED',
  TRANSFERRED: 'TRANSFERRED_TO_OPERATOR',
  COMPLETED: 'COMPLETED',
});

const UNLOCK_PATTERNS = [
  /\bdesbloque(ar|io|ado|ada)?\b/i,
  /\b(liberar?|libera)\b.{0,30}\b(caminh[aã]o|ve[ií]culo|carro|truck)\b/i,
  /\b(caminh[aã]o|ve[ií]culo|carro|truck)\b.{0,30}\b(bloqueado|travado|liberar?|libera)\b/i,
];

export function isUnlockIntent(text) {
  const normalized = String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  return UNLOCK_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

export function cpfLast4(value) {
  const valueDigits = onlyDigits(value);
  return valueDigits.length === 11 ? valueDigits.slice(-4) : null;
}

export async function credentialHash(last4, pepper) {
  if (!/^\d{4}$/.test(String(last4 || '')) || !pepper) return null;
  const bytes = new TextEncoder().encode(`${pepper}:${last4}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function validateCpfCredential(input, expectedHash, pepper, previousAttempts = 0, maxAttempts = 3) {
  const nextAttempts = Math.min(maxAttempts, Number(previousAttempts || 0) + 1);
  const candidate = onlyDigits(input);
  const candidateHash = candidate.length === 4 ? await credentialHash(candidate, pepper) : null;
  const valid = Boolean(candidateHash && expectedHash && candidateHash === expectedHash);
  return {
    valid,
    attempts: valid ? Number(previousAttempts || 0) : nextAttempts,
    locked: !valid && nextAttempts >= maxAttempts,
  };
}

function collectAlertTypes(payload) {
  const candidates = [payload?.alerts, payload?.active_alerts, payload?.data?.alerts, payload?.data?.active_alerts];
  const alerts = candidates.find(Array.isArray) || [];
  return [...new Set(alerts.map((alert) => String(
    alert?.type || alert?.alert_type || alert?.code || alert?.name || alert,
  ).trim()).filter(Boolean))];
}

export function parseAlertResponse(payload) {
  const alertTypes = collectAlertTypes(payload || {});
  const active = Boolean(
    payload?.has_active_alert ?? payload?.active ?? payload?.data?.has_active_alert ?? payload?.data?.active ?? alertTypes.length,
  );
  return { active, alertTypes };
}

export function parseCommandResponse(payload) {
  const status = String(payload?.status || payload?.data?.status || payload?.result || '').toUpperCase();
  if (status === 'SENT_TO_VEHICLE') return { kind: 'sent', status };
  if (status === 'BLOCKED_BY_ACTIVE_ALERT') return { kind: 'blocked', status };
  return { kind: 'failed', status: status || 'FAILED' };
}

export async function runUnlockCommand({ checkAlerts, sendCommand }) {
  const alert = parseAlertResponse(await checkAlerts());
  if (alert.active) return { kind: 'blocked', status: UNLOCK_STATES.BLOCKED, alertTypes: alert.alertTypes, commandCalled: false };
  const command = parseCommandResponse(await sendCommand());
  return { ...command, commandCalled: true };
}

export function safeSuccessMessage(plate) {
  return `✓ O comando de desbloqueio foi enviado para o veículo ${plate}.\n\nAguarde alguns instantes para a atualização.`;
}

export const ACTIVE_ALERT_MESSAGE = 'Identifiquei uma ocorrência/alerta ativo relacionado ao seu veículo.\n\nPara sua segurança, não vou enviar o comando de desbloqueio automaticamente.\n\nAguarde um momento. Vou transferir seu atendimento para um operador para realizar a tratativa.';
export const RACE_ALERT_MESSAGE = 'Identifiquei um alerta ativo no veículo durante a solicitação.\n\nPor segurança, não vou enviar o comando de desbloqueio.\n\nAguarde um momento enquanto transfiro você para um operador.';
export const API_FAILURE_MESSAGE = 'Não consegui concluir a solicitação automaticamente neste momento.\n\nAguarde um momento enquanto transfiro você para um operador.';
