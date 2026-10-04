# Smart Chat — atendimento pelo WhatsApp

O Smart Chat recebe mensagens do WhatsApp pela Z-API, identifica o condutor
pelo número cadastrado, consulta manuais de tecnologia e transfere o
atendimento para o operador correto no painel Web.

## Fluxo

1. O condutor envia uma mensagem ao número conectado à Z-API.
2. O webhook do Supabase procura o telefone em `external_driver_directory`.
3. O bot confirma os dados disponíveis do condutor.
4. Dúvidas são pesquisadas nos manuais cadastrados.
5. Ao pedir atendimento, o condutor escolhe Monitoramento ou Checklist.
6. O sistema encontra a base e um operador online vinculado.
7. As mensagens aparecem no painel e as respostas retornam ao WhatsApp.

## Estrutura

- `painel/` — painel usado por gestores e operadores.
- `motor-bot/` — protótipo isolado do futuro configurador do bot. Não possui
  conexão com produção.
- `supabase/025_whatsapp_bot.sql` — tabelas, manuais e roteamento.
- `supabase/functions/whatsapp-webhook/` — recebe os webhooks da Z-API.
- `supabase/functions/send-whatsapp-message/` — envia as respostas dos
  operadores pela Z-API.
- `supabase/functions/lovable-driver-sync/` — sincroniza os condutores.
- `DEPLOY.md` — configuração da Z-API e do Supabase.

## Segurança

O ID e o token da instância, o Client-Token e o segredo do webhook ficam
somente nos Secrets das Edge Functions. Eles não devem ser colocados no
GitHub, no JavaScript do painel ou enviados em capturas de tela.

O histórico de atendimentos permanece no Supabase. A Z-API funciona por uma
sessão do WhatsApp Web vinculada por QR Code; use um número destinado ao
atendimento e evite automações de envio em massa.
