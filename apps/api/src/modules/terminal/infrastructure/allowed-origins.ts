export function getAllowedOrigins(): string[] {
  const configured = process.env.CORS_ORIGINS;
  if (configured) return configured.split(",").map((origin) => origin.trim());
  return [process.env.KORRELO_WEB_URL ?? "http://localhost:3000"];
}
