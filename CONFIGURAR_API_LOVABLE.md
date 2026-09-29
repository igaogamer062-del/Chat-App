# Ativar a API de condutores do Lovable no Smart Chat

## O que já está configurado

- Edge Function publicada: `lovable-driver-sync`.
- URL base: `https://alert-trigger-hub.lovable.app`.
- Endpoint: `/api/public/v1/drivers`.
- A chave secreta nunca é enviada ao GitHub Pages nem armazenada no navegador.

## 1. Executar a migration

No Supabase, abra **SQL Editor**, copie todo o conteúdo de
`supabase/024_lovable_driver_integration.sql` e clique em **Run**.

## 2. Salvar a chave da API

No projeto do Supabase, abra **Edge Functions → Secrets** e crie:

- Key: `LOVABLE_API_KEY`
- Value: a chave completa `sr_live_...` gerada no sistema Lovable

Clique em **Save**. Não coloque essa chave em `config.js`, no GitHub ou em
qualquer arquivo do frontend.

## 3. Publicar o painel

Faça commit e push dos arquivos desta pasta para o GitHub. O GitHub Pages
passará a mostrar o botão **Sincronizar condutores** em **Bases e
transportadoras**.

## 4. Sincronizar e conferir

1. Entre no Smart Chat com um perfil Gestor.
2. Abra **Bases e transportadoras**.
3. Clique em **Sincronizar condutores**.
4. Confira a quantidade importada exibida na tela.

Para Monitoramento, o nome da transportadora devolvido pela API precisa ser
igual ao cadastro existente no Smart Chat e essa transportadora precisa estar
vinculada a uma base. Checklist segue diretamente para a base Checklist.

O importador reconhece listas JSON diretas e também listas dentro de `data`,
`drivers`, `items`, `results` ou `records`. Se a API usar outros nomes de
campos, compartilhe apenas um exemplo da resposta JSON sem a chave secreta.
