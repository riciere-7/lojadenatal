const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * Envia o email de entrega dos materiais via Resend.
 *
 * @param {string|object} to - Email do cliente ou objeto de parâmetros
 * @param {string|string[]} links - Link ou lista de links do Google Drive
 * @param {object} env - Variáveis de ambiente (RESEND_API_KEY, EMAIL_FROM)
 * @param {object} [options] - Opções extras (ex: productName)
 */
export async function sendDeliveryEmail(to, links, env = {}, options = {}) {
  // Permite chamada com objeto único: sendDeliveryEmail({ to, links, env, options })
  if (typeof to === "object" && to !== null) {
    const params = to;
    to = params.to;
    links = params.links;
    env = params.env || env;
    options = params.options || options;
  }

  const apiKey = env.RESEND_API_KEY;
  const from = env.EMAIL_FROM;

  if (!apiKey) {
    throw new Error("Variável RESEND_API_KEY não configurada.");
  }
  if (!from) {
    throw new Error("Variável EMAIL_FROM não configurada.");
  }

  const linksArray = Array.isArray(links) ? links : [links].filter(Boolean);
  if (linksArray.length === 0) {
    throw new Error("Nenhum link fornecido para entrega.");
  }

  const productName = options.productName || "Materiais de Natal";

  const linkItemsHtml = linksArray
    .map(
      (link, idx) => `
        <div style="margin: 16px 0;">
          <a href="${link}" style="background-color: #1f3b57; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 8px; font-weight: bold; display: inline-block;">
            Abrir pasta no Google Drive ${linksArray.length > 1 ? `#${idx + 1}` : ""}
          </a>
          <p style="margin: 6px 0 0; font-size: 13px; color: #6b6b6b; word-break: break-all;">
            Ou acesse diretamente: <a href="${link}" style="color: #c9a24a;">${link}</a>
          </p>
        </div>
      `
    )
    .join("");

  const linkItemsText = linksArray
    .map((link, idx) => `• Link ${linksArray.length > 1 ? `${idx + 1}: ` : ""}${link}`)
    .join("\n");

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: Arial, Helvetica, sans-serif; background-color: #fbf6ea; color: #2b2b2b; padding: 24px; margin: 0;">
      <div style="max-width: 580px; margin: 0 auto; background-color: #ffffff; border: 1px solid #e3dccb; border-radius: 12px; padding: 32px;">
        <div style="text-align: center; margin-bottom: 24px;">
          <span style="color: #c9a24a; font-size: 12px; letter-spacing: 2px; text-transform: uppercase;">Natal 2026</span>
          <h1 style="color: #1f3b57; font-family: Georgia, serif; font-size: 26px; margin: 8px 0;">Seu pedido está pronto! 🎄</h1>
        </div>
        <p style="font-size: 15px; line-height: 1.6;">Olá,</p>
        <p style="font-size: 15px; line-height: 1.6;">
          Seu pagamento via PIX foi confirmado com sucesso. O seu acesso a <strong>${productName}</strong> já está liberado.
        </p>
        <div style="margin: 28px 0; padding: 20px; background-color: #f8f6f0; border-radius: 10px; border-left: 4px solid #c9a24a;">
          <p style="margin: 0 0 12px; font-weight: bold; color: #1f3b57;">Acesse seus materiais:</p>
          ${linkItemsHtml}
        </div>
        <p style="font-size: 14px; color: #6b6b6b; line-height: 1.5;">
          <strong>Dica para impressão:</strong> Dentro da pasta você encontrará os arquivos em formato PDF prontos para imprimir em folha A4.
        </p>
        <hr style="border: 0; border-top: 1px solid #e3dccb; margin: 28px 0;">
        <p style="font-size: 12px; color: #888888; text-align: center; margin: 0;">
          Se tiver alguma dúvida, basta responder a este email. Tenha um excelente Natal!
        </p>
      </div>
    </body>
    </html>
  `.trim();

  const text = `
Seu pedido está pronto! 🎄

Olá,

Seu pagamento via PIX foi confirmado com sucesso. O seu acesso a ${productName} já está liberado.

Acesse seus materiais na pasta do Google Drive:
${linkItemsText}

Dica: Dentro da pasta você encontrará os arquivos em PDF prontos para imprimir em folha A4.

Se tiver alguma dúvida, basta responder a este email.
Tenha um excelente Natal!
  `.trim();

  const body = {
    from,
    to: [to],
    subject: `Seus materiais de Natal estão prontos para download! 🎄`,
    html,
    text,
  };

  const response = await fetch(RESEND_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`Falha no envio de email pelo Resend (${response.status}): ${errorText}`);
  }

  return await response.json().catch(() => ({ id: "sent" }));
}

