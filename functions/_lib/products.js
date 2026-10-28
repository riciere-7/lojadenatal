// Catálogo de produtos. Valores em centavos (R$ 9,90 = 990).
// Os preços abaixo são provisórios: ajuste antes de publicar.
export const PRODUCTS = {
  cartoes: {
    name: "Cartões de Natal imprimíveis (10 modelos)",
    amount: 990,
    driveEnvKey: "DRIVE_URL_CARTOES",
    files: ["cartoes_natal_10_modelos.pdf"],
  },
  guia: {
    name: "Guia: Como economizar no Natal",
    amount: 990,
    driveEnvKey: "DRIVE_URL_GUIA",
    files: ["guia_como_economizar_no_natal.pdf"],
  },
  combo: {
    name: "Kit Natal completo (cartões + guia)",
    amount: 1690,
    driveEnvKey: "DRIVE_URL_KIT",
    files: ["cartoes_natal_10_modelos.pdf", "guia_como_economizar_no_natal.pdf"],
  },
};

/**
 * Retorna o link de entrega (Google Drive) para um produto a partir das variáveis de ambiente.
 * Regra:
 * - cartoes: DRIVE_URL_CARTOES
 * - guia: DRIVE_URL_GUIA
 * - combo: DRIVE_URL_KIT
 */
export function getProductDriveUrl(productId, env = {}) {
  const product = PRODUCTS[productId];
  if (!product || !product.driveEnvKey) return null;
  return env[product.driveEnvKey] || null;
}

