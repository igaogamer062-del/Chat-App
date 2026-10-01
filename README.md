# Smart Chat — atendimento pelo WhatsApp

O Smart Chat recebe mensagens pela API oficial do WhatsApp Cloud, identifica o
condutor pelo número cadastrado, consulta manuais de tecnologia e transfere o
atendimento para o operador correto no painel Web.

## Fluxo

1. O condutor envia uma mensagem ao número do WhatsApp da operação.
2. O webhook do Supabase procura o telefone em `external_driver_directory`.
3. O bot confirma nome, transportadora, placa e tecnologia disponíveis.
4. Dúvidas são pesquisadas nos manuais cadastrados no painel.
5. Ao pedir atendimento, o condutor escolhe Monitoramento ou Checklist.
6. O sistema encontra a base e um operador online vinculado.
7. As mensagens aparecem no painel Web e as respostas voltam ao WhatsApp.

## Estrutura

- `painel/` — painel de gestores e operadores.
- `supabase/025_whatsapp_bot.sql` — tabelas, busca de manuais, roteamento e
  encerramento dos componentes exclusivos do antigo aplicativo móvel.
- `supabase/functions/whatsapp-webhook/` — recebe mensagens e executa o bot.
- `supabase/functions/send-whatsapp-message/` — envia ao WhatsApp as respostas
  escritas pelos operadores.
- `supabase/functions/lovable-driver-sync/` — mantém os dados dos condutores
  sincronizados com a API externa.
- `DEPLOY.md` — ativação no Supabase e na Meta.

## Segurança

Tokens da Meta, chave da API externa, App Secret e service role ficam somente
nos Secrets das Edge Functions do Supabase. O GitHub Pages recebe apenas a URL
e a chave pública do projeto Supabase.

O antigo PWA do condutor foi removido. O histórico de atendimentos continua
preservado no banco.
