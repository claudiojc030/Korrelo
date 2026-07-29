export interface LoginDict {
  loadingSubtitle: string;
  twoFactorSubtitle: string;
  setupSubtitle: string;
  loginSubtitle: string;
  verificationCodeLabel: string;
  verificationCodePlaceholder: string;
  emailLabel: string;
  emailPlaceholder: string;
  passwordLabel: string;
  passwordPlaceholder: string;
  showPassword: string;
  hidePassword: string;
  submitVerify: string;
  submitCreateAccount: string;
  submitLogin: string;
  back: string;
  authFailedFallback: string;
  unknownError: string;
}

export const loginEn: LoginDict = {
  loadingSubtitle: "Loading...",
  twoFactorSubtitle: "Enter the code from your authenticator app",
  setupSubtitle: "Create this VPS's admin account",
  loginSubtitle: "Sign in with your admin account",
  verificationCodeLabel: "Verification code",
  verificationCodePlaceholder: "123456 or a backup code",
  emailLabel: "Email",
  emailPlaceholder: "you@example.com",
  passwordLabel: "Password",
  passwordPlaceholder: "At least 8 characters",
  showPassword: "Show password",
  hidePassword: "Hide password",
  submitVerify: "Verify",
  submitCreateAccount: "Create account",
  submitLogin: "Sign in",
  back: "Back",
  authFailedFallback: "Authentication failed.",
  unknownError: "Unknown error",
};

export const loginPt: LoginDict = {
  loadingSubtitle: "Carregando...",
  twoFactorSubtitle: "Digite o código do seu app autenticador",
  setupSubtitle: "Crie a conta de administrador desta VPS",
  loginSubtitle: "Entre com sua conta de administrador",
  verificationCodeLabel: "Código de verificação",
  verificationCodePlaceholder: "123456 ou um código de backup",
  emailLabel: "E-mail",
  emailPlaceholder: "voce@exemplo.com",
  passwordLabel: "Senha",
  passwordPlaceholder: "Mínimo 8 caracteres",
  showPassword: "Mostrar senha",
  hidePassword: "Ocultar senha",
  submitVerify: "Verificar",
  submitCreateAccount: "Criar conta",
  submitLogin: "Entrar",
  back: "Voltar",
  authFailedFallback: "Falha ao autenticar.",
  unknownError: "Erro desconhecido",
};
