# Colocar o bot do WhatsApp no ar com Z-API

## 1. Criar e conectar a instância

1. Acesse `https://app.z-api.io/` e crie sua conta.
2. Inicie o teste grátis e crie uma instância.
3. Abra a instância e conecte o número secundário lendo o QR Code em
   **WhatsApp → Aparelhos conectados → Conectar um aparelho**.
4. Na tela da instância, copie sem divulgar:
   - ID da instância;
   - Token da instância.
5. Em **Segurança**, gere e copie o **Client-Token** da conta.

## 2. Salvar os Secrets no Supabase

Abra **Supabase → Edge Functions → Secrets** e crie:

```text
ZAPI_INSTANCE_ID=ID da instância
ZAPI_INSTANCE_TOKEN=token da instância
ZAPI_CLIENT_TOKEN=Client-Token da conta
ZAPI_WEBHOOK_SECRET=uma frase longa e aleatória criada por você
```

Remova os antigos `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET` e `WHATSAPP_GRAPH_VERSION`
depois que o teste da Z-API funcionar.

## 3. Publicar as Edge Functions atualizadas

No terminal da pasta do Smart Chat:

```powershell
npx.cmd supabase login
npx.cmd supabase link --project-ref dyewxsxmqywhffvtnpzo
npx.cmd supabase functions deploy whatsapp-webhook --no-verify-jwt
npx.cmd supabase functions deploy send-whatsapp-message --no-verify-jwt
```

## 4. Configurar o webhook de recebimento

Na instância da Z-API, abra **Webhooks e configurações gerais**. No webhook
**Ao receber**, informe:

```text
https://dyewxsxmqywhffvtnpzo.supabase.co/functions/v1/whatsapp-webhook?secret=SEU_SEGREDO
```

Troque `SEU_SEGREDO` exatamente pelo valor salvo em `ZAPI_WEBHOOK_SECRET`.
Salve a configuração. Não ative o recebimento de grupos nem o retorno de
mensagens enviadas pelo próprio número durante o primeiro teste.

## 5. Sincronizar condutores e testar

1. No painel Smart Chat, entre como Gestor.
2. Em **Bases e transportadoras**, clique em **Sincronizar condutores**.
3. Confira se o telefone do condutor contém DDI e DDD.
4. Em **Bot e manuais**, mantenha o bot ativo e cadastre ao menos um manual.
5. Envie `Olá` de um telefone de condutor para o número conectado à Z-API.
6. Peça `ATENDIMENTO`, escolha Monitoramento ou Checklist e mantenha um
   operador da base online.
7. Responda pelo painel e confirme a chegada da resposta ao WhatsApp.

## 6. Motor do bot

O diretório `motor-bot/` contém somente a estrutura visual do futuro motor de
configuração. Ele está identificado como inativo, não acessa o Supabase e não
altera o roteamento atual.
