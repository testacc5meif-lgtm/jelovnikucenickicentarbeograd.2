// Провера пре уписа у базу.
//
// Најозбиљнији квар није пад базе него дан кад установа промени распоред
// колона у PDF-у. Тада све ради: обрада, распоред, база, и све троје
// весело упишу празан или поломљен јеловник преко исправног. Ознака да су
// подаци застарели ту не помаже, јер податак није стар него погрешан, а
// систем мисли да је све у реду.
//
// Зато обрада мора да оцени сопствени резултат пре него што дира базу.
// Границе испод изведене су из мерења на правом документу за септембар
// 2026: 15 дана, од 9 до 16 ставки по дану, ниједан празан оброк.

const MEALS = ['dorucak', 'rucak', 'vecera'];

export const LIMITS = {
  minDays: 5,          // и половина месеца има бар толико дана
  minItemsPerDay: 4,   // измерено најмање 9, узето са резервом
  maxItemsPerDay: 40,  // измерено највише 16
  maxItemsPerMeal: 20, // измерено највише 9
  minAverage: 6,       // измерен просек 12,9
};

const DAY_MS = 86400000;
const asTime = (iso) => Date.parse(`${iso}T00:00:00Z`);

/**
 * Оцењује да ли обрађен јеловник сме да иде у базу.
 *
 * Разликује две врсте налаза. `problems` заустављају упис, јер значе да
 * подаци нису од поверења. `warnings` се само пријављују: јеловник коме
 * недостаје дан јесте мањкав, али је бољи од јеловника од прошлог месеца,
 * па улази у базу и види се у /health.
 *
 * Та разлика је научена на скупо. Јеловник за октобар 2026. био је
 * одбијен две недеље због налаза који је заустављао упис, а апликација је
 * све то време приказивала септембар.
 *
 * @returns {{ok: boolean, problems: string[], warnings: string[], stats: object}}
 */
export function acceptMenu(menu) {
  const problems = [];
  const warnings = [];
  const days = menu?.days ?? [];

  if (days.length < LIMITS.minDays) {
    problems.push(`прочитано само ${days.length} дана, најмање ${LIMITS.minDays}`);
  }

  const perDay = [];

  for (const day of days) {
    const counts = MEALS.map((meal) => (day[meal] || []).length);
    const total = counts.reduce((sum, n) => sum + n, 0);
    perDay.push(total);

    // Празан оброк је најјаснији знак да подела на колоне више не ваља.
    const empty = MEALS.filter((meal, index) => counts[index] === 0);
    if (empty.length > 0) problems.push(`${day.date}: празан оброк (${empty.join(', ')})`);

    if (total > LIMITS.maxItemsPerDay) {
      problems.push(`${day.date}: ${total} ставки у дану, највише ${LIMITS.maxItemsPerDay}`);
    }
    if (total < LIMITS.minItemsPerDay) {
      problems.push(`${day.date}: свега ${total} ставки у дану, најмање ${LIMITS.minItemsPerDay}`);
    }

    const biggest = Math.max(...counts);
    if (biggest > LIMITS.maxItemsPerMeal) {
      problems.push(`${day.date}: један оброк има ${biggest} ставки, највише ${LIMITS.maxItemsPerMeal}`);
    }

    // Датум који није после претходног значи да подела на дане више не
    // прати документ, па подаци нису од поверења.
    if (day.dateConflict) {
      problems.push(`${day.date}: датум није после претходног (${day.dateConflict})`);
    }

    if (day.dateGuessed) warnings.push(`${day.date}: датум није прочитан, изведен је из редоследа`);
  }

  const average = perDay.length ? perDay.reduce((sum, n) => sum + n, 0) / perDay.length : 0;
  if (perDay.length > 0 && average < LIMITS.minAverage) {
    problems.push(`просек ${average.toFixed(1)} ставки по дану, најмање ${LIMITS.minAverage}`);
  }

  // Прескочен дан усред јеловника обично значи да обрада није нашла блок.
  // То се пријављује, али не зауставља упис: остали дани су исправни.
  let missing = 0;
  for (let i = 1; i < days.length; i += 1) {
    const gap = (asTime(days[i].date) - asTime(days[i - 1].date)) / DAY_MS;
    if (gap > 1) {
      missing += gap - 1;
      warnings.push(`између ${days[i - 1].date} и ${days[i].date} нема ${gap - 1} дана`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    warnings,
    stats: {
      days: days.length,
      items: perDay.reduce((sum, n) => sum + n, 0),
      averagePerDay: Number(average.toFixed(1)),
      missingDays: missing,
    },
  };
}
