import { parseCsv } from "./csv-parser";

describe("parseCsv", () => {
  it("faz parse de um csv simples com header e linhas", () => {
    const result = parseCsv("id,name\n1,alice\n2,bob\n");
    expect(result.header).toEqual(["id", "name"]);
    expect(result.rows).toEqual([
      ["1", "alice"],
      ["2", "bob"],
    ]);
  });

  it("respeita campos entre aspas com vírgula e quebra de linha internas", () => {
    const result = parseCsv('id,note\n1,"hello, world"\n2,"multi\nline"\n');
    expect(result.header).toEqual(["id", "note"]);
    expect(result.rows).toEqual([
      ["1", "hello, world"],
      ["2", "multi\nline"],
    ]);
  });

  it("decodifica aspas duplicadas como uma aspas literal", () => {
    const result = parseCsv('id,quote\n1,"she said ""hi"""\n');
    expect(result.rows).toEqual([["1", 'she said "hi"']]);
  });

  it("retorna header vazio e nenhuma linha para entrada vazia", () => {
    const result = parseCsv("");
    expect(result.header).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it("lida com uma unica linha sem quebra final", () => {
    const result = parseCsv("id,name");
    expect(result.header).toEqual(["id", "name"]);
    expect(result.rows).toEqual([]);
  });
});
