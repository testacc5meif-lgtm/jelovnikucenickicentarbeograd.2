// Кратак дневник позива ка рутама за спољни распоред.
//
// Без овога се не види разлика између три сасвим различита квара: позив
// уопште не стиже, стиже на погрешну путању, или стиже са погрешном
// тајном. Споља сва три изгледају исто, као обавештење које није дошло.
//
// Живи у меморији, држи последњих неколико позива и види се кроз /health.

const MAX = 12;
const entries = [];

export function note(entry) {
  entries.unshift({ at: new Date().toISOString(), ...entry });
  if (entries.length > MAX) entries.length = MAX;
}

export function recent() {
  return entries;
}
