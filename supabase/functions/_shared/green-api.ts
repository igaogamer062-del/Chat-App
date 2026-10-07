const DEFAULT_GREEN_API_URL = 'https://api.green-api.com';

export function greenApiCredentials() {
  const apiUrl = (Deno.env.get('GREEN_API_URL') || DEFAULT_GREEN_API_URL).replace(/\/$/, '');
  const idInstance = Deno.env.get('GREEN_API_ID_INSTANCE') || '';
  const apiTokenInstance = Deno.env.get('GREEN_API_TOKEN_INSTANCE') || '';
  if (!idInstance || !apiTokenInstance) throw new Error('Credenciais da GREEN-API não configuradas');
  return { apiUrl, idInstance, apiTokenInstance };
}

export function whatsappChatId(value: unknown) {
  const raw = String(value || '').trim();
  if (raw.endsWith('@c.us') || raw.endsWith('@g.us')) return raw;
  const phone = raw.replace(/\D/g, '');
  if (!phone) throw new Error('Número de WhatsApp inválido');
  return `${phone}@c.us`;
}

export async function sendGreenApiText(to: string, body: string) {
  const { apiUrl, idInstance, apiTokenInstance } = greenApiCredentials();
  const pieces = String(body).match(/[\s\S]{1,3900}/g) || [];
  let lastResult: Record<string, any> = {};
  for (const message of pieces) {
    const response = await fetch(
      `${apiUrl}/waInstance${encodeURIComponent(idInstance)}/sendMessage/${encodeURIComponent(apiTokenInstance)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId: whatsappChatId(to), message }),
      },
    );
    lastResult = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(lastResult?.message || lastResult?.error || `GREEN-API respondeu ${response.status}`);
    }
  }
  return lastResult;
}
