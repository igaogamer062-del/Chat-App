# Atualização 021 — aplicativo móvel e roteamento

Esta atualização prepara o mesmo Supabase do Smart Chat para o novo aplicativo móvel criado no Manus. O painel web continua sendo usado por Operadores e Gestores. O antigo PWA deixa de fazer parte do fluxo divulgado aos condutores.

## 1. Atualizar o banco

1. Abra o projeto do Smart Chat no Supabase.
2. Entre em **SQL Editor** e clique em **New query**.
3. Copie todo o conteúdo de `supabase/021_mobile_app_routing.sql`.
4. Cole no editor e clique em **Run**.
5. Confirme que a execução terminou sem erro.

A migração cria o vínculo do usuário móvel com o atendimento, protocolo, avaliação e o fluxo de espera por operador. A busca ocorre no servidor a cada 10 segundos por até 5 minutos. O fluxo continua mesmo quando o aplicativo estiver fechado.

## 2. Publicar o painel web

Envie ao repositório do GitHub Pages o conteúdo do pacote `Smart-Chat-painel-2026-09-28.zip`. O `index.html` precisa ficar na raiz do repositório.

O painel agora possui modo noturno e diurno em todas as abas. A escolha fica salva no navegador. A fila mostra somente atendimentos efetivamente roteados. Gestores enxergam todos os atendimentos ativos e Operadores enxergam os seus.

## 3. Configurar autenticação do aplicativo

No Supabase, abra **Authentication → Providers**:

- **Google**: ative depois de criar as credenciais OAuth e informar ao Google a URL de callback exibida pelo Supabase.
- **Phone**: ative depois de configurar um provedor de SMS compatível. O acesso por telefone usa OTP; nenhuma senha de condutor precisa ser armazenada pelo aplicativo.

Em **Authentication → URL Configuration**, inclua a URL de retorno fornecida pelo projeto do Manus. Use exatamente o esquema e o endereço informados por ele.

## 4. Dados permitidos no aplicativo

O aplicativo recebe somente:

- URL pública do projeto Supabase;
- chave pública Publishable/anon;
- nomes das RPCs descritas em `outputs/MANUS-Supabase-Smart-Chat.txt`.

Nunca coloque a chave `service_role` no aplicativo, no GitHub ou em mensagens.

## 5. Encerrar o PWA antigo

Depois de validar o aplicativo do Manus:

1. Pare de divulgar o endereço `/driver-app/`.
2. Distribua aos condutores somente o aplicativo móvel.
3. Mantenha o painel web para Operadores e Gestores.
4. Quando os testes do aplicativo terminarem, o diretório legado `driver-app` poderá ser arquivado em outro repositório.

