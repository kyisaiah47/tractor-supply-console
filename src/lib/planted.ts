// Effects written into the generated dataset on purpose, so the models have signal to find.
// The generator reads these values and the model tests check each one is recovered.

// Our order book is this share of the dataset's market-level Demand_Units.
export const MARKET_SHARE = 0.01;

const RAW_SEASONAL = [0.8, 0.9, 1.25, 1.35, 1.2, 0.95, 0.85, 0.9, 1.1, 1.05, 0.8, 0.75];
const seasonalMean = RAW_SEASONAL.reduce((a, b) => a + b, 0) / 12;

export const PLANTED = {
  // Spring planting peaks March to May; harvest brings a smaller September bump.
  seasonal: RAW_SEASONAL.map((x) => x / seasonalMean),
  growthPerYear: 0.06,
  // Supplier B ships 40% faster than the dataset's delays; Supplier D is 40% slower in Q4.
  supplierDelay: {
    "Supplier B": 0.6,
    "Supplier D": { q4: 1.4 },
  } as Record<string, number | { q4: number }>,
  // Hydraulic pumps from Supplier E fail 2.5x as often; TX-400 transmissions 1.8x.
  failure: [
    { category: "HYD", supplier: "Supplier E", model: undefined, multiplier: 2.5 },
    { category: "TRN", supplier: undefined, model: "TX-400", multiplier: 1.8 },
  ] as { category: string; supplier?: string; model?: string; multiplier: number }[],
  // Share of each future month already booked: 100% this month, falling 7.5 points a month.
  bookedDecayPerMonth: 0.075,
  bookedFloor: 0.2,
};
