export interface SecurityDict {
  loading: string;
  pageTitle: string;
  pageDescription: string;
  unknownDevice: string;
  browserGeneric: string;
  justNow: string;
  minAgoTemplate: string;
  hourAgoTemplate: string;
  dayAgoTemplate: string;
  errorSetupFailed: string;
  errorInvalidCode: string;
  errorDisableFailed: string;
  errorUnknown: string;
  disabledTitle: string;
  disabledDescription: string;
  enableButton: string;
  setupStep1: string;
  qrAlt: string;
  manualCodeLabel: string;
  setupStep2: string;
  codePlaceholder: string;
  confirmButton: string;
  backupCodesWarning: string;
  backupCodesSavedButton: string;
  enabledTitle: string;
  enabledDescription: string;
  passwordPlaceholder: string;
  disableButton: string;
  sessionsTitle: string;
  sessionsDescription: string;
  noSessions: string;
  currentSessionBadge: string;
  unknownIp: string;
  lastUsedTemplate: string;
  revokeButton: string;
}

export const securityEn: SecurityDict = {
  loading: "Loading...",
  pageTitle: "Account security",
  pageDescription:
    "Two-factor authentication (2FA) requires a code from your authenticator app (Google Authenticator, Authy, etc) in addition to your password to sign in to Korrelo.",
  unknownDevice: "Unknown device",
  browserGeneric: "Browser",
  justNow: "just now",
  minAgoTemplate: "{n} min ago",
  hourAgoTemplate: "{n}h ago",
  dayAgoTemplate: "{n}d ago",
  errorSetupFailed: "Couldn't start the setup.",
  errorInvalidCode: "Invalid code.",
  errorDisableFailed: "Couldn't disable 2FA.",
  errorUnknown: "Unknown error",
  disabledTitle: "2FA disabled",
  disabledDescription: "Your account is currently protected only by your password.",
  enableButton: "Turn on 2FA",
  setupStep1: "1. Scan the QR code with your authenticator app (or type the code manually).",
  qrAlt: "2FA QR code",
  manualCodeLabel: "Manual code",
  setupStep2: "2. Enter the 6-digit code shown in the app:",
  codePlaceholder: "123456",
  confirmButton: "Confirm and enable",
  backupCodesWarning:
    "Save these backup codes now, they won't be shown again. Each one works only once, and lets you sign in if you lose access to your authenticator app.",
  backupCodesSavedButton: "I've saved the codes",
  enabledTitle: "2FA enabled",
  enabledDescription: "Enter your password to disable it (this removes the code requirement at login).",
  passwordPlaceholder: "Your password",
  disableButton: "Turn off 2FA",
  sessionsTitle: "Active sessions",
  sessionsDescription:
    "All devices with a valid session on this account. Ending a session revokes access immediately, even without changing your password.",
  noSessions: "No active sessions found.",
  currentSessionBadge: "This session",
  unknownIp: "Unknown IP",
  lastUsedTemplate: "{ip} · last used {time}",
  revokeButton: "End session",
};

export const securityPt: SecurityDict = {
  loading: "Carregando...",
  pageTitle: "Segurança da conta",
  pageDescription:
    "Autenticação em duas etapas (2FA) exige um código do seu app autenticador (Google Authenticator, Authy, etc) além da senha pra entrar no Korrelo.",
  unknownDevice: "Dispositivo desconhecido",
  browserGeneric: "Navegador",
  justNow: "agora mesmo",
  minAgoTemplate: "há {n} min",
  hourAgoTemplate: "há {n}h",
  dayAgoTemplate: "há {n}d",
  errorSetupFailed: "Falha ao iniciar configuração.",
  errorInvalidCode: "Código inválido.",
  errorDisableFailed: "Falha ao desativar.",
  errorUnknown: "Erro desconhecido",
  disabledTitle: "2FA desativado",
  disabledDescription: "Sua conta só é protegida por senha no momento.",
  enableButton: "Ativar 2FA",
  setupStep1: "1. Escaneie o QR code com seu app autenticador (ou digite o código manualmente).",
  qrAlt: "QR code do 2FA",
  manualCodeLabel: "Código manual",
  setupStep2: "2. Digite o código de 6 dígitos que apareceu no app:",
  codePlaceholder: "123456",
  confirmButton: "Confirmar e ativar",
  backupCodesWarning:
    "Guarde esses códigos de backup agora, eles não vão aparecer de novo. Cada um só funciona uma vez, e servem pra entrar caso você perca acesso ao app autenticador.",
  backupCodesSavedButton: "Já salvei os códigos",
  enabledTitle: "2FA ativado",
  enabledDescription: "Digite sua senha pra desativar (isso remove a exigência do código no login).",
  passwordPlaceholder: "Sua senha",
  disableButton: "Desativar 2FA",
  sessionsTitle: "Sessões ativas",
  sessionsDescription:
    "Todos os dispositivos com uma sessão válida nesta conta. Encerrar uma sessão derruba o acesso imediatamente, mesmo sem trocar a senha.",
  noSessions: "Nenhuma sessão ativa encontrada.",
  currentSessionBadge: "Esta sessão",
  unknownIp: "IP desconhecido",
  lastUsedTemplate: "{ip} · último uso {time}",
  revokeButton: "Encerrar",
};
