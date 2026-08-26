# MEK Cloud Mobile v0.3.0

Motor WhatsApp persistente para o ecossistema MEK, com sessão em PostgreSQL e API própria para integração com o MEK ERP.

## O que entra na v0.3.0

- Sessão WhatsApp persistente no PostgreSQL.
- Pareamento por código ou QR Code.
- API de mensagens com `API_TOKEN` separado do `ADMIN_TOKEN`.
- Envio de mensagens de texto.
- `requestId` para idempotência e proteção contra duplicidade.
- Histórico de mensagens de entrada e saída no PostgreSQL.
- Registro de status: PENDING, SENT, SERVER_ACK, DELIVERED, READ, PLAYED e ERROR quando disponíveis.
- Base pronta para o MEK AI Core na v0.4.0.

## Variáveis de ambiente

- `DATABASE_URL` — obrigatório.
- `ADMIN_TOKEN` — protege o painel administrativo e pareamento.
- `API_TOKEN` — protege a API usada pelo ERP/integrações.
- `WHATSAPP_SESSION_ID` — opcional; padrão `primary`.
- `PORT` — padrão `8080`.

## API v1

Todas as rotas abaixo usam:

```http
Authorization: Bearer SEU_API_TOKEN
Content-Type: application/json
```

### Status da API

`GET /api/v1/status`

### Enviar texto

`POST /api/v1/messages/text`

```json
{
  "phone": "5521999999999",
  "message": "Olá! Sua reserva MEK foi confirmada.",
  "requestId": "reserva-641-confirmacao-1"
}
```

O `requestId` é recomendado e deve ser reutilizado em uma repetição da mesma operação. Se a requisição for repetida, o servidor devolve o registro anterior em vez de enviar a mensagem novamente.

### Consultar uma mensagem

`GET /api/v1/messages/reserva-641-confirmacao-1`

### Histórico

`GET /api/v1/messages?phone=5521999999999&direction=OUTBOUND&limit=50`

## Próxima fase — v0.4.0

O histórico criado nesta versão será usado pelo MEK AI Core para interpretar conversas, manter contexto por cliente e acionar ferramentas do ERP, agenda, contratos e cobranças.
