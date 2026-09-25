# Publicação das melhorias do Smart Chat

## 1. Atualizar o banco

No projeto Supabase do Smart Chat, abra **SQL Editor**, cole e execute:

`supabase/019_smart_chat_roles_routing_admin.sql`

Essa migração:

- reduz os perfis para `Operador` e `Gestor`;
- cria a opção individual de receber chats;
- cria a base `Checklist`;
- impede o encaminhamento para usuários sem vínculo com a base;
- libera o histórico completo para gestores;
- adiciona suporte às assinaturas de notificação do PWA.

Depois, vincule pelo menos um usuário com chat ativo à base **Checklist** no painel.

## 2. Vincular a CLI ao projeto correto

```powershell
npx.cmd supabase link --project-ref dyewxsxmqywhffvtnpzo
```

## 3. Configurar as notificações push

As chaves foram geradas localmente em `supabase/.env.push.local`. Esse arquivo está ignorado pelo Git e não deve ser publicado.

```powershell
npx.cmd supabase secrets set --env-file supabase/.env.push.local
```

## 4. Publicar as Edge Functions

```powershell
npx.cmd supabase functions deploy admin-create-user
```

```powershell
npx.cmd supabase functions deploy send-chat-push
```

## 5. Publicar o site

```powershell
git add .
git commit -m "feat: aprimorar Smart Chat e roteamento por base"
git push origin main
```

O endereço principal abrirá diretamente o login da equipe. O link para o aplicativo dos condutores ficará disponível na aba **Instalar aplicativo**.
