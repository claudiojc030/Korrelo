export interface LoginDict {
  loadingSubtitle: string;
  twoFactorSubtitle: string;
  loginSubtitle: string;
  verificationCodeLabel: string;
  verificationCodePlaceholder: string;
  usernameLabel: string;
  usernamePlaceholder: string;
  passwordLabel: string;
  passwordPlaceholder: string;
  showPassword: string;
  hidePassword: string;
  submitVerify: string;
  submitLogin: string;
  back: string;
  authFailedFallback: string;
  unknownError: string;
}

export const loginEn: LoginDict = {
  loadingSubtitle: "Loading...",
  twoFactorSubtitle: "Enter the code from your authenticator app",
  loginSubtitle: "Sign in with your admin account",
  verificationCodeLabel: "Verification code",
  verificationCodePlaceholder: "123456 or a backup code",
  usernameLabel: "Username",
  usernamePlaceholder: "admin",
  passwordLabel: "Password",
  passwordPlaceholder: "At least 8 characters",
  showPassword: "Show password",
  hidePassword: "Hide password",
  submitVerify: "Verify",
  submitLogin: "Sign in",
  back: "Back",
  authFailedFallback: "Authentication failed.",
  unknownError: "Unknown error",
};

export const loginPt: LoginDict = {
  loadingSubtitle: "Carregando...",
  twoFactorSubtitle: "Digite o código do seu app autenticador",
  loginSubtitle: "Entre com sua conta de administrador",
  verificationCodeLabel: "Código de verificação",
  verificationCodePlaceholder: "123456 ou um código de backup",
  usernameLabel: "Usuário",
  usernamePlaceholder: "admin",
  passwordLabel: "Senha",
  passwordPlaceholder: "Mínimo 8 caracteres",
  showPassword: "Mostrar senha",
  hidePassword: "Ocultar senha",
  submitVerify: "Verificar",
  submitLogin: "Entrar",
  back: "Voltar",
  authFailedFallback: "Falha ao autenticar.",
  unknownError: "Erro desconhecido",
};
