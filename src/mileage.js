const CAPITAL_LINE_ID = "capital-airport-express";
const CAPITAL_LOOP_IDS = {
  sanyuanqiaoT3: `${CAPITAL_LINE_ID}.segment-sanyuanqiao-t3`,
  t3T2: `${CAPITAL_LINE_ID}.segment-t3-t2`,
  t2Sanyuanqiao: `${CAPITAL_LINE_ID}.segment-t2-sanyuanqiao`
};

export function calculateMileageM(network, selectedSegmentIds) {
  const selected = new Set(selectedSegmentIds);
  const segments = new Map(network.segments.map((segment) => [segment.id, segment]));
  let totalM = 0;
  for (const id of selected) {
    const segment = segments.get(id);
    if (!segment) continue;
    if (segment.lineId !== CAPITAL_LINE_ID || !Object.values(CAPITAL_LOOP_IDS).includes(id)) totalM += segment.distanceM;
  }
  const loop = Object.values(CAPITAL_LOOP_IDS).filter((id) => selected.has(id));
  if (loop.length === 1) totalM += segments.get(loop[0]).distanceM;
  if (loop.length === 2) {
    const missing = Object.entries(CAPITAL_LOOP_IDS).find(([, id]) => !selected.has(id))?.[0];
    totalM += { t3T2: 23864, sanyuanqiaoT3: 23400, t2Sanyuanqiao: 23865 }[missing];
  }
  if (loop.length === 3) totalM += 25076;
  return totalM;
}

export { CAPITAL_LOOP_IDS };
