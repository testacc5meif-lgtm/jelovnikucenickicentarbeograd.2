const ICONS = { dorucak: '☕', rucak: '\u{1F35D}', vecera: '\u{1F319}' };
const WEEK_SHORT = ['нед', 'пон', 'уто', 'сре', 'чет', 'пет', 'суб'];
const WEEK_LONG = ['недеља', 'понедељак', 'уторак', 'среда', 'четвртак', 'петак', 'субота'];
const MONTHS = ['јануар', 'фебруар', 'март', 'април', 'мај', 'јун', 'јул', 'август', 'септембар', 'октобар', 'новембар', 'децембар'];

const TZ_FALLBACK = 'Europe/Belgrade';

const el = (id) => document.getElementById(id);
const state = { meta: null, days: new Map(), selected: null, prefs: { dorucak: true, rucak: true, vecera: true } };

/* ---------- Помоћне функције за датуме ---------- */

const shift = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

const weekdayIndex = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const human = (iso) => {
  const [, m, d] = iso.split('-').map(Number);
  return `${d}. ${MONTHS[m - 1]}`;
};

/**
 * Тренутни датум и час у зони установе.
 *
 * Не сме да се узима из /api/meta, јер тај одговор стоји у кешу, па би
 * апликација сутра и даље мислила да је јуче. Ни сат телефона не ваља,
 * јер уређај може да буде у другој зони, а оброци се служе по београдском
 * времену.
 */
function nowThere() {
  const zone = state.meta?.timezone || TZ_FALLBACK;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date());

  const at = (type) => parts.find((part) => part.type === type).value;
  return {
    date: `${at('year')}-${at('month')}-${at('day')}`,
    minutes: Number(at('hour')) * 60 + Number(at('minute')),
  };
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

/* ---------- Учитавање података ---------- */

async function load() {
  const isRefresh = Boolean(state.meta);
  const keepScroll = window.scrollY;

  state.meta = await (await fetch('/api/meta')).json();
  state.today = nowThere().date;
  const first = state.meta.range?.first;
  const last = state.meta.range?.last;
  const floor = shift(state.today, -3);
  const from = first ? (first > floor ? first : floor) : state.today;
  const to = last || shift(state.today, 14);

  const data = await (await fetch(`/api/menu?from=${from}&to=${to}`)).json();
  state.days = new Map(data.days.map((day) => [day.date, day]));

  // Сервер јавља кад служи последње успешно прочитане податке зато што
  // база тренутно не одговара. Корисник то мора да зна, али без панике:
  // јеловник се мења двапут месечно, па је то готово увек тачан податак.
  state.stale = Boolean(state.meta.stale || data.stale);
  state.staleSince = state.meta.staleSince || data.staleSince || null;

  const params = new URLSearchParams(location.search);
  const requested = params.get('dan');
  state.selected = state.days.has(requested)
    ? requested
    : state.days.has(state.today)
      ? state.today
      : [...state.days.keys()][0] || state.today;

  renderStrip();
  renderDay();
  renderFooter();
  renderUpNext();
  load.lastAt = Date.now();

  // Освежавање не сме да помери страницу под прстом корисника.
  if (isRefresh) {
    window.scrollTo(0, keepScroll);
    return;
  }

  // Први приказ иде из кеша, да се апликација отвори одмах док се сервер
  // буди. Одмах затим се тражи свеж податак, мимо кеша, и ако се разликује
  // приказ се тихо поправи. Без овога је кеширан одговор умео да остане
  // заробљен данима, па су се виделе старе вредности.
  refreshMeta();

  // Долазак из обавештења: помери приказ на тражени оброк.
  const focus = params.get('obrok');
  if (focus) {
    // Без "smooth": глатко померање прегледач прекине док се страна још слаже.
    requestAnimationFrame(() => el(`meal-${focus}`)?.scrollIntoView({ block: 'center' }));
  }
}

/** Тражи свеж /api/meta мимо кеша и поправља приказ ако се разликује. */
async function refreshMeta() {
  try {
    const fresh = await (await fetch('/api/meta?svez=1')).json();
    if (JSON.stringify(fresh) === JSON.stringify(state.meta)) return;
    state.meta = fresh;
    state.today = nowThere().date;
    renderStrip();
    renderDay();
    renderFooter();
    renderUpNext();
  } catch {
    // Нема мреже: остаје оно из кеша, што је и сврха кеша.
  }
}

/* ---------- Приказ ---------- */

function renderStrip() {
  const strip = el('strip');
  strip.replaceChildren();
  for (const date of state.days.keys()) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (date === state.today ? ' today' : '');
    chip.setAttribute('aria-selected', String(date === state.selected));
    chip.innerHTML = `<small>${WEEK_SHORT[weekdayIndex(date)]}</small><strong>${Number(date.slice(8))}</strong>`;
    chip.addEventListener('click', () => {
      state.selected = date;
      history.replaceState(null, '', date === state.today ? '/' : `/?dan=${date}`);
      renderStrip();
      renderDay();
      renderUpNext();
    });
    strip.append(chip);
  }
  // Трака се помера само водоравно. scrollIntoView би овде повукао и целу
  // страницу навише, што квари долазак из обавештења на одређени оброк.
  //
  // Рачуна се двапут: одмах, и после исцртавања. При првом позиву трака
  // још нема ширину, па би израчун одгурао изабрани дан ван видљивог дела.
  // Мере се стварни положаји, не offsetLeft. Он се рачуна у односу на
  // најближег позиционираног претка, па на широком екрану, где је садржај
  // центриран, укључи и леву маргину и израчун промаши за пола екрана.
  const centre = () => {
    const active = strip.querySelector('[aria-selected="true"]');
    if (!active || strip.clientWidth === 0) return;
    const box = strip.getBoundingClientRect();
    const chip = active.getBoundingClientRect();
    const offset = (chip.left - box.left) - (strip.clientWidth - chip.width) / 2;
    strip.scrollLeft = Math.max(0, strip.scrollLeft + offset);
  };
  centre();
  requestAnimationFrame(centre);
}

/**
 * Следећи оброк који тек предстоји. Кад се данашњи дан заврши,
 * прелази на сутрашњи доручак, исто као што ради и вечерње обавештење.
 */
function nextUp() {
  const { date, minutes } = nowThere();
  for (const meal of state.meta.meals) {
    const [h, m] = meal.startsAt.split(':').map(Number);
    if (minutes < h * 60 + m) return { date, meal, minutesAway: h * 60 + m - minutes };
  }
  const tomorrow = shift(date, 1);
  const first = state.meta.meals[0];
  const [h, m] = first.startsAt.split(':').map(Number);
  return { date: tomorrow, meal: first, minutesAway: 24 * 60 - minutes + h * 60 + m };
}

function renderDay() {
  const day = state.days.get(state.selected);
  const isToday = state.selected === state.today;

  const stale = state.stale
    ? `<p class="stale">Приказ од ${state.staleSince ? new Date(state.staleSince).toLocaleString('sr-RS') : 'раније'}. `
      + 'Веза са базом тренутно не ради, па подаци можда нису најновији.</p>'
    : '';

  el('dayHead').innerHTML = `<h2>${isToday ? 'Данас' : WEEK_LONG[weekdayIndex(state.selected)]}, ${human(state.selected)}</h2>
    <p>${isToday ? WEEK_LONG[weekdayIndex(state.selected)] : ''}</p>${stale}`;

  el('empty').hidden = Boolean(day);
  const container = el('meals');
  container.replaceChildren();
  if (!day) return;

  const next = nextUp();
  const minutesNow = nowThere().minutes;

  for (const meal of state.meta.meals) {
    const items = day.meals[meal.key] || [];
    const [h, m] = meal.startsAt.split(':').map(Number);

    const isNext = next.date === state.selected && next.meal.key === meal.key;
    const isPast = isToday && !isNext && minutesNow >= h * 60 + m;

    const card = document.createElement('section');
    card.className = 'meal' + (isNext ? ' next' : '') + (isPast ? ' past' : '');
    card.id = `meal-${meal.key}`;

    const list = items.length
      ? `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : '<p class="none">Није предвиђено.</p>';

    // Ознака поред наслова говори у ком је стању оброк, да се не мора
    // рачунати из сата. Одбројавање се освежава истим тајмером као трака.
    const mark = isNext
      ? `<span class="mark next" data-countdown="${meal.key}">${untilText(next.minutesAway)}</span>`
      : isPast ? '<span class="mark past">било</span>' : '';

    card.innerHTML = `<div class="meal-head"><span class="ico" aria-hidden="true">${ICONS[meal.key]}</span>`
      + `<h3>${meal.label}</h3>${mark}<span class="time">од ${meal.startsAt}</span></div>${list}`;
    container.append(card);
  }
}

/** "за 1 ч 20 мин", или "сада" кад је време стигло. */
function untilText(minutes) {
  if (minutes <= 0) return 'сада';
  const hours = Math.floor(minutes / 60);
  return `за ${hours > 0 ? `${hours} ч ` : ''}${minutes % 60} мин`;
}

function renderUpNext() {
  const box = el('upNext');
  clearInterval(renderUpNext.timer);

  const tick = () => {
    // Понoћ затиче апликацију отворену, па дан мора сам да се преврне.
    if (nowThere().date !== state.today) {
      load().catch(() => {});
      return;
    }
    const next = nextUp();
    if (!state.days.has(next.date)) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    state.next = next;
    const when = next.date === state.today ? '' : 'сутра ';
    box.innerHTML = `<span>Следећи оброк: <b>${next.meal.label}</b> ${when}у ${next.meal.startsAt}</span>`
      + `<span class="cd">${untilText(next.minutesAway)}</span>`;

    // Одбројавање на самој картици прати исти откуцај.
    const badge = document.querySelector(`.mark.next[data-countdown="${next.meal.key}"]`);
    if (badge) badge.textContent = untilText(next.minutesAway);
  };

  tick();
  renderUpNext.timer = setInterval(tick, 30000);
}

function renderFooter() {
  const source = state.meta.source;
  const foot = el('foot');
  if (!source) {
    foot.replaceChildren();
    return;
  }
  const parts = [];
  if (source.allergens) parts.push(`<div><b>Алерго инфо:</b> ${escapeHtml(source.allergens)}</div>`);
  if (source.note) parts.push(`<div>${escapeHtml(source.note)}</div>`);
  if (source.url && source.url.startsWith('http')) {
    parts.push(`<div>Извор: <a href="${escapeHtml(source.url)}" rel="noopener">званични PDF јеловник</a></div>`);
  }
  if (source.fetchedAt) {
    parts.push(`<div>Ажурирано ${new Date(source.fetchedAt).toLocaleDateString('sr-RS')}</div>`);
  }
  foot.innerHTML = parts.join('');
}

/* ---------- Обавештења ---------- */

function urlBase64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from([...raw].map((ch) => ch.charCodeAt(0)));
}

const isStandalone = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent)
  // iPad од новијих издања пријављује се као Mac, али има додир на екрану.
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// На iPhone-у сваки прегледач ради на Apple-овом мотору, али само Safari
// сме да дода апликацију на почетни екран. Chrome и Firefox тамо носе
// своје ознаке у називу.
const isIosSafari = () => isIos() && !/CriOS|FxiOS|EdgiOS|OPiOS|Chrome/i.test(navigator.userAgent);

/**
 * Зашто претплата тренутно није могућа, ако није.
 *
 * Редослед је важан. Провера за iPhone иде прва, јер тамо ниједан
 * прегледач осим Safari-ја нема ни PushManager, па би иначе искакала
 * порука да прегледач не подржава обавештења, што је тачно али
 * кориснику не каже шта да уради.
 */
function whyNotSubscribable() {
  if (!state.meta.pushEnabled) return 'Обавештења тренутно нису подешена на серверу.';

  if (isIos()) {
    if (!isIosSafari()) {
      return 'На iPhone-у обавештења може да укључи само Safari. Отвори ову исту адресу у Safari-ју, '
        + 'додај је на почетни екран преко дугмета Подели, па се претплати из тако отворене апликације.';
    }
    if (!isStandalone()) {
      return 'На iPhone-у обавештења раде тек из апликације са почетног екрана. Додирни дугме Подели, '
        + 'изабери „Додај на почетни екран”, отвори је одатле, па се претплати.';
    }
    if (!('PushManager' in window)) {
      return 'Овај iPhone има старије издање система. Обавештења траже iOS 16.4 или новији.';
    }
    return null;
  }

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return 'Овај прегледач не подржава обавештења.';
  }
  return null;
}

function openSheet() {
  const prefs = el('prefs');
  prefs.replaceChildren();
  for (const meal of state.meta.meals) {
    const li = document.createElement('li');
    const id = `pref-${meal.key}`;
    li.innerHTML = `<input type="checkbox" id="${id}" ${state.prefs[meal.key] ? 'checked' : ''}>`
      + `<label for="${id}">${meal.label}<div class="when">обавештење у ${meal.notifyAt}</div></label>`;
    prefs.append(li);
  }

  const note = el('sheetNote');
  const save = el('sheetSave');
  const prepreka = whyNotSubscribable();

  note.hidden = !prepreka;
  if (prepreka) note.textContent = prepreka;
  save.disabled = Boolean(prepreka);

  el('sheet').hidden = false;
}

/**
 * Тражи дозволу за обавештења.
 * Старији прегледачи враћају резултат кроз позивну функцију уместо кроз
 * обећање, па су покривена оба облика.
 */
function askPermission() {
  return new Promise((resolve) => {
    try {
      const maybe = Notification.requestPermission((result) => resolve(result));
      if (maybe && typeof maybe.then === 'function') maybe.then(resolve, () => resolve('denied'));
    } catch {
      resolve('denied');
    }
  });
}

function remember(prefs) {
  try {
    localStorage.setItem('prefs', JSON.stringify(prefs));
  } catch {
    // Safari у приватном режиму одбија упис. Подешавања се тада не памте,
    // али претплата и даље мора да прође.
  }
}

async function saveSubscription() {
  const prefs = Object.fromEntries(state.meta.meals.map((meal) => [meal.key, el(`pref-${meal.key}`).checked]));
  state.prefs = prefs;
  const noneSelected = Object.values(prefs).every((value) => !value);

  // Дозвола се тражи пре свега осталог, док кориснички додир још важи.
  // Safari на iPhone-у одбија захтев који стигне после чекања на нешто
  // друго, па би иза два await-а тихо пропао.
  const permissionAsked = noneSelected ? null : askPermission();

  remember(prefs);
  const registration = await navigator.serviceWorker.ready;

  if (noneSelected) {
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      await fetch('/api/unsubscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: existing.endpoint }),
      });
      await existing.unsubscribe();
    }
    el('bellDot').hidden = true;
    return 'Обавештења су искључена.';
  }

  const permission = await permissionAsked;
  if (permission !== 'granted') return 'Дозвола за обавештења није дата.';

  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(state.meta.vapidPublicKey),
    }));

  await fetch('/api/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subscription: subscription.toJSON(), prefs }),
  });
  el('bellDot').hidden = false;
  return 'Спремно. Јавићемо ти пред сваки оброк.';
}

/* ---------- Повезивање ---------- */

el('bell').addEventListener('click', openSheet);

// Трака „следећи оброк” води право на тај дан и оброк.
el('upNext').addEventListener('click', () => {
  const next = state.next;
  if (!next || !state.days.has(next.date)) return;
  state.selected = next.date;
  history.replaceState(null, '', next.date === state.today ? '/' : `/?dan=${next.date}`);
  renderStrip();
  renderDay();
  el(`meal-${next.meal.key}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
});

el('sheetClose').addEventListener('click', () => { el('sheet').hidden = true; });
el('sheet').addEventListener('click', (event) => {
  if (event.target === el('sheet')) el('sheet').hidden = true;
});
el('sheetSave').addEventListener('click', async () => {
  const save = el('sheetSave');
  const note = el('sheetNote');
  save.disabled = true;
  try {
    note.textContent = await saveSubscription();
  } catch (error) {
    note.textContent = `Није успело: ${error.message}`;
  }
  note.hidden = false;
  save.disabled = false;
});

try {
  const stored = JSON.parse(localStorage.getItem('prefs') || 'null');
  if (stored) state.prefs = stored;
} catch {
  /* нема сачуваних подешавања */
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch((error) => console.warn('SW:', error.message));

  // Приказ креће из кеша, па сервер стигне са свежијим подацима касније.
  // Тада service worker јави, а приказ се тихо освежи.
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'menu-updated') load().catch(() => {});
  });
  navigator.serviceWorker.ready
    .then((registration) => registration.pushManager.getSubscription())
    .then((subscription) => { el('bellDot').hidden = !subscription; })
    .catch(() => {});
}

// Освежи податке кад се корисник врати у апликацију, али не на сваки повратак:
// јеловник се мења двапут месечно, па је довољно на два минута.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  if (load.lastAt && Date.now() - load.lastAt < 120000) return;
  load().catch(() => {});
});

// При првој посети нема шта да се покаже из кеша, а буђење успаваног
// сервера уме да потраје, па корисник мора да зна да се нешто дешава.
el('empty').hidden = false;
el('empty').innerHTML = '<p>Учитавање јеловника…</p><p class="muted">Сервер се буди, то уме да потраје и двадесетак секунди.</p>';

load().catch((error) => {
  el('empty').hidden = false;
  el('empty').innerHTML = `<p>Подаци тренутно нису доступни.</p><p class="muted">${escapeHtml(error.message)}</p>`;
});
