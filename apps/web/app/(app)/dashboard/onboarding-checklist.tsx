import Link from "next/link";
import { CheckCircle2, Circle, Sparkles } from "lucide-react";
import { GithubConnectButton } from "../../github-connect-button";

interface OnboardingChecklistProps {
  githubConnected: boolean;
  hasProjects: boolean;
  twoFactorEnabled: boolean;
}

interface Step {
  key: string;
  label: string;
  description: string;
  done: boolean;
  action: React.ReactNode;
}

export function OnboardingChecklist({ githubConnected, hasProjects, twoFactorEnabled }: OnboardingChecklistProps) {
  const steps: Step[] = [
    {
      key: "github",
      label: "Conectar sua conta do GitHub",
      description: "Necessário pra importar e implantar seus repositórios.",
      done: githubConnected,
      action: <GithubConnectButton />,
    },
    {
      key: "project",
      label: "Criar ou importar seu primeiro projeto",
      description: "Traga um repositório existente ou comece um novo.",
      done: hasProjects,
      action: (
        <Link
          href="/projects"
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-[13.5px] font-medium text-background transition-opacity hover:opacity-90"
        >
          Ir pra Projetos
        </Link>
      ),
    },
    {
      key: "2fa",
      label: "Ativar autenticação em duas etapas",
      description: "Protege sua conta de administrador com um segundo fator.",
      done: twoFactorEnabled,
      action: (
        <Link
          href="/security"
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-[13.5px] font-medium text-background transition-opacity hover:opacity-90"
        >
          Ir pra Segurança
        </Link>
      ),
    },
  ];

  const pending = steps.filter((step) => !step.done);
  if (pending.length === 0) {
    return null;
  }

  return (
    <div className="mb-6 rounded-xl border border-border-subtle bg-surface p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles size={15} strokeWidth={1.75} className="text-accent" />
        <h2 className="text-[13.5px] font-semibold text-foreground">Primeiros passos</h2>
        <span className="text-[12px] text-muted-foreground">
          {steps.length - pending.length}/{steps.length}
        </span>
      </div>
      <div className="flex flex-col gap-3">
        {steps.map((step) => (
          <div
            key={step.key}
            className={`flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 ${
              step.done ? "opacity-50" : "bg-background/40"
            }`}
          >
            <div className="flex items-start gap-2.5">
              {step.done ? (
                <CheckCircle2 size={17} strokeWidth={1.75} className="mt-0.5 flex-none text-accent" />
              ) : (
                <Circle size={17} strokeWidth={1.75} className="mt-0.5 flex-none text-muted-foreground" />
              )}
              <div>
                <p className="text-[13.5px] font-medium text-foreground">{step.label}</p>
                <p className="mt-0.5 text-[12px] text-muted-foreground">{step.description}</p>
              </div>
            </div>
            {!step.done && <div className="flex-none">{step.action}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}
