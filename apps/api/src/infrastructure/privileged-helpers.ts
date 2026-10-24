/**
 * HELPERS PRIVILEGIADOS DO KORRELO.
 *
 * O Core roda como usuário sem privilégio. As únicas elevações permitidas no
 * sudoers (instaladas por scripts/setup-vps.sh) são:
 *
 *   - `systemctl reload nginx` (comando fixo, sem curinga);
 *   - /usr/local/sbin/korrelo-certbot  (flags fixas; aceita só domínios/e-mail);
 *   - /usr/local/sbin/korrelo-service  (ação fixa + lista fechada de units).
 *
 * Nenhum argumento vindo de requisição chega ao certbot/systemctl como opção:
 * os helpers validam e montam a linha de comando internamente.
 */
export const KORRELO_CERTBOT_HELPER = "/usr/local/sbin/korrelo-certbot";
export const KORRELO_SERVICE_HELPER = "/usr/local/sbin/korrelo-service";
