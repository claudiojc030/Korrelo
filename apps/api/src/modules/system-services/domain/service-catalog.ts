export type ServiceRiskLevel = "baixo" | "medio" | "alto";

export interface SystemServiceDefinition {
  id: string;
  unitName: string;
  displayName: string;
  category: string;
  description: string;
  riskLevel: ServiceRiskLevel;
  riskNote: string;
}

// Lista fechada de propósito. A API só aceita ligar/desligar serviços que
// estão aqui, nunca um nome de unit arbitrário vindo do cliente. Serviços
// essenciais (ssh, cron, docker, nginx, fail2ban, ufw, systemd-*, dbus,
// NetworkManager/systemd-networkd, rsyslog) nunca entram nessa lista.
export const SERVICE_CATALOG: SystemServiceDefinition[] = [
  {
    id: "avahi-daemon",
    unitName: "avahi-daemon",
    displayName: "Avahi (mDNS / descoberta de rede local)",
    category: "Rede",
    description: "Anuncia e descobre dispositivos na rede local (tipo o Bonjour da Apple). Sem uso numa VPS.",
    riskLevel: "baixo",
    riskNote: "Nenhum impacto esperado, nada no Korrelo ou no deploy de projetos depende disso.",
  },
  {
    id: "cups",
    unitName: "cups",
    displayName: "CUPS (impressão)",
    category: "Hardware",
    description: "Sistema de impressão. Uma VPS não tem impressora.",
    riskLevel: "baixo",
    riskNote: "Nenhum impacto esperado.",
  },
  {
    id: "cups-browsed",
    unitName: "cups-browsed",
    displayName: "CUPS Browsed (descoberta de impressoras de rede)",
    category: "Hardware",
    description: "Procura impressoras de rede automaticamente pro CUPS. Mesma história do CUPS.",
    riskLevel: "baixo",
    riskNote: "Nenhum impacto esperado.",
  },
  {
    id: "modemmanager",
    unitName: "ModemManager",
    displayName: "ModemManager",
    category: "Hardware",
    description: "Gerencia modems 3G/4G/banda larga móvel. Não existe numa VPS.",
    riskLevel: "baixo",
    riskNote: "Nenhum impacto esperado.",
  },
  {
    id: "bluetooth",
    unitName: "bluetooth",
    displayName: "Bluetooth",
    category: "Hardware",
    description: "Pilha Bluetooth. Sem hardware de Bluetooth numa VPS, não faz nada além de ocupar memória.",
    riskLevel: "baixo",
    riskNote: "Nenhum impacto esperado.",
  },
  {
    id: "whoopsie",
    unitName: "whoopsie",
    displayName: "Whoopsie (telemetria de erro do Ubuntu)",
    category: "Diagnóstico",
    description: "Envia relatórios de erro do sistema pra Canonical.",
    riskLevel: "baixo",
    riskNote: "Só reduz a telemetria enviada pra Canonical, não afeta nada do Korrelo.",
  },
  {
    id: "apport",
    unitName: "apport",
    displayName: "Apport (coletor de crash reports)",
    category: "Diagnóstico",
    description: "Coleta detalhes quando um programa do sistema trava, pra gerar relatório de erro.",
    riskLevel: "baixo",
    riskNote: "Você perde o relatório automático de crash de programas do sistema operacional (não do Korrelo).",
  },
  {
    id: "multipathd",
    unitName: "multipathd",
    displayName: "Multipathd (multipath de disco / SAN)",
    category: "Armazenamento",
    description: "Gerencia múltiplos caminhos de acesso a um mesmo disco, usado em storage corporativo (SAN).",
    riskLevel: "baixo",
    riskNote: "Só importa se sua VPS usa armazenamento SAN com múltiplos caminhos. Bem incomum, praticamente nenhuma VPS usa isso.",
  },
  {
    id: "packagekit",
    unitName: "packagekit",
    displayName: "PackageKit",
    category: "Desktop",
    description: "Camada de gerenciamento de pacotes usada por interfaces gráficas de atualização (GNOME Software etc).",
    riskLevel: "baixo",
    riskNote: "Não afeta apt/dpkg na linha de comando, só interfaces gráficas que uma VPS não tem.",
  },
  {
    id: "accounts-daemon",
    unitName: "accounts-daemon",
    displayName: "AccountsService",
    category: "Desktop",
    description: "Gerencia metadados de contas de usuário (foto, idioma) pra telas de login gráficas.",
    riskLevel: "baixo",
    riskNote: "Só usado por interfaces gráficas de login, que uma VPS não tem.",
  },
  {
    id: "wpa-supplicant",
    unitName: "wpa_supplicant",
    displayName: "wpa_supplicant (Wi-Fi)",
    category: "Rede",
    description: "Gerencia conexões Wi-Fi. Uma VPS se conecta por rede cabeada/virtual, nunca Wi-Fi.",
    riskLevel: "baixo",
    riskNote: "Nenhum impacto esperado.",
  },
  {
    id: "vm-guest-agent",
    unitName: "qemu-guest-agent",
    displayName: "QEMU/VMware Guest Agent",
    category: "Virtualização",
    description: "Permite que o hypervisor (o software da hospedeira que roda sua VPS) monitore e desligue a VPS de forma graciosa.",
    riskLevel: "alto",
    riskNote: "Se sua hospedeira depende disso pra desligar/reiniciar a VPS com segurança pelo painel dela, desativar pode deixar isso menos confiável. Só desative se tiver certeza de que sua hospedeira não usa.",
  },
];

export function findServiceDefinition(id: string): SystemServiceDefinition | undefined {
  return SERVICE_CATALOG.find((service) => service.id === id);
}
