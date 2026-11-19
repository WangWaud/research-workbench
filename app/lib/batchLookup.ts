import type { FreezerBox, FrozenSlot, MaterialType } from "./workbench.ts";

export type BatchLookupStatus = "exact" | "normalized" | "candidate" | "ambiguous" | "not-found";

export type BatchLookupItem = {
  index: number;
  input: string;
  status: BatchLookupStatus;
  slots: FrozenSlot[];
  matchedNames: string[];
};

export function parseBatchLookupInput(value: string) {
  return value
    .split(/[\r\n\t,，;；]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function safeKey(value: string) {
  return value.replace(/[！-～]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
    .trim().toLocaleLowerCase("zh-CN");
}

function candidateKey(value: string) {
  return safeKey(value).replace(/[\s_\-‐‑‒–—―]+/g, "");
}

function uniqueNames(slots: FrozenSlot[]) {
  return [...new Set(slots.map((slot) => slot.materialName))].sort((a, b) => a.localeCompare(b, "zh-CN"));
}

function hasMultipleIdentities(slots: FrozenSlot[]) {
  return new Set(slots.map(({ materialType, materialName }) => JSON.stringify([materialType, materialName.trim()]))).size > 1;
}

export function hasConfirmedBoxLocation(box: FreezerBox) {
  return [box.freezer, box.position].every((value) => value.trim() && !/待确认|待核对|未知|未填写|未定位|^[-—]+$/.test(value.trim()));
}

export function isBatchPickable(slot: FrozenSlot, box: FreezerBox | undefined) {
  return slot.status === "正常" && box !== undefined && hasConfirmedBoxLocation(box);
}

export function buildBatchLookup(
  value: string,
  slots: FrozenSlot[],
  materialType: "全部" | MaterialType = "菌株",
): BatchLookupItem[] {
  const pool = materialType === "全部" ? slots : slots.filter((slot) => slot.materialType === materialType);
  return parseBatchLookupInput(value).map((input, index) => {
    const exact = pool.filter((slot) => slot.materialName.trim() === input);
    if (exact.length) return { index, input, status: hasMultipleIdentities(exact) ? "ambiguous" : "exact", slots: exact, matchedNames: uniqueNames(exact) };

    const normalized = pool.filter((slot) => safeKey(slot.materialName) === safeKey(input));
    if (normalized.length) return { index, input, status: hasMultipleIdentities(normalized) ? "ambiguous" : "normalized", slots: normalized, matchedNames: uniqueNames(normalized) };

    const candidates = pool.filter((slot) => candidateKey(slot.materialName) === candidateKey(input));
    if (candidates.length) {
      const matchedNames = uniqueNames(candidates);
      return { index, input, status: hasMultipleIdentities(candidates) ? "ambiguous" : "candidate", slots: candidates, matchedNames };
    }

    return { index, input, status: "not-found" as const, slots: [], matchedNames: [] };
  });
}
