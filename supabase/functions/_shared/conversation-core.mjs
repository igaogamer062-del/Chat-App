export function normalizeConversationText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

export function isGreeting(value) {
  const text = normalizeConversationText(value);
  return /^(oi+|ola+|bom dia|boa tarde|boa noite|e ai|opa|inicio|menu)[!.? ]*$/.test(text);
}

export function isAttendanceIntent(value) {
  const text = normalizeConversationText(value);
  return /\b(atendimento|atendente|operador|falar com (a )?central|falar com alguem|suporte humano)\b/.test(text);
}

export function isHelpIntent(value) {
  const text = normalizeConversationText(value);
  return /\b(duvida|duvidas|ajuda|orientacao|orientar|como funciona)\b/.test(text);
}

export function isKeyboardIntent(value) {
  const text = normalizeConversationText(value);
  return /\b(teclado|terminal|display|tela|mensagem no equipamento)\b/.test(text);
}

export function requestedDriverData(value) {
  const text = normalizeConversationText(value);
  if (/\b(meus dados|meu cadastro|dados cadastrados|dados do motorista|dados do condutor)\b/.test(text)) return 'all';
  if (/^(placa|tecnologia|rastreador|transportadora|empresa|nome)[?.! ]*$/.test(text)) {
    if (text.startsWith('placa')) return 'plate';
    if (text.startsWith('tecnologia') || text.startsWith('rastreador')) return 'technology';
    if (text.startsWith('transportadora') || text.startsWith('empresa')) return 'carrier';
    return 'name';
  }
  if (/\b(qual|informe|mostrar?|ver)\b.{0,24}\b(placa)\b|\bminha placa\b/.test(text)) return 'plate';
  if (/\b(qual|informe|mostrar?|ver)\b.{0,24}\b(tecnologia|rastreador)\b|\bminha tecnologia\b/.test(text)) return 'technology';
  if (/\b(qual|informe|mostrar?|ver)\b.{0,24}\b(transportadora|empresa)\b|\bminha transportadora\b/.test(text)) return 'carrier';
  if (/\b(qual|informe|mostrar?|ver)\b.{0,24}\b(nome)\b|\bmeu nome\b/.test(text)) return 'name';
  return null;
}

export function driverDataAnswer(driver, request) {
  const values = {
    name: `Nome: ${driver.full_name || 'Não informado'}`,
    carrier: `Transportadora: ${driver.carrier_name || 'Não informada'}`,
    plate: `Placa: ${driver.vehicle_plate || 'Não informada'}`,
    technology: `Tecnologia: ${driver.technology || 'Não informada'}`,
  };
  return request === 'all'
    ? [values.name, values.carrier, values.plate, values.technology].join('\n')
    : values[request] || '';
}

const TRACKING_TERMS = /\b(rastreamento|rastreador|tecnologia|macro|macros|sinal|gps|satelite|telemetria|terminal|teclado|display|tela|inicio de viagem|fim de viagem|omnilink|sascar|autotrac|onixsat|positron|bloqueio|bloqueado|desbloqueio|desbloquear|veiculo|caminhao|placa|panico|botao de panico|isca|sensor|ignicao|comando|monitoramento|checklist)\b/;

export function isTrackingQuestion(value) {
  return TRACKING_TERMS.test(normalizeConversationText(value));
}

export function conversationalGreeting(configuredGreeting) {
  const greeting = String(configuredGreeting || '').trim();
  if (!greeting) return 'Olá! Como posso ajudar?';
  if (/como posso ajudar\??$/i.test(greeting)) return greeting;
  return `${greeting}\n\nComo posso ajudar?`;
}

export const SCOPE_MESSAGE = 'Posso ajudar com rastreamento, tecnologia embarcada, macros, bloqueio e desbloqueio, checklist e atendimento operacional. Me conte o que aconteceu com o veículo.';

export const HELP_MESSAGE = 'Posso ajudar com rastreamento, teclado, macros, tecnologia embarcada, bloqueio e desbloqueio. Em que posso ajudar?';

export const ATTENDANCE_OPTIONS = 'Certo. Qual tipo de atendimento você precisa?\n\n1 - Monitoramento\n2 - Checklist';

export const COMMAND_OPTIONS = 'Qual comando você precisa enviar ao veículo?\n\n1 - Desbloqueio';
