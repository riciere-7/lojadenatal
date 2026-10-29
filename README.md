# Loja de materiais de Natal

Landing page estática na Cloudflare Pages, com checkout PinPay (PIX), funções serverless na própria Pages (`functions/`) e entrega automática de materiais por email via Resend com links de pastas do Google Drive.

## Estrutura do projeto

```
index.html                  landing page e formulário de compra
obrigado.html               página após o pagamento
admin.html                  painel administrativo (métricas, vendas, simulador e pinpay)
functions/
  api/
    checkout.js             cria a sessão de checkout na PinPay e grava pedido pendente
    webhook.js              recebe webhook payment_approved, valida HMAC, checa idempotência e entrega
    webhook/
      pinpay.js             alias para webhook /api/webhook/pinpay
    admin.js                API do painel admin (métricas, pedidos, sync pinpay e simulador)
  _lib/
    products.js             catálogo de produtos e resolução das variáveis de link de entrega
    email.js                serviço de envio de email transacional via Resend
test/
  webhook.test.js           testes unitários locais com simulação de KV, Resend e PinPay
```

## Configuração

### 1. Variáveis de ambiente (Cloudflare Pages)

No painel da Cloudflare Pages, em **Settings → Environment variables**, configure as seguintes variáveis como **Secret** (ou em `.dev.vars` para desenvolvimento local com Wrangler):

| Variável | Tipo | Descrição |
| :--- | :--- | :--- |
| `ADMIN_PASSWORD` | Secret | Senha para login no Painel Admin (`/admin`). Padrão local: `natal2026admin`. |
| `PINPAY_SECRET_KEY` | Secret | Chave secreta de API da PinPay (`sk_...`). |
| `PINPAY_WEBHOOK_SECRET` | Secret | Segredo retornado no cadastro do webhook da PinPay (`whsec_...`). |
| `RESEND_API_KEY` | Secret | Chave de API do Resend (`re_...`). |
| `EMAIL_FROM` | Texto / Secret | Email do remetente (ex: `natal@seudominio.com`). **Atenção:** o domínio precisa estar verificado no Resend. |
| `DRIVE_URL_CARTOES` | Secret | Link público da pasta do Google Drive com os cartões. |
| `DRIVE_URL_GUIA` | Secret | Link público da pasta do Google Drive com o guia. |
| `DRIVE_URL_KIT` | Secret | Link público da pasta do Google Drive com o kit completo. |

> **Nota sobre o Resend:** Para enviar emails em produção pelo Resend, é obrigatório registrar e verificar o seu domínio (com os registros SPF/DKIM indicados no painel do Resend). O uso de domínios gratuitos (como `@gmail.com`) ou não verificados será rejeitado pela API do Resend.

### 2. KV Namespace para Idempotência e Pedidos (`ORDERS`)

Para rastrear os pedidos pendentes e garantir que um webhook reenviado não dispare múltiplos emails:

1. No painel da Cloudflare, acesse **Workers & Pages → KV** e crie um namespace (ex: `LOJA_NATAL_ORDERS`).
2. No seu projeto Pages, acesse **Settings → Functions → KV namespace bindings**.
3. Adicione um binding com o nome de variável **`ORDERS`** apontando para o namespace criado.

### 3. Registro do Webhook na PinPay

A confirmação de pagamento é enviada pela PinPay via webhook global da conta:

1. Faça uma requisição `POST` autenticada para a PinPay (ou cadastre no painel da PinPay):
   ```bash
   curl -X POST https://api.usepinpay.com/functions/v1/api-v1/webhooks \
     -H "Authorization: Bearer sk_SUA_CHAVE_AQUI" \
     -H "Content-Type: application/json" \
     -d '{
       "url": "https://SEU-SITE.pages.dev/api/webhook",
       "events": ["payment_approved"]
     }'
   ```
2. A resposta conterá o campo `secret` (com prefixo `whsec_...`).
3. Adicione esse valor à variável de ambiente `PINPAY_WEBHOOK_SECRET` na Cloudflare Pages.

---

## Fluxo de Compra e Entrega

1. **Seleção:** O cliente seleciona o produto e informa o email em `index.html`.
2. **Checkout:** `POST /api/checkout` gera um identificador único `external_reference` (`NATAL-<uuid>`), grava o pedido com status `pending` no KV `ORDERS` (`order:NATAL-...`), e solicita a sessão de pagamento via PIX na PinPay.
3. **Pagamento:** O cliente é redirecionado para `checkout_url` e realiza o pagamento via PIX.
4. **Webhook:** Após a aprovação, a PinPay envia `POST /api/webhook` com o cabeçalho `X-Webhook-Signature`.
5. **Autenticação:** O endpoint valida a assinatura HMAC-SHA256 usando `PINPAY_WEBHOOK_SECRET` em tempo constante. Assinaturas inválidas recebem `401 Unauthorized`.
6. **Filtro de evento:** Eventos que não sejam `payment_approved` são respondidos com `200 OK` e ignorados.
7. **Idempotência:** O sistema verifica se a chave `delivered:<external_reference>` existe no KV `ORDERS`. Se já existir, encerra com `200 OK` imediatamente, evitando envio duplicado.
8. **Resolução de produto e link:** O webhook consulta o KV `order:<external_reference>` (e/ou dados do payload) para identificar o `product_id` e o email do cliente. Obtém o link da pasta correspondente do Google Drive configurado nas variáveis de ambiente.
9. **Gravação e Disparo:** A chave de entrega é gravada no KV antes do envio (para prevenir race conditions). Em seguida, `sendDeliveryEmail` dispara o email com os links via Resend. Se o envio de email falhar, a chave de entrega é removida para permitir que o retry automático do webhook tente novamente.

---

## Painel Administrativo (`/admin`)

O projeto inclui um painel de controle acessível pela rota `/admin`:

- **Acompanhamento de Vendas:** visualização de todos os pedidos salvos no KV `ORDERS`, status de pagamento/entrega, faturamento total, quantidade de pedidos e ticket médio.
- **Sincronização PinPay:** teste de autenticação da chave secreta (`PINPAY_SECRET_KEY`) e registro automático da URL de webhook (`https://lojadenatal.pages.dev/api/webhook/pinpay`) diretamente na conta da PinPay.
- **Simulador de Webhook:** disparo de eventos `payment_approved` de teste com cálculo dinâmico de assinatura HMAC-SHA256 para homologar a entrega sem precisar efetuar pagamentos reais.
- **Reenvio de Acesso:** botão para reenviar os links do Google Drive para o email do cliente com um clique.
- **Segurança:** protegido por senha via variável `ADMIN_PASSWORD` (senha padrão local: `natal2026admin`).

---

## Testes Locais

A suíte de testes unitários roda localmente com Node.js sem chamar APIs externas ou Cloudflare real (usando mocks para KV, Resend e PinPay):

```bash
npm test
```

Cenários cobertos:
- Rejeição de assinaturas HMAC ausentes ou inválidas (401).
- Ignorar eventos que não sejam `payment_approved` (200).
- Processamento bem-sucedido de `payment_approved` gerando exatamente 1 email e gravando no KV.
- Idempotência: reenvio do mesmo evento pelo webhook da PinPay não duplica o envio de emails (200).
- Gravação do pedido pendente no KV pelo endpoint de checkout.
- Rollback da marca de entrega em caso de indisponibilidade da API do Resend (permitindo retentativa).

---

## Dúvidas Pendentes e Detalhes da PinPay

Durante a implementação, foram identificados pontos não documentados na especificação da PinPay que requerem confirmação:

1. **Formato exato do cabeçalho `X-Webhook-Signature`:**
   - A documentação indica apenas *"HMAC-SHA256 no header X-Webhook-Signature"*.
   - A implementação atual calcula o HMAC-SHA256 sobre o corpo bruto (`rawBody` UTF-8) e compara contra string hexadecimal em minúsculas.
   - *Dúvida a confirmar com a PinPay:* O valor enviado no cabeçalho é hexadecimal puro, Base64, ou utiliza formato com carimbo de data/hora (ex.: `t=...,v1=...`)?
2. **Schema JSON exato do evento `payment_approved`:**
   - O formato completo das propriedades do payload não está disponível na documentação fornecida.
   - A implementação atual faz busca defensiva pelo `external_reference` e `email` em diversas posições conhecidas (`payload.external_reference`, `payload.data.external_reference`, `payload.customer.email`, etc.), mas garante a recuperação do `product_id` consultando o KV gravado na criação do checkout.
   - *Dúvida a confirmar com a PinPay:* Qual o formato JSON exato entregue no webhook (exemplo de payload)?
3. **Política de retentativas (retries) do Webhook:**
   - *Dúvida a confirmar com a PinPay:* Quantas vezes e em quais intervalos a PinPay tenta reenviar o webhook se o endpoint responder com código de erro 5xx?
