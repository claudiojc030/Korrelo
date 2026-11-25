import {
  cgroupPeakFilePath,
  parseCgroupMemoryMapping,
  parseCgroupPeakBytes,
  readContainerCgroupPeakMb,
} from "./container-cgroup-peak";
import { realpath } from "node:fs/promises";

jest.mock("node:fs/promises", () => {
  const actual = jest.requireActual("node:fs/promises");
  return {
    ...actual,
    realpath: jest.fn(async (filePath: string) => filePath),
  };
});

const mockedRealpath = realpath as jest.MockedFunction<typeof realpath>;

const ID = "a".repeat(64);
const OTHER_ID = "b".repeat(64);

function reader(files: Record<string, string>) {
  return async (filePath: string): Promise<string> => {
    if (filePath in files) return files[filePath];
    throw new Error("ENOENT");
  };
}

function v2Cgroup(containerId = ID): string {
  return `0::/system.slice/docker-${containerId}.scope\n`;
}

function v1Cgroup(containerId = ID): string {
  return `11:memory:/docker/${containerId}\n`;
}

function peakPathV2(containerId = ID): string {
  return `/sys/fs/cgroup/system.slice/docker-${containerId}.scope/memory.peak`;
}

function peakPathV1(containerId = ID): string {
  return `/sys/fs/cgroup/memory/docker/${containerId}/memory.max_usage_in_bytes`;
}

describe("container cgroup peak", () => {
  beforeEach(() => {
    mockedRealpath.mockReset();
    mockedRealpath.mockImplementation((filePath) => Promise.resolve(String(filePath)));
  });

  it("lê memory.peak no cgroup v2", async () => {
    const peak = await readContainerCgroupPeakMb(
      { pid: 1234, containerId: ID },
      {
        readTextFile: reader({
          "/proc/1234/cgroup": v2Cgroup(),
          [peakPathV2()]: "125829120\n", // 120 MiB
        }),
      },
    );

    expect(peak).toBe(120);
  });

  it("lê memory.max_usage_in_bytes no cgroup v1", async () => {
    const peak = await readContainerCgroupPeakMb(
      { pid: 4321, containerId: ID },
      {
        readTextFile: reader({
          "/proc/4321/cgroup": v1Cgroup(),
          [peakPathV1()]: "104857600\n", // 100 MiB
        }),
      },
    );

    expect(peak).toBe(100);
  });

  it("retorna null quando o kernel não expõe o arquivo de pico", async () => {
    const peak = await readContainerCgroupPeakMb(
      { pid: 1234, containerId: ID },
      { readTextFile: reader({ "/proc/1234/cgroup": v2Cgroup() }) },
    );

    expect(peak).toBeNull();
  });

  it("retorna null em permissão negada ou leitura inválida", async () => {
    const peak = await readContainerCgroupPeakMb(
      { pid: 1234, containerId: ID },
      {
        readTextFile: async () => {
          throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        },
      },
    );

    expect(peak).toBeNull();
  });

  it("rejeita caminho inválido, traversal e cgroup de outro container", async () => {
    expect(parseCgroupMemoryMapping("0::/system.slice/../../etc\n")).toBeNull();
    expect(parseCgroupMemoryMapping("0::/system.slice/docker-other.scope\n")).not.toBeNull();

    expect(cgroupPeakFilePath({ version: 2, path: "/system.slice/other.scope" }, ID)).toBeNull();
    expect(cgroupPeakFilePath({ version: 2, path: `/system.slice/docker-${ID}.scope` }, OTHER_ID)).toBeNull();

    const peak = await readContainerCgroupPeakMb(
      { pid: 1234, containerId: ID },
      {
        readTextFile: reader({
          "/proc/1234/cgroup": `0::/system.slice/docker-${OTHER_ID}.scope\n`,
          [peakPathV2(OTHER_ID)]: "999999999\n",
        }),
      },
    );
    expect(peak).toBeNull();
  });

  it("symlink para fora da árvore de cgroups retorna null", async () => {
    mockedRealpath.mockResolvedValueOnce("/etc/passwd");

    const peak = await readContainerCgroupPeakMb(
      { pid: 1234, containerId: ID },
      {
        readTextFile: reader({
          "/proc/1234/cgroup": v2Cgroup(),
          [peakPathV2()]: "125829120\n",
          "/etc/passwd": "999999999\n",
        }),
      },
    );

    expect(peak).toBeNull();
  });

  it("symlink dentro da raiz para outro container também retorna null", async () => {
    mockedRealpath.mockResolvedValueOnce(
      `/sys/fs/cgroup/system.slice/docker-${OTHER_ID}.scope/memory.peak`,
    );

    const peak = await readContainerCgroupPeakMb(
      { pid: 1234, containerId: ID },
      {
        readTextFile: reader({
          "/proc/1234/cgroup": v2Cgroup(),
          [peakPathV2()]: "125829120\n",
        }),
      },
    );

    expect(peak).toBeNull();
  });

  it("aceita o padrão cgroupfs, além do systemd", async () => {
    const cgroupfs = `0::/docker/${ID}`;
    const peakFile = `/sys/fs/cgroup/docker/${ID}/memory.peak`;
    const peak = await readContainerCgroupPeakMb(
      { pid: 1234, containerId: ID },
      {
        readTextFile: reader({
          "/proc/1234/cgroup": `${cgroupfs}\n`,
          [peakFile]: "104857600\n",
        }),
      },
    );

    expect(peak).toBe(100);
  });

  it("retorna null para PID inválido, container ID inválido ou container removido", async () => {
    expect(
      await readContainerCgroupPeakMb(
        { pid: 0, containerId: ID },
        { readTextFile: reader({}) },
      ),
    ).toBeNull();
    expect(
      await readContainerCgroupPeakMb(
        { pid: 1234, containerId: "../etc" },
        { readTextFile: reader({}) },
      ),
    ).toBeNull();

    const removed = await readContainerCgroupPeakMb(
      { pid: 9999, containerId: ID },
      { readTextFile: reader({}) },
    );
    expect(removed).toBeNull();
  });

  it("retorna null para valores inválidos ou não numéricos", () => {
    expect(parseCgroupPeakBytes("max")).toBeNull();
    expect(parseCgroupPeakBytes("0")).toBeNull();
    expect(parseCgroupPeakBytes("-1")).toBeNull();
    expect(parseCgroupPeakBytes("abc")).toBeNull();
    expect(parseCgroupPeakBytes("")).toBeNull();
  });

  it("respeita timeout de leitura", async () => {
    const peak = await readContainerCgroupPeakMb(
      { pid: 1234, containerId: ID },
      {
        timeoutMs: 20,
        readTextFile: () => new Promise<string>(() => undefined),
      },
    );

    expect(peak).toBeNull();
  });

  it("múltiplos containers são independentes; falha parcial não bloqueia", async () => {
    const values = await Promise.all([
      readContainerCgroupPeakMb(
        { pid: 1111, containerId: ID },
        {
          readTextFile: reader({
            "/proc/1111/cgroup": v2Cgroup(ID),
            [peakPathV2(ID)]: "209715200\n", // 200 MiB
          }),
        },
      ),
      readContainerCgroupPeakMb(
        { pid: 2222, containerId: OTHER_ID },
        {
          readTextFile: reader({
            "/proc/2222/cgroup": v1Cgroup(OTHER_ID),
            [peakPathV1(OTHER_ID)]: "52428800\n", // 50 MiB
          }),
        },
      ),
      readContainerCgroupPeakMb(
        { pid: 3333, containerId: "c".repeat(64) },
        { readTextFile: reader({}) },
      ),
    ]);

    expect(values).toEqual([200, 50, null]);
  });

  it("timeout de um container não bloqueia a leitura dos outros", async () => {
    const values = await Promise.all([
      readContainerCgroupPeakMb(
        { pid: 1111, containerId: ID },
        { timeoutMs: 20, readTextFile: () => new Promise<string>(() => undefined) },
      ),
      readContainerCgroupPeakMb(
        { pid: 2222, containerId: OTHER_ID },
        {
          readTextFile: reader({
            "/proc/2222/cgroup": v2Cgroup(OTHER_ID),
            [peakPathV2(OTHER_ID)]: "104857600\n",
          }),
        },
      ),
    ]);

    expect(values).toEqual([null, 100]);
  });

  it("não presume cgroup v2 quando só existe v1", () => {
    expect(parseCgroupMemoryMapping(v1Cgroup())).toEqual({
      version: 1,
      path: `/docker/${ID}`,
    });
    expect(cgroupPeakFilePath({ version: 1, path: `/docker/${ID}` }, ID)).toBe(peakPathV1());
  });
});
