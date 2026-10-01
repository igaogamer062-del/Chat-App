# Colocar o bot oficial do WhatsApp no ar

## 1. Atualizar o banco

No **SQL Editor** do Supabase, execute o arquivo
`supabase/025_whatsapp_bot.sql`. Ele cria as configurações do bot, contatos,
manuais e eventos do WhatsApp. Também remove as funções e tabelas exclusivas do
aplicativo móvel, preservando atendimentos e mensagens.

Depois, em **Authentication → Providers**, desative **Google** se ele era usado
somente pelo aplicativo do condutor. Em **Authentication → URL Configuration**,
remova os redirects `smartchat://auth/callback` e os redirects do Expo. Não
desative Email, pois a equipe continua entrando no painel com e-mail e senha.

## 2. Publicar as Edge Functions

No terminal da pasta do Smart Chat:

```powershell
npx.cmd supabase login
npx.cmd supabase link --project-ref dyewxsxmqywhffvtnpzo
npx.cmd supabase functions deploy lovable-driver-sync --no-verify-jwt
npx.cmd supabase functions deploy whatsapp-webhook --no-verify-jwt
npx.cmd supabase functions deploy send-whatsapp-message --no-verify-jwt
```

## 3. Criar a configuração temporária na Meta

1. Acesse `https://developers.facebook.com/apps/`.
2. Clique em **Create app** e escolha um caso de uso relacionado ao WhatsApp.
3. Vincule ou crie um portfólio empresarial.
4. Adicione o produto **WhatsApp**.
5. Em **WhatsApp → API Setup**, a Meta fornece um número de teste, um Phone
   Number ID, um WhatsApp Business Account ID e um token temporário.
6. Cadastre seu celular como destinatário de teste e confirme o código recebido.

O número de teste serve para validar o bot com poucos destinatários autorizados.
Para usar seu número secundário com qualquer condutor, adicione esse número ao
WhatsApp Business Account e conclua a verificação solicitada pela Meta.

## 4. Criar os Secrets no Supabase

Abra **Supabase → Edge Functions → Secrets** e salve:

```text
WHATSAPP_ACCESS_TOKEN=token exibido pela Meta
WHATSAPP_PHONE_NUMBER_ID=Phone Number ID da Meta
WHATSAPP_VERIFY_TOKEN=uma frase secreta criada por você
WHATSAPP_APP_SECRET=App Secret em Meta → App settings → Basic
WHATSAPP_GRAPH_VERSION=v26.0
```

O valor de `WHATSAPP_VERIFY_TOKEN` é criado por você. Use uma frase longa e
aleatória e informe exatamente o mesmo valor na configuração do webhook.

## 5. Configurar o webhook na Meta

Em **WhatsApp → Configuration → Webhooks**:

- Callback URL:
  `https://dyewxsxmqywhffvtnpzo.supabase.co/functions/v1/whatsapp-webhook`
- Verify token: o mesmo `WHATSAPP_VERIFY_TOKEN` salvo no Supabase.

Depois da validação, assine o campo **messages**.

## 6. Sincronizar condutores

No painel Web, entre como Gestor, abra **Bases e transportadoras** e clique em
**Sincronizar condutores**. A API externa precisa devolver o telefone do
condutor com um destes campos: `phone`, `phone_number`, `mobile`, `telefone` ou
`celular`. O sincronizador também reconhece placa, tecnologia e transportadora.

## 7. Cadastrar manuais

Abra **Bot e manuais**:

1. Ajuste a saudação e as mensagens de fallback.
2. Adicione manuais TXT ou PDF com texto selecionável.
3. Informe a tecnologia para restringir o manual, ou deixe em branco para um
   manual geral.
4. Mantenha o bot ativo.

## 8. Testar

1. Envie `Olá` para o número de teste da Meta.
2. Confirme se o bot reconhece o telefone e apresenta os dados.
3. Envie uma dúvida presente em um manual.
4. Digite `ATENDIMENTO` e escolha Monitoramento ou Checklist.
5. Mantenha um operador online e vinculado à base correspondente.
6. Responda pelo painel e confirme o recebimento no WhatsApp.

Enquanto usar o token temporário da Meta, ele pode expirar. Para produção,
gere um token de usuário do sistema com as permissões
`whatsapp_business_management` e `whatsapp_business_messaging`.
