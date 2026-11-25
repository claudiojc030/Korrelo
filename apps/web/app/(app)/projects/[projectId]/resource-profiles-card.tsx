import { MemoryStick } from "lucide-react";
import { authHeaderServer } from "../../../../lib/auth-cookie-server";
import { fetchApiServer } from "../../../../lib/api-server-fetch";
import { getLocaleServer } from "../../../../lib/i18n/get-locale-server";
import { getDictionary } from "../../../../lib/i18n/dictionaries";

interface StoredProfileSummary {
  measuredAt: string;
  environment: "lab" | "production";
  confidence: "low" | "medium" | "high";
  status: string;
  usable: boolean;
  reasons: string[];
  buildPeakMb: number | null;
  buildMemoryLimitMb: number;
  stagingPeakMb: number | null;
  stagingMemoryLimitMb: number;
}

interface ResourceProfilesPanel {
  projectId: string;
  latestMeasurement: StoredProfileSummary | null;
  latestValid: StoredProfileSummary | null;
  message: string | null;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border-subtle py-2.5 last:border-0">
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-right text-[13px] text-foreground">{value}</span>
    </div>
  );
}

export async function ResourceProfilesCard({ projectId }: { projectId: string }) {
  const t = getDictionary(await getLocaleServer()).projectDetail;
  const result = await fetchApiServer<ResourceProfilesPanel>(
    `/monitoring/resource-profiles?projectId=${encodeURIComponent(projectId)}`,
    { headers: await authHeaderServer() },
  );

  const profile = result.ok ? (result.data.latestValid ?? result.data.latestMeasurement) : null;

  return (
    <div className="mt-6 rounded-xl border border-border-subtle bg-surface p-4">
      <h2 className="mb-2 flex items-center gap-2 text-[13px] font-medium text-muted-foreground">
        <MemoryStick size={14} strokeWidth={1.75} />
        {t.resourceProfilesTitle}
      </h2>

      {!result.ok ? (
        <p className="text-[12.5px] text-destructive">{t.resourceProfileLoadError}</p>
      ) : !profile ? (
        <p className="text-[12.5px] text-muted-foreground">
          {result.data.message ?? t.resourceProfileNotMeasured}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-x-6 md:grid-cols-2">
          <Row
            label={result.data.latestValid ? t.resourceProfileLatestValid : t.resourceProfileLatest}
            value={new Date(profile.measuredAt).toLocaleString("pt-BR")}
          />
          <Row
            label={t.resourceProfileBuildPeak}
            value={
              profile.buildPeakMb != null
                ? `${profile.buildPeakMb} MB / ${profile.buildMemoryLimitMb} MB`
                : "-"
            }
          />
          <Row
            label={t.resourceProfileStagingPeak}
            value={
              profile.stagingPeakMb != null
                ? `${profile.stagingPeakMb} MB / ${profile.stagingMemoryLimitMb} MB`
                : "-"
            }
          />
          <Row label={t.resourceProfileConfidence} value={profile.confidence} />
          <Row label={t.resourceProfileStatus} value={profile.status} />
          <Row
            label={t.resourceProfileEnvironment}
            value={profile.environment === "lab" ? t.resourceProfileLab : t.resourceProfileProduction}
          />
          {profile.reasons.length > 0 && (
            <div className="md:col-span-2">
              <Row label={t.resourceProfileReason} value={profile.reasons.join("; ")} />
            </div>
          )}
          {!result.data.latestValid && (
            <div className="md:col-span-2">
              <p className="pt-2 text-[12px] text-muted-foreground">{t.resourceProfileNoValid}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
