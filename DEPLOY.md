# Colocar o bot do WhatsApp no ar com GREEN-API

## 1. Criar e conectar a instância

1. Acesse `https://console.green-api.com/` e abra a instância Developer.
2. Conecte o número secundário pelo QR Code em
   **WhatsApp → Aparelhos conectados → Conectar um aparelho**.
3. Na instância, copie sem divulgar:
   - `apiUrl`;
   - `idInstance`;
   - `apiTokenInstance`.

## 2. Salvar os Secrets no Supabase

Abra **Supabase → Edge Functions → Secrets** e crie:

```text
GREEN_API_URL=apiUrl mostrado pela GREEN-API
GREEN_API_ID_INSTANCE=idInstance
GREEN_API_TOKEN_INSTANCE=apiTokenInstance
GREEN_API_WEBHOOK_TOKEN=uma frase longa e aleatória criada por você
```

O token do webhook não vem da GREEN-API. Crie uma frase secreta. Salve apenas
a frase no Supabase e informe `Bearer SUA_FRASE` no campo da GREEN-API.

## 3. Publicar as Edge Functions atualizadas

No terminal da pasta do Smart Chat:

```powershell
npx.cmd supabase login
npx.cmd supabase link --project-ref dyewxsxmqywhffvtnpzo
npx.cmd supabase functions deploy whatsapp-webhook --no-verify-jwt
npx.cmd supabase functions deploy send-whatsapp-message --no-verify-jwt
npx.cmd supabase functions deploy vehicle-unlock
```

## 4. Configurar o webhook de recebimento

Na instância GREEN-API, abra as configurações e informe:

```text
Webhook URL:
https://dyewxsxmqywhffvtnpzo.supabase.co/functions/v1/whatsapp-webhook

Webhook URL Token:
Bearer + o valor de GREEN_API_WEBHOOK_TOKEN
```

Ative somente o necessário para o primeiro teste:

- receber notificações de mensagens e arquivos: **ativado**;
- mensagens recebidas (`incomingWebhook`): **ativado**;
- mensagens enviadas pelo aparelho: **desativado**;
- mensagens enviadas pela API: **desativado**;
- grupos: não usar no teste.

Salve e aguarde alguns minutos para a configuração ser aplicada.

## 5. Testar

1. No Smart Chat, entre como Gestor.
2. Em **Bases e transportadoras**, sincronize os condutores.
3. Confirme que o número do teste possui DDI e DDD.
4. Envie `Olá` desse número para o WhatsApp conectado à GREEN-API.
5. Peça `ATENDIMENTO`, escolha Monitoramento ou Checklist e mantenha um
   operador da base online.
6. Responda pelo painel e confirme a chegada da resposta no WhatsApp.

## 6. Motor do bot

O diretório `motor-bot/` contém somente a estrutura visual do futuro motor de
configuração. Ele está identificado como inativo, não acessa o Supabase e não
altera o roteamento atual.
