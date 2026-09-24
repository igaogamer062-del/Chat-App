# Smart Chat — Guia de implantação (Supabase + GitHub Pages)

Este guia parte do zero: um projeto Supabase novo e um repositório GitHub novo.

## 1. Criar o projeto Supabase

1. Acesse https://supabase.com/dashboard e crie um novo projeto (escolha uma senha forte para o banco).
2. Aguarde o projeto ficar pronto e vá em **Project Settings → API**. Anote:
   - **Project URL** (algo como `https://xxxxxxxx.supabase.co`)
   - **anon public key** (chave pública, começa com `eyJ...` ou `sb_publishable_...`)

Nunca use a **service_role key** em nenhum arquivo do front-end — só a `anon public key`.

## 2. Rodar o SQL (nesta ordem exata)

Vá em **SQL Editor** no painel do Supabase e execute, um arquivo por vez, colando o conteúdo e clicando em "Run":

1. `supabase/000_core_setup.sql` — cria perfis, autenticação e sistema de permissões.
2. `supabase/012_chat_checklist_pwa.sql`
3. `supabase/013_driver_pwa_login_and_results.sql`
4. `supabase/014_checklist_media_and_rules.sql`
5. `supabase/015_bases_monitoramento_dashboard.sql` — Bases, Transportadoras, fluxo de Monitoramento e Dashboard.
6. `supabase/016_complete_service_flows.sql` — encerramento completo e encaminhamento manual.

Se algum passo der erro, leia a mensagem: normalmente é porque um arquivo anterior não foi executado ainda.

## 3. Ativar login por e-mail/senha

Em **Authentication → Providers**, confirme que **Email** está habilitado (é o padrão).
Em **Authentication → Settings**, se for só uso interno, você pode desativar a confirmação por e-mail para agilizar os testes (não recomendado em produção).

## 4. Criar o primeiro Administrador

1. Vá em **Authentication → Users → Add user** e crie seu usuário (e-mail + senha).
2. Volte ao **SQL Editor** e rode (trocando o e-mail):
   ```sql
   update public.profiles set access_role='Administrador'
   where id = (select id from auth.users where email = 'seu-email@empresa.com');
   ```
3. Esse usuário já pode entrar no painel (`painel/index.html`) e, pela aba **Usuários**, promover os demais colegas conforme forem se cadastrando.

## 5. Criar o bucket de anexos e publicar a função

O arquivo `014_checklist_media_and_rules.sql` cria o bucket `checklist-chat-files`. Depois,
publique a função `supabase/functions/checklist-media` pelo Supabase CLI:

```powershell
npx.cmd supabase login
npx.cmd supabase link --project-ref SEU_PROJECT_REF
npx.cmd supabase functions deploy checklist-media --no-verify-jwt
```

O `PROJECT_REF` é o código que aparece no começo da URL do projeto.

## 6. Configurar as chaves nos dois apps

Edite estes dois arquivos com a URL e a chave anônima do passo 1:

- `driver-app/config.js`
  ```js
  window.CHECKLIST_CONFIG = { url: 'https://xxxxxxxx.supabase.co', key: 'SUA-CHAVE-ANON' };
  ```
- `painel/config.js`
  ```js
  window.PAINEL_CONFIG = { url: 'https://xxxxxxxx.supabase.co', key: 'SUA-CHAVE-ANON' };
  ```

## 7. Publicar no GitHub Pages

1. Crie um repositório novo no GitHub e suba TODO o conteúdo desta pasta, incluindo o `index.html` da raiz.
2. No repositório, vá em **Settings → Pages**.
3. Em "Build and deployment", escolha **Deploy from a branch**, branch `main`, pasta `/ (root)`.
4. Salve. Em 1–2 minutos o GitHub mostra a URL pública, algo como:
   `https://SEU-USUARIO.github.io/SEU-REPO/`
5. A raiz mostra a entrada do sistema, o painel fica em `.../painel/` e o app do condutor em `.../driver-app/`.

> GitHub Pages serve arquivos estáticos via HTTPS — é compatível com o Supabase JS Client sem nenhuma configuração extra de CORS (o Supabase já libera qualquer origem por padrão; se quiser restringir, isso se configura em **Project Settings → API → CORS**, mas não é obrigatório para funcionar).

## 8. Popular dados de teste

Depois de logado no painel como Administrador, na aba **Bases**:
1. Crie uma ou mais **Bases** (ex.: "Operação São Paulo").
2. Crie **Transportadoras** já vinculando à base (ex.: "TransBrasil" → "Operação São Paulo").
3. Em **Base de veículos**, clique em **Sincronizar planilha Google**. Também é possível cadastrar uma linha manualmente.
4. Em **Operadores por base**, vincule operadores (que tenham a permissão `monitoring_chat`) às bases.

Na aba **Usuários**, garanta que os operadores de monitoramento tenham a função certa (por padrão `Operador`, `Lider` e `Supervisor` já vêm com `monitoring_chat` liberado; ajuste em massa por função ou individualmente se precisar).

## 9. Testar o fluxo do condutor

1. Abra `.../driver-app/` no celular (ou instale como PWA — "Adicionar à tela inicial").
2. Cadastre uma conta de condutor.
3. No bot, toque em **Checklist** ou **Monitoramento**, responda Nome/Placa/Tecnologia.
4. Para o Monitoramento, use uma placa cadastrada na "Planilha de teste" para ver o roteamento automático funcionando; use uma placa qualquer para ver o fluxo de "não roteado" caindo na aba **Atendimentos → Não roteados** do painel.

## 10. Ir para produção depois

- Trocar a "Planilha de teste" (`mock_fleet_drivers`) por uma Edge Function que consulta a API real da transportadora — o comentário no fim de `015_bases_monitoramento_dashboard.sql` mostra exatamente onde trocar.
- Revisar as políticas de RLS se o volume de usuários crescer bastante (hoje já é seguro para uso interno, mas vale uma auditoria antes de abrir para muitos clientes externos).
