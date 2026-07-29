export interface SetupDict {
  loadingSubtitle: string;
  welcomeTitle: string;
  welcomeSubtitle: string;
  usernameLabel: string;
  usernamePlaceholder: string;
  passwordLabel: string;
  passwordPlaceholder: string;
  showPassword: string;
  hidePassword: string;
  submitCreateAccount: string;
  authFailedFallback: string;
  unknownError: string;
}

export const setupEn: SetupDict = {
  loadingSubtitle: "Loading...",
  welcomeTitle: "Welcome to Korrelo",
  welcomeSubtitle: "This is a fresh install. Create the admin account to get started.",
  usernameLabel: "Username",
  usernamePlaceholder: "admin",
  passwordLabel: "Password",
  passwordPlaceholder: "At least 8 characters",
  showPassword: "Show password",
  hidePassword: "Hide password",
  submitCreateAccount: "Create account",
  authFailedFallback: "Couldn't create the account.",
  unknownError: "Unknown error",
};

export const setupPt: SetupDict = {
  loadingSubtitle: "Carregando...",
  welcomeTitle: "Bem-vindo ao Korrelo",
  welcomeSubtitle: "Esta é uma instalação nova. Crie a conta de administrador para começar.",
  usernameLabel: "Usuário",
  usernamePlaceholder: "admin",
  passwordLabel: "Senha",
  passwordPlaceholder: "Mínimo 8 caracteres",
  showPassword: "Mostrar senha",
  hidePassword: "Ocultar senha",
  submitCreateAccount: "Criar conta",
  authFailedFallback: "Não foi possível criar a conta.",
  unknownError: "Erro desconhecido",
};
