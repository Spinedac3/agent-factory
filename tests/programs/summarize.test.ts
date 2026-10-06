import { describe, expect, it } from "vitest";
import { summarizedRows, summaryLines } from "../../src/programs/summarize.js";

const ROWS = [
  { area: "corte", operario: "Ana", piezas: 10, operarios: "Ana,Beto" },
  { area: "corte", operario: "Beto", piezas: 4, operarios: "Beto" },
  { area: "corte", operario: "Ana", piezas: 6, operarios: "Ana" },
  { area: "empaque", operario: "Ciro", piezas: 7, operarios: "Ciro" },
];

describe("summarizing rows", () => {
  it("turns rows into one per group, with its count and sums, most rows first", () => {
    // Performs the test.
    const rows = summarizedRows(ROWS, { by: ["area"], sum: ["piezas"] });

    // Performs assertions.
    expect(rows).toEqual([
      { area: "corte", rows: 3, piezas: 20 },
      { area: "empaque", rows: 1, piezas: 7 },
    ]);
  });

  it("writes a subtotal for each level above the full key, and each group under it", () => {
    // Performs the test.
    const lines = summaryLines(ROWS, { by: ["area", "operario"], sum: ["piezas"] });

    // Performs assertions.
    expect(lines).toEqual([
      "resumen por area · operario, calculado sobre las 4 filas (no lo recuentes): grupos: 3 · piezas: 27",
      "area=corte: filas 3 · piezas: 20 · operario distintos: 2",
      "  area=corte · operario=Ana: filas 2 · piezas: 16",
      "  area=corte · operario=Beto: filas 1 · piezas: 4",
      "area=empaque: filas 1 · piezas: 7 · operario distintos: 1",
      "  area=empaque · operario=Ciro: filas 1 · piezas: 7",
    ]);
  });

  it("counts each value of a field that holds several, and ranks the rows inside a group", () => {
    // Performs the test.
    const lines = summaryLines(ROWS, {
      by: ["area"],
      top: { field: "operarios", n: 2, separator: "," },
      rank: { field: "piezas", n: 1, order: "asc", show: ["operario"] },
    });

    // Performs assertions.
    expect(lines[1]).toBe(
      "area=corte: filas 3 · top operarios: Ana (2), Beto (2) · menores piezas (1): Beto: piezas=4",
    );
  });

  it("puts the count by class first when the rows are classified", () => {
    // Performs the test.
    const lines = summaryLines(
      ROWS.map((row, index) => ({ ...row, class: index === 0 ? "alta" : "baja" })),
      { by: ["area"] },
    );

    // Performs assertions.
    expect(lines[1]).toBe("por clase: baja 3 · alta 1");
  });
});
