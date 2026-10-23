// Planted defect: runtime imports a higher package by its name, resolved through its package.json "exports".
import { hamsterdan } from "@fixture/hamsterdan";

export const upward = hamsterdan;
