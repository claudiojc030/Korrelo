/* eslint-disable @typescript-eslint/no-require-imports */
const admin = require("../../../../scripts/staging-admin.cjs") as {
  projectSlug: (name: string) => string | null;
  timingSafeEqualText: (a: string, b: string) => boolean;
  verifyImageMetadata: (
    metadata: {
      Id: string;
      Config: { Labels: Record<string, string> };
      Os: string;
      Architecture: string;
    },
    expected: {
      projectId: string;
      projectName: string;
      commitSha: string;
      expectedImageId?: string | null;
      architecture: string;
    },
  ) => { ok: boolean; issues: string[]; imageId: string | null };
};

const imageId = "sha256:" + "a".repeat(64);
const commit = "b".repeat(40);

function metadata(labels: Record<string, string> = {}, overrides: Record<string, unknown> = {}) {
  return {
    Id: imageId,
    Config: {
      Labels: {
        "korrelo.projectId": "mesatta",
        "korrelo.commitSha": commit,
        ...labels,
      },
    },
    Os: "linux",
    Architecture: "amd64",
    ...overrides,
  };
}

const expected = {
  projectId: "uuid-mesatta",
  projectName: "Mesatta",
  commitSha: commit,
  architecture: "amd64",
};

describe("staging-admin CLI helpers", () => {
  it("aceita label pelo slug do projeto e exige commit/plataforma", () => {
    expect(admin.verifyImageMetadata(metadata(), expected).ok).toBe(true);
    expect(admin.projectSlug("Mesatta")).toBe("mesatta");
    expect(admin.verifyImageMetadata(metadata(), { ...expected, projectName: "Outro" }).ok).toBe(false);
    expect(admin.verifyImageMetadata(metadata(), { ...expected, commitSha: "c".repeat(40) }).ok).toBe(false);
    expect(admin.verifyImageMetadata(metadata(), { ...expected, architecture: "arm64" }).ok).toBe(false);
  });

  it("recusa image ID ou SO divergente", () => {
    expect(
      admin.verifyImageMetadata(metadata({}, { Id: "sha256:" + "c".repeat(64) }), {
        ...expected,
        expectedImageId: imageId,
      }).ok,
    ).toBe(false);
    expect(admin.verifyImageMetadata(metadata({}, { Os: "windows" }), expected).ok).toBe(false);
    expect(
      admin.verifyImageMetadata(metadata(), { ...expected, expectedImageId: imageId }).ok,
    ).toBe(true);
  });

  it("compara tokens sem vazar tamanho", () => {
    expect(admin.timingSafeEqualText("abc", "abc")).toBe(true);
    expect(admin.timingSafeEqualText("abc", "abd")).toBe(false);
    expect(admin.timingSafeEqualText("abc", "abcd")).toBe(false);
  });
});
