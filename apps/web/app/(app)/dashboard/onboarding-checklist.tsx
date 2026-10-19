import Link from "next/link";
import { CheckCircle2, Circle, Sparkles } from "lucide-react";
import { GithubConnectButton } from "../../github-connect-button";
import { getLocaleServer } from "../../../lib/i18n/get-locale-server";
import { getDictionary } from "../../../lib/i18n/dictionaries";

interface OnboardingChecklistProps {
  /**
   * null = "não deu pra saber" (a API falhou). Nesses passos a linha é
   * omitida em vez de marcada como pendente: um checklist que mostra
   * "conecte o GitHub" quando o problema era a API lying pro usuário.
   */
  githubConnected: boolean | null;
  hasProjects: boolean | null;
  twoFactorEnabled: boolean | null;
}

interface Step {
  key: string;
  label: string;
  description: string;
  done: boolean;
  action: React.ReactNode;
}

export async function OnboardingChecklist({ githubConnected, hasProjects, twoFactorEnabled }: OnboardingChecklistProps) {
  const t = getDictionary(await getLocaleServer());
  const allSteps: (Step & { known: boolean })[] = [
    {
      key: "github",
      label: t.dashboard.onboardingGithubLabel,
      description: t.dashboard.onboardingGithubDescription,
      done: githubConnected === true,
      known: githubConnected !== null,
      action: <GithubConnectButton />,
    },
    {
      key: "project",
      label: t.dashboard.onboardingProjectLabel,
      description: t.dashboard.onboardingProjectDescription,
      done: hasProjects === true,
      known: hasProjects !== null,
      action: (
        <Link
          href="/projects"
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-[13.5px] font-medium text-background transition-opacity hover:opacity-90"
        >
          {t.dashboard.onboardingProjectAction}
        </Link>
      ),
    },
    {
      key: "2fa",
      label: t.dashboard.onboarding2faLabel,
      description: t.dashboard.onboarding2faDescription,
      done: twoFactorEnabled === true,
      known: twoFactorEnabled !== null,
      action: (
        <Link
          href="/security"
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-[13.5px] font-medium text-background transition-opacity hover:opacity-90"
        >
          {t.dashboard.onboarding2faAction}
        </Link>
      ),
    },
  ];

  const steps: Step[] = allSteps.filter((step) => step.known);

  const pending = steps.filter((step) => !step.done);
  if (pending.length === 0) {
    return null;
  }

  return (
    <div className="mb-6 rounded-xl border border-border-subtle bg-surface p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles size={15} strokeWidth={1.75} className="text-accent" />
        <h2 className="text-[13.5px] font-semibold text-foreground">{t.dashboard.onboardingTitle}</h2>
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
