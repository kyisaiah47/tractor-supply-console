// Labels for the order form. The catalog itself (parts, suppliers, prices) lives in the API.

export const TRACTOR_MODELS = [
  { code: "TX-100", name: "Compact utility", horsepower: 25 },
  { code: "TX-200", name: "Utility", horsepower: 60 },
  { code: "TX-300", name: "Mid row-crop", horsepower: 130 },
  { code: "TX-400", name: "Row-crop", horsepower: 230 },
  { code: "TX-500", name: "Four-wheel drive", horsepower: 420 },
] as const;

export const WAREHOUSES = [
  { code: "CA", name: "Fresno, CA" },
  { code: "FL", name: "Lakeland, FL" },
  { code: "IL", name: "Peoria, IL" },
  { code: "NY", name: "Syracuse, NY" },
  { code: "TX", name: "Amarillo, TX" },
] as const;
