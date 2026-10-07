# Configuração do desbloqueio automático

O desbloqueio funciona no backend das Edge Functions do Supabase. Nenhuma chave
do simulador deve ser adicionada ao painel, ao GitHub ou ao navegador.

## Secrets necessários

Cadastre em **Supabase → Edge Functions → Secrets**:

- `SIMULATOR_BASE_URL`: endereço HTTPS do simulador, sem barra no final.
- `SIMULATOR_API_KEY`: chave privada aceita pelo simulador no cabeçalho `x-api-key`.
- `SMART_CHAT_AUTH_PEPPER`: segredo interno para hash. Já está configurado no projeto atual.

## Endpoints consumidos

- `GET /api/v1/vehicles/:vehicle_id/alerts/active`
- `POST /api/v1/commands/unlock`

Payload do comando:

```json
{
  "request_id": "UNLOCK-20261006-000001",
  "vehicle_id": "ID_DO_VEICULO",
  "plate": "IKX4440",
  "driver_id": "ID_DO_CONDUTOR",
  "command": "UNLOCK",
  "source": "SMART_CHAT"
}
```

## Preparar os condutores

Depois de publicar a alteração, entre no Smart Chat como gestor, abra
**Bases e transportadoras** e clique em **Sincronizar condutores**. A sincronização:

1. relaciona o ID do veículo pela SM ou pela placa conhecida;
2. gera somente o hash dos quatro últimos dígitos do CPF;
3. remove CPF e senha do payload de diagnóstico.

## Teste manual

1. Mantenha um operador da base do condutor conectado ao Smart Chat.
2. Envie no WhatsApp: `preciso desbloquear meu caminhão`.
3. Com alerta ativo, confirme que o bot não pede CPF e transfere ao operador.
4. Sem alerta, informe os quatro últimos dígitos do CPF.
5. Confirme com `1`.
6. Verifique que o retorno é “comando enviado ao veículo”.
7. No atendimento transferido, use **Desbloquear agora** e confirme que o backend
   consulta novamente os alertas antes de enviar o comando.

Enquanto os secrets do simulador não estiverem configurados, o fluxo sempre usa
o fallback seguro e transfere a solicitação para um operador.
