import * as XLSX from "xlsx";
import {
  BOX_EXPORT_COLUMNS,
  BOX_LEDGER_BASELINE_SHEET,
  buildBoxExportRecords,
  buildBoxGridMatrix,
  MATERIAL_TYPES,
} from "./workbench.ts";
import type { FreezerBox, FrozenSlot } from "./workbench.ts";

export function buildFreezerWorkbook(boxes: FreezerBox[], slots: FrozenSlot[], exportedAt = new Date().toISOString()) {
  const workbook = XLSX.utils.book_new();
  const selectedIds = new Set(boxes.map((box) => box.id));
  const selectedSlots = slots.filter((slot) => selectedIds.has(slot.boxId));
  const instructionsSheet = XLSX.utils.aoa_to_sheet([
    ["科研工作台冻存盒台账"],
    ["导出时间", exportedAt],
    ["回导步骤", "在“孔位明细”或“全部孔位”中修改后，回到工作台 → 导入与备份 → 上传本文件 → 核对差异预览。"],
    ["可修改字段", "是否占用、材料类型、材料名称 / 编号、分类地位（菌株）、状态、浓度、保存日期、提取日期、备注。"],
    ["不要修改", "记录键、盒标识符、孔位坐标，以及隐藏的“回导原始值”工作表。"],
    ["清空孔位", "把“是否占用”改为“否”；工作台会在预览中单独列出清空数量，并支持本次页面内撤销。"],
    ["科学数据", "工作台不会自动猜测浓度、日期或 Primer 信息；导入前请人工核对预览。"],
  ]);
  instructionsSheet["!cols"] = [{ wch: 18 }, { wch: 96 }];
  XLSX.utils.book_append_sheet(workbook, instructionsSheet, "使用说明");
  const summaryHeaders = ["盒标识符", "冰箱", "架位", "冻存盒名称", "占用孔位", "空位", ...MATERIAL_TYPES, "导出时间"];
  const summaryRows = boxes.map((box) => {
    const boxSlots = selectedSlots.filter((slot) => slot.boxId === box.id);
    return [
      box.identifier,
      box.freezer,
      box.position,
      box.name,
      boxSlots.length,
      box.rows * box.columns - boxSlots.length,
      ...MATERIAL_TYPES.map((type) => boxSlots.filter((slot) => slot.materialType === type).length),
      exportedAt,
    ];
  });
  const summarySheet = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
  summarySheet["!cols"] = [{ wch: 12 }, { wch: 18 }, { wch: 12 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, ...MATERIAL_TYPES.map(() => ({ wch: 9 })), { wch: 22 }];
  summarySheet["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(summaryHeaders.length - 1)}${summaryRows.length + 1}` };
  XLSX.utils.book_append_sheet(workbook, summarySheet, "盒索引");

  const records = buildBoxExportRecords(boxes, selectedSlots);
  const exportValue = (key: (typeof BOX_EXPORT_COLUMNS)[number]["key"], value: string | number | undefined) =>
    key === "concentration" && typeof value === "string" && Number.isFinite(Number(value)) && String(Number(value)) === value ? Number(value) : value;
  const ledgerRows = records.map((record) => BOX_EXPORT_COLUMNS.map((column) => exportValue(column.key, record[column.key])));
  const ledgerSheet = XLSX.utils.aoa_to_sheet([BOX_EXPORT_COLUMNS.map((column) => column.label), ...ledgerRows]);
  ledgerSheet["!cols"] = BOX_EXPORT_COLUMNS.map((column) => ({ wch: column.width }));
  ledgerSheet["!autofilter"] = { ref: `A1:${XLSX.utils.encode_col(BOX_EXPORT_COLUMNS.length - 1)}${ledgerRows.length + 1}` };
  XLSX.utils.book_append_sheet(workbook, ledgerSheet, boxes.length === 1 ? "孔位明细" : "全部孔位");

  boxes.forEach((box) => {
    const gridSheet = XLSX.utils.aoa_to_sheet([
      ["盒标识符", box.identifier],
      ["冰箱", box.freezer],
      ["架位", box.position],
      ["冻存盒名称", box.name],
      [],
      ...buildBoxGridMatrix(box, selectedSlots),
    ]);
    gridSheet["!cols"] = [{ wch: 11 }, ...Array.from({ length: box.columns }, () => ({ wch: 17 }))];
    XLSX.utils.book_append_sheet(workbook, gridSheet, boxes.length === 1 ? "盒图" : box.identifier.slice(0, 31));
  });

  const baselineSheet = XLSX.utils.aoa_to_sheet([
    [...BOX_EXPORT_COLUMNS.map((column) => column.label), "内部盒 ID", "内部冻存管 ID"],
    ...records.map((record) => [...BOX_EXPORT_COLUMNS.map(({ key }) => record[key]), record.boxId, record.slotId]),
  ]);
  XLSX.utils.book_append_sheet(workbook, baselineSheet, BOX_LEDGER_BASELINE_SHEET);
  XLSX.utils.book_set_sheet_visibility(workbook, BOX_LEDGER_BASELINE_SHEET, 1);

  return workbook;
}

export function createFreezerWorkbookBytes(boxes: FreezerBox[], slots: FrozenSlot[]) {
  return XLSX.write(buildFreezerWorkbook(boxes, slots), { bookType: "xlsx", type: "array", compression: true });
}
