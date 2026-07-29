import type { ApiErrorsDict } from "./api-errors";

export const apiErrorsMiscEn: ApiErrorsDict = {
  GITHUB_APP_NOT_CONNECTED: "No GitHub account connected yet.",
  GITHUB_APP_ID_MISSING: "Server misconfiguration (GITHUB_APP_ID not set).",
  GITHUB_APP_PRIVATE_KEY_MISSING: "Server misconfiguration (GITHUB_APP_PRIVATE_KEY not set).",
  GITHUB_API_ERROR: "GitHub API request failed.",
  SERVICE_UNKNOWN: "Unknown service.",
  SERVICE_NOT_FOUND_ON_VPS: "This service doesn't exist on this VPS.",
  SERVICE_TOGGLE_FAILED: "Failed to toggle the service.",
  ENV_ENCRYPTION_KEY_MISSING: "Server misconfiguration (ENV_ENCRYPTION_KEY not set).",
  ENV_ENCRYPTION_KEY_INVALID_LENGTH: "Server misconfiguration (ENV_ENCRYPTION_KEY must be 32 bytes / 64 hex characters).",
  ENV_VAR_DECRYPT_FAILED: "Failed to decrypt environment variable. ENV_ENCRYPTION_KEY may be wrong.",
};

export const apiErrorsMiscPt: ApiErrorsDict = {
  GITHUB_APP_NOT_CONNECTED: "Nenhuma conta GitHub conectada ainda.",
  GITHUB_APP_ID_MISSING: "Erro de configuração do servidor (GITHUB_APP_ID ausente).",
  GITHUB_APP_PRIVATE_KEY_MISSING: "Erro de configuração do servidor (GITHUB_APP_PRIVATE_KEY ausente).",
  GITHUB_API_ERROR: "Falha na requisição à API do GitHub.",
  SERVICE_UNKNOWN: "Serviço desconhecido.",
  SERVICE_NOT_FOUND_ON_VPS: "Esse serviço não existe nesta VPS.",
  SERVICE_TOGGLE_FAILED: "Falha ao ativar/desativar o serviço.",
  ENV_ENCRYPTION_KEY_MISSING: "Erro de configuração do servidor (ENV_ENCRYPTION_KEY ausente).",
  ENV_ENCRYPTION_KEY_INVALID_LENGTH: "Erro de configuração do servidor (ENV_ENCRYPTION_KEY precisa ter 32 bytes / 64 caracteres hex).",
  ENV_VAR_DECRYPT_FAILED: "Falha ao decifrar variável de ambiente. ENV_ENCRYPTION_KEY pode estar errado.",
};
