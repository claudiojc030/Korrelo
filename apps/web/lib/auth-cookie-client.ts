export const TOKEN_COOKIE = "forgedesk_token";
const MAX_AGE_SECONDS = 12 * 60 * 60;

export function setTokenClient(token: string): void {
  document.cookie = `${TOKEN_COOKIE}=${token}; path=/; max-age=${MAX_AGE_SECONDS}; SameSite=Lax`;
}

export function getTokenClient(): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${TOKEN_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

export function clearTokenClient(): void {
  document.cookie = `${TOKEN_COOKIE}=; path=/; max-age=0`;
}
