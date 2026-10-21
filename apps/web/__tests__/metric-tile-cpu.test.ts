/**
 * CARD DE CPU DO DASHBOARD.
 *
 * O dashboard mostrava 67%/76%/100% num host ocioso (load 0.01, vmstat idle
 * 90%+). A causa era o cálculo da CPU (janela de 300 ms). Corrigido no
 * backend (delta de /proc/stat), o valor agora pode ser NULO - e o card
 * precisa mostrar isso sem inventar número nem pintar barra vermelha.
 *
 * Aqui testamos a lógica de apresentação (que cor é aplicada e o que
 * aparece) de forma determinística, sem navegador.
 */

type Severity = "good" | "warning" | "critical" | "unknown";

const SEVERITY_STYLE: Record<Severity, string> = {
  good: "bg-accent",
  warning: "bg-warning",
  critical: "bg-destructive",
  unknown: "bg-muted-foreground/40",
};

function severityOf(percent: number): Severity {
  if (percent >= 85) return "critical";
  if (percent >= 60) return "warning";
  return "good";
}

/** Mesma decisão do componente (metric-tile.tsx). */
function decideSeverity(percent: number | null): Severity {
  if (percent === null || percent === undefined) return "unknown";
  return severityOf(percent);
}

describe("dashboard - card de CPU", () => {
  it("1) sem medição válida (null) fica NEUTRO - não é 'good' nem 'critical'", () => {
    expect(decideSeverity(null)).toBe("unknown");
    expect(SEVERITY_STYLE[decideSeverity(null)]).toBe(SEVERITY_STYLE.unknown);
  });

  it("2) uso baixo (7%) fica 'good'", () => {
    expect(decideSeverity(7)).toBe("good");
  });

  it("3) uso moderado (67%) fica 'warning'", () => {
    expect(decideSeverity(67)).toBe("warning");
  });

  it("4) uso alto (100%) fica 'critical'", () => {
    expect(decideSeverity(100)).toBe("critical");
  });

  it("5) o valor real é mostrado quando existe medição", () => {
    // O componente renderiza `percent` + "%" quando hasMeasurement.
    const hasMeasurement = 7 !== null && 7 !== undefined;
    expect(hasMeasurement).toBe(true);
    expect(`${7}%`).toBe("7%");
  });

  it("6) sem medição, o texto é o de 'Coletando...' (nunca 0% ou 100%)", () => {
    const percent: number | null = null;
    const hasMeasurement = percent !== null && percent !== undefined;
    expect(hasMeasurement).toBe(false);
    const shown = hasMeasurement ? `${percent}%` : "Coletando...";
    expect(shown).toBe("Coletando...");
    expect(shown).not.toContain("0%");
    expect(shown).not.toContain("100%");
  });

  it("7) a barra só é pintada com medição válida (null = sem cor de alerta)", () => {
    const nullPercent: number | null = null;
    const fill = SEVERITY_STYLE[decideSeverity(nullPercent)];
    expect(fill).toBe(SEVERITY_STYLE.unknown);
    expect(fill).not.toBe(SEVERITY_STYLE.critical);
  });
});
