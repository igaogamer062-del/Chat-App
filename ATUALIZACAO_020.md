# Atualização 020 — painel, chat e visão do Operador

## 1. Supabase

No projeto do Smart Chat, abra **SQL Editor → New query**, copie todo o conteúdo de:

`supabase/020_operator_dashboard.sql`

Cole no editor e clique em **Run**. O resultado esperado é `Success. No rows returned`.

Esse SQL libera o Dashboard para o Operador e calcula somente os atendimentos atribuídos ao usuário conectado.

## 2. GitHub Pages

Extraia o ZIP da atualização e envie o conteúdo para a raiz do repositório. O arquivo `index.html` deve continuar na raiz.

Após o GitHub Pages concluir a publicação, use `Ctrl + F5` no painel. No PWA instalado, feche e abra o aplicativo para o novo Service Worker ativar a versão atualizada.

## 3. Validação rápida

1. Abra um atendimento e digite por mais de quatro segundos: o texto deve permanecer.
2. Abra o encerramento, preencha os campos e confirme: o formulário não deve desaparecer.
3. No computador, Enter envia a mensagem do condutor.
4. No celular, Enter cria uma nova linha.
5. Entre como Operador e confirme as abas **Meu dashboard** e **Meu histórico**.

